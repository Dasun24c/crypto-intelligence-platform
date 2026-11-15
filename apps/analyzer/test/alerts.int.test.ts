import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { AlertCondition, IndicatorPoint, SetupTransitionMessage } from '@cip/contracts';
import { createDb } from '@cip/db';
import { createLogger } from '@cip/observability';
import { AlertService, type DeliveryQueue, MARKET_CURSOR_KEY } from '../src/alerts/alert-service.ts';

const BTC = '019a6f00-0000-7000-8000-000000000001';
const ETH = '019a6f00-0000-7000-8000-000000000002';
const MIN = 60_000;

const owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 2 });
const db = createDb({ connectionString: inject('dbRoleUrls').svc_analyzer, max: 4 });
const redis = new Redis(inject('redisUrl'));
const log = createLogger({ service: 'analyzer', instance: 'test', level: 'error' });
const userId = randomUUID();

let clock = Date.now();
let jobs: { name: string; data: { eventId: string }; jobId: string }[] = [];
const queue: DeliveryQueue = {
  add: (name, data, opts) => {
    jobs.push({ name, data, jobId: opts.jobId });
    return Promise.resolve();
  },
};
let service: AlertService;

beforeAll(async () => {
  await owner
    .insertInto('app.users')
    .values({
      id: userId,
      email: `${userId}@cip.test`,
      display_name: 'Alerts',
      role: 'viewer',
      password_hash: 'x',
    })
    .execute();
});
afterAll(async () => {
  await service?.stop();
  redis.disconnect();
  await db.destroy();
  await owner.destroy();
});

/** A fresh service per test (memory, lease and cursor start over); only these rules are enabled. */
beforeEach(async () => {
  await service?.stop();
  await owner.updateTable('alerts.rules').set({ enabled: false }).execute();
  await redis.del('lease:analyzer:alerts', MARKET_CURSOR_KEY);
  jobs = [];
  clock = Date.now();
});

async function addRule(
  condition: AlertCondition,
  opts: { cooldownSec?: number; instrumentIds?: string[] } = {},
) {
  const id = randomUUID();
  await owner
    .insertInto('alerts.rules')
    .values({
      id,
      owner_id: userId,
      name: condition.kind,
      scope: opts.instrumentIds ? { instrumentIds: opts.instrumentIds } : {},
      condition,
      severity: 'warning',
      cooldown_sec: opts.cooldownSec ?? 0,
    })
    .execute();
  return id;
}

async function start(held: string[] = [BTC]) {
  service = new AlertService({
    db,
    redis,
    queue,
    log,
    instance: `test-${randomUUID().slice(0, 8)}`,
    held: () => held,
    now: () => clock,
    tickMs: 3_600_000, // ticks are driven by the test
  });
  await service.start();
  await service.tick(); // takes the alerts lease, positions the md:events cursor
}

/** The next tick, 5 s later (rules, lease and the 5 s clock run then too). */
async function tick(ms = 5_000) {
  clock += ms;
  await service.tick();
  await service.idle();
}

const fired = (ruleId: string) =>
  owner
    .selectFrom('alerts.events')
    .select(['id', 'dedupe_key', 'title', 'late', 'severity'])
    .where('rule_id', '=', ruleId)
    .orderBy('fired_at')
    .execute();

const md = (type: string, data: Record<string, unknown>) =>
  redis.xadd('md:events', '*', 'type', type, 'data', JSON.stringify(data));

