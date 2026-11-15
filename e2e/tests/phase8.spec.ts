/// <reference lib="dom" />
import { Redis } from 'ioredis';
import { type APIRequestContext, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { LIVE_ONLY, REPLAY_STACK } from '../support/stack.ts';
import { accessToken, adminAccessToken, signIn } from '../support/session.ts';
import { VIEWER } from '../support/users.ts';

/**
 * Phase 8 (alerts and notifications), criteria 8.1, 8.3, 8.4 and 8.6, against a running stack.
 *
 * - Market-driven conditions wait for the live (or replayed) market to produce their event.
 * - Feed health, large trades and walls are injected into `md:events` (Valkey on the host), on a
 *   reference instrument nobody trades: they go through the real analyzer, jobs and API.
 * - A calendar entry and a gold closure are made through the admin API.
 */
const REDIS_URL = process.env.E2E_REDIS_URL ?? 'redis://127.0.0.1:16379';
const RUN = Date.now().toString(36);

interface Instrument {
  id: string;
  displayName: string;
  role: string;
  priceTick: string;
}
interface AlertEvent {
  id: string;
  ruleId: string;
  firedAt: number;
  title: string;
  late: boolean;
  sourceRefs: Record<string, unknown>;
}
interface Notification {
  id: string;
  event: AlertEvent;
  readAt: number | null;
}

test.describe('Phase 8', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(REPLAY_STACK, LIVE_ONLY);
  test.setTimeout(20 * 60_000);

  let ctx: BrowserContext;
  let page: Page;
  let api: APIRequestContext;
  let headers: Record<string, string>;
  let admin: Record<string, string>;
  let signedInAt = 0;
  let redis: Redis;
  const rules: { id: string; kind: string; createdAt: number }[] = [];
  const cleanup: (() => Promise<unknown>)[] = [];

  test.beforeAll(async ({ browser, playwright }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL;
    api = await playwright.request.newContext({ baseURL });
    await fresh(true);
    ctx = await browser.newContext({ baseURL });
    page = await ctx.newPage();
    await signIn(page, VIEWER);
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
  });

  test.afterAll(async () => {
    // This run's rules are removed (their alerts stay in the inbox), and its admin entries too.
    await fresh();
    for (const r of rules) await api.delete(`/api/v1/alerts/rules/${r.id}`, { headers });
    for (const undo of cleanup) await undo().catch(() => undefined);
    await api?.dispose();
    await ctx?.close();
    redis?.disconnect();
  });

  /**
   * Access tokens last 15 minutes and this file runs longer: both are renewed once 12 minutes old.
   * (`headers` and `admin` are read when each call is made.)
   */
  async function fresh(force = false) {
    if (!force && Date.now() - signedInAt < 12 * 60_000) return;
    headers = await accessToken(api, VIEWER);
    admin = await adminAccessToken(api);
    signedInAt = Date.now();
  }

  async function rule(kind: string, condition: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    await fresh();
    const res = await api.post('/api/v1/alerts/rules', {
      headers,
      data: {
        name: `e2e ${kind} ${RUN}`,
        condition: { kind, ...condition },
        channels: ['in_app', 'web'],
        ...extra,
      },
    });
    expect(res.status(), await res.text()).toBe(201);
    const body = (await res.json()) as { id: string; createdAt: number };
    rules.push({ id: body.id, kind, createdAt: body.createdAt });
    return body.id;
  }
  async function fired(ruleId: string): Promise<AlertEvent[]> {
    await fresh();
    const res = await api.get(`/api/v1/alerts/events?ruleId=${ruleId}&limit=200`, { headers });
    expect(res.ok(), await res.text()).toBe(true);
    return ((await res.json()) as { items: AlertEvent[] }).items;
  }
  async function inbox(): Promise<Notification[]> {
    await fresh();
    const res = await api.get('/api/v1/notifications?limit=1000', { headers });
    expect(res.ok(), await res.text()).toBe(true);
    return ((await res.json()) as { items: Notification[] }).items;
  }
  const inject = (type: string, data: Record<string, unknown>) =>
    redis.xadd('md:events', 'MAXLEN', '~', '200000', '*', 'type', type, 'data', JSON.stringify(data));
  /** The open app received the push: the inbox item is listed on the Alert Center page. */
  const shown = (notificationId: string) =>
    expect(page.locator(`[data-notification-id="${notificationId}"]`).first()).toBeAttached({
      timeout: 30_000,
    });

  test('8.1 every condition type: from its source event to the inbox and the open app', async () => {
    const instruments = (await (await api.get('/api/v1/instruments', { headers })).json()) as Instrument[];
    // Prices: the first instrument with a live ticker; injected events: a reference instrument.
    let priced: { instrument: Instrument; last: string } | undefined;
    for (const i of instruments) {
      const t = await api.get(`/api/v1/market/${i.id}/ticker`, { headers });
      if (t.ok()) {
        priced = { instrument: i, last: ((await t.json()) as { last: string }).last };
        break;
      }
    }
    expect(priced, 'an instrument with a live ticker').toBeDefined();
    const ref = instruments.find((i) => i.role === 'reference') ?? instruments.at(-1)!;
    const half = Number(priced!.instrument.priceTick) / 2;
    const dp = (priced!.instrument.priceTick.split('.')[1]?.length ?? 0) + 1;

    await page.goto('/alerts');
    await expect(page.getByRole('heading', { name: 'Alert Center', level: 1 })).toBeVisible();

    // One rule per kind, each set to fire on the next event of its kind.
    const ids: Record<string, string[]> = {
      price_cross: [
        await rule(
          'price_cross',
          { price: (Number(priced!.last) + half).toFixed(dp), direction: 'above' },
          { scope: { instrumentIds: [priced!.instrument.id] } },
        ),
        await rule(
          'price_cross',
          { price: (Number(priced!.last) - half).toFixed(dp), direction: 'below' },
          { scope: { instrumentIds: [priced!.instrument.id] } },
        ),
      ],
      price_change_pct: [await rule('price_change_pct', { windowMin: 1, pct: 0.0001 })],
      indicator_threshold: [
        await rule(
          'indicator_threshold',
          { tf: '1m', indicator: 'rsi', op: '>', value: 0 },
          { scope: { instrumentIds: [priced!.instrument.id] }, cooldownSec: 0 },
        ),
      ],
      volume_anomaly: [await rule('volume_anomaly', { tf: '1m', minZ: 0.01 })],
      smc_event: [
        await rule('smc_event', {
          tfs: ['5m', '15m', '1h', '4h', '1d'],
          events: ['sweep', 'false_breakout', 'bos', 'choch', 'mss', 'poi_entry'],
        }),
      ],
      setup_transition: [
        await rule('setup_transition', {
          toStates: ['forming', 'triggered', 'confirmed', 'entry_active', 'resolved'],
        }),
      ],
      spread_threshold: [await rule('spread_threshold', { baseAsset: 'PAXG', absBps: 0.01 })],
      economic_event_upcoming: [
        await rule('economic_event_upcoming', { minImpact: 'high', minutesBefore: 30 }),
      ],
      gold_market_session: [await rule('gold_market_session', { on: ['close'] })],
      large_trade: [await rule('large_trade', {}, { scope: { instrumentIds: [ref.id] } })],
      wall: [await rule('wall', { events: ['appeared'] }, { scope: { instrumentIds: [ref.id] } })],
      feed_health: [
        await rule('feed_health', { events: ['halted'] }, { scope: { instrumentIds: [ref.id] } }),
      ],
    };
    expect(Object.keys(ids)).toHaveLength(12);

    // The admin's sources: a release in 10 minutes, a gold closure starting in 90 s.
    const now = Date.now();
    const release = await api.post('/api/v1/calendar/events', {
      headers: admin,
      data: {
        title: `e2e release ${RUN}`,
        category: 'other',
        impact: 'high',
        scheduledAt: now + 10 * 60_000,
        timeConfirmed: true,
      },
    });
    expect(release.status(), await release.text()).toBe(201);
    const releaseId = ((await release.json()) as { id: string }).id;
    cleanup.push(() => api.delete(`/api/v1/calendar/events/${releaseId}`, { headers: admin }));
    const closesAt = Math.ceil((now + 90_000) / 1000) * 1000;
    const closure = await api.post('/api/v1/admin/closures', {
      headers: admin,
      data: { from: closesAt, to: closesAt + 120_000 },
    });
    expect(closure.status(), await closure.text()).toBe(201);
    cleanup.push(() => api.delete(`/api/v1/admin/closures?from=${closesAt}`, { headers: admin }));

    // The analyzer re-reads rules within 5 s; then the injected events.
    await page.waitForTimeout(7_000);
    await inject('feed.status', {
      instrumentId: ref.id,
      stream: 'trades',
      state: 'disconnected',
      previous: 'trading',
      detail: 'halted',
    });
    await inject('trade.large', {
      id: crypto.randomUUID(),
      instrumentId: ref.id,
      ts: Date.now(),
      takerSide: 'buy',
      avgPrice: '1',
      qty: '5000000',
      notionalUsd: '5000000',
      grouping: 'single',
      fillCount: 1,
      priceLevels: 1,
      thresholdUsd: '1000000',
    });
    await inject('wall.appeared', {
      id: crypto.randomUUID(),
      instrumentId: ref.id,
      side: 'bid',
      price: '0.9999',
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      maxNotionalUsd: '3000000',
      endedReason: null,
    });

    // A trending price can leave the crossing thresholds behind before the analyzer reads the rules
    // (within 5 s): until one fires, they are set again around the latest price every 30 s.
    let armedAt = Date.now();
    const rearm = async () => {
      await fresh();
      const t = await api.get(`/api/v1/market/${priced!.instrument.id}/ticker`, { headers });
      if (!t.ok()) return;
      const last = Number(((await t.json()) as { last: string }).last);
      for (const [id, direction, price] of [
        [ids['price_cross']![0]!, 'above', last + half],
        [ids['price_cross']![1]!, 'below', last - half],
      ] as const) {
        const { version } = (await (await api.get(`/api/v1/alerts/rules/${id}`, { headers })).json()) as {
          version: number;
        };
        await api.patch(`/api/v1/alerts/rules/${id}`, {
          headers,
          data: { version, condition: { kind: 'price_cross', price: price.toFixed(dp), direction } },
        });
      }
      armedAt = Date.now();
    };

    // Each kind: its first alert, in the inbox and pushed to the open page.
    const pending = new Set(Object.keys(ids));
    // The gold market's own calendar: when it is already closed before our closure starts (a weekend
    // or the daily break), there is no closing to see, so the gold kind can't be checked in this run.
    // The analyzer's integration test checks it at a fixed weekday.
    const goldCalendar = (await (
      await api.get('/api/v1/market/closures?calendar=gold', { headers })
    ).json()) as { from: number; to: number }[];
    if (goldCalendar.some((c) => c.from < closesAt && c.to > now)) {
      pending.delete('gold_market_session');
      test.info().annotations.push({
        type: 'gold_market_session',
        description: 'not checked: the gold market was already closed, so no closing could be seen',
      });
    }
    const started = Date.now();
    await expect
      .poll(
        async () => {
          if (pending.has('price_cross') && Date.now() - armedAt > 30_000) await rearm();
          for (const kind of [...pending]) {
            const events = (await Promise.all(ids[kind]!.map(fired))).flat();
            if (!events.length) continue;
            const first = events.sort((a, b) => a.firedAt - b.firedAt)[0]!;
            const item = (await inbox()).find((n) => n.event.id === first.id);
            if (!item) continue;
            await shown(item.id);
            pending.delete(kind);
            test.info().annotations.push({
              type: kind,
              description: `fired ${Math.round((first.firedAt - started) / 1000)} s after the rules were active: ${first.title}`,
            });
          }
          return [...pending].sort().join(', ') || 'all delivered';
        },
        { message: 'every kind fired and was delivered', timeout: 15 * 60_000, intervals: [5_000] },
      )
      .toBe('all delivered');
  });

  test('8.3 100 identical triggers inside the cooldown produce exactly one notification', async () => {
    const instruments = (await (await api.get('/api/v1/instruments', { headers })).json()) as Instrument[];
    const ref = instruments.find((i) => i.role === 'reference') ?? instruments.at(-1)!;
    const id = await rule(
      'feed_health',
      { events: ['delisted'] },
      { scope: { instrumentIds: [ref.id] }, cooldownSec: 600 },
    );
    await page.waitForTimeout(7_000);
    for (let i = 0; i < 100; i++)
      await inject('feed.status', {
        instrumentId: ref.id,
        stream: 'trades',
        state: 'disconnected',
        previous: 'trading',
        detail: 'delisted',
      });
    await expect.poll(async () => (await fired(id)).length, { timeout: 60_000 }).toBe(1);
    // Some seconds more: still one, and one inbox item.
    await page.waitForTimeout(10_000);
    const events = await fired(id);
    expect(events).toHaveLength(1);
    expect((await inbox()).filter((n) => n.event.ruleId === id)).toHaveLength(1);
  });

  test('8.4 alerts fired while the app is away are in its inbox when it comes back', async () => {
    const instruments = (await (await api.get('/api/v1/instruments', { headers })).json()) as Instrument[];
    const ref = instruments.find((i) => i.role === 'reference') ?? instruments.at(-1)!;
    const id = await rule(
      'feed_health',
      { events: ['gap'] },
      { scope: { instrumentIds: [ref.id] }, cooldownSec: 0 },
    );
    await page.waitForTimeout(7_000);
    await page.goto('about:blank'); // the app is closed
    for (let i = 0; i < 3; i++)
      await inject('gap.opened', {
        gapId: crypto.randomUUID(),
        instrumentId: ref.id,
        stream: 'trades',
        from: Date.now() - 60_000,
        to: null,
        detectedBy: 'sequence',
      });
    await expect.poll(async () => (await fired(id)).length, { timeout: 60_000 }).toBe(3);
    await page.goto('/alerts');
    const missed = (await inbox()).filter((n) => n.event.ruleId === id);
    expect(missed).toHaveLength(3);
    for (const n of missed) await shown(n.id);
  });

  test('8.6 the rule test lists exactly what the live rule fired', async () => {
    const indicator = rules.find((r) => r.kind === 'indicator_threshold')!;
    // Enough live minutes to compare: six since the rule was created.
    await page.waitForTimeout(Math.max(0, indicator.createdAt + 6 * 60_000 - Date.now()));
    const now = Date.now();
    // From a minute after the rule was created (the analyzer read it within 5 s) to two minutes ago.
    const from = indicator.createdAt + 60_000;
    const to = now - 120_000;
    expect(to, 'the rule has been live for a few minutes').toBeGreaterThan(from + 120_000);
    const live = (await fired(indicator.id))
      .filter((e) => e.firedAt >= from && e.firedAt <= to)
      .map((e) => `${String(e.sourceRefs['instrumentId'])}@${String(e.sourceRefs['candleTime'])}`)
      .sort();
    const test8 = (await (
      await api.post(`/api/v1/alerts/rules/${indicator.id}/test?hours=1`, { headers })
    ).json()) as {
      wouldHaveFired: { at: number; sourceRefs: Record<string, unknown> }[];
    };
    const dry = test8.wouldHaveFired
      .filter((m) => m.at >= from && m.at <= to)
      .map((m) => `${String(m.sourceRefs['instrumentId'])}@${String(m.sourceRefs['candleTime'])}`)
      .sort();
    expect(live.length).toBeGreaterThan(0);
    expect(dry).toEqual(live);
    test.info().annotations.push({
      type: 'dry run',
      description: `${live.length} live alerts = ${dry.length} listed by the rule test`,
    });
  });
});
