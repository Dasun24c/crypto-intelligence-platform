import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  type ChartOverlay,
  type Envelope,
  type LiquidityLevel,
  type PoiZone,
  REPLAY_QUEUE,
  type ReplayJob,
  type ReplayStatus,
  type SetupDetail,
  type SetupSummary,
  type SetupTransitionMessage,
  type SmcEventMessage,
  type StructureEvent,
  type SubscribeAck,
  type Sweep,
  type SwingPoint,
  type TradingRange,
  WS_NAMESPACE,
  WS_PATH,
} from '@cip/contracts';
import { createDb, LAUNCH_PROFILE_IDS, type NewPoiZone } from '@cip/db';
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
  // Zones (Phase 5): a 1h order block and a linked demand zone, an invalidated 15m FVG, a 5m FVG.
  const zone = (
    n: number,
    tf: '5m' | '15m' | '1h',
    type: 'order_block' | 'fvg' | 'demand',
    over: Partial<NewPoiZone> & Pick<NewPoiZone, 'top' | 'bottom' | 'known_at'>,
  ): NewPoiZone => ({
    id: id(base + n),
    run_id: runId,
    instrument_id: BTC,
    timeframe: tf,
    type,
    direction: 'bullish' as const,
    origin_from: new Date(FROM + 6 * H),
    origin_to: new Date(FROM + 7 * H),
    status: 'untouched' as const,
    flags: [],
    ...over,
  });
  await owner
    .insertInto('analysis.poi_zones')
    .values([
      zone(20, '1h', 'order_block', {
        top: '104.5',
        bottom: '103',
        known_at: new Date(FROM + 9 * H),
        htf: true,
        structure_event_id: id(base + 4),
        status: 'partially_filled',
        fill_pct: 37.5,
        first_touch_at: new Date(FROM + 12 * H),
        status_changed_at: new Date(FROM + 12 * H),
      }),
      zone(21, '1h', 'demand', {
        top: '104.2',
        bottom: '103.2',
        known_at: new Date(FROM + 10 * H),
        linked_zone_id: id(base + 20),
      }),
      zone(22, '15m', 'fvg', {
        direction: 'bearish',
        top: '106.4',
        bottom: '106',
        known_at: new Date(FROM + 10 * H),
        status: 'invalidated',
        fill_pct: 100,
        first_touch_at: new Date(FROM + 11 * H),
        status_changed_at: new Date(FROM + 11 * H),
      }),
      zone(23, '5m', 'fvg', { top: '101', bottom: '100.5', known_at: new Date(FROM + 2 * H) }),
    ])
    .execute();
  await owner
    .updateTable('analysis.poi_zones')
    .set({ linked_zone_id: id(base + 21) })
    .where('id', '=', id(base + 20))
    .execute();
  await seedSetups(runId, base);
}

/**
 * Setups (Phase 6): a confirmed bullish Pattern 1 on 5m (entry zone the 5m FVG, T1 the pdh level),
 * a bearish Pattern 4 on 5m that reached its target, and a Pattern 2 forming on 15m.
 */
