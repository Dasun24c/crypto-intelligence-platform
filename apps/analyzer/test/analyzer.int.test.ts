import { Redis } from 'ioredis';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { type AnalysisStatus, analysisStatusKey, IndicatorsClosedEventSchema } from '@cip/contracts';
import { candleToRow, createDb, LAUNCH_PROFILE_IDS } from '@cip/db';
import { type Candle, floorTo, HISTORY_CANDLES, TF_MS, TIMEFRAMES, type Timeframe } from '@cip/domain';
import { computeIndicators, DEFAULT_INDICATOR_PARAMS, type IndicatorValues } from '@cip/indicators';
import { createLogger } from '@cip/observability';
import { HISTORY_GRACE_MS, RULESET_VERSION } from '../src/analysis/actor.ts';
import { Analyzer, candleStream } from '../src/analysis/analyzer.ts';

const SOL = '019a6f00-0000-7000-8000-000000000003'; // binance SOLUSDT: full history
const ETH_CB = '019a6f00-0000-7000-8000-000000000006'; // coinbase ETH-USD: no history at all
const FROM = Date.UTC(2026, 10, 10, 12, 0); // the run starts here
const MIN = 60_000;

const owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 2 });
const db = createDb({ connectionString: inject('dbRoleUrls').svc_analyzer, max: 4 });
const redis = new Redis(inject('redisUrl'));
const log = createLogger({ service: 'analyzer', instance: 'test', level: 'silent' });
const clock = { now: FROM + 30_000 };
const analyzers: Analyzer[] = [];

function analyzer(instance: string): Analyzer {
  const a = new Analyzer({
    db,
    redis,
    redisUrl: inject('redisUrl'),
    log,
    instance,
    tickMs: 3_600_000, // the tests tick by hand
    blockMs: 100,
    now: () => clock.now,
  });
  analyzers.push(a);
  return a;
}

