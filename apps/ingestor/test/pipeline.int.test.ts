import { readFileSync } from 'node:fs';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Candle } from '@cip/domain';
import { createDb } from '@cip/db';
import { parseRecording, replayEvents } from '@cip/exchange-adapters';
import { createLogger } from '@cip/observability';
import { BinancePipeline, CoinbasePipeline, type PipelineDeps } from '../src/market/pipelines.ts';
import { BatchWriter, CandleWriter, candleStream, GapRecorder } from '../src/market/writers.ts';

const BTC = '019a6f00-0000-7000-8000-000000000001';
const PAXG = '019a6f00-0000-7000-8000-000000000004';
const PAXG_CB = '019a6f00-0000-7000-8000-000000000008';
const T = Date.UTC(2026, 10, 9, 12, 0);

const db = createDb({ connectionString: inject('dbRoleUrls').svc_ingestor, max: 4 });
const redis = new Redis(inject('redisUrl'));
const log = createLogger({ service: 'ingestor', instance: 'test', level: 'silent' });
const backfills: unknown[] = [];

function minute(i: number, close: string, extra: Partial<Candle> = {}): Candle {
  return {
    timeframe: '1m',
    openTime: T + i * 60_000,
    open: close,
    high: close,
    low: close,
    close,
    volume: '1',
    quoteVolume: close,
    tradeCount: 1,
    takerBuyVolume: '1',
    microProfile: [1],
    source: 'exchange_kline',
    quality: 'complete',
    underlyingClosed: false,
    ...extra,
  };
}

function deps(instrumentId: string, venue: 'binance' | 'coinbase', symbol: string): PipelineDeps {
  return {
    instrument: {
      id: instrumentId,
      venue,
      venueSymbol: symbol,
      base: 'X',
      quote: 'USD',
      assetClass: 'crypto',
      role: 'monitored',
      priceTick: '0.01',
      qtyStep: '0.0001',
      isPrimaryVenue: true,
      underlyingCalendarId: null,
      storeRawTrades: true,
    },
    candles: new CandleWriter(db, redis, log),
    trades: new BatchWriter(
      (rows) =>
        db
          .insertInto('market.trades')
          .values(rows)
          .onConflict((oc) => oc.doNothing())
          .execute()
          .then(() => undefined),
      log,
      'trades',
    ),
    metrics: new BatchWriter(async () => undefined, log, 'metrics'),
    snapshots: new BatchWriter(async () => undefined, log, 'snapshots'),
    gaps: new GapRecorder(db, redis, log, async (gap) => void backfills.push(gap)),
    redis,
    log,
    closed: () => false,
    profileBuckets: 24,
  };
}

beforeAll(async () => {
  await redis.flushall();
});
afterAll(async () => {
  await db.destroy();
  redis.disconnect();
});

describe('CandleWriter', () => {
  it('stores the minute and every timeframe closing at its boundary in one go, then wakes the analyzer', async () => {
    const w = new CandleWriter(db, redis, log);
    const closes = ['100', '101', '99', '102', '100.5'];
    for (let i = 0; i < 5; i++) await w.writeMinute(BTC, minute(i, closes[i]!));
    const five = await db
      .selectFrom('market.candles')
      .selectAll()
      .where('instrument_id', '=', BTC)
      .where('timeframe', '=', '5m')
      .where('open_time', '=', new Date(T))
      .executeTakeFirstOrThrow();
    expect(five).toMatchObject({
      open: '100',
      high: '102',
      low: '99',
      close: '100.5',
      volume: '5',
      source: 'aggregated',
      quality: 'complete',
    });
    const entries = await redis.xrange(candleStream(BTC), '-', '+');
    expect(entries).toHaveLength(5);
    expect(entries.at(-1)![1]).toEqual(['boundary', String(T + 5 * 60_000), 'tfs', '1m,5m']);
  });

  it('marks aggregates with missing minutes partial and never overwrites a published candle', async () => {
    const w = new CandleWriter(db, redis, log);
    await w.writeMinute(BTC, minute(59, '105'));
    const hour = await db
      .selectFrom('market.candles')
      .select(['quality', 'volume'])
      .where('instrument_id', '=', BTC)
      .where('timeframe', '=', '1h')
      .executeTakeFirstOrThrow();
    expect(hour).toEqual({ quality: 'partial', volume: '6' });
    await w.writeMinute(BTC, minute(59, '999'));
    const again = await db
      .selectFrom('market.candles')
      .select('close')
      .where('instrument_id', '=', BTC)
      .where('open_time', '=', new Date(T + 59 * 60_000))
      .where('timeframe', '=', '1m')
      .executeTakeFirstOrThrow();
    expect(again.close).toBe('105');
    expect(await w.lastClose(BTC)).toEqual({ close: '105', openTime: T + 59 * 60_000 });
  });
});

