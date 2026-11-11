import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  type ChartOverlay,
  type Envelope,
  type LiquidityLevel,
  REPLAY_QUEUE,
  type ReplayJob,
  type ReplayStatus,
  type SmcEventMessage,
  type StructureEvent,
  type SubscribeAck,
  type Sweep,
  type SwingPoint,
  type TradingRange,
  WS_NAMESPACE,
  WS_PATH,
} from '@cip/contracts';
import { createDb, LAUNCH_PROFILE_IDS } from '@cip/db';
import { call, createUser, type Harness, startApi, tokenFor } from './harness.ts';

/** API contracts §3 "Indicators and SMC" and "Setups and replays", §5.3 `smc:{instrumentId}`. */
const BTC = '019a6f00-0000-7000-8000-000000000001';
const ETH = '019a6f00-0000-7000-8000-000000000002';
const PAXG = '019a6f00-0000-7000-8000-000000000004';
const LIVE = '019a6f00-0000-7000-8000-00000000d001';
const REPLAY = '019a6f00-0000-7000-8000-00000000d002';
const FROM = Date.UTC(2026, 10, 10, 0, 0);
const H = 3_600_000;
/** A gold-market closure for the overlay test. */
const CLOSED = Date.UTC(2025, 0, 5, 22, 0);

