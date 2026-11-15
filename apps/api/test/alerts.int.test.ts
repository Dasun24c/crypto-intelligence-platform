import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  ALERTS_STREAM,
  type AlertRule,
  type Envelope,
  type SubscribeAck,
  WS_NAMESPACE,
  WS_PATH,
} from '@cip/contracts';
import { createDb, type Database } from '@cip/db';
import { call, createUser, type Harness, startApi, type TestUser, tokenFor } from './harness.ts';

const BTC = '019a6f00-0000-7000-8000-000000000001';
const HOUR = 3_600_000;

let h: Harness;
let owner: Kysely<Database>;
const redis = new Redis(inject('redisUrl'));
const sockets: Socket[] = [];
let alice: TestUser;
let bob: TestUser;
let admin: TestUser;
let aliceToken: string;
let bobToken: string;
let adminToken: string;

beforeAll(async () => {
  h = await startApi();
  owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 2 });
  alice = await createUser(h, 'viewer');
  bob = await createUser(h, 'analyst');
  admin = await createUser(h, 'admin');
  [aliceToken, bobToken, adminToken] = await Promise.all([
    tokenFor(h, alice),
    tokenFor(h, bob),
    tokenFor(h, admin),
  ]);
});
afterAll(async () => {
  for (const s of sockets) s.disconnect();
  redis.disconnect();
  await owner.destroy();
  await h.close();
});

const rule = (token: string, body: unknown) =>
  call<AlertRule>(h.base, 'POST', '/api/v1/alerts/rules', { token, body });
const gapRule = { name: 'Gaps', condition: { kind: 'feed_health', events: ['gap'] }, cooldownSec: 600 };

/** A fired alert in the user's inbox, as the analyzer and the jobs service would have written it. */
async function delivered(
  ruleId: string,
  userId: string,
  title: string,
  at: number,
): Promise<{ eventId: string; notificationId: string }> {
  const eventId = randomUUID();
  const notificationId = randomUUID();
  await owner
    .insertInto('alerts.events')
    .values({
      id: eventId,
      rule_id: ruleId,
      fired_at: new Date(at),
      dedupe_key: `test:${eventId}`,
      severity: 'warning',
      title,
      body: 'body',
      source_refs: { instrumentId: BTC },
    })
    .execute();
  await owner
    .insertInto('alerts.notifications')
    .values({
      id: notificationId,
      event_id: eventId,
      user_id: userId,
      channel: 'in_app',
      status: 'sent',
      created_at: new Date(at),
    })
    .execute();
  return { eventId, notificationId };
}