describe('BinancePipeline on recorded traffic', () => {
  it('turns the venue-closed klines into stored candles with their aggregates', async () => {
    const lines = parseRecording(
      readFileSync(
        new URL('../../../packages/exchange-adapters/fixtures/binance-klines.jsonl', import.meta.url),
        'utf8',
      ),
    );
    const pipeline = new BinancePipeline(deps(PAXG, 'binance', 'PAXGUSDT'));
    pipeline.onConnectionOpen(Date.now());
    for (const e of replayEvents(lines).events) if (e.symbol === 'PAXGUSDT') pipeline.onEvent(e);
    await expect.poll(() => pipeline.candlesWritten, { timeout: 5_000 }).toBe(1);
    const rows = await db
      .selectFrom('market.candles')
      .select(['timeframe', 'source', 'trade_count', 'micro_profile'])
      .where('instrument_id', '=', PAXG)
      .orderBy('timeframe')
      .execute();
    expect(rows.map((r) => r.timeframe).sort()).toEqual(['1m', '5m']); // 06:34 closes at 06:35: a 5m boundary
    const oneMinute = rows.find((r) => r.timeframe === '1m')!;
    expect(oneMinute.source).toBe('exchange_kline');
    expect(oneMinute.trade_count).toBe(14);
    expect(oneMinute.micro_profile).toBeNull(); // we did not see that minute's trades: unknown, not zero
  });
});

describe('gaps', () => {
  it('records a reconnect gap and queues its backfill', async () => {
    const pipeline = new CoinbasePipeline(deps(PAXG_CB, 'coinbase', 'PAXG-USD'), {
      nextOpen: Math.ceil(Date.now() / 60_000) * 60_000,
      lastClose: '4100',
    });
    pipeline.onConnectionOpen(Date.now() - 10_000);
    pipeline.onEvent({
      type: 'heartbeat',
      venue: 'coinbase',
      symbol: 'PAXG-USD',
      ts: Date.now() - 9_000,
      receivedAt: Date.now() - 9_000,
      lastTradeId: 1,
    });
    pipeline.onConnectionClosed(Date.now() - 5_000);
    pipeline.onConnectionOpen(Date.now());
    await expect.poll(() => backfills.length, { timeout: 5_000 }).toBeGreaterThan(0);
    const gap = await db
      .selectFrom('market.data_gaps')
      .selectAll()
      .where('instrument_id', '=', PAXG_CB)
      .executeTakeFirstOrThrow();
    expect(gap).toMatchObject({ stream: 'trades', detected_by: 'reconnect', status: 'open' });
    const events = await redis.xrange('md:events', '-', '+');
    expect(events.some(([, fields]) => fields[1] === 'gap.opened')).toBe(true);
  });
});