let h: Harness;
let viewer: string;
let analyst: string;
const owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 2 });
const redis = new Redis(inject('redisUrl'));
const queueConnection = new Redis(inject('redisUrl'), { maxRetriesPerRequest: null });
const queue = new Queue<ReplayJob>(REPLAY_QUEUE, { connection: queueConnection, prefix: 'cip' });
const sockets: Socket[] = [];
const id = (n: number) => `019a6f00-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

function run(runId: string, mode: 'live' | 'replay') {
  return {
    id: runId,
    mode,
    instrument_id: BTC,
    profile_id: LAUNCH_PROFILE_IDS['crypto-majors'],
    ruleset_version: 'indicators-1+smc-0.1.0',
    params_hash: 'hash',
    from_time: new Date(FROM),
    status: mode === 'live' ? ('running' as const) : ('completed' as const),
    started_at: new Date(mode === 'live' ? FROM - 60 * H : FROM - 50 * H),
    ...(mode === 'replay'
      ? {
          to_time: new Date(FROM + 10 * H),
          finished_at: new Date(FROM + 50 * H),
          result_digest: 'x',
          source_run_id: LIVE,
        }
      : {}),
  };
}

/** One of each projection on 1h (and a 5m swing and a 15m level), for a run. */
async function seed(runId: string, base: number): Promise<void> {
  await owner
    .insertInto('analysis.swing_points')
    .values([
      {
        id: id(base + 1),
        run_id: runId,
        instrument_id: BTC,
        timeframe: '1h',
        kind: 'high',
        structure_level: 'internal',
        price: '105.5',
        candle_time: new Date(FROM + 2 * H),
        confirmed_at: new Date(FROM + 5 * H),
        flags: ['warmup'],
      },
      {
        id: id(base + 2),
        run_id: runId,
        instrument_id: BTC,
        timeframe: '1h',
        kind: 'low',
        structure_level: 'external',
        price: '99.25',
        candle_time: new Date(FROM + 6 * H),
        confirmed_at: new Date(FROM + 12 * H),
        flags: [],
      },
      {
        id: id(base + 3),
        run_id: runId,
        instrument_id: BTC,
        timeframe: '5m',
        kind: 'low',
        structure_level: 'internal',
        price: '100',
        candle_time: new Date(FROM + H),
        confirmed_at: new Date(FROM + H + 15 * 60_000),
        flags: [],
      },
    ])
    .execute();
  await owner
    .insertInto('analysis.structure_events')
    .values({
      id: id(base + 4),
      run_id: runId,
      instrument_id: BTC,
      timeframe: '1h',
      structure_level: 'internal',
      type: 'bos',
      direction: 'bullish',
      broken_swing_id: id(base + 1),
      break_price: '105.5',
      break_candle_time: new Date(FROM + 8 * H),
      is_initial: true,
      displacement: JSON.stringify({ from: FROM + 7 * H, to: FROM + 8 * H, bodyAtr: 2.4, createdFvg: true }),
      flags: [],
    })
    .execute();
  await owner
    .insertInto('analysis.trading_ranges')
    .values([
      {
        id: id(base + 5),
        run_id: runId,
        instrument_id: BTC,
        timeframe: '1h',
        high: '106',
        low: '98',
        equilibrium: '102',
        window_start: new Date(FROM - 40 * H),
        detected_at: new Date(FROM + H),
        ended_at: new Date(FROM + 9 * H),
        end_reason: 'breakout_up',
        flags: [],
      },
      {
        id: id(base + 6),
        run_id: runId,
        instrument_id: BTC,
        timeframe: '1h',
        high: '110',
        low: '107',
        equilibrium: '108.5',
        window_start: new Date(FROM - 30 * H),
        detected_at: new Date(FROM + 20 * H),
        ended_at: null,
        end_reason: null,
        flags: [],
      },
    ])
    .execute();
  const level = (
    n: number,
    type: string,
    tf: '15m' | '1h' | '1d',
    status: 'active' | 'swept',
    price: string,
  ) => ({
    id: id(base + n),
    run_id: runId,
    instrument_id: BTC,
    origin_timeframe: tf,
    type,
    side: type.endsWith('l') || type.endsWith('low') ? ('sell_side' as const) : ('buy_side' as const),
    price,
    touches: type.startsWith('eq') ? 2 : 1,
    session_name: null,
    source_ref: JSON.stringify({ keys: [] }),
    location: 'none' as const,
    known_at: new Date(FROM + n * H),
    status,
    status_changed_at: status === 'swept' ? new Date(FROM + 11 * H) : null,
    sweep_count: status === 'swept' ? 1 : 0,
    flags: [],
  });
  await owner
    .insertInto('analysis.liquidity_levels')
    .values([
      level(7, 'eql', '1h', 'swept', '99.25'),
      level(8, 'pdh', '1d', 'active', '107'),
      level(9, 'eqh', '15m', 'active', '106.2'),
    ])
    .execute();
  await owner
    .insertInto('analysis.sweeps')
    .values({
      id: id(base + 10),
      run_id: runId,
      instrument_id: BTC,
      timeframe: '1h',
      level_id: id(base + 7),
      group_id: id(base + 11),
      kind: 'wick',
      side: 'sell_side',
      level_price: '99.25',
      extreme_price: '98.9',
      penetration_atr: 0.35,
      breach_candle_time: new Date(FROM + 10 * H),
      confirmed_candle_time: new Date(FROM + 10 * H),
      notional_beyond_usd: null,
      flags: ['liquidity_unverified'],
    })
    .execute();
}

/** The same three engine events in a run's log (for digests). */
async function log(runId: string, change = ''): Promise<void> {
  await owner
    .insertInto('analysis.detection_events')
    .values(
      [1, 2, 3].map((seq) => ({
        run_id: runId,
        seq,
        candle_time: new Date(FROM + seq * H),
        instrument_id: BTC,
        timeframe: '1h' as const,
        type: 'swing_confirmed' as const,
        entity_id: id(900 + seq),
        payload: JSON.stringify({
          key: `sw:1h:int:h:${FROM + seq * H}`,
          data: { price: `10${seq}${seq === 3 ? change : ''}` },
        }),
      })),
    )
    .execute();
}

beforeAll(async () => {
  h = await startApi();
  viewer = await tokenFor(h, await createUser(h, 'viewer'));
  analyst = await tokenFor(h, await createUser(h, 'analyst'));
  await owner
    .insertInto('analysis.detection_runs')
    .values([run(LIVE, 'live'), run(REPLAY, 'replay')])
    .execute();
  await seed(LIVE, 100);
  await seed(REPLAY, 200);
  await log(LIVE);
  await log(REPLAY);
  // Long ago: closures are global, and other suites list the ones around today.
  await owner
    .insertInto('market.underlying_market_closures')
    .values({
      calendar_id: 'gold',
      starts_at: new Date(CLOSED - 2 * H),
      ends_at: new Date(CLOSED + H),
      reason: 'weekend',
      source: 'manual',
    })
    .execute();
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await queue.obliterate({ force: true });
  await queue.close();
  queueConnection.disconnect();
  redis.disconnect();
  await h.close();
  await owner.destroy();
});

const get = (path: string, token = viewer) => call(h.base, 'GET', `/api/v1${path}`, { token });

describe('SMC endpoints', () => {
  it("lists one timeframe's swings, oldest first, from the live run", async () => {
    const res = await get(`/smc/${BTC}/swings?tf=1h`);
    expect(res.status).toBe(200);
    expect(res.body as SwingPoint[]).toEqual([
      {
        id: id(101),
        tf: '1h',
        kind: 'high',
        level: 'internal',
        price: '105.5',
        candleTime: FROM + 2 * H,
        confirmedAt: FROM + 5 * H,
        flags: ['warmup'],
      },
      {
        id: id(102),
        tf: '1h',
        kind: 'low',
        level: 'external',
        price: '99.25',
        candleTime: FROM + 6 * H,
        confirmedAt: FROM + 12 * H,
        flags: [],
      },
    ]);
    expect(
      ((await get(`/smc/${BTC}/swings?tf=1h&level=external`)).body as SwingPoint[]).map((s) => s.id),
    ).toEqual([id(102)]);
    expect(
      ((await get(`/smc/${BTC}/swings?tf=1h&from=${FROM + 3 * H}`)).body as SwingPoint[]).map((s) => s.id),
    ).toEqual([id(102)]);
    expect(((await get(`/smc/${BTC}/swings?tf=1h&limit=1`)).body as SwingPoint[]).map((s) => s.id)).toEqual([
      id(102),
    ]);
  });

  it('gives structure with its displacement, ranges overlapping a window, and sweeps with their level', async () => {
    const [bos] = (await get(`/smc/${BTC}/structure?tf=1h`)).body as StructureEvent[];
    expect(bos).toEqual({
      id: id(104),
      tf: '1h',
      level: 'internal',
      type: 'bos',
      direction: 'bullish',
      brokenSwingId: id(101),
      breakPrice: '105.5',
      breakCandleTime: FROM + 8 * H,
      isInitial: true,
      displacement: { from: FROM + 7 * H, to: FROM + 8 * H, bodyAtr: 2.4, createdFvg: true },
      flags: [],
    });
    const ranges = (await get(`/smc/${BTC}/ranges?tf=1h&from=${FROM + 10 * H}&to=${FROM + 30 * H}`))
      .body as TradingRange[];
    expect(ranges.map((r) => r.id)).toEqual([id(106)]);
    expect(((await get(`/smc/${BTC}/ranges?tf=1h`)).body as TradingRange[])[0]).toMatchObject({
      endedAt: FROM + 9 * H,
      endReason: 'breakout_up',
      equilibrium: '102',
    });
    const [sweep] = (await get(`/smc/${BTC}/sweeps?tf=1h`)).body as Sweep[];
    expect(sweep).toMatchObject({
      levelId: id(107),
      levelType: 'eql',
      groupId: id(111),
      breachAt: FROM + 10 * H,
      confirmedAt: FROM + 11 * H,
      notionalBeyondUsd: null,
      flags: ['liquidity_unverified'],
    });
  });

  it('lists the levels a timeframe shows: its own and longer origins, active unless asked', async () => {
    const levels = async (q: string) =>
      ((await get(`/smc/${BTC}/levels?${q}`)).body as LiquidityLevel[]).map((l) => l.type);
    expect(await levels('tf=1h')).toEqual(['pdh']);
    expect(await levels('tf=15m')).toEqual(['pdh', 'eqh']);
    expect(await levels('tf=1h&status=active,swept')).toEqual(['eql', 'pdh']);
    expect(await levels('tf=5m&types=eqh,eql&status=swept,active')).toEqual(['eql', 'eqh']);
    expect((await get(`/smc/${BTC}/levels?tf=1h&types=nope`)).status).toBe(400);
  });

  it('serves a whole chart overlay, a replay by runId, and nothing for an instrument never analysed', async () => {
    const overlay = (await get(`/smc/${BTC}/overlay?tf=1h&from=${FROM}&to=${FROM + 24 * H}`))
      .body as ChartOverlay;
    expect(overlay.run).toMatchObject({
      id: LIVE,
      status: 'running',
      profile: { name: 'crypto-majors', version: 2 },
    });
    expect(overlay.swings).toHaveLength(2);
    expect(overlay.structure).toHaveLength(1);
    expect(overlay.ranges).toHaveLength(2);
    expect(overlay.levels.map((l) => l.type)).toEqual(['eql', 'pdh']);
    expect(overlay.sweeps).toHaveLength(1);
    expect(overlay).toMatchObject({ zones: [], setups: [], closures: [] });
    const replay = (await get(`/smc/${BTC}/swings?tf=1h&runId=${REPLAY}`)).body as SwingPoint[];
    expect(replay.map((s) => s.id)).toEqual([id(201), id(202)]);
    expect((await get(`/smc/${BTC}/swings?tf=1h&runId=${id(999)}`)).status).toBe(404);
    expect((await get(`/smc/${ETH}/overlay?tf=1h`)).body).toMatchObject({
      run: null,
      swings: [],
      levels: [],
    });
    // A gold instrument's overlay carries the closures in its window.
    expect(
      ((await get(`/smc/${PAXG}/overlay?tf=1h&from=${CLOSED - 3 * H}&to=${CLOSED}`)).body as ChartOverlay)
        .closures,
    ).toEqual([{ from: CLOSED - 2 * H, to: CLOSED + H, reason: 'weekend' }]);
    expect((await get(`/smc/${BTC}/overlay?tf=1h&from=${FROM}&to=${FROM}`)).status).toBe(400);
    expect((await get(`/smc/${id(998)}/overlay?tf=1h`)).status).toBe(404);
  });
});

describe('replays', () => {
  const post = (body: unknown, token = analyst) => call(h.base, 'POST', '/api/v1/replays', { token, body });

  it('queues a replay for the analyzer and reports it queued', async () => {
    const res = await post({ instrumentId: BTC, from: FROM, to: FROM + 6 * H });
    expect(res.status).toBe(202);
    const { runId } = res.body as { runId: string };
    const job = await queue.getJob(runId);
    expect(job?.data).toMatchObject({ runId, instrumentId: BTC, from: FROM, to: FROM + 6 * H });
    expect((await get(`/replays/${runId}`)).body).toMatchObject({
      runId,
      status: 'queued',
      digest: null,
      comparison: null,
    });
    const audit = await owner
      .selectFrom('app.audit_log')
      .selectAll()
      .where('action', '=', 'replay.requested')
      .execute();
    expect(audit.at(-1)).toMatchObject({ target_id: BTC });
  });

  it('refuses a third concurrent replay, a future period and a bad request', async () => {
    expect((await post({ instrumentId: BTC, from: FROM, to: FROM + H })).status).toBe(202);
    expect((await post({ instrumentId: BTC, from: FROM, to: FROM + H })).status).toBe(429);
    expect((await post({ instrumentId: BTC, from: Date.now(), to: Date.now() + H }, viewer)).status).toBe(
      403,
    );
    await queue.obliterate({ force: true });
    expect((await post({ instrumentId: BTC, from: FROM, to: Date.now() + H })).status).toBe(400);
    expect((await post({ instrumentId: BTC, from: FROM + H, to: FROM })).status).toBe(400);
    expect((await get(`/replays/${id(997)}`)).status).toBe(404);
  });

  it("compares a completed replay's digest with the live run's over the same period", async () => {
    const body = (await get(`/replays/${REPLAY}`)).body as ReplayStatus;
    expect(body).toMatchObject({
      runId: REPLAY,
      status: 'completed',
      from: FROM,
      to: FROM + 10 * H,
      events: 3,
    });
    expect(body.comparison).toMatchObject({ liveRunId: LIVE, liveEvents: 3, replayEvents: 3, equal: true });
    expect(body.comparison!.liveDigest).toMatch(/^[0-9a-f]{64}$/);
    // A differing event makes the digests differ.
    await owner.deleteFrom('analysis.detection_events').where('run_id', '=', REPLAY).execute();
    await log(REPLAY, '.5');
    expect(((await get(`/replays/${REPLAY}`)).body as ReplayStatus).comparison).toMatchObject({
      equal: false,
    });
  });
});

describe('smc channel', () => {
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

  it('delivers SMC detections with their an:events id, and snapshots the active levels and ranges', async () => {
    const ch = `smc:${BTC}`;
    const socket = connect();
    await connected(socket);
    const messages: Envelope[] = [];
    socket.on('message', (m: Envelope) => messages.push(m));
    const ack = (await socket.emitWithAck('subscribe', { channels: [ch] })) as SubscribeAck;
    expect(ack.results[ch]!.mode).toBe('live');
    const sweep = {
      id: id(301),
      tf: '1h',
      levelId: id(107),
      levelType: 'eql',
      groupId: id(302),
      kind: 'wick',
      side: 'sell_side',
      levelPrice: '99.25',
      extremePrice: '98.9',
      penetrationAtr: 0.35,
      breachAt: FROM,
      confirmedAt: FROM + H,
      notionalBeyondUsd: null,
      flags: [],
    };
    const message: SmcEventMessage = {
      instrumentId: BTC,
      runId: LIVE,
      seq: 9,
      tf: '1h',
      time: FROM + H,
      type: 'sweep',
      data: sweep as Sweep,
    };
    const seq = await redis.xadd('an:events', '*', 'type', 'smc', 'data', JSON.stringify(message));
    await redis.xadd(
      'an:events',
      '*',
      'type',
      'smc',
      'data',
      JSON.stringify({ ...message, instrumentId: ETH }),
    );
    await expect.poll(() => messages.length).toBe(1);
    expect(messages[0]).toEqual({ ch, seq, ts: Number(seq!.split('-')[0]), type: 'sweep', data: sweep });

    const old = (await socket.emitWithAck('subscribe', {
      channels: [ch],
      since: { [ch]: '1-0' },
    })) as SubscribeAck;
    expect(old.results[ch]).toMatchObject({ mode: 'snapshot', snapshot: { run: { id: LIVE } } });
    const snapshot = old.results[ch]!.snapshot as { levels: LiquidityLevel[]; ranges: TradingRange[] };
    expect(snapshot.levels.map((l) => l.type)).toEqual(['pdh', 'eqh']);
    expect(snapshot.ranges.map((r) => r.id)).toEqual([id(106)]);
  });
});
