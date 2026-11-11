import { metrics } from '@opentelemetry/api';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { floorTo, TF_MS, type Timeframe } from '@cip/domain';
import { createDb, type NewCandle } from '@cip/db';
import type { MinimalWebSocket } from '@cip/exchange-adapters';
import { createLogger } from '@cip/observability';
import { DEEP_HISTORY_CANDLES, MarketIngestor } from '../src/market/ingestor.ts';

// Instruments no other ingestor test stores candles or gaps for.
const ETH_BN = '019a6f00-0000-7000-8000-000000000002';
const SOL_CB = '019a6f00-0000-7000-8000-000000000007';
const PREFIX = 'history-test';
/** Instruments this file disabled, enabled again when it ends. */
let disabled: string[] = [];

const owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 2 });
const db = createDb({ connectionString: inject('dbRoleUrls').svc_ingestor, max: 4 });
const redis = new Redis(inject('redisUrl'));
const queueRedis = new Redis(inject('redisUrl'), { maxRetriesPerRequest: null });
const backfillQueue = new Queue('backfill', { connection: queueRedis, prefix: PREFIX });

/** A venue socket that never connects: these tests need the pipelines, not market data. */
class SilentSocket implements MinimalWebSocket {
  readyState = 0;
  onopen: MinimalWebSocket['onopen'] = null;
  onmessage: MinimalWebSocket['onmessage'] = null;
  onclose: MinimalWebSocket['onclose'] = null;
  onerror: MinimalWebSocket['onerror'] = null;
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
}

/** The clock check is the only REST call the ingestor makes here; venue time is local time. */
const fetchImpl = (async (input: string) =>
  input.endsWith('/api/v3/time')
    ? Response.json({ serverTime: Date.now() })
    : new Response('not stubbed', { status: 404 })) as typeof fetch;
const venue = { WebSocketImpl: SilentSocket, fetchImpl };

/** Starts the ingestor on the live venues (stubbed) and stops it once every pipeline exists. */
async function startAndStop(): Promise<void> {
  const ingestor = new MarketIngestor({
    db,
    redis,
    redisUrl: inject('redisUrl'),
    log: createLogger({ service: 'ingestor', instance: 'test', level: 'silent' }),
    meter: metrics.getMeter('test'),
    instance: PREFIX,
    queuePrefix: PREFIX,
    profileBuckets: 24,
    backfillDays: 7,
    venueOverrides: { binance: venue, coinbase: venue },
  });
  await ingestor.start();
  await ingestor.stop();
}

async function deepGaps(instrumentId: string) {
  const rows = await owner
    .selectFrom('market.data_gaps')
    .select(['id', 'stream', 'gap_start', 'gap_end', 'detected_by', 'status', 'details'])
    .where('instrument_id', '=', instrumentId)
    .where(sql<string>`details->>'reason'`, '=', 'deep history')
    .execute();
  const tf = (g: (typeof rows)[number]) => g.details['timeframe'] as Timeframe;
  return rows.map((g) => ({ ...g, tf: tf(g) })).sort((a, b) => TF_MS[a.tf] - TF_MS[b.tf]);
}

const candle = (instrumentId: string, timeframe: Timeframe, t: number): NewCandle => ({
  instrument_id: instrumentId,
  timeframe,
  open_time: new Date(t),
  open: '1',
  high: '1',
  low: '1',
  close: '1',
  volume: '1',
  quote_volume: '1',
  trade_count: null,
  taker_buy_volume: null,
  micro_profile: null,
  source: 'rest',
  quality: 'complete',
  underlying_closed: false,
  finalized_at: new Date(t),
});

beforeAll(async () => {
  await redis.flushall();
  // Only this file's instruments stream, so other test files never find gaps they did not record.
  disabled = (
    await owner
      .updateTable('market.instruments')
      .set({ enabled: false })
      .where('enabled', '=', true)
      .where('id', 'not in', [ETH_BN, SOL_CB])
      .returning('id')
      .execute()
  ).map((r) => r.id);
});
afterAll(async () => {
  if (disabled.length > 0)
    await owner
      .updateTable('market.instruments')
      .set({ enabled: true })
      .where('id', 'in', disabled)
      .execute();
  await backfillQueue.close();
  queueRedis.disconnect();
  redis.disconnect();
  await db.destroy();
  await owner.destroy();
});

describe('deep history for the higher timeframes', () => {
  it('records a gap per timeframe on first start, and none once history reaches back far enough', async () => {
    const before = Date.now();
    await startAndStop();
    const after = Date.now();

    const first = await deepGaps(ETH_BN);
    expect(first.map((g) => g.tf)).toEqual(['5m', '15m', '1h', '4h', '1d']);
    expect((await deepGaps(SOL_CB)).map((g) => g.tf)).toEqual(['5m', '15m', '1h', '4h', '1d']);
    for (const g of first) {
      // Up to the last period that had ended when the pipeline was created, and 1,100 periods back.
      const to = g.gap_end!.getTime();
      expect([floorTo(before, g.tf), floorTo(after, g.tf)]).toContain(to);
      expect(g.gap_start.getTime()).toBe(to - 1_100 * TF_MS[g.tf]);
      expect(g).toMatchObject({
        stream: 'kline',
        detected_by: 'timer',
        status: 'open',
        details: { timeframe: g.tf, reason: 'deep history' },
      });
      // Queued for the backfill job like any other gap.
      const job = await backfillQueue.getJob(`backfill:${ETH_BN}:${g.id}`);
      expect(job?.data).toEqual({
        id: g.id,
        instrumentId: ETH_BN,
        stream: 'kline',
        from: g.gap_start.getTime(),
        to,
      });
    }
    expect(DEEP_HISTORY_CANDLES).toBe(1_100);

    // History that reaches the origin (or further back) is not fetched again on the next start;
    // 1d history starting two days after the origin still falls short.
    const origin = (tf: Timeframe) => first.find((g) => g.tf === tf)!.gap_start.getTime();
    await owner
      .insertInto('market.candles')
      .values([
        candle(ETH_BN, '5m', origin('5m') - TF_MS['5m']),
        candle(ETH_BN, '15m', origin('15m')),
        candle(ETH_BN, '1h', origin('1h') - TF_MS['1h']),
        candle(ETH_BN, '4h', origin('4h')),
        candle(ETH_BN, '1d', origin('1d') + 2 * TF_MS['1d']),
      ])
      .execute();
    await startAndStop();
    const again = (await deepGaps(ETH_BN)).filter((g) => !first.some((f) => f.id === g.id));
    expect(again.map((g) => g.tf)).toEqual(['1d']);
  });
});
