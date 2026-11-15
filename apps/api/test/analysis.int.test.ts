import { Redis } from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  type AnalysisStatus,
  analysisStatusKey,
  type DetectionRun,
  type Envelope,
  type IndicatorPoint,
  type IndicatorSeries,
  type SubscribeAck,
  WS_NAMESPACE,
  WS_PATH,
} from '@cip/contracts';
import { createDb, LAUNCH_PROFILE_IDS } from '@cip/db';
import { call, createUser, type Harness, startApi, tokenFor } from './harness.ts';

const SOL = '019a6f00-0000-7000-8000-000000000003';
const ETH = '019a6f00-0000-7000-8000-000000000002';
const RUN = '019a6f00-0000-7000-8000-00000000c001';
const OLD_RUN = '019a6f00-0000-7000-8000-00000000c000';
const FROM = Date.UTC(2026, 10, 10, 12, 0);
const HOUR = 3_600_000;

let h: Harness;
let viewer: string;
const owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 2 });
const redis = new Redis(inject('redisUrl'));
const sockets: Socket[] = [];

const value = (i: number) => ({
  rsi: 50 + i,
  macd: i === 0 ? null : -1.25 * i,
  macd_signal: null,
  macd_hist: null,
  ema_fast: 140 + i / 3,
  ema_mid: 139,
  ema_slow: null,
  vwap: i % 2 ? 141.5 : null,
  atr: 2.5,
  volume_z: i === 4 ? 4.2 : 0.3,
  volume_anomaly: i === 4,
  trend: i >= 3 ? ('bullish' as const) : null,
  trend_strength: i >= 3 ? 0.8 : null,
});

beforeAll(async () => {
  h = await startApi();
  viewer = await tokenFor(h, await createUser(h, 'viewer'));
  const run = (id: string, status: 'running' | 'superseded', started: number) => ({
    id,
    mode: 'live' as const,
    instrument_id: SOL,
    profile_id: LAUNCH_PROFILE_IDS['crypto-majors'],
    ruleset_version: 'indicators-1',
    params_hash: 'hash',
    from_time: new Date(FROM),
    status,
    started_at: new Date(started),
    ...(status === 'superseded'
      ? { finished_at: new Date(started + 1000), to_time: new Date(started + 1000) }
      : {}),
  });
  await owner
    .insertInto('analysis.detection_runs')
    .values([run(OLD_RUN, 'superseded', FROM - 2 * HOUR), run(RUN, 'running', FROM)])
    .execute();
  // Five 1h points: three before the run started (warm-up), two after.
  await owner
    .insertInto('analysis.indicator_values')
    .values(
      Array.from({ length: 5 }, (_, i) => ({
        instrument_id: SOL,
        timeframe: '1h' as const,
        open_time: new Date(FROM + (i - 3) * HOUR),
        run_id: RUN,
        ...value(i),
      })),
    )
    .execute();
  await owner
    .insertInto('analysis.indicator_values')
    .values({ instrument_id: SOL, timeframe: '1h', open_time: new Date(FROM), run_id: OLD_RUN, ...value(9) })
    .execute();
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  redis.disconnect();
  await h.close();
  await owner.destroy();
});

const get = (path: string) => call(h.base, 'GET', `/api/v1${path}`, { token: viewer });

const point = (i: number): IndicatorPoint => ({
  t: FROM + (i - 3) * HOUR,
  rsi: 50 + i,
  macd: i === 0 ? null : -1.25 * i,
  macdSignal: null,
  macdHist: null,
  emaFast: 140 + i / 3,
  emaMid: 139,
  emaSlow: null,
  vwap: i % 2 ? 141.5 : null,
  atr: 2.5,
  volumeZ: i === 4 ? 4.2 : 0.3,
  volumeAnomaly: i === 4,
  trend: i >= 3 ? 'bullish' : null,
  trendStrength: i >= 3 ? 0.8 : null,
  warmup: i < 3,
});