describe('alert evaluation in the analyzer (ADR 020)', () => {
  it('reads the price once a second from the ticker of instruments held here, and fires on the crossing', async () => {
    const rule = await addRule(
      { kind: 'price_cross', price: '100000', direction: 'above' },
      { instrumentIds: [BTC] },
    );
    await start();
    const ticker = (ts: number, last: string) =>
      redis.set(
        `ticker:${BTC}`,
        JSON.stringify({
          instrumentId: BTC,
          ts,
          last,
          bid: last,
          ask: last,
          change24hPct: 0,
          volume24hQuote: '0',
        }),
      );
    await ticker(clock, '99999.5');
    await tick(1_000);
    await ticker(clock + 1, '100000.5');
    await tick(1_000);
    const events = await fired(rule);
    expect(events.map((e) => [e.dedupe_key, e.late])).toEqual([
      [`price_cross:${BTC}:above:100000:${clock - 999}`, false],
    ]);
    expect(events[0]!.title).toBe('BTC · Binance BTC/USDT crossed above 100000');
    // Handed to the jobs service, with a job id from the event (a retry cannot deliver it twice).
    expect(jobs).toEqual([
      { name: 'deliver', data: { eventId: events[0]!.id }, jobId: `alert-${events[0]!.id}` },
    ]);
  });

  it('reads md:events once: halts, gaps, large trades and walls; entries processed over 120 s late are labelled late', async () => {
    const halted = await addRule({ kind: 'feed_health', events: ['halted', 'gap'] });
    const trades = await addRule({ kind: 'large_trade', minUsd: '1000000' });
    const walls = await addRule({ kind: 'wall', events: ['appeared'] });
    await start();
    const tradeId = randomUUID();
    const wallId = randomUUID();
    const gapId = randomUUID();
    await md('feed.status', {
      instrumentId: ETH,
      stream: 'trades',
      state: 'disconnected',
      previous: 'trading',
      detail: 'halted',
    });
    await md('gap.opened', {
      gapId,
      instrumentId: BTC,
      stream: 'trades',
      from: clock - MIN,
      to: null,
      detectedBy: 'sequence',
    });
    await md('trade.large', {
      id: tradeId,
      instrumentId: BTC,
      ts: clock,
      takerSide: 'buy',
      avgPrice: '98000',
      qty: '20',
      notionalUsd: '1960000',
      grouping: 'single',
      fillCount: 1,
      priceLevels: 1,
      thresholdUsd: '500000',
    });
    await md('trade.large', {
      id: randomUUID(),
      instrumentId: BTC,
      ts: clock,
      takerSide: 'sell',
      avgPrice: '98000',
      qty: '1',
      notionalUsd: '98000',
      grouping: 'single',
      fillCount: 1,
      priceLevels: 1,
      thresholdUsd: '50000',
    });
    await md('wall.appeared', {
      id: wallId,
      instrumentId: ETH,
      side: 'bid',
      price: '3000',
      firstSeen: clock,
      lastSeen: clock,
      maxNotionalUsd: '2500000',
      endedReason: null,
    });
    // Read three minutes later (a restart): late.
    await tick(3 * MIN);
    expect((await fired(halted)).map((e) => [e.title, e.late])).toEqual([
      ['ETH · Binance ETH/USDT: feed halted', true],
      ['BTC · Binance BTC/USDT: feed data gap', true],
    ]);
    expect((await fired(trades)).map((e) => e.dedupe_key)).toEqual([`large_trade:${tradeId}`]);
    expect((await fired(walls)).map((e) => e.dedupe_key)).toEqual([`wall:${wallId}:appeared`]);
    expect(await redis.get(MARKET_CURSOR_KEY)).toBe(
      (await redis.xrevrange('md:events', '+', '-', 'COUNT', 1))[0]![0],
    );
    // Read again (a new holder): the cursor stops anything from firing twice.
    jobs = [];
    await service.stop();
    await start();
    await tick();
    expect(jobs).toEqual([]);
  });

  it('lets exactly one of 100 identical triggers inside the cooldown through (criterion 8.3)', async () => {
    const rule = await addRule({ kind: 'feed_health', events: ['halted'] }, { cooldownSec: 300 });
    await start();
    for (let i = 0; i < 100; i++)
      await md('feed.status', {
        instrumentId: BTC,
        stream: 'trades',
        state: 'disconnected',
        previous: 'trading',
        detail: 'halted',
      });
    await tick(1_000);
    expect(await fired(rule)).toHaveLength(1);
    expect(jobs).toHaveLength(1);
    // The cooldown lives in Redis: a second instance, or a restart, honours it too.
    await service.stop();
    await start();
    await md('feed.status', {
      instrumentId: BTC,
      stream: 'trades',
      state: 'disconnected',
      previous: 'trading',
      detail: 'halted',
    });
    await tick(1_000);
    expect(await fired(rule)).toHaveLength(1);
  });

  it('evaluates the stored PAXG spread, upcoming releases and gold-market closures on its 5 s clock', async () => {
    const spread = await addRule({ kind: 'spread_threshold', baseAsset: 'PAXG', absBps: 30 });
    const releases = await addRule({ kind: 'economic_event_upcoming', minImpact: 'high', minutesBefore: 30 });
    const gold = await addRule({ kind: 'gold_market_session', on: ['close'] });
    await start();
    const releaseId = randomUUID();
    await owner
      .insertInto('market.economic_events')
      .values({
        id: releaseId,
        source: 'manual',
        source_ref: `test:${releaseId}`,
        release: 'cpi',
        title: 'CPI (test)',
        category: 'inflation',
        impact: 'high',
        scheduled_at: new Date(clock + 10 * MIN),
        time_confirmed: true,
      })
      .execute();
    await owner
      .insertInto('market.cross_venue_spreads')
      .values({
        base_asset: 'PAXG',
        ts: new Date(clock - 1_000),
        primary_instrument_id: '019a6f00-0000-7000-8000-000000000004',
        secondary_instrument_id: '019a6f00-0000-7000-8000-000000000008',
        primary_usd: '2650',
        secondary_usd: '2665',
        usdt_usd: '1',
        spread_bps: 56.6,
      })
      .execute();
    service.reloadCalendars();
    await tick();
    expect((await fired(spread)).map((e) => e.title)).toEqual(['PAXG spread 56.6 bps']);
    expect((await fired(releases)).map((e) => e.title)).toEqual(['CPI (test) in 10 min']);
    // The gold market closes: a manual closure from now on.
    const closesAt = clock + 1_000;
    await owner
      .insertInto('market.underlying_market_closures')
      .values({
        calendar_id: 'gold',
        starts_at: new Date(closesAt),
        ends_at: new Date(closesAt + 3_600_000),
        reason: 'holiday',
        source: 'manual',
      })
      .execute();
    service.reloadCalendars();
    await tick();
    expect((await fired(gold)).map((e) => [e.dedupe_key, e.title])).toEqual([
      [`gold_session:close:${closesAt}`, 'Gold market closed'],
    ]);
    await tick();
    expect(await fired(releases)).toHaveLength(1); // the same release fires once
  });

  it('evaluates what an actor published: indicators, structure breaks and setups, late when caught up', async () => {
    const rsi = await addRule({
      kind: 'indicator_threshold',
      tf: '1h',
      indicator: 'rsi',
      op: '>',
      value: 70,
    });
    const mss = await addRule({ kind: 'smc_event', tfs: ['1h'], events: ['mss'] });
    const confirmed = await addRule({ kind: 'setup_transition', toStates: ['confirmed'], minScore: 60 });
    await start();
    const hour = Math.floor(clock / 3_600_000) * 3_600_000 - 3_600_000;
    const structureId = randomUUID();
    const setupId = randomUUID();
    const decided = hour + 3_600_000;
    service.published(
      BTC,
      [
        {
          kind: 'indicators',
          tf: '1h',
          point: { t: hour, rsi: 74.2, macdHist: 1, volumeZ: 0.4, atr: 120 } as IndicatorPoint,
        },
        {
          kind: 'smc',
          message: {
            instrumentId: BTC,
            runId: randomUUID(),
            seq: 1,
            tf: '1h',
            time: decided,
            type: 'structure',
            data: {
              id: structureId,
              tf: '1h',
              level: 'external',
              type: 'mss',
              direction: 'bearish',
              brokenSwingId: null,
              breakPrice: '97500',
              breakCandleTime: hour,
              isInitial: false,
              displacement: null,
              flags: [],
            },
          },
        },
        {
          kind: 'setup',
          message: {
            id: setupId,
            instrumentId: BTC,
            pattern: 'htf_order_block',
            direction: 'bearish',
            setupTf: '15m',
            score: 72.5,
            transition: {
              from: 'triggered',
              to: 'confirmed',
              reason: 'mss',
              candleTime: hour,
              decidedAt: decided,
              processedAt: decided + 10 * MIN,
              late: true,
              evidence: {},
            },
          } as unknown as SetupTransitionMessage,
        },
      ],
      decided + 500,
    );
    await service.idle();
    expect((await fired(rsi)).map((e) => [e.title, e.late])).toEqual([
      ['BTC · Binance BTC/USDT 1h: RSI above 70', false],
    ]);
    expect((await fired(mss)).map((e) => [e.dedupe_key, e.title])).toEqual([
      [`smc:mss:${structureId}`, 'BTC · Binance BTC/USDT 1h: bearish MSS'],
    ]);
    // Decided ten minutes before it was processed (catch-up): labelled late (criterion 8.5).
    expect((await fired(confirmed)).map((e) => [e.dedupe_key, e.late])).toEqual([
      [`setup:${setupId}:confirmed`, true],
    ]);
  });
});
