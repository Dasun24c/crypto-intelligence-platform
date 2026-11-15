import { Redis } from 'ioredis';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { createDb } from '@cip/db';
import type { RestCandle } from '@cip/exchange-adapters';
import { createLogger } from '@cip/observability';
import { checkConsistency, previousDay } from '../src/consistency.ts';
import { gapRepairer, sweepHoles } from '../src/gap-repairs.ts';

const BTC_BN = '019a6f00-0000-7000-8000-000000000001';
const BTC_CB = '019a6f00-0000-7000-8000-000000000005';
const T = Date.UTC(2026, 10, 3, 10, 0);

const owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 2 });
const jobsDb = createDb({ connectionString: inject('dbRoleUrls').svc_jobs, max: 2 });
const redis = new Redis(inject('redisUrl'));
const log = createLogger({ service: 'jobs', instance: 'test', level: 'silent' });

afterAll(async () => {
  await owner.destroy();
  await jobsDb.destroy();
  redis.disconnect();
});

const venueCandle = (i: number, close: string, volume = '1'): RestCandle => ({
  openTime: T + i * 60_000,
  open: '100',
  high: '101',
  low: '99',
  close,
  volume,
  quoteVolume: '100',
  tradeCount: 7,
});

async function store(instrumentId: string, i: number, close: string, volume: string, flat = false, base = T) {
  await owner
    .insertInto('market.candles')
    .values({
      instrument_id: instrumentId,
      timeframe: '1m',
      open_time: new Date(base + i * 60_000),
      open: flat ? close : '100',
      high: flat ? close : '101',
      low: flat ? close : '99',
      close,
      volume,
      quote_volume: '100',
      trade_count: 7,
      taker_buy_volume: null,
      micro_profile: null,
      source: 'exchange_kline',
      quality: 'complete',
      underlying_closed: false,
      finalized_at: new Date(),
    })
    .execute();
}

