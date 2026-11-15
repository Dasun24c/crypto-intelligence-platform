import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { ALERTS_STREAM, type AlertFiredMessage } from '@cip/contracts';
import { createDb } from '@cip/db';
import { deliverAlert, PUSHES_PER_MINUTE } from '../src/notifications.ts';

const owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 2 });
const db = createDb({ connectionString: inject('dbRoleUrls').svc_jobs, max: 2 });
const redis = new Redis(inject('redisUrl'));
const userId = randomUUID();
// 12 November 2026, 10:00 UTC: 15:30 in Colombo.
const NOW = Date.UTC(2026, 10, 12, 10, 0);

beforeAll(async () => {
  await owner
    .insertInto('app.users')
    .values({
      id: userId,
      email: `${userId}@cip.test`,
      display_name: 'x',
      role: 'viewer',
      password_hash: 'x',
    })
    .execute();
});
afterAll(async () => {
  redis.disconnect();
  await db.destroy();
  await owner.destroy();
});

async function ruleWith(channels: string[], quietHours: Record<string, unknown> | null = null) {
  const id = randomUUID();
  await owner
    .insertInto('alerts.rules')
    .values({
      id,
      owner_id: userId,
      name: 'Halts',
      condition: { kind: 'feed_health', events: ['halted'] },
      severity: 'critical',
      channels,
      quiet_hours: quietHours,
    })
    .execute();
  return id;
}

async function firedEvent(ruleId: string) {
  const id = randomUUID();
  await owner
    .insertInto('alerts.events')
    .values({
      id,
      rule_id: ruleId,
      fired_at: new Date(NOW - 1_000),
      dedupe_key: `test:${id}`,
      severity: 'critical',
      title: 'Feed halted',
      body: 'detail',
      source_refs: { instrumentId: '019a6f00-0000-7000-8000-000000000001' },
      late: true,
    })
    .execute();
  return id;
}

async function lastMessage(): Promise<{ user: string; message: AlertFiredMessage }> {
  const [, fields] = (await redis.xrevrange(ALERTS_STREAM, '+', '-', 'COUNT', 1))[0]!;
  return { user: fields[3]!, message: JSON.parse(fields[5]!) as AlertFiredMessage };
}

describe('alert delivery (the notifications queue, ADR 020)', () => {
  it('puts the alert in the owner’s inbox, records each chosen channel, and pushes it on their channel', async () => {
    const eventId = await firedEvent(await ruleWith(['in_app', 'desktop', 'web']));
    const result = await deliverAlert({ db, redis, now: () => NOW }, eventId);
    const rows = await owner
      .selectFrom('alerts.notifications')
      .select(['id', 'channel', 'status', 'user_id', 'read_at'])
      .where('event_id', '=', eventId)
      .orderBy('channel')
      .execute();
    expect(rows.map((r) => [r.channel, r.status, r.user_id, r.read_at])).toEqual([
      ['desktop', 'sent', userId, null],
      ['in_app', 'sent', userId, null],
      ['web', 'sent', userId, null],
    ]);
    const inbox = rows.find((r) => r.channel === 'in_app')!;
    expect(result).toEqual({ notificationId: inbox.id, quiet: false });
    const { user, message } = await lastMessage();
    expect(user).toBe(userId);
    expect(message).toMatchObject({
      channels: ['desktop', 'web'],
      quiet: false,
      notification: {
        id: inbox.id,
        readAt: null,
        event: { id: eventId, title: 'Feed halted', late: true, ruleName: 'Halts' },
      },
    });
    // A retry writes nothing twice.
    expect(await deliverAlert({ db, redis, now: () => NOW }, eventId)).toMatchObject({
      notificationId: inbox.id,
    });
    expect(
      await owner.selectFrom('alerts.notifications').select('id').where('event_id', '=', eventId).execute(),
    ).toHaveLength(3);
  });

  it('delivers quietly inside the rule’s quiet hours, and beyond 20 native notifications a minute', async () => {
    // 15:30 in Colombo is inside 15:00–16:00 there.
    const quiet = await ruleWith(['in_app', 'desktop'], {
      start: '15:00',
      end: '16:00',
      timeZone: 'Asia/Colombo',
    });
    expect(
      await deliverAlert({ db, redis, now: () => NOW + 60_000 * 7 }, await firedEvent(quiet)),
    ).toMatchObject({ quiet: true });
    expect((await lastMessage()).message.quiet).toBe(true);

    const loud = await ruleWith(['in_app', 'desktop']);
    const minute = NOW + 60_000 * 30;
    const results: boolean[] = [];
    for (let i = 0; i < PUSHES_PER_MINUTE + 2; i++)
      results.push((await deliverAlert({ db, redis, now: () => minute }, await firedEvent(loud)))!.quiet);
    expect(results.filter((q) => !q)).toHaveLength(PUSHES_PER_MINUTE);
    expect(results.slice(-2)).toEqual([true, true]);
  });

  it('skips an event that does not exist', async () => {
    expect(await deliverAlert({ db, redis }, randomUUID())).toBeNull();
  });
});
