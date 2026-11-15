import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { eventFromRow, inQuietHours, ruleFromRow } from '@cip/alerts';
import {
  ALERTS_STREAM,
  type AlertFiredMessage,
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
} from '@cip/contracts';
import { alertEventForDelivery, type Database } from '@cip/db';

/** A `notifications` job: deliver one fired alert (ADR 020). */
export interface DeliverJob {
  eventId: string;
}

/** Native notifications a user receives per minute; beyond that, alerts reach the inbox quietly. */
export const PUSHES_PER_MINUTE = 20;
/** `alerts:events` keeps about this many messages (a client offline longer gets a snapshot). */
export const ALERTS_STREAM_MAXLEN = 100_000;
export const pushCountKey = (userId: string, minute: number) => `alerts:push:${userId}:${minute}`;

export interface DeliveryDeps {
  db: Kysely<Database>;
  redis: Redis;
  now?: () => number;
}

/**
 * Delivers a fired alert to its rule's owner: one `alerts.notifications` row per channel the rule
 * chose (the `in_app` row is the inbox item), then `alert.fired` on `alerts:events`, which every API
 * instance pushes to the owner's open apps. Safe to retry: rows are written once.
 */
export async function deliverAlert(
  deps: DeliveryDeps,
  eventId: string,
): Promise<{ notificationId: string; quiet: boolean } | null> {
  const found = await alertEventForDelivery(deps.db, eventId);
  if (!found) return null;
  const { event, rule } = found;
  const now = deps.now?.() ?? Date.now();
  const channels = NOTIFICATION_CHANNELS.filter((c) => c === 'in_app' || rule.channels.includes(c));
  await deps.db
    .insertInto('alerts.notifications')
    .values(
      channels.map((channel) => ({
        id: uuidv7(),
        event_id: event.id,
        user_id: rule.owner_id,
        channel,
        status: 'sent' as const,
        attempts: 1,
        created_at: new Date(now),
      })),
    )
    .onConflict((oc) => oc.columns(['event_id', 'user_id', 'channel']).doNothing())
    .execute();
  const inbox = await deps.db
    .selectFrom('alerts.notifications')
    .select(['id', 'created_at', 'read_at'])
    .where('event_id', '=', event.id)
    .where('user_id', '=', rule.owner_id)
    .where('channel', '=', 'in_app')
    .executeTakeFirstOrThrow();

  // Quiet: inside the rule's quiet hours now, or beyond the user's native notifications this minute.
  const key = pushCountKey(rule.owner_id, Math.floor(now / 60_000));
  const pushes = await deps.redis.incr(key);
  if (pushes === 1) await deps.redis.expire(key, 120);
  const quiet = inQuietHours(ruleFromRow(rule)?.quietHours ?? null, now) || pushes > PUSHES_PER_MINUTE;

  const message: AlertFiredMessage = {
    notification: {
      id: inbox.id,
      event: eventFromRow(event, rule.name),
      createdAt: inbox.created_at.getTime(),
      readAt: inbox.read_at?.getTime() ?? null,
    },
    channels: channels.filter((c): c is Exclude<NotificationChannel, 'in_app'> => c !== 'in_app'),
    quiet,
  };
  await deps.redis.xadd(
    ALERTS_STREAM,
    'MAXLEN',
    '~',
    ALERTS_STREAM_MAXLEN,
    '*',
    'type',
    'alert.fired',
    'user',
    rule.owner_id,
    'data',
    JSON.stringify(message),
  );
  return { notificationId: inbox.id, quiet };
}
