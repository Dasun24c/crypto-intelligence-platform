import { Queue } from 'bullmq';
import { sql } from 'kysely';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  HISTORICAL_NOTICE,
  HISTORICAL_OBSERVATIONS,
  OUTCOME_RESULTS,
  REPLAY_QUEUE,
  type ReplayJob,
  replaySettingsOf,
  type ReplayStatus,
  type ReplaySummary,
  STATS_DIMENSIONS,
  type SetupStats,
  type SetupStatsRow,
  type StatsDimension,
} from '@cip/contracts';
import { createDb, LAUNCH_PROFILE_IDS } from '@cip/db';
import { call, createUser, type Harness, startApi, tokenFor } from './harness.ts';

/**
 * Phase 12 (ADR 026): outcome statistics (criterion 12.1: they reconcile with direct database
 * queries), their labels (12.2), replays with changed settings and run comparisons (12.3), and the
 * audited CSV exports. Rows live on two Coinbase pairs in March 2025, away from the other suites'.
 */
const X = '019a6f00-0000-7000-8000-000000000005'; // Coinbase BTC-USD
const Y = '019a6f00-0000-7000-8000-000000000007'; // Coinbase SOL-USD
const V4 = LAUNCH_PROFILE_IDS['crypto-majors'];
const H = 3_600_000;
const W = Date.UTC(2025, 2, 3); // a Monday: the statistics' window is (W, W + 48 h]
const TO = W + 48 * H;
// Ids of their own: other suites in this database use the c0…, d0…, ca… and cb… ranges.
const id = (n: number) => `019a6f00-0000-7000-8000-${(0x120000 + n).toString(16).padStart(12, '0')}`;
const L1 = id(1); // live, X, rules r1: superseded
const L2 = id(2); // live, X, rules r1: running (overlaps L1)
const L3 = id(3); // live, Y, rules r2
const R1 = id(4); // replay of X with minRR 3
const R2 = id(5); // replay of X that changed nothing

let h: Harness;
let viewer: string;
let analyst: string;
let analystId: string;
let v4Params: { smc: { setups: { checklist: { minRR: number } } } };
const owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 2 });
const queueConnection = new Redis(inject('redisUrl'), { maxRetriesPerRequest: null });
const queue = new Queue<ReplayJob>(REPLAY_QUEUE, { connection: queueConnection, prefix: 'cip' });

