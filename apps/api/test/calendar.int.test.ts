import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  CALENDAR_SYNC_JOB,
  type CalendarStatus,
  CONFIG_CHANNELS,
  type EconomicEvent,
  type Envelope,
  type SubscribeAck,
  WS_NAMESPACE,
  WS_PATH,
} from '@cip/contracts';
import { calendarKnownFrom, createDb, LAUNCH_PROFILE_IDS } from '@cip/db';
import { call, createUser, type Harness, startApi, type TestUser, tokenFor } from './harness.ts';

/** API contracts §3 "Calendar" and §5.3 `calendar` (Phase 7). */
const owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 2 });
const redis = new Redis(inject('redisUrl'));
const sockets: Socket[] = [];
const DAY = 86_400_000;

let h: Harness;
let viewer: string;
let admin: string;
let adminUser: TestUser;
let now: number;
const ids = {
  cpi: '019a7000-0000-7000-8000-0000000ca001',
  gdpBea: '019a7000-0000-7000-8000-0000000ca002',
  gdpFred: '019a7000-0000-7000-8000-0000000ca003',
  cancelled: '019a7000-0000-7000-8000-0000000ca004',
  far: '019a7000-0000-7000-8000-0000000ca005',
};

beforeAll(async () => {
  h = await startApi();
  now = h.clock.now;
  viewer = await tokenFor(h, await createUser(h, 'viewer'));
  adminUser = await createUser(h, 'admin');
  admin = await tokenFor(h, adminUser);
  const row = (
    id: string,
    source: 'fred' | 'bea' | 'manual',
    ref: string,
    extra: Record<string, unknown>,
  ) => ({
    id,
    source,
    source_ref: ref,
    release: null,
    title: ref,
    category: 'other' as const,
    impact: 'medium' as const,
    scheduled_at: new Date(now + DAY),
    time_confirmed: false,
    actual: null,
    forecast: null,
    previous: null,
    created_by: null,
    ...extra,
  });
  await owner
    .insertInto('market.economic_events')
    .values([
      row(ids.cpi, 'fred', '10:test', {
        release: 'cpi',
        title: 'Consumer Price Index (CPI)',
        category: 'inflation',
        impact: 'high',
        scheduled_at: new Date(now + 2 * DAY),
      }),
      row(ids.gdpBea, 'bea', 'bea-test-gdp', {
        release: 'gdp',
        title: 'GDP (Second Estimate)',
        category: 'growth',
        time_confirmed: true,
      }),
      row(ids.gdpFred, 'fred', '53:test', { release: 'gdp', status: 'superseded' }),
      row(ids.cancelled, 'manual', 'manual:test', { status: 'cancelled' }),
      row(ids.far, 'fred', '50:test', {
        release: 'employment_situation',
        scheduled_at: new Date(now + 90 * DAY),
      }),
    ])
    .execute();
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await h.close();
  await owner.destroy();
  redis.disconnect();
});

const get = <T>(path: string, token = viewer) => call<T>(h.base, 'GET', `/api/v1${path}`, { token });

