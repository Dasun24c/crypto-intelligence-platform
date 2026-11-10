import { Redis } from 'ioredis';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { createDb } from '@cip/db';
import type { RestCandle } from '@cip/exchange-adapters';
import { createLogger } from '@cip/observability';
import { checkConsistency, previousDay } from '../src/consistency.ts';

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

async function store(instrumentId: string, i: number, close: string, volume: string, flat = false) {
  await owner
    .insertInto('market.candles')
    .values({
      instrument_id: instrumentId,
      timeframe: '1m',
      open_time: new Date(T + i * 60_000),
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

  it('checks the previous UTC day by default', () => {
    expect(previousDay(Date.UTC(2026, 10, 10, 0, 20))).toEqual({
      from: Date.UTC(2026, 10, 9),
      to: Date.UTC(2026, 10, 10),
    });
  });
});