describe('nightly consistency check', () => {
  it('reports exact matches, mismatched fields, missing minutes and Coinbase minutes that are not flat', async () => {
    await store(BTC_BN, 0, '100.5', '1');
    await store(BTC_BN, 1, '100.6', '1'); // the venue says 100.7
    // Binance minute 2 was never stored.
    await store(BTC_CB, 0, '100.5', '1');
    await store(BTC_CB, 1, '100.5', '0', true); // no trades: flat, as Coinbase omits the minute
    await store(BTC_CB, 2, '100.5', '1'); // stored with volume although the venue had no trades

    const binance = {
      klines: async (symbol: string, interval: string) =>
        symbol === 'BTCUSDT' && interval === '1m'
          ? [venueCandle(0, '100.5'), venueCandle(1, '100.7'), venueCandle(2, '100.9')]
          : [],
    };
    const coinbase = {
      candles: async (product: string, granularity: number) =>
        product === 'BTC-USD' && granularity === 60
          ? [{ ...venueCandle(0, '100.5'), quoteVolume: undefined, tradeCount: undefined } as RestCandle]
          : [],
    };
    const report = await checkConsistency(
      { db: jobsDb, redis, log, venues: { binance, coinbase } },
      { from: T, to: T + 3 * 60_000 },
    );
    expect(report.ok).toBe(false);
    const result = (venue: string, tf: string) =>
      report.results.find((r) => r.symbol === venue && r.timeframe === tf)!;
    expect(result('BTCUSDT', '1m')).toMatchObject({ compared: 3, matched: 1, differences: 2 });
    expect(result('BTCUSDT', '1m').samples).toEqual([
      { t: T + 60_000, kind: 'mismatch', fields: { close: { stored: '100.6', venue: '100.7' } } },
      { t: T + 120_000, kind: 'missing' },
    ]);
    expect(result('BTC-USD', '1m')).toMatchObject({ compared: 3, matched: 2, differences: 1 });
    expect(result('BTC-USD', '1m').samples[0]).toMatchObject({ t: T + 120_000, kind: 'not_flat' });
    expect(result('ETHUSDT', '1h')).toMatchObject({ compared: 0, differences: 0 });

    // Evidence is kept: one feed event per failing series, and the report in Redis.
    const events = await owner
      .selectFrom('market.feed_events')
      .select(['instrument_id', 'details'])
      .where('event', '=', 'error')
      .execute();
    expect(events.map((e) => e.instrument_id).sort()).toEqual([BTC_BN, BTC_CB]);
    expect(JSON.parse((await redis.get('consistency:report:2026-11-03'))!).ok).toBe(false);
  });

  it('records each run of minutes missing from our own history as a gap, and queues its repair once', async () => {
    // A thin product: the venue has no candles at all, so only our own history shows the hole.
    const USDT_CB = '019a6f00-0000-7000-8000-000000000009';
    const T2 = Date.UTC(2026, 10, 4, 10, 0);
    for (const i of [0, 1, 4, 5]) await store(USDT_CB, i, '1', '0', true, T2);
    const queued: { name: string; data: unknown; opts: unknown }[] = [];
    const queue = {
      add: (name: string, data: unknown, opts: unknown) => {
        queued.push({ name, data, opts });
        return Promise.resolve();
      },
    } as unknown as Parameters<typeof gapRepairer>[2];
    const deps = {
      db: jobsDb,
      redis,
      log,
      venues: { binance: { klines: async () => [] }, coinbase: { candles: async () => [] } },
      repair: gapRepairer(jobsDb, redis, queue, () => T2 + 86_400_000),
    };
    const range = { from: T2, to: T2 + 10 * 60_000 };
    const hole = { instrumentId: USDT_CB, symbol: 'USDT-USD', from: T2 + 120_000, to: T2 + 240_000 };

    const report = await checkConsistency(deps, range);
    expect(report.ok).toBe(false);
    // Minutes before the first stored candle or after the last are not holes.
    expect(report.holes).toEqual([{ ...hole, repairQueued: true }]);
    const gap = await owner
      .selectFrom('market.data_gaps')
      .selectAll()
      .where('instrument_id', '=', USDT_CB)
      .where('detected_by', '=', 'consistency_check')
      .executeTakeFirstOrThrow();
    expect(gap).toMatchObject({
      stream: 'kline',
      status: 'open',
      details: { reason: 'missing candles', minutes: 2 },
    });
    expect([gap.gap_start.getTime(), gap.gap_end?.getTime()]).toEqual([hole.from, hole.to]);
    expect(queued).toEqual([
      {
        name: 'gap',
        data: { id: gap.id, instrumentId: USDT_CB, stream: 'kline', from: hole.from, to: hole.to },
        opts: expect.objectContaining({ jobId: `backfill:${USDT_CB}:${gap.id}`, delay: 0, attempts: 8 }),
      },
    ]);
    const [, fields] = (await redis.xrevrange('md:events', '+', '-', 'COUNT', 1))[0]!;
    expect(fields[1]).toBe('gap.opened');
    expect(JSON.parse(fields[3]!)).toMatchObject({
      gapId: gap.id,
      instrumentId: USDT_CB,
      detectedBy: 'consistency_check',
    });

    // Checked again while that gap is open: still reported, but not recorded or queued twice.
    const again = await checkConsistency(deps, range);
    expect(again.holes).toEqual([{ ...hole, repairQueued: false }]);
    expect(queued).toHaveLength(1);
  });

  it('checks a day that has not ended only up to the last settled minute', async () => {
    const T3 = Date.UTC(2026, 10, 5);
    const ends: number[] = [];
    const report = await checkConsistency(
      {
        db: jobsDb,
        log,
        now: () => T3 + 5 * 60_000 + 40_000, // 00:05:40; minute 00:05 has not settled
        venues: {
          binance: {
            klines: async (_s: string, _i: string, _start: number, end: number) => (ends.push(end), []),
          },
          coinbase: {
            candles: async (_p: string, _g: number, _start: number, end: number) => (ends.push(end), []),
          },
        },
      },
      { from: T3, to: T3 + 86_400_000 },
    );
    expect(report.to).toBe(T3 + 5 * 60_000);
    expect(ends.length).toBeGreaterThan(0);
    expect(Math.max(...ends)).toBeLessThanOrEqual(T3 + 5 * 60_000);
  });

  it('sweeps the last 24 hours for holes and queues each repair once', async () => {
    const ETH_CB = '019a6f00-0000-7000-8000-000000000006';
    const T4 = Date.UTC(2026, 10, 6, 10, 0);
    for (const i of [0, 1, 2, 6, 7]) await store(ETH_CB, i, '3000', '1', false, T4);
    const queued: { data: { instrumentId: string; from: number; to: number } }[] = [];
    const queue = {
      add: (_name: string, data: { instrumentId: string; from: number; to: number }) => {
        queued.push({ data });
        return Promise.resolve();
      },
    } as unknown as Parameters<typeof gapRepairer>[2];
    const repair = gapRepairer(jobsDb, redis, queue, () => T4 + 86_400_000);
    expect(await sweepHoles(jobsDb, repair, T4 + 60 * 60_000)).toBeGreaterThanOrEqual(1);
    const mine = queued.filter((q) => q.data.instrumentId === ETH_CB);
    expect(mine.map((q) => [q.data.from, q.data.to])).toEqual([[T4 + 3 * 60_000, T4 + 6 * 60_000]]);
    // The next sweep finds the gap it recorded still open: nothing new.
    await sweepHoles(jobsDb, repair, T4 + 70 * 60_000);
    expect(queued.filter((q) => q.data.instrumentId === ETH_CB)).toHaveLength(1);
  });

  it('checks the previous UTC day by default', () => {
    expect(previousDay(Date.UTC(2026, 10, 10, 0, 20))).toEqual({
      from: Date.UTC(2026, 10, 9),
      to: Date.UTC(2026, 10, 10),
    });
  });
});