describe('calendar events', () => {
  it('lists the scheduled events of the window (by default the last day and the next 60), by impact', async () => {
    const all = await get<EconomicEvent[]>('/calendar/events');
    expect(all.status).toBe(200);
    expect(all.body.map((e) => e.id)).toEqual([ids.gdpBea, ids.cpi]);
    expect(all.body[1]).toMatchObject({
      source: 'fred',
      sourceRef: '10:test',
      release: 'cpi',
      impact: 'high',
      category: 'inflation',
      currency: 'USD',
      country: 'US',
      scheduledAt: now + 2 * DAY,
      timeConfirmed: false,
    });
    const high = await get<EconomicEvent[]>('/calendar/events?minImpact=high');
    expect(high.body.map((e) => e.id)).toEqual([ids.cpi]);
    const later = await get<EconomicEvent[]>(`/calendar/events?from=${now + 80 * DAY}&to=${now + 100 * DAY}`);
    expect(later.body.map((e) => e.id)).toEqual([ids.far]);
    expect((await get(`/calendar/events?from=${now}&to=${now + 401 * DAY}`)).status).toBe(400);
    expect((await get(`/calendar/events?from=${now}&to=${now - 1}`)).status).toBe(400);
  });

  it('is unavailable to checklist item 8 until FRED first synced, then reports each source and the blackouts', async () => {
    const before = await get<CalendarStatus>('/calendar/status');
    expect(before.body).toMatchObject({ available: false, availableFrom: null, status: 'down' });
    expect(before.body.detail).toMatch(/calendar_unavailable/);
    expect(before.body.blackouts).toEqual([
      expect.objectContaining({ profile: 'crypto-majors', beforeMin: 30, afterMin: 30, currencies: ['USD'] }),
      expect.objectContaining({ profile: 'gold', beforeMin: 60, afterMin: 60, currencies: ['USD'] }),
    ]);
    expect(before.body.blackouts.flatMap((b) => b.instrumentIds)).toHaveLength(9);
    expect(LAUNCH_PROFILE_IDS).toBeDefined();

    const finished = new Date(now - 10 * 60_000);
    await owner
      .insertInto('market.calendar_syncs')
      .values([
        {
          id: '019a7000-0000-7000-8000-0000000cb001',
          source: 'fred',
          started_at: finished,
          finished_at: finished,
          status: 'ok',
          inserted: 8,
        },
        {
          id: '019a7000-0000-7000-8000-0000000cb002',
          source: 'bea',
          started_at: finished,
          finished_at: finished,
          status: 'ok',
          inserted: 20,
        },
      ])
      .execute();
    const after = await get<CalendarStatus>('/calendar/status');
    expect(after.body).toMatchObject({
      available: true,
      availableFrom: calendarKnownFrom(finished.getTime()),
      status: 'ok',
      detail: 'FRED and BEA synced',
    });
    expect(after.body.sources).toEqual([
      expect.objectContaining({ source: 'fred', configured: true, lastSuccessAt: finished.getTime() }),
      expect.objectContaining({ source: 'bea', configured: true, lastSuccessAt: finished.getTime() }),
    ]);
    const health = await get<{ calendar: unknown }>('/system/health');
    expect(health.body.calendar).toEqual({ status: 'ok', available: true, detail: 'FRED and BEA synced' });

    // A FRED sync without a key: still available (the data stays), but degraded.
    const later = new Date(now - 60_000);
    await owner
      .insertInto('market.calendar_syncs')
      .values({
        id: '019a7000-0000-7000-8000-0000000cb003',
        source: 'fred',
        started_at: later,
        finished_at: later,
        status: 'skipped',
        error: 'not configured',
      })
      .execute();
    const skipped = await get<CalendarStatus>('/calendar/status');
    expect(skipped.body).toMatchObject({
      available: true,
      status: 'degraded',
      detail: 'FRED: no API key configured',
    });
    expect(skipped.body.sources[0]).toMatchObject({ source: 'fred', configured: false });
  });

  it('lets an admin enter, correct and cancel an FOMC statement: audited, each change a revision', async () => {
    const at = now + 27 * DAY;
    const create = await call<EconomicEvent>(h.base, 'POST', '/api/v1/calendar/events', {
      token: admin,
      body: {
        release: 'fomc',
        title: 'FOMC statement',
        category: 'central_bank',
        impact: 'high',
        scheduledAt: at,
        timeConfirmed: true,
      },
    });
    expect(create.status).toBe(201);
    const id = create.body.id;
    expect(create.body).toMatchObject({
      source: 'manual',
      sourceRef: `manual:${id}`,
      currency: 'USD',
      impact: 'high',
    });

    const patch = await call<EconomicEvent>(h.base, 'PATCH', `/api/v1/calendar/events/${id}`, {
      token: admin,
      body: { scheduledAt: at + 30 * 60_000 },
    });
    expect(patch.status).toBe(200);
    expect(patch.body.scheduledAt).toBe(at + 30 * 60_000);
    expect((await call(h.base, 'DELETE', `/api/v1/calendar/events/${id}`, { token: admin })).status).toBe(
      204,
    );
    expect((await get<EconomicEvent[]>('/calendar/events')).body.some((e) => e.id === id)).toBe(false);

    const revisions = await owner
      .selectFrom('market.economic_event_revisions')
      .select(['revision', 'scheduled_at', 'status'])
      .where('event_id', '=', id)
      .orderBy('revision')
      .execute();
    expect(revisions.map((r) => [r.revision, r.scheduled_at.getTime(), r.status])).toEqual([
      [1, at, 'scheduled'],
      [2, at + 30 * 60_000, 'scheduled'],
      [3, at + 30 * 60_000, 'cancelled'],
    ]);
    const audit = await owner
      .selectFrom('app.audit_log')
      .select(['action', 'actor_user_id'])
      .where('target_id', '=', id)
      .orderBy('chain_seq')
      .execute();
    expect(audit).toEqual([
      { action: 'calendar_event.created', actor_user_id: adminUser.id },
      { action: 'calendar_event.updated', actor_user_id: adminUser.id },
      { action: 'calendar_event.cancelled', actor_user_id: adminUser.id },
    ]);
  });

  it('refuses to edit synced entries, unknown or cancelled ones, and bad values', async () => {
    const edit = (id: string, body: unknown) =>
      call(h.base, 'PATCH', `/api/v1/calendar/events/${id}`, { token: admin, body });
    expect((await edit(ids.cpi, { impact: 'low' })).status).toBe(409);
    expect((await edit(ids.cancelled, { impact: 'low' })).status).toBe(404);
    expect(
      (await call(h.base, 'DELETE', `/api/v1/calendar/events/${ids.gdpBea}`, { token: admin })).status,
    ).toBe(409);
    const bad = await call(h.base, 'POST', '/api/v1/calendar/events', {
      token: admin,
      body: {
        title: 'x',
        category: 'central_bank',
        impact: 'extreme',
        scheduledAt: now,
        timeConfirmed: true,
      },
    });
    expect(bad.status).toBe(400);
  });

  it('queues a sync on the jobs service queue', async () => {
    const res = await call(h.base, 'POST', '/api/v1/calendar/sync', { token: admin });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true });
    const connection = new Redis(inject('redisUrl'), { maxRetriesPerRequest: null });
    const queue = new Queue('maintenance', { connection, prefix: h.config.QUEUE_PREFIX });
    const job = await queue.getJob('calendar-sync-requested');
    expect(job?.name).toBe(CALENDAR_SYNC_JOB);
    await job?.remove();
    await queue.close();
    connection.disconnect();
  });
});