describe('alert rules (API contracts §3 "Alerts")', () => {
  it('creates, reads, updates and removes a user’s own rules, audited, with optimistic versions', async () => {
    const created = await rule(aliceToken, { ...gapRule, scope: { instrumentIds: [BTC] } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      ownerId: alice.id,
      name: 'Gaps',
      enabled: true,
      scope: { instrumentIds: [BTC] },
      severity: 'info',
      cooldownSec: 600,
      channels: ['in_app'],
      quietHours: null,
      version: 1,
    });
    const id = created.body.id;
    expect((await call(h.base, 'GET', `/api/v1/alerts/rules/${id}`, { token: aliceToken })).body.name).toBe(
      'Gaps',
    );
    // Another user's rule reads as not found, and cannot be changed or tested.
    for (const [method, path] of [
      ['GET', `/api/v1/alerts/rules/${id}`],
      ['DELETE', `/api/v1/alerts/rules/${id}`],
      ['POST', `/api/v1/alerts/rules/${id}/test`],
    ] as const)
      expect((await call(h.base, method, path, { token: bobToken })).status).toBe(404);
    expect((await call(h.base, 'GET', '/api/v1/alerts/rules', { token: bobToken })).body).toEqual([]);

    const updated = await call<AlertRule>(h.base, 'PATCH', `/api/v1/alerts/rules/${id}`, {
      token: aliceToken,
      body: { version: 1, enabled: false, channels: ['in_app', 'desktop'] },
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ enabled: false, channels: ['in_app', 'desktop'], version: 2 });
    const stale = await call(h.base, 'PATCH', `/api/v1/alerts/rules/${id}`, {
      token: aliceToken,
      body: { version: 1, name: 'x' },
    });
    expect(stale.status).toBe(409);

    // Admins may list another user's rules; nobody else may.
    expect(
      (await call(h.base, 'GET', `/api/v1/alerts/rules?ownerId=${alice.id}`, { token: adminToken })).body,
    ).toHaveLength(1);
    expect(
      (await call(h.base, 'GET', `/api/v1/alerts/rules?ownerId=${alice.id}`, { token: bobToken })).status,
    ).toBe(403);

    expect((await call(h.base, 'DELETE', `/api/v1/alerts/rules/${id}`, { token: aliceToken })).status).toBe(
      204,
    );
    expect((await call(h.base, 'GET', `/api/v1/alerts/rules/${id}`, { token: aliceToken })).status).toBe(404);
    expect((await call(h.base, 'GET', '/api/v1/alerts/rules', { token: aliceToken })).body).toEqual([]);
    // The row is kept (its alerts stay in the inbox), never evaluated again.
    const row = await owner
      .selectFrom('alerts.rules')
      .select(['deleted_at', 'enabled'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.deleted_at).not.toBeNull();
    expect(row.enabled).toBe(false);
    const audit = await owner
      .selectFrom('app.audit_log')
      .select('action')
      .where('target_id', '=', id)
      .orderBy('chain_seq')
      .execute();
    expect(audit.map((a) => a.action)).toEqual([
      'alert_rule.created',
      'alert_rule.updated',
      'alert_rule.deleted',
    ]);
  });

  it('refuses invalid rules with the contract’s reasons', async () => {
    const bad = await rule(aliceToken, {
      name: 'x',
      condition: { kind: 'price_cross', price: '-1', direction: 'above' },
    });
    expect(bad.status).toBe(400);
    const noInbox = await rule(aliceToken, { ...gapRule, channels: ['desktop'] });
    expect(noInbox.status).toBe(400);
  });

  it('lists what a rule would have fired over the last 24 hours, with its cooldown (criterion 8.6)', async () => {
    const created = await rule(aliceToken, { ...gapRule, scope: { instrumentIds: [BTC] } });
    const now = h.clock.now;
    const gap = (at: number) => ({
      id: randomUUID(),
      instrument_id: BTC,
      stream: 'trades' as const,
      gap_start: new Date(at - 60_000),
      gap_end: null,
      detected_at: new Date(at),
      detected_by: 'sequence' as const,
      status: 'repaired' as const,
    });
    // Within 10 minutes of the first: dropped by the cooldown. 25 hours ago: outside the window.
    const gaps = [
      gap(now - 3 * HOUR),
      gap(now - 3 * HOUR + 5 * 60_000),
      gap(now - HOUR),
      gap(now - 25 * HOUR),
    ];
    await owner.insertInto('market.data_gaps').values(gaps).execute();
    const test = await call(h.base, 'POST', `/api/v1/alerts/rules/${created.body.id}/test?hours=24`, {
      token: aliceToken,
    });
    expect(test.status).toBe(200);
    expect(test.body).toMatchObject({ ruleId: created.body.id, evaluated: 3, suppressed: 1 });
    expect(test.body.wouldHaveFired.map((m: { dedupeKey: string }) => m.dedupeKey)).toEqual([
      `feed:gap:${gaps[0]!.id}`,
      `feed:gap:${gaps[2]!.id}`,
    ]);
    expect(test.body.wouldHaveFired[0].title).toMatch(/feed data gap$/);
  });
});

describe('the inbox', () => {
  it('lists the user’s alerts with the unread count, marks them read and tells the user’s other devices', async () => {
    const created = await rule(bobToken, gapRule);
    const now = h.clock.now;
    const first = await delivered(created.body.id, bob.id, 'first', now - 2_000);
    const second = await delivered(created.body.id, bob.id, 'second', now - 1_000);
    const page = await call(h.base, 'GET', '/api/v1/notifications?limit=1', { token: bobToken });
    expect(page.body.unread).toBe(2);
    expect(page.body.items.map((n: { event: { title: string } }) => n.event.title)).toEqual(['second']);
    expect(page.body.items[0].event).toMatchObject({ ruleName: 'Gaps', instrumentId: BTC, late: false });
    const older = await call(h.base, 'GET', `/api/v1/notifications?limit=1&cursor=${page.body.nextCursor}`, {
      token: bobToken,
    });
    expect(older.body.items[0].id).toBe(first.notificationId);
    // Alice sees none of Bob's.
    expect((await call(h.base, 'GET', '/api/v1/notifications', { token: aliceToken })).body.items).toEqual(
      [],
    );
    expect(
      (
        await call(h.base, 'POST', `/api/v1/notifications/${second.notificationId}/read`, {
          token: aliceToken,
        })
      ).status,
    ).toBe(204);
    expect(
      (await call(h.base, 'GET', '/api/v1/notifications?unread=true', { token: bobToken })).body.unread,
    ).toBe(2);

    const latest = (await redis.xrevrange(ALERTS_STREAM, '+', '-', 'COUNT', 1))[0]?.[0] ?? '0-0';
    expect(
      (await call(h.base, 'POST', `/api/v1/notifications/${second.notificationId}/read`, { token: bobToken }))
        .status,
    ).toBe(204);
    expect(
      (await call(h.base, 'GET', '/api/v1/notifications?unread=true', { token: bobToken })).body.items.map(
        (n: { id: string }) => n.id,
      ),
    ).toEqual([first.notificationId]);
    const read = await redis.xrange(ALERTS_STREAM, `(${latest}`, '+');
    expect(read.map(([, f]) => [f[1], f[3], JSON.parse(f[5]!) as unknown])).toEqual([
      ['notification.read', bob.id, { ids: [second.notificationId] }],
    ]);
    const all = await call(h.base, 'POST', '/api/v1/notifications/read-all', { token: bobToken, body: {} });
    expect(all.body).toEqual({ read: 1 });
    expect((await call(h.base, 'GET', '/api/v1/notifications', { token: bobToken })).body.unread).toBe(0);
    const events = await call(h.base, 'GET', '/api/v1/alerts/events', { token: bobToken });
    expect(events.body.items.map((e: { id: string }) => e.id)).toEqual([second.eventId, first.eventId]);
  });
});

describe('the alerts channel', () => {
  function connect(token: string): Socket {
    const socket = io(h.base + WS_NAMESPACE, {
      path: WS_PATH,
      transports: ['websocket'],
      auth: { token },
      reconnection: false,
    });
    sockets.push(socket);
    return socket;
  }
  const connected = (socket: Socket) =>
    new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
  const subscribe = (socket: Socket, since?: string) =>
    socket.emitWithAck(
      'subscribe',
      since ? { channels: ['alerts'], since: { alerts: since } } : { channels: ['alerts'] },
    ) as Promise<SubscribeAck>;
  const fire = (userId: string, title: string) =>
    redis.xadd(ALERTS_STREAM, '*', 'type', 'alert.fired', 'user', userId, 'data', JSON.stringify({ title }));
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 50));
  };

  it('delivers each user only their own alerts, live and after a reconnect', async () => {
    const a = connect(aliceToken);
    const b = connect(bobToken);
    await Promise.all([connected(a), connected(b)]);
    const got: Record<string, Envelope[]> = { a: [], b: [] };
    a.on('message', (m: Envelope) => got['a']!.push(m));
    b.on('message', (m: Envelope) => got['b']!.push(m));
    const [ackA] = await Promise.all([subscribe(a), subscribe(b)]);
    expect(ackA.results['alerts']).toMatchObject({ mode: 'live' });

    await fire(alice.id, 'for alice');
    await until(() => got['a']!.length === 1);
    expect(got['a']!.map((m) => [m.ch, m.type, (m.data as { title: string }).title])).toEqual([
      ['alerts', 'alert.fired', 'for alice'],
    ]);
    expect(got['b']).toEqual([]);
    const seen = got['a']![0]!.seq!;

    // Offline: one for Alice and one for Bob. Back again, Alice gets hers replayed, not Bob's.
    a.disconnect();
    await fire(alice.id, 'while away');
    await fire(bob.id, 'for bob');
    await until(() => got['b']!.length === 1);
    const again = connect(aliceToken);
    await connected(again);
    const replayed: Envelope[] = [];
    again.on('message', (m: Envelope) => replayed.push(m));
    const ack = await subscribe(again, seen);
    expect(ack.results['alerts']).toMatchObject({ mode: 'replayed' });
    expect(replayed.map((m) => (m.data as { title: string }).title)).toEqual(['while away']);

    // Too old to replay: the unread count and the latest inbox items instead.
    const s = connect(aliceToken);
    await connected(s);
    const result = await subscribe(s, '0-1');
    expect(result.results['alerts']).toMatchObject({ mode: 'snapshot', snapshot: { unread: 0, latest: [] } });
  });
});
