import { readFileSync } from 'node:fs';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Envelope } from '@cip/contracts';
import { createDb } from '@cip/db';
import { parseRecording, replayEvents } from '@cip/exchange-adapters';
import { createLogger } from '@cip/observability';
import { Detections } from '../src/market/detections.ts';
import { LivePublisher } from '../src/market/live.ts';
import {
  BinancePipeline,
  CoinbasePipeline,
  type InstrumentPipeline,
  type PipelineDeps,
} from '../src/market/pipelines.ts';
import { SpreadMonitor, spreadLegs } from '../src/market/spread.ts';
import { BatchWriter, CandleWriter, GapRecorder } from '../src/market/writers.ts';

const PAXG_BN = '019a6f00-0000-7000-8000-000000000004';
const PAXG_CB = '019a6f00-0000-7000-8000-000000000008';
const USDT = '019a6f00-0000-7000-8000-000000000009';
const T0 = 1794300000000; // the known-answer fixture's 08:40:00 UTC

const db = createDb({ connectionString: inject('dbRoleUrls').svc_ingestor, max: 4 });
const owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 2 });
const redis = new Redis(inject('redisUrl'));
const subscriber = new Redis(inject('redisUrl'));
const log = createLogger({ service: 'ingestor', instance: 'test', level: 'silent' });
const live = new LivePublisher(redis, log);
const received: Envelope[] = [];

const fixture = (name: string) =>
  replayEvents(
    parseRecording(
      readFileSync(new URL(`../../../packages/exchange-adapters/fixtures/${name}`, import.meta.url), 'utf8'),
    ),
  ).events;

function deps(
  instrumentId: string,
  venue: 'binance' | 'coinbase',
  symbol: string,
  base: string,
): PipelineDeps {
  return {
    instrument: {
      id: instrumentId,
      venue,
      venueSymbol: symbol,
      base,
      quote: venue === 'binance' ? 'USDT' : 'USD',
      assetClass: 'tokenised_gold',
      role: 'monitored',
      priceTick: '0.01',
      qtyStep: '0.00001',
      isPrimaryVenue: venue === 'binance',
      underlyingCalendarId: null,
      storeRawTrades: false,
    },
    candles: new CandleWriter(db, redis, log),
    trades: new BatchWriter(async () => undefined, log, 'trades'),
    metrics: new BatchWriter(async () => undefined, log, 'metrics'),
    snapshots: new BatchWriter(async () => undefined, log, 'snapshots'),
    gaps: new GapRecorder(db, redis, log, async () => undefined),
    redis,
    log,
    closed: () => false,
    profileBuckets: 24,
    live,
    detections: new Detections(db, redis, log),
    usdPerQuote: () => '1',
  };
}

beforeAll(async () => {
  await redis.flushall();
  await subscriber.psubscribe('live:*');
  subscriber.on('pmessage', (_p: string, _c: string, message: string) => {
    received.push(JSON.parse(message) as Envelope);
  });
});
afterAll(async () => {
  subscriber.disconnect();
  await db.destroy();
  await owner.destroy();
  redis.disconnect();
});