const get = (path: string, token = viewer) => call(h.base, 'GET', `/api/v1${path}`, { token });
async function text(
  path: string,
  token = viewer,
): Promise<{ status: number; body: string; headers: Headers }> {
  const res = await fetch(`${h.base}/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.text(), headers: res.headers };
}

interface SeedSetup {
  n: number;
  run: string;
  instrument: string;
  pattern: 'double_liquidity_trap' | 'eq_near_poi' | 'htf_order_block' | 'sweep_outside_fill_inside';
  variant?: 'A' | 'B';
  direction: 'bullish' | 'bearish';
  tfs: ['1h', '5m'] | ['4h', '15m'];
  at: number;
  state: 'forming' | 'triggered' | 'confirmed' | 'entry_active' | 'resolved';
  resolution?:
    'target_reached' | 'invalidated' | 'expired_no_entry' | 'expired_open' | 'ambiguous' | 'expired';
  outcome?: { result: string; entered: boolean; mfe?: number; mae?: number };
}

const SOFI = 'sweep_outside_fill_inside' as const;
/** The rows, with the session each starts in (by its candle's UTC hour) noted. */
const SETUPS: SeedSetup[] = [
  // L1: from W + 12 h. s1, s2 found while warming up; s3, s4 live.
  {
    n: 1,
    run: L1,
    instrument: X,
    pattern: SOFI,
    direction: 'bullish',
    tfs: ['1h', '5m'],
    at: W + H,
    state: 'resolved',
    resolution: 'target_reached',
    outcome: { result: 'target_reached', entered: true, mfe: 2.5, mae: 0.4 },
  }, // asia
  {
    n: 2,
    run: L1,
    instrument: X,
    pattern: 'double_liquidity_trap',
    variant: 'A',
    direction: 'bearish',
    tfs: ['4h', '15m'],
    at: W + 8 * H,
    state: 'resolved',
    resolution: 'invalidated',
    outcome: { result: 'invalidated', entered: true, mfe: 0.3, mae: 1.1 },
  }, // london (07:45–08:00)
  {
    n: 3,
    run: L1,
    instrument: X,
    pattern: 'htf_order_block',
    direction: 'bullish',
    tfs: ['1h', '5m'],
    at: W + 14 * H,
    state: 'triggered',
  }, // new_york
  {
    n: 4,
    run: L1,
    instrument: X,
    pattern: 'eq_near_poi',
    direction: 'bearish',
    tfs: ['1h', '5m'],
    at: W + 22 * H,
    state: 'confirmed',
  }, // outside (21:55–22:00)
  {
    n: 13,
    run: L1,
    instrument: X,
    pattern: SOFI,
    direction: 'bullish',
    tfs: ['1h', '5m'],
    at: W,
    state: 'forming',
  }, // at `from`: not counted
  // L2: the same rules as L1, from W + 30 h. Its copy of s3 is the one counted (the newer run).
  {
    n: 23,
    run: L2,
    instrument: X,
    pattern: 'htf_order_block',
    direction: 'bullish',
    tfs: ['1h', '5m'],
    at: W + 14 * H,
    state: 'resolved',
    resolution: 'expired',
  },
  {
    n: 5,
    run: L2,
    instrument: X,
    pattern: SOFI,
    direction: 'bullish',
    tfs: ['1h', '5m'],
    at: W + 33 * H,
    state: 'entry_active',
  }, // london
  {
    n: 6,
    run: L2,
    instrument: X,
    pattern: SOFI,
    direction: 'bearish',
    tfs: ['4h', '15m'],
    at: W + 35 * H,
    state: 'resolved',
    resolution: 'expired_open',
    outcome: { result: 'expired_open', entered: true, mfe: 1.2, mae: 0.8 },
  }, // london
  {
    n: 7,
    run: L2,
    instrument: X,
    pattern: 'double_liquidity_trap',
    variant: 'B',
    direction: 'bullish',
    tfs: ['1h', '5m'],
    at: W + 40 * H,
    state: 'resolved',
    resolution: 'expired_no_entry',
    outcome: { result: 'expired_no_entry', entered: false },
  }, // new_york
  {
    n: 8,
    run: L2,
    instrument: X,
    pattern: 'htf_order_block',
    direction: 'bearish',
    tfs: ['4h', '15m'],
    at: W + 41 * H,
    state: 'resolved',
    resolution: 'ambiguous',
    outcome: { result: 'ambiguous', entered: true, mfe: 0.9, mae: 0.9 },
  }, // new_york
  {
    n: 12,
    run: L2,
    instrument: X,
    pattern: SOFI,
    direction: 'bullish',
    tfs: ['1h', '5m'],
    at: W + 50 * H,
    state: 'forming',
  }, // after `to`: not counted
  // L3: Y under other rules, from W + 6 h.
  {
    n: 9,
    run: L3,
    instrument: Y,
    pattern: SOFI,
    direction: 'bullish',
    tfs: ['1h', '5m'],
    at: W + 3 * H,
    state: 'resolved',
    resolution: 'target_reached',
    outcome: { result: 'target_reached', entered: true, mfe: 3.0, mae: 0.2 },
  }, // asia
  {
    n: 10,
    run: L3,
    instrument: Y,
    pattern: SOFI,
    direction: 'bullish',
    tfs: ['1h', '5m'],
    at: W + 20 * H,
    state: 'forming',
  }, // new_york
  // R1: a replay's own setup, counted only when asked for by runId.
  {
    n: 11,
    run: R1,
    instrument: X,
    pattern: SOFI,
    direction: 'bullish',
    tfs: ['1h', '5m'],
    at: W + H,
    state: 'resolved',
    resolution: 'invalidated',
    outcome: { result: 'invalidated', entered: true, mfe: 0.1, mae: 1.0 },
  },
];

const ORIGINS = { '1m': W - 7 * 24 * H, '1h': W - 40 * 24 * H };

function runRow(
  runId: string,
  o: {
    mode: 'live' | 'replay';
    instrument: string;
    rules: string;
    from: number;
    started: number;
    status: 'running' | 'superseded' | 'completed';
    to?: number;
    settings?: object;
    params?: object;
    source?: string;
  },
) {
  return {
    id: runId,
    mode: o.mode,
    instrument_id: o.instrument,
    profile_id: V4,
    ruleset_version: o.rules,
    params_hash: o.params ? 'h-changed' : 'h-v4',
    from_time: new Date(o.from),
    to_time: o.to === undefined ? null : new Date(o.to),
    series_origins: ORIGINS,
    status: o.status,
    started_at: new Date(o.started),
    finished_at: o.status === 'running' ? null : new Date(o.started + H),
    result_digest: o.mode === 'replay' ? 'stored' : null,
    source_run_id: o.source ?? null,
    settings: o.settings ? JSON.stringify(o.settings) : null,
    params: o.params ? JSON.stringify(o.params) : null,
  };
}

/** A `setup_transition` event's data (the whole setup), as the engine emits it. */
function transition(o: {
  pattern: string;
  direction: string;
  tfs: [string, string];
  createdAt: number;
  to: string;
  score: number;
}) {
  return {
    pattern: o.pattern,
    variant: null,
    direction: o.direction,
    contextTf: o.tfs[0],
    setupTf: o.tfs[1],
    from: null,
    to: o.to,
    reason: 'test',
    resolution: null,
    createdAt: o.createdAt,
    score: o.score,
    mandatoryPassed: true,
  };
}

type EventSpec = {
  seq: number;
  at: number;
  tf: '1h' | '5m' | '15m';
  type: string;
  key: string;
  data: object;
};
async function events(runId: string, list: EventSpec[]): Promise<void> {
  await owner
    .insertInto('analysis.detection_events')
    .values(
      list.map((e) => ({
        run_id: runId,
        seq: e.seq,
        candle_time: new Date(e.at),
        instrument_id: X,
        timeframe: e.tf,
        type: e.type as 'swing_confirmed',
        entity_id: id(500 + e.seq),
        payload: JSON.stringify({ key: e.key, data: e.data }),
      })),
    )
    .execute();
}

const SWING: EventSpec = {
  seq: 1,
  at: W + 2 * H,
  tf: '1h',
  type: 'swing_confirmed',
  key: 'sw:1h:int:h:1',
  data: { price: '101' },
};
const S = (score: number): EventSpec => ({
  seq: 2,
  at: W + 3 * H,
  tf: '5m',
  type: 'setup_transition',
  key: 'su:S',
  data: transition({
    pattern: SOFI,
    direction: 'bullish',
    tfs: ['1h', '5m'],
    createdAt: W + 2 * H,
    to: 'confirmed',
    score,
  }),
});
const S2: EventSpec = {
  seq: 3,
  at: W + 4 * H,
  tf: '15m',
  type: 'setup_transition',
  key: 'su:S2',
  data: transition({
    pattern: 'htf_order_block',
    direction: 'bearish',
    tfs: ['4h', '15m'],
    createdAt: W + 4 * H,
    to: 'forming',
    score: 30,
  }),
};
const LEVEL: EventSpec = {
  seq: 3,
  at: W + 5 * H,
  tf: '15m',
  type: 'level_created',
  key: 'lv:15m:1',
  data: { price: '99' },
};
// Two transitions of one setup on the same candle, the same in both runs: matched in order.
const S3 = (seq: number, to: string): EventSpec => ({
  seq,
  at: W + 6 * H,
  tf: '5m',
  type: 'setup_transition',
  key: 'su:S3',
  data: transition({
    pattern: SOFI,
    direction: 'bearish',
    tfs: ['1h', '5m'],
    createdAt: W + 5 * H,
    to,
    score: 50,
  }),
});

beforeAll(async () => {
  h = await startApi();
  viewer = await tokenFor(h, await createUser(h, 'viewer'));
  const a = await createUser(h, 'analyst');
  analystId = a.id;
  analyst = await tokenFor(h, a);
  const profile = await owner
    .selectFrom('market.instrument_profiles')
    .select('params')
    .where('id', '=', V4)
    .executeTakeFirstOrThrow();
  v4Params = profile.params as typeof v4Params;
  const changed = structuredClone(v4Params);
  changed.smc.setups.checklist.minRR = 3;
  await owner
    .insertInto('analysis.detection_runs')
    .values([
      runRow(L1, {
        mode: 'live',
        instrument: X,
        rules: 'r1',
        from: W + 12 * H,
        started: W - 24 * H,
        status: 'superseded',
        to: W + 30 * H,
      }),
      runRow(L2, {
        mode: 'live',
        instrument: X,
        rules: 'r1',
        from: W + 30 * H,
        started: W + 30 * H,
        status: 'running',
      }),
      runRow(L3, {
        mode: 'live',
        instrument: Y,
        rules: 'r2',
        from: W + 6 * H,
        started: W + 6 * H,
        status: 'running',
      }),
    ])
    .execute();
  await owner
    .insertInto('analysis.detection_runs')
    .values([
      runRow(R1, {
        mode: 'replay',
        instrument: X,
        rules: 'r1',
        from: W,
        to: W + 40 * H,
        started: W + 60 * H,
        status: 'completed',
        settings: { minRR: 3 },
        params: changed,
        source: L2,
      }),
      runRow(R2, {
        mode: 'replay',
        instrument: X,
        rules: 'r1',
        from: W,
        to: W + 40 * H,
        started: W + 61 * H,
        status: 'completed',
        source: L2,
      }),
    ])
    .execute();
  await owner
    .insertInto('analysis.setups')
    .values(
      SETUPS.map((s) => ({
        id: id(100 + s.n),
        run_id: s.run,
        instrument_id: s.instrument,
        pattern: s.pattern,
        variant: s.variant ?? null,
        direction: s.direction,
        context_tf: s.tfs[0],
        setup_tf: s.tfs[1],
        state: s.state,
        resolution: s.resolution ?? null,
        entry_zone_id: null,
        entry_price: null,
        invalidation_price: null,
        target1_price: null,
        target2_price: null,
        target1_ref: null,
        target2_ref: null,
        rr_target1: null,
        refs: '{}',
        confluence_score: '75',
        mandatory_passed: true,
        created_candle_time: new Date(s.at),
        updated_candle_time: new Date(s.at + H),
        resolved_candle_time: s.state === 'resolved' ? new Date(s.at + 2 * H) : null,
      })),
    )
    .execute();
  await owner
    .insertInto('analysis.setup_outcomes')
    .values(
      SETUPS.filter((s) => s.outcome).map((s) => ({
        setup_id: id(100 + s.n),
        entry_touched_at: s.outcome!.entered ? new Date(s.at + H / 2) : null,
        resolved_at: new Date(s.at + 2 * H),
        result: s.outcome!.result as 'target_reached',
        mfe_r: s.outcome!.mfe ?? null,
        mae_r: s.outcome!.mae ?? null,
        bars_held: s.outcome!.entered ? 12 : null,
        resolved_with_tf: s.outcome!.result === 'ambiguous' ? ('1m' as const) : null,
      })),
    )
    .execute();
  // The live run L2 has analysed past the replays' period (its latest 1m candle).
  await owner
    .insertInto('analysis.indicator_values')
    .values({
      instrument_id: X,
      timeframe: '1m',
      open_time: new Date(W + 48 * H),
      run_id: L2,
      ...nullIndicators(),
    })
    .execute();
  await events(L2, [SWING, S(80), S2, S3(4, 'triggered'), S3(5, 'confirmed')]);
  await events(R1, [SWING, S(65), LEVEL, S3(4, 'triggered'), S3(5, 'confirmed')]);
  await events(R2, [SWING, S(80), S2, S3(4, 'triggered'), S3(5, 'confirmed')]);
});

function nullIndicators() {
  return {
    rsi: null,
    macd: null,
    macd_signal: null,
    macd_hist: null,
    ema_fast: null,
    ema_mid: null,
    ema_slow: null,
    vwap: null,
    atr: null,
    volume_z: null,
    volume_anomaly: null,
    trend: null,
    trend_strength: null,
  };
}

afterAll(async () => {
  await h.close();
  await queue.close();
  queueConnection.disconnect();
  await owner.destroy();
});

// ── The oracle: what the statistics must be, from a direct query of the stored rows ─────────────

interface Fact {
  id: string;
  run_id: string;
  mode: 'live' | 'replay';
  instrument_id: string;
  pattern: string;
  variant: string | null;
  direction: string;
  context_tf: string;
  setup_tf: string;
  state: string;
  created: Date;
  run_from: Date;
  started_at: Date;
  ruleset_version: string;
  params_hash: string;
  changed: boolean;
  profile_name: string;
  profile_version: number;
  sessions: { name: string; start: string; end: string }[] | null;
  result: string | null;
  entry_touched_at: Date | null;
  mfe_r: number | null;
  mae_r: number | null;
}

/**
 * Every setup in (from, to] with its run, profile and outcome, straight from the tables; the rest
 * (which runs, found when, the overlap between runs, the session, the counts) is worked out here
 * in plain code, independently of the endpoint's SQL.
 */
async function oracle(q: {
  groupBy: StatsDimension[];
  from: number;
  to: number;
  found?: 'all' | 'live' | 'warmup';
  instrumentId?: string;
  runId?: string;
}) {
  const { rows } = await sql<Fact>`
    SELECT s.id, s.run_id, r.mode, s.instrument_id, s.pattern, s.variant, s.direction, s.context_tf, s.setup_tf,
           s.state, s.created_candle_time AS created, r.from_time AS run_from, r.started_at, r.ruleset_version,
           r.params_hash, r.params IS NOT NULL AS changed, p.name AS profile_name, p.version AS profile_version,
           COALESCE(r.params, p.params) -> 'smc' -> 'sessions' AS sessions,
           o.result, o.entry_touched_at, o.mfe_r, o.mae_r
    FROM analysis.setups s
    JOIN analysis.detection_runs r ON r.id = s.run_id
    JOIN market.instrument_profiles p ON p.id = r.profile_id
    LEFT JOIN analysis.setup_outcomes o ON o.setup_id = s.id
    WHERE s.created_candle_time > ${new Date(q.from)} AND s.created_candle_time <= ${new Date(q.to)}`.execute(
    owner,
  );
  const found = q.found ?? 'all';
  const kept = rows
    .filter((f) => (q.runId ? f.run_id === q.runId : f.mode === 'live'))
    .filter((f) => !q.instrumentId || f.instrument_id === q.instrumentId)
    .filter((f) => {
      const warm = f.created.getTime() <= f.run_from.getTime();
      return found === 'all' || (found === 'warmup') === warm;
    });
  const natural = (f: Fact) =>
    [
      f.instrument_id,
      f.ruleset_version,
      f.params_hash,
      f.pattern,
      f.direction,
      f.context_tf,
      f.setup_tf,
      f.created.getTime(),
    ].join('|');
  const newest = new Map<string, Fact>();
  for (const f of kept) {
    const seen = newest.get(natural(f));
    if (!seen || f.started_at > seen.started_at) newest.set(natural(f), f);
  }
  const session = (f: Fact) => {
    const hour = new Date(f.created.getTime() - 1).getUTCHours();
    return (
      (f.sessions ?? []).find((w) => hour >= Number(w.start.slice(0, 2)) && hour < Number(w.end.slice(0, 2)))
        ?.name ?? 'outside'
    );
  };
  const keyOf = (f: Fact) =>
    JSON.stringify(
      q.groupBy.map(
        (d) =>
          ({
            pattern: f.pattern,
            variant: f.variant,
            direction: f.direction,
            tfPair: `${f.context_tf}/${f.setup_tf}`,
            instrument: f.instrument_id,
            session: session(f),
            rules: `${f.ruleset_version}|${f.profile_name} v${f.profile_version}|${f.params_hash}|${f.changed}`,
          })[d],
      ),
    );
  const summarise = (fs: Fact[]) => {
    const resolved = fs.filter((f) => f.result !== null);
    const entered = resolved.filter((f) => f.mfe_r !== null);
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    return {
      detected: fs.length,
      warmup: fs.filter((f) => f.created.getTime() <= f.run_from.getTime()).length,
      confirmed: fs.filter((f) => f.result !== null || f.state === 'confirmed' || f.state === 'entry_active')
        .length,
      open: fs.filter((f) => f.result === null && (f.state === 'confirmed' || f.state === 'entry_active'))
        .length,
      resolved: resolved.length,
      entered: resolved.filter((f) => f.entry_touched_at !== null).length,
      outcomes: Object.fromEntries(
        OUTCOME_RESULTS.map((o) => [o, resolved.filter((f) => f.result === o).length]),
      ),
      avgMfeR: mean(entered.map((f) => f.mfe_r!)),
      avgMaeR: mean(entered.map((f) => f.mae_r!)),
    };
  };
  const groups = new Map<string, Fact[]>();
  for (const f of newest.values()) groups.set(keyOf(f), [...(groups.get(keyOf(f)) ?? []), f]);
  return {
    totals: summarise([...newest.values()]),
    runs: new Set([...newest.values()].map((f) => f.run_id)).size,
    groups: new Map([...groups].map(([k, fs]) => [k, summarise(fs)])),
  };
}

/** The endpoint's row key in the oracle's terms. */
function rowKey(r: SetupStatsRow, groupBy: StatsDimension[]): string {
  const k = r.key;
  return JSON.stringify(
    groupBy.map(
      (d) =>
        ({
          pattern: k.pattern,
          variant: k.variant ?? null,
          direction: k.direction,
          tfPair: k.tfPair && `${k.tfPair.context}/${k.tfPair.setup}`,
          instrument: k.instrumentId,
          session: k.session,
          rules:
            k.rules &&
            `${k.rules.rulesetVersion}|${k.rules.profile.name} v${k.rules.profile.version}|${k.rules.paramsHash}|${k.rules.changedSettings}`,
        })[d],
    ),
  );
}

function numbers(r: Omit<SetupStatsRow, 'key'>) {
  return {
    detected: r.detected,
    warmup: r.warmup,
    confirmed: r.confirmed,
    open: r.open,
    resolved: r.resolved,
    entered: r.entered,
    outcomes: r.outcomes,
    avgMfeR: r.avgMfeR === null ? null : Number(r.avgMfeR.toFixed(9)),
    avgMaeR: r.avgMaeR === null ? null : Number(r.avgMaeR.toFixed(9)),
  };
}

async function reconcile(q: Parameters<typeof oracle>[0]): Promise<SetupStats> {
  const params = new URLSearchParams({
    groupBy: q.groupBy.join(','),
    from: String(q.from),
    to: String(q.to),
  });
  if (q.found) params.set('found', q.found);
  if (q.instrumentId) params.set('instrumentId', q.instrumentId);
  if (q.runId) params.set('runId', q.runId);
  const res = await get(`/setups/stats?${params.toString()}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const stats = res.body as SetupStats;
  const expected = await oracle(q);
  expect(numbers(stats.totals)).toEqual(numbers(expected.totals as SetupStatsRow));
  expect(stats.runs).toBe(expected.runs);
  expect(stats.rows).toHaveLength(expected.groups.size);
  for (const row of stats.rows) {
    const want = expected.groups.get(rowKey(row, q.groupBy));
    expect(want, rowKey(row, q.groupBy)).toBeDefined();
    expect(numbers(row)).toEqual(numbers(want as SetupStatsRow));
  }
  return stats;
}

describe('outcome statistics (criteria 12.1 and 12.2)', () => {
  it('reconcile with the stored rows for every dimension, alone and together', async () => {
    for (const d of STATS_DIMENSIONS) await reconcile({ groupBy: [d], from: W, to: TO });
    await reconcile({ groupBy: ['pattern', 'session'], from: W, to: TO });
    await reconcile({ groupBy: [...STATS_DIMENSIONS], from: W, to: TO });
  });

  it('count each setup once, from the newer of two runs under the same rules, as worked out by hand', async () => {
    const stats = await reconcile({ groupBy: ['session'], from: W, to: TO });
    expect(stats).toMatchObject({ label: HISTORICAL_OBSERVATIONS, notice: HISTORICAL_NOTICE, runs: 3 });
    expect(stats.totals).toMatchObject({
      detected: 10,
      warmup: 4,
      confirmed: 8,
      open: 2,
      resolved: 6,
      entered: 5,
      outcomes: { target_reached: 2, invalidated: 1, expired_no_entry: 1, expired_open: 1, ambiguous: 1 },
    });
    expect(stats.totals.avgMfeR).toBeCloseTo(1.58, 12);
    expect(stats.totals.avgMaeR).toBeCloseTo(0.68, 12);
    const by = Object.fromEntries(stats.rows.map((r) => [r.key.session, r.detected]));
    expect(by).toEqual({ asia: 2, london: 3, new_york: 4, outside: 1 });
    // Most setups first.
    expect(stats.rows.map((r) => r.key.session)).toEqual(['new_york', 'london', 'asia', 'outside']);
  });

  it('filter by how a setup was found, by instrument and by run', async () => {
    const live = await reconcile({ groupBy: ['pattern'], from: W, to: TO, found: 'live' });
    // L1 found s3 live; L2's copy came while it warmed up, so here L1's counts.
    expect(live.totals).toMatchObject({ detected: 7, warmup: 0, confirmed: 5, open: 2, resolved: 3 });
    const warm = await reconcile({ groupBy: ['pattern'], from: W, to: TO, found: 'warmup' });
    expect(warm.totals).toMatchObject({ detected: 4, warmup: 4 });
    const y = await reconcile({ groupBy: ['instrument'], from: W, to: TO, instrumentId: Y });
    expect(y.rows.map((r) => [r.key.instrumentId, r.detected])).toEqual([[Y, 2]]);
    const replay = await reconcile({ groupBy: ['rules'], from: W, to: TO, runId: R1 });
    expect(replay.rows).toHaveLength(1);
    expect(replay.rows[0]!.key.rules).toMatchObject({
      rulesetVersion: 'r1',
      changedSettings: true,
      paramsHash: 'h-changed',
    });
    expect(replay.totals).toMatchObject({ detected: 1, resolved: 1, outcomes: { invalidated: 1 } });
    const rules = await reconcile({ groupBy: ['rules'], from: W, to: TO });
    expect(rules.rows.map((r) => [r.key.rules!.rulesetVersion, r.detected])).toEqual([
      ['r1', 8],
      ['r2', 2],
    ]);
  });

  it('give zeros and nulls for an empty period, and refuse a bad query', async () => {
    const empty = (await get(`/setups/stats?from=${W - 10 * H}&to=${W - 9 * H}`)).body as SetupStats;
    expect(empty).toMatchObject({ groupBy: ['pattern'], found: 'all', runs: 0, rows: [] });
    expect(empty.totals).toMatchObject({ detected: 0, avgMfeR: null, avgMaeR: null });
    expect((await get(`/setups/stats?groupBy=colour`)).status).toBe(400);
    expect((await get(`/setups/stats?groupBy=pattern,pattern`)).status).toBe(400);
    expect((await get(`/setups/stats?from=${TO}&to=${W}`)).status).toBe(400);
    expect((await get(`/setups/stats?found=maybe`)).status).toBe(400);
    expect((await get(`/setups/stats?runId=${id(999)}`)).status).toBe(404);
    expect((await get(`/setups/stats?instrumentId=${id(998)}`)).status).toBe(404);
    expect((await call(h.base, 'GET', '/api/v1/setups/stats')).status).toBe(401);
  });
});

describe('replays with changed settings, and comparisons (criterion 12.3)', () => {
  it('queues a replay that changes settings, audits them, and lists it', async () => {
    const res = await call(h.base, 'POST', '/api/v1/replays', {
      token: analyst,
      body: {
        instrumentId: X,
        from: W,
        to: W + 6 * H,
        settings: { minRR: 3, patterns: [SOFI, 'double_liquidity_trap'] },
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const { runId } = res.body as { runId: string };
    expect((await queue.getJob(runId))?.data).toMatchObject({
      runId,
      instrumentId: X,
      requestedBy: analystId,
      settings: { minRR: 3, patterns: [SOFI, 'double_liquidity_trap'] },
    });
    const audit = await owner
      .selectFrom('app.audit_log')
      .select('details')
      .where('action', '=', 'replay.requested')
      .where('actor_user_id', '=', analystId)
      .executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({ runId, settings: { minRR: 3 } });
    const status = (await get(`/replays/${runId}`)).body as ReplayStatus;
    expect(status).toMatchObject({ runId, status: 'queued', settings: { minRR: 3 }, comparison: null });
    const list = (await get(`/replays?instrumentId=${X}`, analyst)).body as ReplaySummary[];
    expect(list.map((r) => r.runId)).toEqual(expect.arrayContaining([runId, R1, R2]));
    expect(list.find((r) => r.runId === runId)).toMatchObject({ status: 'queued', mine: true });
    expect(list.find((r) => r.runId === R1)).toMatchObject({
      status: 'completed',
      settings: { minRR: 3 },
      sourceRunId: L2,
      mine: false,
    });
    // Newest first.
    const times = list.map((r) => r.requestedAt);
    expect(times).toEqual([...times].sort((a, b) => b - a));
    await queue.obliterate({ force: true });
  });

  it("gives the instrument's current values of the settings a replay may change", async () => {
    const res = await get(`/replays/settings?instrumentId=${X}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      instrumentId: X,
      profile: { name: 'crypto-majors', version: 4 },
      settings: replaySettingsOf(v4Params),
    });
    expect((res.body as { settings: { minRR: number } }).settings.minRR).toBe(
      v4Params.smc.setups.checklist.minRR,
    );
    expect((await get(`/replays/settings?instrumentId=${id(995)}`)).status).toBe(404);
    expect((await get('/replays/settings')).status).toBe(400);
  });

  it('refuses settings that change nothing or are out of range', async () => {
    for (const settings of [
      {},
      { patterns: [] },
      { minRR: -1 },
      { mandatory: ['sweep', 'sweep'] },
      { colour: 'red' },
    ]) {
      const res = await call(h.base, 'POST', '/api/v1/replays', {
        token: analyst,
        body: { instrumentId: X, from: W, to: W + H, settings },
      });
      expect(res.status, JSON.stringify(settings)).toBe(400);
    }
  });

  it('lists the changed setting and every differing detection against the live run', async () => {
    const body = (await get(`/replays/${R1}`)).body as ReplayStatus;
    expect(body).toMatchObject({
      runId: R1,
      status: 'completed',
      settings: { minRR: 3 },
      sourceRunId: L2,
      events: 5,
    });
    const c = body.comparison!;
    expect(c).toMatchObject({
      base: { runId: L2, mode: 'live', events: 5, settings: null },
      other: { runId: R1, mode: 'replay', events: 5, settings: { minRR: 3 } },
      from: W,
      to: W + 40 * H,
      equal: false,
      sameOrigins: true,
      incomplete: false,
      settings: [{ path: 'smc.setups.checklist.minRR', base: v4Params.smc.setups.checklist.minRR, other: 3 }],
      eventTypes: [
        { type: 'level_created', base: 0, other: 1 },
        { type: 'setup_transition', base: 4, other: 3 },
        { type: 'swing_confirmed', base: 1, other: 1 },
      ],
      onlyInBase: 1,
      onlyInOther: 1,
      changed: 1,
      setupsTotal: 2,
    });
    expect(c.setups).toEqual([
      {
        key: 'su:S',
        pattern: SOFI,
        variant: null,
        direction: 'bullish',
        contextTf: '1h',
        setupTf: '5m',
        createdAt: W + 2 * H,
        base: { state: 'confirmed', resolution: null, score: 80, mandatoryPassed: true, transitions: 1 },
        other: { state: 'confirmed', resolution: null, score: 65, mandatoryPassed: true, transitions: 1 },
      },
      {
        key: 'su:S2',
        pattern: 'htf_order_block',
        variant: null,
        direction: 'bearish',
        contextTf: '4h',
        setupTf: '15m',
        createdAt: W + 4 * H,
        base: { state: 'forming', resolution: null, score: 30, mandatoryPassed: true, transitions: 1 },
        other: null,
      },
    ]);
  });

  it('matches the live run when nothing was changed, and compares with any run named', async () => {
    const same = ((await get(`/replays/${R2}`)).body as ReplayStatus).comparison!;
    expect(same).toMatchObject({
      equal: true,
      settings: [],
      onlyInBase: 0,
      onlyInOther: 0,
      changed: 0,
      setups: [],
    });
    expect(same.other.digest).toBe(same.base.digest);
    // Against the other replay, the setting differs the other way round.
    const crossed = ((await get(`/replays/${R2}?compareWith=${R1}`)).body as ReplayStatus).comparison!;
    expect(crossed).toMatchObject({
      base: { runId: R1 },
      other: { runId: R2 },
      settings: [{ path: 'smc.setups.checklist.minRR', base: 3, other: v4Params.smc.setups.checklist.minRR }],
    });
    expect((await get(`/replays/${R2}?compareWith=${R2}`)).status).toBe(400);
    expect((await get(`/replays/${R2}?compareWith=${L3}`)).status).toBe(400); // another instrument
    expect((await get(`/replays/${R2}?compareWith=${id(997)}`)).status).toBe(404);
    expect((await get(`/replays/${L2}`)).status).toBe(404); // a live run is not a replay
  });

  it('lists the rules version and the profile when they differ', async () => {
    await owner
      .updateTable('analysis.detection_runs')
      .set({ ruleset_version: 'r9', profile_id: LAUNCH_PROFILE_IDS.gold })
      .where('id', '=', R2)
      .execute();
    try {
      const c = ((await get(`/replays/${R2}`)).body as ReplayStatus).comparison!;
      expect(c.settings.slice(0, 2)).toEqual([
        { path: 'rulesetVersion', base: 'r1', other: 'r9' },
        { path: 'profile', base: 'crypto-majors v4', other: 'gold v4' },
      ]);
      // Gold's own settings follow, path by path (its news blackout, for one).
      expect(c.settings.map((s) => s.path)).toContain('smc.setups.checklist.newsBlackoutMin.before');
    } finally {
      await owner
        .updateTable('analysis.detection_runs')
        .set({ ruleset_version: 'r1', profile_id: V4 })
        .where('id', '=', R2)
        .execute();
    }
  });
});

describe('CSV exports (audited)', () => {
  const audits = async (kind: string) =>
    owner
      .selectFrom('app.audit_log')
      .selectAll()
      .where('action', '=', 'export.downloaded')
      .where('target_id', '=', kind)
      .execute();

  it('exports the statistics as the endpoint gives them, labelled historical observations', async () => {
    const res = await text(`/exports/setup-stats.csv?groupBy=session,pattern&from=${W}&to=${TO}`);
    expect(res.status, res.body).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="setup-statistics-historical-observations-\d{4}-\d\d-\d\d\.csv"$/,
    );
    const lines = res.body.trimEnd().split('\r\n');
    expect(lines[0]).toBe(
      'group,session,pattern,detected,found_while_warming_up,confirmed,open,resolved,entry_touched,target_reached,invalidated,expired_no_entry,expired_open,ambiguous,avg_mfe_r,avg_mae_r',
    );
    const stats = (await get(`/setups/stats?groupBy=session,pattern&from=${W}&to=${TO}`)).body as SetupStats;
    expect(lines).toHaveLength(stats.rows.length + 2);
    expect(lines.at(-1)!.startsWith('all,,,10,4,8,2,6,5,2,1,1,1,1,')).toBe(true);
    expect(lines.slice(1, -1).map((l) => l.split(',').slice(1, 4).join(','))).toEqual(
      stats.rows.map((r) => `${r.key.session},${r.key.pattern},${r.detected}`),
    );
    expect((await audits('setup-stats')).at(-1)).toMatchObject({
      actor_type: 'user',
      details: expect.objectContaining({ export: 'setup-stats', rows: stats.rows.length }),
    });
  });

  it('exports one line per counted setup with its outcome', async () => {
    const res = await text(`/exports/setups.csv?from=${W}&to=${TO}&instrumentId=${X}`);
    expect(res.status, res.body).toBe(200);
    const [header, ...lines] = res.body.trimEnd().split('\r\n');
    const cols = header!.split(',');
    expect(cols.slice(0, 6)).toEqual(['setup_id', 'run_id', 'run_mode', 'venue', 'symbol', 'pattern']);
    expect(lines).toHaveLength(8); // X's counted setups: s1–s8, with L2's copy of s3
    const row = (n: number) => {
      const line = lines.find((l) => l.startsWith(id(100 + n)));
      return (
        line &&
        (Object.fromEntries(line.split(',').map((v, i): [string, string] => [cols[i]!, v])) as Record<
          string,
          string
        >)
      );
    };
    expect(row(3)).toBeUndefined(); // L1's copy of s3 is not counted
    expect(row(23)).toMatchObject({
      run_id: L2,
      found: 'while_warming_up',
      session: 'new_york',
      state: 'resolved',
      confirmed: 'no',
    });
    expect(row(1)).toMatchObject({
      venue: 'coinbase',
      symbol: 'BTC-USD',
      session: 'asia',
      result: 'target_reached',
      mfe_r: '2.5',
      mae_r: '0.4',
      confirmed: 'yes',
      created_at: new Date(W + H).toISOString(),
    });
    expect((await audits('setups')).at(-1)!.details).toMatchObject({ export: 'setups', rows: 8 });
  });

  it("exports a replay's comparison, with every differing setup", async () => {
    const res = await text(`/exports/run-comparison.csv?runId=${R1}`);
    expect(res.status, res.body).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="replay-comparison-${R1}.csv"`);
    const lines = res.body.trimEnd().split('\r\n');
    expect(lines[0]).toBe('section,item,base,other');
    expect(lines).toContain(`run,run_id,${L2},${R1}`);
    expect(lines).toContain(`setting,smc.setups.checklist.minRR,${v4Params.smc.setups.checklist.minRR},3`);
    expect(lines).toContain('events,setup_transition,4,3');
    expect(lines.filter((l) => l.startsWith('setup,'))).toHaveLength(2);
    expect((await audits('run-comparison')).at(-1)!.details).toMatchObject({ runId: R1, compareWith: L2 });
    expect((await text(`/exports/run-comparison.csv?runId=${L2}`)).status).toBe(404);
  });

  it('needs a session, and validates like the endpoints', async () => {
    expect((await fetch(`${h.base}/api/v1/exports/setups.csv`)).status).toBe(401);
    expect((await text(`/exports/setup-stats.csv?groupBy=colour`)).status).toBe(400);
    expect((await text(`/exports/setups.csv?runId=${id(996)}`)).status).toBe(404);
  });
});
