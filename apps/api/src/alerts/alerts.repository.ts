import { Inject, Injectable } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import { eventFromRow } from '@cip/alerts';
import type {
  AlertEvent,
  CreateAlertRuleRequestSchema,
  Notification,
  Page,
  UpdateAlertRuleRequest,
} from '@cip/contracts';
import type { AlertRuleRow, Database } from '@cip/db';
import type { z } from 'zod';
import { decodeCursor, encodeCursor } from '../market/market.repository.js';
import { DB } from '../tokens.js';

type NewRule = z.output<typeof CreateAlertRuleRequestSchema>;

/** At most this many rules per user (removed ones do not count). */
export const MAX_RULES_PER_USER = 100;

/** The `alerts` schema as the API reads and writes it (data model §7, ADR 020). */
@Injectable()
export class AlertsRepository {
  constructor(@Inject(DB) private readonly db: Kysely<Database>) {}

  rules(ownerId: string): Promise<AlertRuleRow[]> {
    return this.db
      .selectFrom('alerts.rules')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .where('deleted_at', 'is', null)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }

  /** A rule that has not been removed. */
  rule(id: string): Promise<AlertRuleRow | undefined> {
    return this.db
      .selectFrom('alerts.rules')
      .selectAll()
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
  }

  async countRules(ownerId: string): Promise<number> {
    const r = await this.db
      .selectFrom('alerts.rules')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('owner_id', '=', ownerId)
      .where('deleted_at', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }

  create(
    trx: Transaction<Database>,
    id: string,
    ownerId: string,
    r: NewRule,
    now: number,
  ): Promise<AlertRuleRow> {
    return trx
      .insertInto('alerts.rules')
      .values({
        id,
        owner_id: ownerId,
        name: r.name,
        enabled: r.enabled,
        scope: r.scope,
        condition: r.condition,
        severity: r.severity,
        cooldown_sec: r.cooldownSec,
        channels: r.channels,
        quiet_hours: r.quietHours,
        created_at: new Date(now),
        updated_at: new Date(now),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** Applies a change made against `patch.version`; undefined when the rule has moved on since. */
  update(
    trx: Transaction<Database>,
    id: string,
    patch: UpdateAlertRuleRequest,
    now: number,
  ): Promise<AlertRuleRow | undefined> {
    return trx
      .updateTable('alerts.rules')
      .set((eb) => ({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.scope !== undefined ? { scope: patch.scope } : {}),
        ...(patch.condition !== undefined ? { condition: patch.condition } : {}),
        ...(patch.severity !== undefined ? { severity: patch.severity } : {}),
        ...(patch.cooldownSec !== undefined ? { cooldown_sec: patch.cooldownSec } : {}),
        ...(patch.channels !== undefined ? { channels: patch.channels } : {}),
        ...(patch.quietHours !== undefined ? { quiet_hours: patch.quietHours } : {}),
        version: eb('version', '+', 1),
        updated_at: new Date(now),
      }))
      .where('id', '=', id)
      .where('version', '=', patch.version)
      .where('deleted_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
  }

  /** Removes a rule: never evaluated again; its alerts stay in the inbox. */
  async remove(trx: Transaction<Database>, id: string, now: number): Promise<void> {
    await trx
      .updateTable('alerts.rules')
      .set((eb) => ({
        enabled: false,
        deleted_at: new Date(now),
        updated_at: new Date(now),
        version: eb('version', '+', 1),
      }))
      .where('id', '=', id)
      .execute();
  }

  /** Fired alerts of the user's rules, removed ones included, newest first. */
  async events(
    userId: string,
    q: { cursor?: string; limit: number; ruleId?: string },
  ): Promise<Page<AlertEvent>> {
    let query = this.db
      .selectFrom('alerts.events as e')
      .innerJoin('alerts.rules as r', 'r.id', 'e.rule_id')
      .selectAll('e')
      .select('r.name as rule_name')
      .where('r.owner_id', '=', userId);
    if (q.ruleId) query = query.where('e.rule_id', '=', q.ruleId);
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      query = query.where((eb) =>
        eb.or([eb('e.fired_at', '<', c.ts), eb.and([eb('e.fired_at', '=', c.ts), eb('e.id', '<', c.id)])]),
      );
    }
    const rows = await query
      .orderBy('e.fired_at', 'desc')
      .orderBy('e.id', 'desc')
      .limit(q.limit + 1)
      .execute();
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => eventFromRow(r, r.rule_name)),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.fired_at, last.id) : null,
    };
  }