async function seedSetups(runId: string, base: number): Promise<void> {
  const setup = (n: number, over: Record<string, unknown>) => ({
    id: id(base + n),
    run_id: runId,
    instrument_id: BTC,
    variant: null,
    context_tf: '1h',
    setup_tf: '5m',
    resolution: null,
    entry_zone_id: null,
    entry_price: null,
    invalidation_price: null,
    target1_price: null,
    target2_price: null,
    target1_ref: null,
    target2_ref: null,
    rr_target1: null,
    mandatory_passed: false,
    quality_flags: ['liquidity_unverified'],
    flags: [],
    refs: JSON.stringify({ sweeps: [], mss: null, rangeId: null, poiId: null, levelIds: [] }),
    resolved_candle_time: null,
    ...over,
  });
  await owner
    .insertInto('analysis.setups')
    .values([
      setup(30, {
        pattern: 'double_liquidity_trap',
        variant: 'A',
        direction: 'bullish',
        state: 'confirmed',
        entry_zone_id: id(base + 23),
        entry_price: '101',
        invalidation_price: '99.8',
        target1_price: '107',
        target1_ref: JSON.stringify({ kind: 'level', id: id(base + 8), price: '107' }),
        rr_target1: 5,
        confluence_score: 77.5,
        mandatory_passed: true,
        refs: JSON.stringify({
          sweeps: [id(base + 10)],
          mss: {
            anchorId: id(base + 1),
            anchorPrice: '105.5',
            breakCandleTime: FROM + 115 * 60_000,
            displacement: { from: FROM + 115 * 60_000, to: FROM + 115 * 60_000, bodyAtr: 1.8 },
            structureEventId: id(base + 4),
          },
          rangeId: id(base + 6),
          poiId: null,
          levelIds: [id(base + 7), id(base + 8)],
        }),
        created_candle_time: new Date(FROM + H),
        updated_candle_time: new Date(FROM + 2 * H),
      }),
      setup(31, {
        pattern: 'sweep_outside_fill_inside',
        direction: 'bearish',
        state: 'resolved',
        resolution: 'target_reached',
        entry_price: '104',
        invalidation_price: '105',
        target1_price: '102',
        rr_target1: 2,
        confluence_score: 70,
        mandatory_passed: true,
        created_candle_time: new Date(FROM + 3 * H),
        updated_candle_time: new Date(FROM + 5 * H),
        resolved_candle_time: new Date(FROM + 5 * H),
      }),
      setup(32, {
        pattern: 'eq_near_poi',
        direction: 'bearish',
        context_tf: '4h',
        setup_tf: '15m',
        state: 'forming',
        confluence_score: 5,
        quality_flags: [],
        created_candle_time: new Date(FROM + 6 * H),
        updated_candle_time: new Date(FROM + 6 * H),
      }),
    ] as never)
    .execute();
  const transition = (
    n: number,
    seq: number,
    from: string | null,
    to: string,
    at: number,
    reason: string,
  ) => ({
    setup_id: id(base + n),
    event_seq: seq,
    from_state: from,
    to_state: to,
    candle_time: new Date(at - 5 * 60_000),
    decided_at: new Date(at),
    processed_at: new Date(at + 1_000),
    reason,
    evidence: JSON.stringify(reason === 'mss_confirmed' ? { entryZone: 'zn' } : {}),
  });
  await owner
    .insertInto('analysis.setup_transitions')
    .values([
      transition(30, 10, null, 'forming', FROM + H, 'preconditions'),
      transition(30, 11, 'forming', 'triggered', FROM + 90 * 60_000, 'sweeps_A'),
      transition(30, 12, 'triggered', 'confirmed', FROM + 2 * H, 'mss_confirmed'),
      transition(31, 13, null, 'forming', FROM + 3 * H, 'preconditions'),
      transition(31, 14, 'entry_active', 'resolved', FROM + 5 * H, 'target1_reached'),
      transition(32, 15, null, 'forming', FROM + 6 * H, 'preconditions'),
    ])
    .execute();
  const items = [
    'htf_bias',
    'liquidity_marked',
    'poi_present',
    'sweep',
    'mss',
    'levels_defined',
    'risk_reward',
    'news_clear',
  ];
  const weights = [15, 10, 15, 15, 20, 5, 15, 5];
  const credits = [0.5, 1, 0.5, 1, 1, 1, 1, 0];
  await owner
    .insertInto('analysis.setup_checklist_results')
    .values([
      ...items.map((item, i) => ({
        setup_id: id(base + 30),
        state: 'confirmed',
        item,
        credit: credits[i]!,
        weight: weights[i]!,
        mandatory: ['sweep', 'mss', 'levels_defined'].includes(item),
        evidence: JSON.stringify(item === 'news_clear' ? { reason: 'calendar_unavailable' } : {}),
      })),
      ...items.map((item, i) => ({
        setup_id: id(base + 30),
        state: 'forming',
        item,
        credit: item === 'news_clear' ? 0 : i === 0 ? 0.5 : 0,
        weight: weights[i]!,
        mandatory: ['sweep', 'mss', 'levels_defined'].includes(item),
        evidence: JSON.stringify({}),
      })),
    ])
    .execute();
  await owner
    .insertInto('analysis.setup_outcomes')
    .values({
      setup_id: id(base + 31),
      entry_touched_at: new Date(FROM + 4 * H),
      resolved_at: new Date(FROM + 5 * H),
      result: 'target_reached',
      mfe_r: 1.25,
      mae_r: 0.2,
      bars_held: 13,
      resolved_with_tf: null,
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

  it('lists the zones a timeframe shows: its own and longer, live unless asked', async () => {
    const zones = async (q: string) => (await get(`/smc/${BTC}/zones?${q}`)).body as PoiZone[];
    const [ob, demand] = await zones('tf=1h');
    expect(ob).toEqual({
      id: id(120),
      tf: '1h',
      type: 'order_block',
      direction: 'bullish',
      top: '104.5',
      bottom: '103',
      originFrom: FROM + 6 * H,
      originTo: FROM + 7 * H,
      knownAt: FROM + 9 * H,
      htf: true,
      location: 'none',
      status: 'partially_filled',
      fillPct: 37.5,
      firstTouchAt: FROM + 12 * H,
      statusChangedAt: FROM + 12 * H,
      structureEventId: id(104),
      linkedZoneId: id(121),
      sweptLiquidityAtOrigin: false,
      flags: [],
    });
    expect(demand).toMatchObject({ id: id(121), type: 'demand', linkedZoneId: id(120), fillPct: 0 });
    expect((await zones('tf=15m')).map((z) => z.id)).toEqual([id(120), id(121)]);
    expect((await zones('tf=15m&status=invalidated')).map((z) => [z.id, z.fillPct])).toEqual([
      [id(122), 100],
    ]);
    expect((await zones('tf=5m&types=fvg')).map((z) => z.id)).toEqual([id(123)]);
    expect((await zones(`tf=1h&runId=${REPLAY}`)).map((z) => z.id)).toEqual([id(220), id(221)]);
    expect((await get(`/smc/${BTC}/zones?tf=1h&status=swept`)).status).toBe(400);
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
      profile: { name: 'crypto-majors', version: 4 },
    });
    expect(overlay.swings).toHaveLength(2);
    expect(overlay.structure).toHaveLength(1);
    expect(overlay.ranges).toHaveLength(2);
    expect(overlay.levels.map((l) => l.type)).toEqual(['eql', 'pdh']);
    expect(overlay.sweeps).toHaveLength(1);
    expect(overlay).toMatchObject({ setups: [], closures: [] });
    // The 1h chart shows the live 1h zones (the 15m and 5m ones belong to shorter charts).
    expect(overlay.zones.map((z) => [z.id, z.type, z.status])).toEqual([
      [id(120), 'order_block', 'partially_filled'],
      [id(121), 'demand', 'untouched'],
    ]);
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
    const snapshot = old.results[ch]!.snapshot as {
      levels: LiquidityLevel[];
      ranges: TradingRange[];
      zones: PoiZone[];
    };
    expect(snapshot.zones.map((z) => z.id)).toEqual([id(123), id(120), id(121)]);
    expect(snapshot.levels.map((l) => l.type)).toEqual(['pdh', 'eqh']);
    expect(snapshot.ranges.map((r) => r.id)).toEqual([id(106)]);
  });

  it('delivers setup transitions on setups:{id} and setups, and snapshots the setups not resolved', async () => {
    const own = `setups:${BTC}`;
    const socket = connect();
    await connected(socket);
    const messages: Envelope[] = [];
    socket.on('message', (m: Envelope) => messages.push(m));
    const ack = (await socket.emitWithAck('subscribe', { channels: [own, 'setups'] })) as SubscribeAck;
    expect([ack.results[own]!.mode, ack.results.setups!.mode]).toEqual(['live', 'live']);
    const message = {
      ...((await get(`/setups?instrumentId=${BTC}&state=confirmed`)).body as { items: SetupSummary[] })
        .items[0]!,
      transition: {
        from: 'triggered',
        to: 'confirmed',
        reason: 'mss_confirmed',
        candleTime: FROM + 115 * 60_000,
        decidedAt: FROM + 2 * H,
        processedAt: FROM + 2 * H + 900,
        late: false,
        evidence: {},
      },
    } as SetupTransitionMessage;
    const seq = await redis.xadd('an:events', '*', 'type', 'setup', 'data', JSON.stringify(message));
    await redis.xadd(
      'an:events',
      '*',
      'type',
      'setup',
      'data',
      JSON.stringify({ ...message, instrumentId: ETH }),
    );
    // BTC's transition reaches both channels; ETH's only the one for every instrument.
    await expect.poll(() => messages.length).toBe(3);
    const ts = Number(seq!.split('-')[0]);
    expect(
      messages
        .slice(0, 2)
        .map((m) => m.ch)
        .sort(),
    ).toEqual(['setups', own].sort());
    expect(messages[0]).toMatchObject({ seq, ts, type: 'setup.transition', data: message });
    expect(messages[2]).toMatchObject({ ch: 'setups', data: { instrumentId: ETH } });

    // Replayed after a reconnect, and a snapshot when the stream no longer holds the point.
    const replayed: Envelope[] = [];
    const again = connect();
    await connected(again);
    again.on('message', (m: Envelope) => replayed.push(m));
    const before = `${ts - 1}-0`;
    const r = (await again.emitWithAck('subscribe', {
      channels: [own],
      since: { [own]: before },
    })) as SubscribeAck;
    expect(r.results[own]!.mode).toBe('replayed');
    await expect.poll(() => replayed.length).toBe(1);
    const old = (await socket.emitWithAck('subscribe', {
      channels: [own],
      since: { [own]: '1-0' },
    })) as SubscribeAck;
    const snapshot = old.results[own]!.snapshot as {
      setups: SetupSummary[];
      transitions: { setupId: string; to: string }[];
    };
    expect(snapshot.setups.map((s) => [s.id, s.displayLabel])).toEqual([
      [id(132), 'Watching'],
      [id(130), 'Confirmed'],
    ]);
    expect(snapshot.transitions.map((t) => [t.setupId, t.to])).toEqual([
      [id(132), 'forming'],
      [id(131), 'resolved'],
      [id(131), 'forming'],
      [id(130), 'confirmed'],
      [id(130), 'triggered'],
      [id(130), 'forming'],
    ]);
  });
});