describe('indicator endpoints', () => {
  it("returns the current run's points oldest first, warm-up marked, with the run's settings", async () => {
    const res = await get(`/indicators/${SOL}?tf=1h`);
    expect(res.status).toBe(200);
    const body = res.body as IndicatorSeries;
    expect(body.run).toEqual({
      id: RUN,
      status: 'running',
      from: FROM,
      profile: { name: 'crypto-majors', version: 4 },
    });
    expect(body.params?.ema).toEqual({ fast: 20, mid: 50, slow: 200 });
    expect(body.points).toEqual([0, 1, 2, 3, 4].map(point));
  });

  it('pages by time: the latest `limit` points, or the first ones from `from`, or those before `to`', async () => {
    expect(((await get(`/indicators/${SOL}?tf=1h&limit=2`)).body as IndicatorSeries).points).toEqual([
      point(3),
      point(4),
    ]);
    const from = (await get(`/indicators/${SOL}?tf=1h&from=${FROM - 2 * HOUR}&limit=2`))
      .body as IndicatorSeries;
    expect(from.points.map((p) => p.t)).toEqual([FROM - 2 * HOUR, FROM - HOUR]);
    const to = (await get(`/indicators/${SOL}?tf=1h&to=${FROM}`)).body as IndicatorSeries;
    expect(to.points.map((p) => p.t)).toEqual([FROM - 3 * HOUR, FROM - 2 * HOUR, FROM - HOUR]);
    expect(((await get(`/indicators/${SOL}?tf=5m`)).body as IndicatorSeries).points).toEqual([]);
  });

  it('answers an instrument never analysed with no run, and refuses bad requests', async () => {
    expect((await get(`/indicators/${ETH}?tf=1h`)).body).toEqual({
      instrumentId: ETH,
      tf: '1h',
      run: null,
      params: null,
      points: [],
    });
    expect((await get(`/indicators/${SOL}?tf=2h`)).status).toBe(400);
    expect((await get(`/indicators/${SOL}?tf=1h&from=${FROM}&to=${FROM}`)).status).toBe(400);
    expect((await get(`/indicators/00000000-0000-4000-8000-000000000000?tf=1h`)).status).toBe(404);
    expect((await call(h.base, 'GET', `/api/v1/indicators/${SOL}?tf=1h`)).status).toBe(401);
  });

  it('lists runs newest first, with the live state the analyzer reports for open ones', async () => {
    const status: AnalysisStatus = {
      instrumentId: SOL,
      runId: RUN,
      status: 'running',
      lagSec: 120,
      paused: true,
      pauseReason: 'data_gap',
      detail: '1m: missing 2026-11-10 12:01 (backfill running)',
      updatedAt: FROM,
    };
    await redis.set(analysisStatusKey(SOL), JSON.stringify(status), 'PX', 10_000);
    const runs = (await get(`/system/runs?instrumentId=${SOL}`)).body as DetectionRun[];
    expect(runs.map((r) => [r.id, r.status, r.lagSec, r.paused, r.pauseReason])).toEqual([
      [RUN, 'running', 120, true, 'data_gap'],
      [OLD_RUN, 'superseded', null, false, null],
    ]);
    expect(runs[1]!.finishedAt).toBe(FROM - 2 * HOUR + 1000);
    expect(((await get('/system/runs?limit=1')).body as DetectionRun[]).map((r) => r.id)).toEqual([RUN]);

    const health = await get('/system/health');
    expect(health.body.analysis).toEqual([status]);
    expect(health.body.status).toBe('degraded');
  });
});

describe('indicators channel', () => {
  function connect(): Socket {
    const socket = io(h.base + WS_NAMESPACE, {
      path: WS_PATH,
      transports: ['websocket'],
      auth: { token: viewer },
      reconnection: false,
    });
    sockets.push(socket);
    return socket;
  }
  const connected = (socket: Socket) =>
    new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
  const collect = (socket: Socket) => {
    const messages: Envelope[] = [];
    socket.on('message', (m: Envelope) => messages.push(m));
    return messages;
  };
  const subscribe = (socket: Socket, channels: string[], since?: Record<string, string>) =>
    socket.emitWithAck('subscribe', since ? { channels, since } : { channels }) as Promise<SubscribeAck>;
  const closed = (tf: string, i: number) =>
    redis.xadd(
      'an:events',
      '*',
      'type',
      'indicators.closed',
      'data',
      JSON.stringify({ instrumentId: SOL, tf, runId: RUN, point: point(i) }),
    );

  it('delivers indicators.closed with its an:events id, and replays what a reconnecting client missed', async () => {
    const ch = `indicators:${SOL}:1h`;
    const socket = connect();
    await connected(socket);
    const messages = collect(socket);
    expect((await subscribe(socket, [ch])).results[ch]!.mode).toBe('live');
    const first = await closed('1h', 3);
    await closed('5m', 4); // another timeframe's channel
    await expect.poll(() => messages.length).toBe(1);
    expect(messages[0]).toEqual({
      ch,
      seq: first,
      ts: Number(first!.split('-')[0]),
      type: 'indicators.closed',
      data: { instrumentId: SOL, tf: '1h', runId: RUN, point: point(3) },
    });
    socket.disconnect();

    await closed('1h', 4);
    const again = connect();
    await connected(again);
    const replayed = collect(again);
    expect((await subscribe(again, [ch], { [ch]: first! })).results[ch]!.mode).toBe('replayed');
    await expect
      .poll(() => replayed.map((m) => (m.data as { point: IndicatorPoint }).point.t))
      .toEqual([FROM + HOUR]);

    // Older than the stream holds: the current series replaces the client's copy.
    const old = await subscribe(again, [ch], { [ch]: '1-0' });
    expect(old.results[ch]).toMatchObject({ mode: 'snapshot', snapshot: { series: { run: { id: RUN } } } });
    expect((old.results[ch]!.snapshot as { series: IndicatorSeries }).series.points).toHaveLength(5);
  });
});
