import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { createDb } from '@cip/db';
import { BinanceVenue, CoinbaseVenue } from '@cip/exchange-adapters';
import { createLogger } from '@cip/observability';
import { Backfiller, GapNotRepairable, GapNotSettled } from '../src/backfill.ts';

const PAXG_CB = '019a6f00-0000-7000-8000-000000000008';
const SOL_BN = '019a6f00-0000-7000-8000-000000000003';
const T = Date.UTC(2026, 10, 2, 10, 0); // a Monday, outside gold closures
const owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 2 });
const jobsDb = createDb({ connectionString: inject('dbRoleUrls').svc_jobs, max: 2 });
const redis = new Redis(inject('redisUrl'));
const log = createLogger({ service: 'jobs', instance: 'test', level: 'silent' });
const hooks = { onEvent: () => undefined, onUnparsed: () => undefined, onStatus: () => undefined };

afterAll(async () => {
  await owner.destroy();
  await jobsDb.destroy();
  redis.disconnect();
});

async function gap(
  instrumentId: string,
  detectedBy: 'reconnect' | 'timer',
  from: number,
  to: number,
): Promise<string> {
  const id = randomUUID();
  await owner
    .insertInto('market.data_gaps')
    .values({
      id,
      instrument_id: instrumentId,
      stream: 'trades',
      gap_start: new Date(from),
      gap_end: new Date(to),
      detected_at: new Date(),
      detected_by: detectedBy,
      status: 'open',
      details: { reason: 'test' },
    })
    .execute();
  return id;
}

function backfiller(fetchImpl: typeof fetch): Backfiller {
  return new Backfiller(
    jobsDb,
    redis,
    log,
    { binance: new BinanceVenue(hooks, { fetchImpl }), coinbase: new CoinbaseVenue(hooks, { fetchImpl }) },
    24,
    () => T + 3_600_000,
  );
}

describe('Backfiller', () => {
  it('repairs a Coinbase gap: fetched minutes, flat minutes where nothing traded, aggregates, gap closed', async () => {
    // Coinbase returns [time, low, high, open, close, volume], newest first, and omits empty minutes.
    const fetchImpl = (async () =>
      Response.json([
        [(T + 4 * 60_000) / 1000, 101, 103, 102, 103, 2],
        [(T + 1 * 60_000) / 1000, 100, 102, 101, 102, 1.5],
        [T / 1000, 99, 101, 100, 101, 1],
      ])) as typeof fetch;
    const id = await gap(PAXG_CB, 'reconnect', T, T + 5 * 60_000);
    const result = await backfiller(fetchImpl).run({
      id,
      instrumentId: PAXG_CB,
      stream: 'trades',
      from: T,
      to: T + 5 * 60_000,
    });
    expect(result.inserted).toBe(5);

    const minutes = await owner
      .selectFrom('market.candles')
      .select(['open_time', 'open', 'close', 'volume', 'quality', 'source', 'micro_profile'])
      .where('instrument_id', '=', PAXG_CB)
      .where('timeframe', '=', '1m')
      .orderBy('open_time')
      .execute();
    expect(minutes.map((m) => [m.close, m.volume, m.quality, m.source])).toEqual([
      ['101', '1', 'repaired', 'rest'],
      ['102', '1.5', 'repaired', 'rest'],
      ['102', '0', 'repaired', 'rest'], // flat: nothing traded
      ['102', '0', 'repaired', 'rest'],
      ['103', '2', 'repaired', 'rest'],
    ]);
    expect(minutes[0]!.micro_profile).toBeNull(); // REST minutes: profile unknown
    expect(minutes[2]!.micro_profile).toHaveLength(24); // empty minute: known all-zero profile

    const five = await owner
      .selectFrom('market.candles')
      .select(['open', 'high', 'low', 'close', 'volume', 'quality'])
      .where('instrument_id', '=', PAXG_CB)
      .where('timeframe', '=', '5m')
      .executeTakeFirstOrThrow();
    expect(five).toEqual({
      open: '100',
      high: '103',
      low: '99',
      close: '103',
      volume: '4.5',
      quality: 'repaired',
    });

    const closed = await owner
      .selectFrom('market.data_gaps')
      .select(['status', 'resolved_at', 'details'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(closed.status).toBe('repaired');
    expect(closed.details).toMatchObject({ reason: 'test', inserted: 5 }); // the original reason is kept
    const events = await redis.xrange('md:events', '-', '+');
    expect(events.some(([, f]) => f[1] === 'gap.closed')).toBe(true);
    expect((await redis.xrange(`md:candles:${PAXG_CB}`, '-', '+')).at(-1)![1]).toContain('backfill');
  });

  it('treats history loaded for the first time as complete venue data', async () => {
    const start = T + 10 * 60_000;
    const kline = (i: number) => [
      start + i * 60_000,
      '10',
      '11',
      '9',
      '10.5',
      '3',
      start + i * 60_000 + 59_999,
      '31',
      5,
      '1',
      '10',
      '0',
    ];
    const fetchImpl = (async () => Response.json([kline(0), kline(1)])) as typeof fetch;
    const id = await gap(SOL_BN, 'timer', start, start + 2 * 60_000);
    await backfiller(fetchImpl).run({
      id,
      instrumentId: SOL_BN,
      stream: 'kline',
      from: start,
      to: start + 2 * 60_000,
    });
    const rows = await owner
      .selectFrom('market.candles')
      .select(['quality', 'trade_count', 'quote_volume'])
      .where('instrument_id', '=', SOL_BN)
      .where('timeframe', '=', '1m')
      .execute();
    expect(rows).toEqual([
      { quality: 'complete', trade_count: 5, quote_volume: '31' },
      { quality: 'complete', trade_count: 5, quote_volume: '31' },
    ]);
  });

  it('leaves a gap open until its last minute has settled at the venue', async () => {
    const now = T + 3_600_000;
    const id = await gap(SOL_BN, 'reconnect', now - 3 * 60_000, now - 10_000);
    const fetchImpl = (async () => {
      throw new Error('must not fetch');
    }) as typeof fetch;
    const err = await backfiller(fetchImpl)
      .run({ id, instrumentId: SOL_BN, stream: 'kline', from: now - 3 * 60_000, to: now - 10_000 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GapNotSettled);
    expect((err as GapNotSettled).waitMs).toBe(30_000); // the minute ends at now; then 30 s to settle
    const row = await owner
      .selectFrom('market.data_gaps')
      .select('status')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('open');
  });

  it('retries when Binance returns nothing, and gives up at once on an unknown gap', async () => {
    const empty = (async () => Response.json([])) as typeof fetch;
    const id = await gap(SOL_BN, 'reconnect', T + 30 * 60_000, T + 31 * 60_000);
    await expect(
      backfiller(empty).run({
        id,
        instrumentId: SOL_BN,
        stream: 'kline',
        from: T + 30 * 60_000,
        to: T + 31 * 60_000,
      }),
    ).rejects.toThrow(/no klines/);
    await expect(
      backfiller(empty).run({ id: randomUUID(), instrumentId: SOL_BN, stream: 'kline', from: 0, to: 1 }),
    ).rejects.toBeInstanceOf(GapNotRepairable);
    await backfiller(empty).markUnrepairable(id, 'test');
    expect(
      (
        await owner
          .selectFrom('market.data_gaps')
          .select('status')
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('unrepairable');
  });
});