  private inbox(userId: string) {
    return this.db
      .selectFrom('alerts.notifications as n')
      .innerJoin('alerts.events as e', 'e.id', 'n.event_id')
      .innerJoin('alerts.rules as r', 'r.id', 'e.rule_id')
      .select([
        'n.id as notification_id',
        'n.created_at as notified_at',
        'n.read_at',
        'e.id',
        'e.rule_id',
        'e.fired_at',
        'e.severity',
        'e.title',
        'e.body',
        'e.source_refs',
        'e.late',
        'r.name as rule_name',
      ])
      .where('n.user_id', '=', userId)
      .where('n.channel', '=', 'in_app');
  }

  /** The user's inbox, newest first. */
  async notifications(
    userId: string,
    q: { cursor?: string; limit: number; unread?: boolean },
  ): Promise<Page<Notification> & { unread: number }> {
    let query = this.inbox(userId);
    if (q.unread === true) query = query.where('n.read_at', 'is', null);
    if (q.unread === false) query = query.where('n.read_at', 'is not', null);
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      query = query.where((eb) =>
        eb.or([
          eb('n.created_at', '<', c.ts),
          eb.and([eb('n.created_at', '=', c.ts), eb('n.id', '<', c.id)]),
        ]),
      );
    }
    const rows = await query
      .orderBy('n.created_at', 'desc')
      .orderBy('n.id', 'desc')
      .limit(q.limit + 1)
      .execute();
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      items: page.map(toNotification),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.notified_at, last.notification_id) : null,
      unread: await this.unreadCount(userId),
    };
  }

  async unreadCount(userId: string): Promise<number> {
    const r = await this.db
      .selectFrom('alerts.notifications')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('user_id', '=', userId)
      .where('channel', '=', 'in_app')
      .where('read_at', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }

  /** The latest inbox items, for the `alerts` channel's snapshot. */
  async latest(userId: string, n: number): Promise<Notification[]> {
    const rows = await this.inbox(userId)
      .orderBy('n.created_at', 'desc')
      .orderBy('n.id', 'desc')
      .limit(n)
      .execute();
    return rows.map(toNotification);
  }

  /** Marks the user's own unread items read; returns the ones that changed. */
  async markRead(userId: string, ids: readonly string[], now: number): Promise<string[]> {
    if (!ids.length) return [];
    const rows = await this.db
      .updateTable('alerts.notifications')
      .set({ read_at: new Date(now) })
      .where('user_id', '=', userId)
      .where('channel', '=', 'in_app')
      .where('id', 'in', ids)
      .where('read_at', 'is', null)
      .returning('id')
      .execute();
    return rows.map((r) => r.id);
  }

  /** Marks everything up to `before` read; returns how many items changed. */
  async markAllRead(userId: string, before: number, now: number): Promise<number> {
    const rows = await this.db
      .updateTable('alerts.notifications')
      .set({ read_at: new Date(now) })
      .where('user_id', '=', userId)
      .where('channel', '=', 'in_app')
      .where('read_at', 'is', null)
      .where('created_at', '<=', new Date(before))
      .returning('id')
      .execute();
    return rows.length;
  }
}

function toNotification(r: {
  notification_id: string;
  notified_at: Date;
  read_at: Date | null;
  id: string;
  rule_id: string;
  fired_at: Date;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  source_refs: Record<string, unknown>;
  late: boolean;
  rule_name: string;
}): Notification {
  return {
    id: r.notification_id,
    event: eventFromRow(r, r.rule_name),
    createdAt: r.notified_at.getTime(),
    readAt: r.read_at?.getTime() ?? null,
  };
}