describe('setups', () => {
  const list = async (query: string) => {
    const res = await get(`/setups?instrumentId=${BTC}${query}`);
    expect(res.status).toBe(200);
    return res.body as { items: SetupSummary[]; nextCursor: string | null };
  };

  it('lists the live run’s setups, newest change first, filtered and paged', async () => {
    const all = await list('');
    expect(all.items.map((s) => [s.id, s.pattern, s.state, s.displayLabel])).toEqual([
      [id(132), 'eq_near_poi', 'forming', 'Watching'],
      [id(131), 'sweep_outside_fill_inside', 'resolved', 'Resolved'],
      [id(130), 'double_liquidity_trap', 'confirmed', 'Confirmed'],
    ]);
    expect(all.items[2]).toMatchObject({
      runId: LIVE,
      variant: 'A',
      direction: 'bullish',
      contextTf: '1h',
      setupTf: '5m',
      levels: { entry: '101', invalidation: '99.8', target1: '107', target2: null, rr: 5 },
      score: 77.5,
      mandatoryPassed: true,
      qualityFlags: ['liquidity_unverified'],
      createdAt: FROM + H,
      updatedAt: FROM + 2 * H,
      resolvedAt: null,
      disclaimer: 'Educational analysis — not financial advice',
    });
    expect((await list('&state=confirmed,resolved')).items.map((s) => s.id)).toEqual([id(131), id(130)]);
    expect((await list('&pattern=eq_near_poi')).items.map((s) => s.id)).toEqual([id(132)]);
    expect((await list('&direction=bullish')).items.map((s) => s.id)).toEqual([id(130)]);
    expect((await list('&minScore=70')).items.map((s) => s.id)).toEqual([id(131), id(130)]);
    expect((await list(`&from=${FROM + 4 * H}&to=${FROM + 7 * H}`)).items.map((s) => s.id)).toEqual([
      id(132),
      id(131),
    ]);
    const page = await list('&limit=2');
    expect(page.items.map((s) => s.id)).toEqual([id(132), id(131)]);
    const next = await list(`&limit=2&cursor=${page.nextCursor}`);
    expect([next.items.map((s) => s.id), next.nextCursor]).toEqual([[id(130)], null]);
    expect((await list(`&runId=${REPLAY}`)).items.map((s) => s.id)).toEqual([id(232), id(231), id(230)]);
    expect((await get(`/setups?pattern=head_and_shoulders`)).status).toBe(400);
    expect((await get(`/setups?instrumentId=${id(998)}`)).status).toBe(404);
    expect((await get(`/setups?runId=${id(997)}`)).status).toBe(404);
  });

  it('gives one setup in full: transitions, checklist, outcome and what it refers to', async () => {
    const res = await get(`/setups/${id(130)}`);
    expect(res.status).toBe(200);
    const d = res.body as SetupDetail;
    expect(d.transitions.map((t) => [t.from, t.to, t.reason, t.decidedAt - t.candleTime, t.late])).toEqual([
      [null, 'forming', 'preconditions', 300_000, false],
      ['forming', 'triggered', 'sweeps_A', 300_000, false],
      ['triggered', 'confirmed', 'mss_confirmed', 300_000, false],
    ]);
    expect(d.checklist.map((c) => [c.item, c.credit])).toEqual([
      ['htf_bias', 0.5],
      ['liquidity_marked', 1],
      ['poi_present', 0.5],
      ['sweep', 1],
      ['mss', 1],
      ['levels_defined', 1],
      ['risk_reward', 1],
      ['news_clear', 0],
    ]);
    expect(d.checklist.at(-1)!.evidence).toEqual({ reason: 'calendar_unavailable' });
    expect(Object.keys(d.checklistByState).sort()).toEqual(['confirmed', 'forming']);
    expect(d.outcome).toBeNull();
    expect(d.targets).toEqual({ target1: { kind: 'level', id: id(108), price: '107' }, target2: null });
    expect(d.refs.sweeps.map((s) => s.id)).toEqual([id(110)]);
    expect(d.refs.mss).toMatchObject({
      anchorId: id(101),
      anchorPrice: '105.5',
      structureEvent: { id: id(104) },
    });
    expect(d.refs.entryZone?.id).toBe(id(123));
    expect(d.refs.levels.map((l) => l.id)).toEqual([id(107), id(108)]);
    expect(d.refs.range?.id).toBe(id(106));
    expect(d.refs.poi).toBeNull();
    const resolved = (await get(`/setups/${id(131)}`)).body as SetupDetail;
    expect(resolved.outcome).toEqual({
      result: 'target_reached',
      entryTouchedAt: FROM + 4 * H,
      resolvedAt: FROM + 5 * H,
      mfeR: 1.25,
      maeR: 0.2,
      barsHeld: 13,
      resolvedWithTf: null,
    });
    expect((await get(`/setups/${id(996)}`)).status).toBe(404);
    expect((await get('/setups/nope')).status).toBe(400);
  });

  it('puts the setups alive in a window on the overlay of their setup timeframe', async () => {
    const overlay = (await get(`/smc/${BTC}/overlay?tf=5m&from=${FROM}&to=${FROM + 10 * H}`))
      .body as ChartOverlay;
    expect(overlay.setups.map((s) => s.id)).toEqual([id(130), id(131)]);
    // Resolved before the window: not shown.
    const later = (await get(`/smc/${BTC}/overlay?tf=5m&from=${FROM + 6 * H}&to=${FROM + 10 * H}`))
      .body as ChartOverlay;
    expect(later.setups.map((s) => s.id)).toEqual([id(130)]);
    const m15 = (await get(`/smc/${BTC}/overlay?tf=15m&from=${FROM}&to=${FROM + 10 * H}`))
      .body as ChartOverlay;
    expect(m15.setups.map((s) => s.id)).toEqual([id(132)]);
  });
});
