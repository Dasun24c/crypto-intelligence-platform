import { readFileSync } from 'node:fs';
import { metrics } from '@opentelemetry/api';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { BookSnapshot, Envelope, FeedStatus, Ticker } from '@cip/contracts';
import { createDb, seedReplayInstruments } from '@cip/db';
import { parseRecording } from '@cip/exchange-adapters';
import { createLogger } from '@cip/observability';
import { MarketIngestor } from '../src/market/ingestor.ts';

const REPLAY_BTC = '019a6f00-0000-7000-8000-000000000101';
const REPLAY_PAXG_CB = '019a6f00-0000-7000-8000-000000000104';

const owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 2 });
const db = createDb({ connectionString: inject('dbRoleUrls').svc_ingestor, max: 4 });
const redis = new Redis(inject('redisUrl'));
const subscriber = new Redis(inject('redisUrl'));
const received: Envelope[] = [];
const recording = (name: string) =>
  parseRecording(
    readFileSync(new URL(`../../../packages/exchange-adapters/fixtures/${name}`, import.meta.url), 'utf8'),
  );

let ingestor: MarketIngestor;

beforeAll(async () => {
  await redis.flushall();
  await seedReplayInstruments(owner);
  await subscriber.psubscribe('live:*');
  subscriber.on('pmessage', (_p: string, _c: string, m: string) => received.push(JSON.parse(m) as Envelope));
  ingestor = new MarketIngestor({
    db,
    redis,
    redisUrl: inject('redisUrl'),
    log: createLogger({ service: 'ingestor', instance: 'test', level: 'silent' }),
    meter: metrics.getMeter('test'),
    instance: 'replay-test',
    queuePrefix: 'test',
    profileBuckets: 24,
    backfillDays: 1,
    source: {
      kind: 'replay',
      recordings: ['binance-ws.jsonl', 'coinbase-l2-paxg.jsonl', 'coinbase-ws.jsonl'].map(recording),
      periodMs: 6_000,
    },
  });
  await ingestor.start();
});
afterAll(async () => {
  await ingestor.stop();
  subscriber.disconnect();
  redis.disconnect();
  await db.destroy();
  await owner.destroy();
});

describe('the ingestor on the replay venue', () => {
  it('streams replay instruments end to end: books, tickers, trades, live channels and feed status', async () => {
    // The Binance-format book syncs through the replay's depth snapshot, like the REST call it stands for.
    await expect
      .poll(async () => redis.get(`book:${REPLAY_BTC}`), { timeout: 10_000, interval: 250 })
      .not.toBeNull();
    const book = JSON.parse((await redis.get(`book:${REPLAY_BTC}`))!) as BookSnapshot;
    expect(book.bids.length).toBeGreaterThan(10);
    expect(Number(book.bids[0]![0])).toBeLessThan(Number(book.asks[0]![0]));

    await expect.poll(async () => redis.get(`ticker:${REPLAY_BTC}`), { timeout: 10_000 }).not.toBeNull();
    const ticker = JSON.parse((await redis.get(`ticker:${REPLAY_BTC}`))!) as Ticker;
    expect(ticker.ts).toBeGreaterThan(Date.now() - 60_000); // moved to now, not the recording's time

    // The Coinbase-format book arrives as a channel snapshot on subscribe.
    await expect.poll(async () => redis.get(`book:${REPLAY_PAXG_CB}`), { timeout: 10_000 }).not.toBeNull();

    await expect
      .poll(
        async () =>
          (
            await db
              .selectFrom('market.trades')
              .select('trade_id')
              .where('instrument_id', '=', REPLAY_BTC)
              .execute()
          ).length,
        { timeout: 10_000 },
      )
      .toBeGreaterThan(10);

    await expect
      .poll(() => received.some((m) => m.ch === `book:${REPLAY_BTC}`), { timeout: 5_000 })
      .toBe(true);
    await expect
      .poll(() => received.some((m) => m.ch === `ticker:${REPLAY_BTC}`), { timeout: 5_000 })
      .toBe(true);

    await expect.poll(async () => redis.get('feed:status:replay'), { timeout: 5_000 }).not.toBeNull();
    const status = JSON.parse((await redis.get('feed:status:replay'))!) as { feeds: FeedStatus[] };
    const btc = status.feeds.filter((f) => f.instrumentId === REPLAY_BTC);
    expect(btc.map((f) => f.stream).sort()).toEqual(['depth', 'kline', 'ticker', 'trades']);
    expect(btc.find((f) => f.stream === 'depth')!.state).toBe('connected');
    expect(ingestor.probe().detail).toContain('replay open');

    // A replay never asks for REST history: no gaps were recorded for it.
    const gaps = await db
      .selectFrom('market.data_gaps')
      .select('id')
      .where('instrument_id', '=', REPLAY_BTC)
      .execute();
    expect(gaps).toEqual([]);
  });

  it('keeps sequence ids contiguous across loops: no gap appears while it loops', async () => {
    await new Promise((r) => setTimeout(r, 7_000)); // more than one 6 s loop
    const gaps = await db
      .selectFrom('market.data_gaps')
      .select(['stream', 'detected_by'])
      .where('instrument_id', 'in', [REPLAY_BTC, REPLAY_PAXG_CB])
      .execute();
    expect(gaps).toEqual([]);
  });
});
