import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { TF_MS, type Timeframe } from '@cip/domain';
import { createDb, type NewCandle } from '@cip/db';
import { BinanceVenue, CoinbaseVenue } from '@cip/exchange-adapters';
import { createLogger } from '@cip/observability';
import { Backfiller, GapNotRepairable, GapNotSettled } from '../src/backfill.ts';

const PAXG_CB = '019a6f00-0000-7000-8000-000000000008';
const SOL_BN = '019a6f00-0000-7000-8000-000000000003';
const ETH_BN = '019a6f00-0000-7000-8000-000000000002';
const ETH_CB = '019a6f00-0000-7000-8000-000000000006';
const SOL_CB = '019a6f00-0000-7000-8000-000000000007';
const USDT_CB = '019a6f00-0000-7000-8000-000000000009';
const T = Date.UTC(2026, 10, 2, 10, 0); // a Monday, outside gold closures
const HOUR = 3_600_000;
const DAY = 86_400_000;
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
  details: Record<string, unknown> = { reason: 'test' },
  stream: 'trades' | 'kline' = 'trades',
): Promise<string> {
  const id = randomUUID();
  await owner
    .insertInto('market.data_gaps')
    .values({
      id,
      instrument_id: instrumentId,
      stream,
      gap_start: new Date(from),
      gap_end: new Date(to),
      detected_at: new Date(),
      detected_by: detectedBy,
      status: 'open',
      details,
    })
    .execute();
  return id;
}

/** A deep-history gap, as the ingestor records it. */
const historyGap = (instrumentId: string, tf: Timeframe, from: number, to: number) =>
  gap(instrumentId, 'timer', from, to, { timeframe: tf, reason: 'deep history' }, 'kline');

/** Binance klines for every period of the request's [startTime, endTime] that `has` keeps. */
function binanceKlines(requests: URL[], has: (t: number) => boolean = () => true): typeof fetch {
  return (async (input: string) => {
    const url = new URL(input);
    requests.push(url);
    const param = (name: string) => Number(url.searchParams.get(name));
    const step = TF_MS[url.searchParams.get('interval') as Timeframe];
    const rows: unknown[][] = [];
    for (let t = param('startTime'); t <= param('endTime') && rows.length < param('limit'); t += step)
      if (has(t)) rows.push([t, '10', '11', '9', '10.5', '3', t + step - 1, '31', 5, '1', '10', '0']);
    return Response.json(rows);
  }) as typeof fetch;
}

/**
 * Coinbase candles for the request's [start, end]: [time (s), low, high, open, close, volume], newest
 * first, and nothing for a period `candle` returns null for (no trades, or not listed yet).
 */
function coinbaseCandles(
  requests: URL[],
  candle: (t: number) => { o: number; h: number; l: number; c: number; v: number } | null,
): typeof fetch {
  return (async (input: string) => {
    const url = new URL(input);
    requests.push(url);
    const step = Number(url.searchParams.get('granularity')) * 1000;
    const end = Date.parse(url.searchParams.get('end')!);
    const rows: number[][] = [];
    for (let t = Date.parse(url.searchParams.get('start')!); t <= end; t += step) {
      const c = candle(t);
      if (c) rows.unshift([t / 1000, c.l, c.h, c.o, c.c, c.v]);
    }
    return Response.json(rows);
  }) as typeof fetch;
}

/** A stored candle, as an aggregate or an earlier fetch left it. */
const storedCandle = (
  instrumentId: string,
  timeframe: NewCandle['timeframe'],
  t: number,
  close: string,
  extra: Partial<NewCandle> = {},
): NewCandle => ({
  instrument_id: instrumentId,
  timeframe,
  open_time: new Date(t),
  open: close,
  high: close,
  low: close,
  close,
  volume: '1',
  quote_volume: close,
  trade_count: null,
  taker_buy_volume: null,
  micro_profile: null,
  source: 'aggregated',
  quality: 'complete',
  underlying_closed: false,
  finalized_at: new Date(t),
  ...extra,
});

const mustNotFetch = (async () => {
  throw new Error('must not fetch');
}) as typeof fetch;

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