/** A deterministic random walk: `count` closed candles of `tf` from `start`. */
function series(tf: Timeframe, start: number, count: number, seed: number): Candle[] {
  let s = seed;
  const rand = () => (s = (s * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
  let close = 150;
  return Array.from({ length: count }, (_, i) => {
    const open = close;
    close = Math.max(1, open * (1 + (rand() - 0.5) * 0.02));
    const high = Math.max(open, close) * (1 + rand() * 0.004);
    const low = Math.min(open, close) * (1 - rand() * 0.004);
    return minuteLike(tf, start + i * TF_MS[tf], open, high, low, close, rand() * 100);
  });
}

function minuteLike(
  tf: Timeframe,
  openTime: number,
  o: number,
  h: number,
  l: number,
  c: number,
  v: number,
): Candle {
  return {
    timeframe: tf,
    openTime,
    open: o.toFixed(2),
    high: h.toFixed(2),
    low: l.toFixed(2),
    close: c.toFixed(2),
    volume: v.toFixed(3),
    quoteVolume: (v * c).toFixed(2),
    tradeCount: 1,
    takerBuyVolume: null,
    microProfile: null,
    source: 'rest',
    quality: 'complete',
    underlyingClosed: false,
  };
}

const history = new Map<Timeframe, Candle[]>();

async function store(candles: Candle[], instrumentId = SOL): Promise<void> {
  for (let i = 0; i < candles.length; i += 500)
    await owner
      .insertInto('market.candles')
      .values(candles.slice(i, i + 500).map((c) => candleToRow(instrumentId, c, new Date())))
      .execute();
}

async function valuesOf(runId: string, tf: Timeframe) {
  return owner
    .selectFrom('analysis.indicator_values')
    .selectAll()
    .where('run_id', '=', runId)
    .where('timeframe', '=', tf)
    .orderBy('open_time')
    .execute();
}

const asRow = (v: IndicatorValues) => ({
  open_time: new Date(v.openTime),
  rsi: v.rsi,
  macd: v.macd,
  macd_signal: v.macdSignal,
  macd_hist: v.macdHist,
  ema_fast: v.emaFast,
  ema_mid: v.emaMid,
  ema_slow: v.emaSlow,
  vwap: v.vwap,
  atr: v.atr,
  volume_z: v.volumeZ,
  volume_anomaly: v.volumeAnomaly,
  trend: v.trend,
  trend_strength: v.trendStrength,
});

const openRun = (instrumentId: string) =>
  owner
    .selectFrom('analysis.detection_runs')
    .selectAll()
    .where('instrument_id', '=', instrumentId)
    .where('status', 'in', ['warming_up', 'running'])
    .executeTakeFirstOrThrow();

async function status(instrumentId: string): Promise<AnalysisStatus> {
  return JSON.parse((await redis.get(analysisStatusKey(instrumentId)))!) as AnalysisStatus;
}

async function events() {
  const entries = await redis.xrange('an:events', '-', '+');
  return entries.map(([id, fields]) => ({
    id,
    type: fields[1],
    data: IndicatorsClosedEventSchema.parse(JSON.parse(fields[3]!)),
  }));
}

beforeAll(async () => {
  await owner
    .updateTable('market.instruments')
    .set({ enabled: false })
    .where('id', 'not in', [SOL, ETH_CB])
    .execute();
  for (const [n, tf] of TIMEFRAMES.entries()) {
    const candles = series(tf, floorTo(FROM, tf) - HISTORY_CANDLES * TF_MS[tf], HISTORY_CANDLES, 7 + n);
    history.set(tf, candles);
    await store(candles);
  }
});

afterAll(async () => {
  for (const a of analyzers) await a.stop();
  await owner.destroy();
  await db.destroy();
  redis.disconnect();
});

describe('analyzer runs (Phase 3)', () => {
  it('warms every timeframe up on 1,000 candles and stores exactly what the indicators package computes', async () => {
    const a = analyzer('a');
    await a.start();
    const run = await openRun(SOL);
    expect(run).toMatchObject({
      mode: 'live',
      status: 'running',
      profile_id: LAUNCH_PROFILE_IDS['crypto-majors'],
      ruleset_version: RULESET_VERSION,
    });
    expect(run.from_time.getTime()).toBe(FROM);
    for (const tf of TIMEFRAMES) {
      const stored = await valuesOf(run.id, tf);
      const want = computeIndicators(history.get(tf)!, tf, DEFAULT_INDICATOR_PARAMS).map(asRow);
      expect(
        stored.map(({ instrument_id: _i, timeframe: _tf, run_id: _r, ...v }) => v),
        tf,
      ).toEqual(want);
    }
    // Warm-up points are history: none of them is published.
    expect(await events()).toEqual([]);
    expect(await status(SOL)).toMatchObject({ runId: run.id, status: 'running', paused: false, lagSec: 0 });
    // An instrument without any history waits for it, and says so.
    const waiting = await status(ETH_CB);
    expect(waiting).toMatchObject({ status: 'warming_up', paused: true, pauseReason: 'warming_up' });
    expect(waiting.detail).toContain('1m: waiting for history');
    expect(a.probe()).toEqual({
      status: 'ok',
      detail: 'analysing 2 instruments: 1 warming up, 0 paused on a data gap',
    });
  });

  it('publishes a candle close at once, on its indicators channel', async () => {
    const run = await openRun(SOL);
    const last = history.get('1m')!.at(-1)!;
    const next = minuteLike('1m', FROM, Number(last.close), 151, 149, 150.5, 12);
    history.get('1m')!.push(next);
    await store([next]);
    const wake = await redis.xadd(candleStream(SOL), '*', 'boundary', String(FROM + MIN), 'tfs', '1m');
    await vi.waitFor(async () => expect(await events()).toHaveLength(1), { timeout: 5_000, interval: 20 });
    const [event] = await events();
    expect(event!.type).toBe('indicators.closed');
    expect(event!.data).toMatchObject({ instrumentId: SOL, tf: '1m', runId: run.id });
    const want = computeIndicators(history.get('1m')!, '1m').at(-1)!;
    expect(event!.data.point).toEqual({ ...asPoint(want), warmup: false });
    // Both ids are Redis server times: wake-up to publish, well inside criterion 3.5's 1 s.
    expect(Number(event!.id.split('-')[0]) - Number(wake!.split('-')[0])).toBeLessThan(1_000);
  });

  it('holds a timeframe back on a missing candle and resumes, in order, once it is repaired', async () => {
    const a = analyzers[0]!;
    const one = history.get('1m')!;
    const missing = minuteLike('1m', FROM + MIN, 150.5, 151, 150, 150.8, 3);
    const after = minuteLike('1m', FROM + 2 * MIN, 150.8, 151.2, 150.4, 151, 4);
    await store([after]);
    const gapId = '019a6f00-0000-7000-8000-00000000a001';
    await owner
      .insertInto('market.data_gaps')
      .values({
        id: gapId,
        instrument_id: SOL,
        stream: 'kline',
        gap_start: new Date(FROM + MIN),
        gap_end: new Date(FROM + 2 * MIN),
        detected_at: new Date(),
        detected_by: 'sequence',
        status: 'open',
      })
      .execute();
    await redis.xadd(candleStream(SOL), '*', 'boundary', String(FROM + 3 * MIN), 'tfs', '1m');
    await vi.waitFor(
      async () => {
        await a.tick();
        expect(await status(SOL)).toMatchObject({ paused: true, pauseReason: 'data_gap' });
      },
      { timeout: 5_000, interval: 50 },
    );
    expect((await status(SOL)).detail).toBe('1m: missing 2026-11-10 12:01 (backfill running)');
    expect((await status(SOL)).lagSec).toBe(120);
    expect(await events()).toHaveLength(1);

    // The backfill stores the minute, closes the gap and wakes the analyzer.
    await store([missing]);
    one.push(missing, after);
    await owner.updateTable('market.data_gaps').set({ status: 'repaired' }).where('id', '=', gapId).execute();
    await redis.xadd(candleStream(SOL), '*', 'boundary', String(FROM + 2 * MIN), 'tfs', 'backfill');
    await vi.waitFor(async () => expect(await events()).toHaveLength(3), { timeout: 5_000, interval: 20 });
    const published = await events();
    expect(published.map((e) => e.data.point.t)).toEqual([FROM, FROM + MIN, FROM + 2 * MIN]);
    expect(published[2]!.data.point).toEqual({
      ...asPoint(computeIndicators(one, '1m').at(-1)!),
      warmup: false,
    });
    await a.tick();
    expect(await status(SOL)).toMatchObject({ paused: false, lagSec: 0 });
  });

  it('waits on a partial aggregate whose missing minutes can still be repaired, then takes it complete', async () => {
    const a = analyzers[0]!;
    const one = history.get('1m')!;
    // 12:00–12:02 are stored; 12:03 and 12:04 are not, so the 5m candle at 12:00 is partial.
    const partial = minuteLike('5m', FROM, 150, 151.2, 149, 151, 19);
    await store([{ ...partial, quality: 'partial' }]);
    await redis.xadd(candleStream(SOL), '*', 'boundary', String(FROM + 5 * MIN), 'tfs', '1m,5m');
    await vi.waitFor(
      async () => {
        await a.tick();
        expect((await status(SOL)).detail).toBe(
          '5m: 2026-11-10 12:00 is missing minutes (waiting for repair)',
        );
      },
      { timeout: 5_000, interval: 50 },
    );
    expect((await events()).filter((e) => e.data.tf === '5m')).toEqual([]);

    // The repair stores the minutes and rebuilds the 5m candle complete; the analyzer then takes it.
    const repaired = [3, 4].map((i) => minuteLike('1m', FROM + i * MIN, 151, 151.2, 150.9, 151, 2));
    await store(repaired);
    one.push(...repaired);
    const complete = minuteLike('5m', FROM, 150, 151.2, 149, 151, 21);
    await owner
      .updateTable('market.candles')
      .set({ quality: 'complete', volume: complete.volume })
      .where('instrument_id', '=', SOL)
      .where('timeframe', '=', '5m')
      .where('open_time', '=', new Date(FROM))
      .execute();
    history.get('5m')!.push(complete);
    await redis.xadd(candleStream(SOL), '*', 'boundary', String(FROM + 5 * MIN), 'tfs', 'backfill');
    await vi.waitFor(async () => expect((await events()).filter((e) => e.data.tf === '5m')).toHaveLength(1), {
      timeout: 5_000,
      interval: 20,
    });
    const [five] = (await events()).filter((e) => e.data.tf === '5m');
    expect(five!.data.point).toEqual({
      ...asPoint(computeIndicators(history.get('5m')!, '5m').at(-1)!),
      warmup: false,
    });
    // 12:03 and 12:04 on 1m, and the 5m candle: six points published so far.
    await vi.waitFor(async () => expect(await events()).toHaveLength(6), { timeout: 5_000, interval: 20 });
    await a.tick();
    expect(await status(SOL)).toMatchObject({ paused: false });
  });

  it('after a restart, recomputes the same values from the run start and publishes nothing again', async () => {
    const run = await openRun(SOL);
    const before = await valuesOf(run.id, '1m');
    await analyzers[0]!.stop();
    const b = analyzer('b');
    await b.start();
    expect((await openRun(SOL)).id).toBe(run.id);
    expect(await valuesOf(run.id, '1m')).toEqual(before);
    expect(await events()).toHaveLength(6);
  });

  it('runs each instrument on one instance only; a standby takes over when the lease is released', async () => {
    const c = analyzer('c');
    await c.start();
    expect(c.instrumentIds).toEqual([]);
    expect(c.probe()).toEqual({ status: 'ok', detail: 'standby: no instrument leases held' });
    await analyzers[1]!.stop();
    await c.tick();
    expect(c.instrumentIds.sort()).toEqual([SOL, ETH_CB].sort());
    expect(await events()).toHaveLength(6);
  });

  it('supersedes the open run when the profile changes, and warms a new one up', async () => {
    const c = analyzers[2]!;
    const old = await openRun(SOL);
    const v2 = '019a6f00-0000-7000-8000-0000000002a1';
    const params = { indicators: { ...DEFAULT_INDICATOR_PARAMS, rsi: { period: 21 } } };
    await sql`
      INSERT INTO market.instrument_profiles (id, name, version, params, params_hash)
      SELECT ${v2}::uuid, 'crypto-majors', 2, p, encode(sha256(convert_to(p::text, 'UTF8')), 'hex')
      FROM (SELECT ${JSON.stringify(params)}::jsonb AS p) AS x
    `.execute(owner);
    await owner.updateTable('market.instruments').set({ profile_id: v2 }).where('id', '=', SOL).execute();
    await c.tick();
    const closed = await owner
      .selectFrom('analysis.detection_runs')
      .selectAll()
      .where('id', '=', old.id)
      .executeTakeFirstOrThrow();
    expect(closed.status).toBe('superseded');
    expect(closed.finished_at).not.toBeNull();
    const run = await openRun(SOL);
    expect(run).toMatchObject({ profile_id: v2, status: 'running' });
    const rsi = (await valuesOf(run.id, '1h')).map((r) => r.rsi);
    expect(rsi.findIndex((v) => v !== null)).toBe(21);
  });
  it('fixes where a short history starts, so history that arrives later never changes the run', async () => {
    const c = analyzers[2]!;
    // ETH-USD had no candles at all; it gets 30 minutes of 1m history, far short of 1,000.
    const recent = series('1m', FROM - 30 * MIN, 30, 99);
    await store(recent, ETH_CB);
    clock.now += HISTORY_GRACE_MS; // the run has waited long enough for history gaps to be recorded
    await c.tick();
    const run = await openRun(ETH_CB);
    expect(run.series_origins).toEqual({ '1m': FROM - 30 * MIN });
    const first = await valuesOf(run.id, '1m');
    expect(first).toHaveLength(30);
    expect(first[0]!.open_time.getTime()).toBe(FROM - 30 * MIN);

    // Older history arrives (a backfill), then the analyzer restarts: the run keeps its start.
    await store(series('1m', FROM - 90 * MIN, 60, 5), ETH_CB);
    await c.stop();
    const d = analyzer('d');
    await d.start();
    expect((await openRun(ETH_CB)).series_origins).toEqual({ '1m': FROM - 30 * MIN });
    expect(await valuesOf(run.id, '1m')).toEqual(first);
    expect(computeIndicators(recent, '1m').map(asRow)).toEqual(
      first.map(({ instrument_id: _i, timeframe: _tf, run_id: _r, ...v }) => v),
    );
  });
});

function asPoint(v: IndicatorValues) {
  return {
    t: v.openTime,
    rsi: v.rsi,
    macd: v.macd,
    macdSignal: v.macdSignal,
    macdHist: v.macdHist,
    emaFast: v.emaFast,
    emaMid: v.emaMid,
    emaSlow: v.emaSlow,
    vwap: v.vwap,
    atr: v.atr,
    volumeZ: v.volumeZ,
    volumeAnomaly: v.volumeAnomaly,
    trend: v.trend,
    trendStrength: v.trendStrength,
  };
}