describe('missing candle close', () => {
  it('records a timer gap for a minute whose final kline is 10 s overdue, once', async () => {
    const recorded: { from: number; to: number }[] = [];
    const d = deps(BTC, 'binance', 'BTCUSDT');
    d.gaps = new GapRecorder(db, redis, log, async (gap) => void recorded.push(gap));
    const pipeline = new BinancePipeline(d);
    const t = Date.UTC(2026, 10, 10, 10, 0);
    pipeline.onConnectionOpen(t);
    pipeline.onEvent({
      type: 'kline',
      venue: 'binance',
      symbol: 'BTCUSDT',
      ts: t + 60_000,
      receivedAt: t + 60_000,
      interval: '1m',
      openTime: t,
      open: '1',
      high: '1',
      low: '1',
      close: '1',
      volume: '0',
      quoteVolume: '0',
      tradeCount: 0,
      takerBuyVolume: '0',
      final: true,
    });
    await pipeline.tick(t + 2 * 60_000 + 11_000); // 10:01 closes at 10:02; due at 10:02:12
    expect(recorded).toHaveLength(0);
    await pipeline.tick(t + 2 * 60_000 + 12_000);
    await pipeline.tick(t + 2 * 60_000 + 13_000);
    await expect
      .poll(() => recorded)
      .toEqual([expect.objectContaining({ from: t + 60_000, to: t + 2 * 60_000, stream: 'kline' })]);
  });
});

describe('live values during an outage', () => {
  it('stops refreshing the ticker and book in Redis once the connection is lost', async () => {
    const events = replayEvents(
      parseRecording(
        readFileSync(
          new URL('../../../packages/exchange-adapters/fixtures/coinbase-l2-paxg.jsonl', import.meta.url),
          'utf8',
        ),
      ),
    ).events.filter((e) => e.symbol === 'PAXG-USD');
    const pipeline = new CoinbasePipeline(deps(PAXG_CB, 'coinbase', 'PAXG-USD'), {
      nextOpen: Math.ceil(Date.now() / 60_000) * 60_000,
      lastClose: '4100',
    });
    const now = Date.now();
    pipeline.onConnectionOpen(now);
    for (const e of events) pipeline.onEvent({ ...e, receivedAt: now });
    pipeline.onEvent({
      type: 'ticker',
      venue: 'coinbase',
      symbol: 'PAXG-USD',
      ts: now,
      receivedAt: now,
      last: '4110',
      bid: '4109.9',
      ask: '4110.1',
      open24h: '4100',
      change24hPct: 0.24,
      volume24hBase: '10',
      volume24hQuote: '41100',
    });
    await pipeline.tick(now + 100);
    expect(await redis.get(`book:${PAXG_CB}`)).not.toBeNull();
    expect(await redis.get(`ticker:${PAXG_CB}`)).not.toBeNull();

    await redis.del(`book:${PAXG_CB}`, `ticker:${PAXG_CB}`);
    pipeline.onConnectionClosed(now + 1_000);
    await pipeline.tick(now + 2_000);
    expect(await redis.get(`book:${PAXG_CB}`)).toBeNull();
    expect(await redis.get(`ticker:${PAXG_CB}`)).toBeNull();
  });
});

describe('feed status on a thin Coinbase product', () => {
  it('counts heartbeats as signs of life for the trade-driven ticker channel', () => {
    const pipeline = new CoinbasePipeline(deps(PAXG_CB, 'coinbase', 'PAXG-USD'), {
      nextOpen: Math.ceil(Date.now() / 60_000) * 60_000,
      lastClose: '4100',
    });
    const now = Date.now();
    pipeline.onConnectionOpen(now - 120_000);
    pipeline.onEvent({
      type: 'heartbeat',
      venue: 'coinbase',
      symbol: 'PAXG-USD',
      ts: now - 1_000,
      receivedAt: now - 900,
      lastTradeId: 1,
    });
    const ticker = pipeline.status(now).find((s) => s.stream === 'ticker')!;
    expect(ticker).toMatchObject({ state: 'connected', detail: 'streaming' });
  });
});