describe('Backfiller: deep history at a higher timeframe', () => {
  const closedGap = (id: string) =>
    owner
      .selectFrom('market.data_gaps')
      .select(['status', 'details'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  it('fills a Binance 1h gap from 1h klines, 1,000 per request, without re-aggregating', async () => {
    const end = Date.UTC(2026, 10, 1);
    const from = end - 1_100 * HOUR;
    const hole = from + 500 * HOUR; // an hour the venue has no kline for
    const requests: URL[] = [];
    const id = await historyGap(ETH_BN, '1h', from, end);
    const result = await backfiller(binanceKlines(requests, (t) => t !== hole)).run({
      id,
      instrumentId: ETH_BN,
      stream: 'kline',
      from,
      to: end,
    });
    expect(result).toEqual({ inserted: 1_099, aggregates: 0 });
    expect(
      requests.map((u) => [u.searchParams.get('interval'), Number(u.searchParams.get('startTime'))]),
    ).toEqual([
      ['1h', from],
      ['1h', from + 1_000 * HOUR],
    ]);

    const stored = await owner
      .selectFrom('market.candles')
      .select([
        'timeframe',
        'open_time',
        'close',
        'quote_volume',
        'trade_count',
        'micro_profile',
        'source',
        'quality',
      ])
      .where('instrument_id', '=', ETH_BN)
      .orderBy('open_time')
      .execute();
    // 1h only: the gap stores no 1m candles and recomputes no aggregates.
    expect(stored).toHaveLength(1_099);
    expect(stored.every((c) => c.timeframe === '1h' && c.source === 'rest' && c.quality === 'complete')).toBe(
      true,
    );
    expect(stored[0]).toEqual({
      timeframe: '1h',
      open_time: new Date(from),
      close: '10.5',
      quote_volume: '31',
      trade_count: 5,
      micro_profile: null,
      source: 'rest',
      quality: 'complete',
    });
    expect(stored.at(-1)!.open_time).toEqual(new Date(end - HOUR));
    expect(stored.find((c) => c.open_time.getTime() === hole)).toBeUndefined();

    expect(await closedGap(id)).toEqual({
      status: 'repaired',
      details: {
        timeframe: '1h',
        reason: 'deep history',
        inserted: 1_099,
        restCandles: 1_099,
        note: `the venue has candles for 1099 of 1100 periods, from ${new Date(from).toISOString()}`,
      },
    });
    expect((await redis.xrange(`md:candles:${ETH_BN}`, '-', '+')).at(-1)![1]).toEqual([
      'boundary',
      String(end),
      'tfs',
      'backfill',
      'from',
      String(from),
    ]);
  });

  it('builds Coinbase 4h candles from 1h, an hour without trades filled flat', async () => {
    const from = Date.UTC(2026, 8, 15, 8); // Tuesday 08:00 UTC
    const end = from + 80 * 4 * HOUR; // 320 hours: two requests of at most 300
    const requests: URL[] = [];
    const id = await historyGap(PAXG_CB, '4h', from, end);
    const fetchImpl = coinbaseCandles(requests, (t) => {
      const i = (t - from) / HOUR;
      return i === 1 ? null : { o: 100 + i, h: 102 + i, l: 99 + i, c: 101 + i, v: 1 };
    });
    expect(
      await backfiller(fetchImpl).run({ id, instrumentId: PAXG_CB, stream: 'kline', from, to: end }),
    ).toEqual({ inserted: 80, aggregates: 0 });
    expect(requests.map((u) => u.searchParams.get('granularity'))).toEqual(['3600', '3600']);

    const candles = await owner
      .selectFrom('market.candles')
      .select([
        'timeframe',
        'open',
        'high',
        'low',
        'close',
        'volume',
        'quote_volume',
        'trade_count',
        'micro_profile',
        'source',
        'quality',
        'underlying_closed',
      ])
      .where('instrument_id', '=', PAXG_CB)
      .where('open_time', '>=', new Date(from))
      .where('open_time', '<', new Date(end))
      .orderBy('open_time')
      .execute();
    expect(candles).toHaveLength(80);
    expect(candles.every((c) => c.timeframe === '4h')).toBe(true); // the 1h candles are not stored
    // 08:00–12:00: hours 100→101, flat at 101, 102→103 and 103→104.
    expect(candles[0]).toEqual({
      timeframe: '4h',
      open: '100',
      high: '105',
      low: '99',
      close: '104',
      volume: '3',
      quote_volume: '308', // volume × close per hour: Coinbase gives no quote volume
      trade_count: null,
      micro_profile: null,
      source: 'rest',
      quality: 'complete',
      underlying_closed: false,
    });
    // 20:00–24:00 UTC overlaps the gold market's daily break (17:00–18:00 New York, 21:00 UTC in summer).
    expect(candles[3]!.underlying_closed).toBe(true);

    const closed = await closedGap(id);
    expect(closed).toMatchObject({
      status: 'repaired',
      details: { timeframe: '4h', inserted: 80, restCandles: 319 },
    });
    expect(closed.details).not.toHaveProperty('note');
  });

  it('replaces a partial aggregate with the venue candle but never a complete one', async () => {
    const day = Date.UTC(2026, 9, 26);
    await owner
      .insertInto('market.candles')
      .values([
        storedCandle(ETH_CB, '1d', day, '1', { quality: 'partial' }), // the first day of the 1m history
        storedCandle(ETH_CB, '1d', day + DAY, '2'),
      ])
      .execute();
    const id = await historyGap(ETH_CB, '1d', day, day + 3 * DAY);
    const fetchImpl = coinbaseCandles([], () => ({ o: 50, h: 52, l: 49, c: 51, v: 10 }));
    const result = await backfiller(fetchImpl).run({
      id,
      instrumentId: ETH_CB,
      stream: 'kline',
      from: day,
      to: day + 3 * DAY,
    });
    expect(result.inserted).toBe(2); // one replaced, one new

    const days = await owner
      .selectFrom('market.candles')
      .select(['open_time', 'close', 'source', 'quality'])
      .where('instrument_id', '=', ETH_CB)
      .where('timeframe', '=', '1d')
      .orderBy('open_time')
      .execute();
    expect(days.map((d) => [d.open_time.getTime(), d.close, d.source, d.quality])).toEqual([
      [day, '51', 'rest', 'complete'],
      [day + DAY, '2', 'aggregated', 'complete'], // published: never changes
      [day + 2 * DAY, '51', 'rest', 'complete'],
    ]);
  });

  it('fills from the stored close before the range when the venue omits its first periods', async () => {
    const from = Date.UTC(2026, 9, 20, 10);
    await owner
      .insertInto('market.candles')
      .values(storedCandle(SOL_CB, '1h', from - HOUR, '20'))
      .execute();
    const id = await historyGap(SOL_CB, '1h', from, from + 3 * HOUR);
    const fetchImpl = coinbaseCandles([], (t) =>
      t === from + 2 * HOUR ? { o: 21, h: 22, l: 20, c: 21.5, v: 3 } : null,
    );
    await backfiller(fetchImpl).run({ id, instrumentId: SOL_CB, stream: 'kline', from, to: from + 3 * HOUR });
    const hours = await owner
      .selectFrom('market.candles')
      .select(['open_time', 'close', 'volume', 'source'])
      .where('instrument_id', '=', SOL_CB)
      .where('timeframe', '=', '1h')
      .where('open_time', '>=', new Date(from))
      .orderBy('open_time')
      .execute();
    expect(hours.map((h) => [h.open_time.getTime() - from, h.close, h.volume, h.source])).toEqual([
      [0, '20', '0', 'rest'], // nothing traded: flat at the stored close
      [HOUR, '20', '0', 'rest'],
      [2 * HOUR, '21.5', '3', 'rest'],
    ]);
  });

  it('stores what the venue has when the pair was listed after the range began, and closes the gap', async () => {
    const end = Date.UTC(2026, 9, 1);
    const step = 15 * 60_000;
    const from = end - 1_100 * step;
    const listed = end - 100 * step;
    const requests: URL[] = [];
    const id = await historyGap(USDT_CB, '15m', from, end);
    const fetchImpl = coinbaseCandles(requests, (t) =>
      t < listed || t === listed + step ? null : { o: 1, h: 1.001, l: 0.999, c: 1.0005, v: 500 },
    );
    expect(
      await backfiller(fetchImpl).run({ id, instrumentId: USDT_CB, stream: 'kline', from, to: end }),
    ).toEqual({ inserted: 100, aggregates: 0 });
    expect(requests).toHaveLength(4); // 300 periods per request

    const candles = await owner
      .selectFrom('market.candles')
      .select(['open_time', 'volume'])
      .where('instrument_id', '=', USDT_CB)
      .where('timeframe', '=', '15m')
      .orderBy('open_time')
      .execute();
    // Nothing is invented before the venue's first candle; after it, a period without trades is flat.
    expect(candles).toHaveLength(100);
    expect(candles[0]!.open_time).toEqual(new Date(listed));
    expect(candles[1]).toEqual({ open_time: new Date(listed + step), volume: '0' });
    expect(await closedGap(id)).toMatchObject({
      status: 'repaired',
      details: {
        inserted: 100,
        note: `the venue has candles for 100 of 1100 periods, from ${new Date(listed).toISOString()}`,
      },
    });

    // Binance with no klines at all for the range: for history that is not an error, unlike a 1m gap.
    const none = await historyGap(SOL_BN, '1d', end - 1_100 * DAY, end);
    const empty = (async () => Response.json([])) as typeof fetch;
    expect(
      await backfiller(empty).run({
        id: none,
        instrumentId: SOL_BN,
        stream: 'kline',
        from: end - 1_100 * DAY,
        to: end,
      }),
    ).toEqual({ inserted: 0, aggregates: 0 });
    expect(await closedGap(none)).toMatchObject({
      status: 'repaired',
      details: { inserted: 0, restCandles: 0, note: 'the venue has no candles for this range' },
    });
  });

  it('gives up at once on an unknown timeframe, and closes a range shorter than one period', async () => {
    const t = Date.UTC(2026, 9, 20);
    const unknown = await gap(SOL_BN, 'timer', t - HOUR, t, { timeframe: '2h' }, 'kline');
    await expect(
      backfiller(mustNotFetch).run({
        id: unknown,
        instrumentId: SOL_BN,
        stream: 'kline',
        from: t - HOUR,
        to: t,
      }),
    ).rejects.toBeInstanceOf(GapNotRepairable);

    const short = await historyGap(SOL_BN, '1d', t + HOUR, t + 2 * HOUR);
    expect(
      await backfiller(mustNotFetch).run({
        id: short,
        instrumentId: SOL_BN,
        stream: 'kline',
        from: t + HOUR,
        to: t + 2 * HOUR,
      }),
    ).toEqual({ inserted: 0, aggregates: 0 });
    expect(await closedGap(short)).toMatchObject({
      status: 'repaired',
      details: { note: 'nothing to fetch' },
    });
  });
});