describe('exchange-flow detection in the pipeline', () => {
  it('stores and announces the known-answer large trade and walls, in order', async () => {
    const pipeline = new CoinbasePipeline(deps(PAXG_CB, 'coinbase', 'PAXG-USD', 'PAXG'), {
      nextOpen: T0 + 60_000,
      lastClose: null,
    });
    pipeline.largeTrades!.start();
    pipeline.onConnectionOpen(T0);
    let nextTick = T0 + 20_000;
    for (const e of fixture('exchange-flow-known.jsonl').filter((e) => e.symbol === 'PAXG-USD')) {
      for (; nextTick <= e.receivedAt; nextTick += 1_000) await pipeline.tick(nextTick);
      pipeline.onEvent(e);
    }
    for (; nextTick <= T0 + 27_000; nextTick += 1_000) await pipeline.tick(nextTick);

    await expect
      .poll(
        async () =>
          (
            await owner
              .selectFrom('market.orderbook_walls')
              .select('id')
              .where('ended_reason', 'is not', null)
              .execute()
          ).length,
      )
      .toBe(2);
    const walls = await owner
      .selectFrom('market.orderbook_walls')
      .select(['side', 'price', 'ended_reason', 'max_notional_usd', 'first_seen', 'last_seen'])
      .where('instrument_id', '=', PAXG_CB)
      .orderBy('side')
      .execute();
    expect(walls.map((w) => [w.side, w.price, w.ended_reason, w.max_notional_usd])).toEqual([
      ['ask', '4102', 'pulled', '123060'],
      ['bid', '4099.5', 'filled', '163980'],
    ]);
    expect(walls[1]!.first_seen.getTime()).toBe(T0 + 20_000);
    expect(walls[1]!.last_seen.getTime()).toBe(T0 + 24_000);

    const trades = await owner.selectFrom('market.large_trades').selectAll().execute();
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      instrument_id: PAXG_CB,
      taker_side: 'sell',
      qty: '42.5',
      notional_usd: '174230.5',
      grouping: 'taker_order',
      fill_count: 4,
      price_levels: 4,
      threshold_usd: '50000',
    });

    const types = (await redis.xrange('md:events', '-', '+')).map(([, f]) => f[1]);
    // The order is complete once 1 s passes with no further fill, so it follows the bid wall's end.
    expect(types).toEqual(['wall.appeared', 'wall.appeared', 'wall.ended', 'wall.ended', 'trade.large']);
    const ended = (await redis.xrange('md:events', '-', '+')).at(-2)![1];
    expect(JSON.parse(ended[3]!)).toMatchObject({
      instrumentId: PAXG_CB,
      endedReason: 'filled',
      price: '4099.5',
    });

    // Book updates go out by themselves, throttled to 10 Hz: the latest one shows the final book.
    await expect
      .poll(() => (received.findLast((m) => m.type === 'book.snapshot')?.data as { bids?: unknown })?.bids)
      .toEqual([
        ['4099.5', '2'],
        ['4099', '1'],
      ]);
    const book = received.findLast((m) => m.type === 'book.snapshot')!;
    expect(book.ch).toBe(`book:${PAXG_CB}`);
    expect(book.data).toMatchObject({
      instrumentId: PAXG_CB,
      bids: [
        ['4099.5', '2'],
        ['4099', '1'],
      ],
    });
  });

  it('publishes candle.closed for the minute and every timeframe closing with it', async () => {
    const pipeline = new BinancePipeline(deps(PAXG_BN, 'binance', 'PAXGUSDT', 'PAXG'));
    pipeline.onConnectionOpen(Date.now());
    for (const e of fixture('binance-klines.jsonl')) if (e.symbol === 'PAXGUSDT') pipeline.onEvent(e);
    await expect.poll(() => pipeline.candlesWritten).toBe(1);
    await expect
      .poll(() => received.filter((m) => m.type === 'candle.closed').map((m) => m.ch))
      .toEqual([`candles:${PAXG_BN}:1m`, `candles:${PAXG_BN}:5m`]);
    const minute = received.find((m) => m.ch === `candles:${PAXG_BN}:1m`)!.data;
    expect(minute).toMatchObject({ n: 14, quality: 'complete', underlyingClosed: false });
  });
});

describe('cross-venue spread', () => {
  it('converts at USDT-USD, publishes on both PAXG market channels and stores every 10 s', async () => {
    const leg = (
      id: string,
      venue: 'binance' | 'coinbase',
      base: string,
      quote: string,
      mid: number | null,
    ) =>
      ({
        instrument: { id, venue, base, quote, isPrimaryVenue: venue === 'binance' },
        mid: () => mid,
      }) as unknown as InstrumentPipeline;
    const pipelines = [
      leg(PAXG_BN, 'binance', 'PAXG', 'USDT', 4100),
      leg(PAXG_CB, 'coinbase', 'PAXG', 'USD', 4100),
      leg(USDT, 'coinbase', 'USDT', 'USD', 0.9995),
    ];
    const monitor = new SpreadMonitor('PAXG', db, live, log);
    const legs = spreadLegs('PAXG', pipelines);
    expect(legs?.usdt?.instrument.id).toBe(USDT);
    monitor.tick(T0 + 1_000, legs);
    monitor.tick(T0 + 2_000, legs); // same 10 s slot: published, not stored again
    expect(monitor.latest).toMatchObject({ primaryUsd: '4097.95', usdtUsd: '0.9995', spreadBps: 5.0025 });
    await expect.poll(() => monitor.stored).toBe(1);
    const rows = await owner.selectFrom('market.cross_venue_spreads').selectAll().execute();
    expect(rows).toEqual([
      expect.objectContaining({ base_asset: 'PAXG', primary_usd: '4097.95', ts: new Date(T0) }),
    ]);
    await expect
      .poll(() => received.filter((m) => m.type === 'spread').map((m) => m.ch))
      .toEqual([`market:${PAXG_BN}`, `market:${PAXG_CB}`, `market:${PAXG_BN}`, `market:${PAXG_CB}`]);

    // A stale leg produces nothing rather than a misleading number.
    monitor.tick(
      T0 + 20_000,
      spreadLegs('PAXG', [pipelines[0]!, leg(PAXG_CB, 'coinbase', 'PAXG', 'USD', null), pipelines[2]!]),
    );
    expect(monitor.latest).toBeNull();
    expect(spreadLegs('PAXG', [pipelines[0]!, pipelines[1]!])).toBeNull(); // USDT pair without USDT-USD
  });
});