describe('calendar channel', () => {
  it('tells subscribers when the calendar changes, from a sync or an admin', async () => {
    const socket = io(h.base + WS_NAMESPACE, {
      path: WS_PATH,
      transports: ['websocket'],
      auth: { token: viewer },
      reconnection: false,
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    const messages: Envelope[] = [];
    socket.on('message', (m: Envelope) => messages.push(m));
    const ack = (await socket.emitWithAck('subscribe', { channels: ['calendar'] })) as SubscribeAck;
    // The snapshot is the latest change (here the admin's cancellation above).
    expect(ack.results['calendar']).toMatchObject({
      mode: 'snapshot',
      snapshot: { at: expect.any(Number), reason: 'manual', changed: 1 },
    });

    await redis.publish(CONFIG_CHANNELS.calendar, JSON.stringify({ at: now, reason: 'sync', changed: 3 }));
    await call(h.base, 'POST', '/api/v1/calendar/events', {
      token: admin,
      body: {
        title: 'Fed chair testimony',
        category: 'central_bank',
        impact: 'medium',
        scheduledAt: now + 5 * DAY,
        timeConfirmed: false,
      },
    });
    await expect.poll(() => messages.length).toBe(2);
    expect(messages.map((m) => [m.ch, m.type, (m.data as { reason: string }).reason])).toEqual([
      ['calendar', 'calendar.updated', 'sync'],
      ['calendar', 'calendar.updated', 'manual'],
    ]);
    // Malformed announcements are ignored.
    await redis.publish(CONFIG_CHANNELS.calendar, 'not json');
    await new Promise((r) => setTimeout(r, 200));
    expect(messages).toHaveLength(2);
  });
});
