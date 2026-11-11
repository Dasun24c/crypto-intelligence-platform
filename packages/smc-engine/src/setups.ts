import { MINUTE_MS, TF_MS, type Timeframe } from '@cip/domain';
import { findDisplacement } from './displacement.js';
import type { Level } from './levels.js';
import { CHECKLIST_ITEMS, type ChecklistItem, PATTERNS, type PatternName, type SmcParams } from './params.js';
import { fromUnits, midpoint } from './price.js';
import type { Ring } from './ring.js';
import { contiguous, type Slot } from './slot.js';
import type { StructState, SwingRef } from './structure.js';
import type {
  ChecklistResult,
  Direction,
  EconomicEventRef,
  EngineFlag,
  LevelType,
  MssData,
  QualityFlag,
  SetupOutcomeData,
  SetupResolution,
  SetupState,
  SetupTransitionData,
  Side,
  TargetRef,
} from './types.js';
import { fillPct, isLive, type Zone } from './zones.js';

/** A confirmed sweep as the patterns need it (rulebook §3.4), kept for a while on its timeframe. */
export interface SweepRec {
  key: string;
  /** The swept level: key, type, origin timeframe, price and touches when it was swept. */
  level: string;
  levelType: LevelType;
  levelTf: Timeframe;
  levelPrice: number;
  touches: number;
  side: Side;
  /** The extreme beyond the level, and the slot index of the (latest) candle that made it. */
  extreme: number;
  extremeIndex: number;
  breachIndex: number;
  confirmIndex: number;
  /** Close and ATR of the confirming candle. */
  close: number;
  atr: number;
  flags: EngineFlag[];
  /** Key of the sweep-extreme level its group left. */
  extremeLevel: string;
}

/** A trading range as the setups see it (the engine's own, or Pattern 4's swing structure). */
export interface RangeRef {
  kind: 'range' | 'swing';
  /** The range's key, or the swing level's for a swing structure. */
  key: string;
  high: number;
  low: number;
  highLevel: string;
  lowLevel: string;
}

/** What the setups read from one timeframe's state in the engine. */
export interface TfView {
  tf: Timeframe;
  ring: Ring<Slot>;
  /** Open time of the next candle: the latest candle closed at `next`. */
  next: number;
  internal: StructState | null;
  external: StructState | null;
  /** Recent internal swings (rulebook §3.2's list), oldest first. */
  highs: SwingRef[];
  lows: SwingRef[];
  range: { key: string; high: number; low: number; highLevel: string; lowLevel: string } | null;
  /** Recent sweeps confirmed on this timeframe, oldest first. */
  sweepLog: SweepRec[];
  /** Setup timeframes: quote volume per candle (volume × close; null for gaps), for `low_liquidity`. */
  qv: Ring<number | null> | null;
}

/** The engine as the setups see it. */
export interface EngineView {
  readonly params: SmcParams;
  /** Price tick in units. */
  readonly tick: number;
  /** The boundary being processed. */
  readonly time: number;
  tf(tf: Timeframe): TfView | undefined;
  readonly levels: ReadonlyMap<string, Level>;
  readonly zones: ReadonlyMap<string, Zone>;
  minute(t: number): { t: number; l: number; h: number; gap: boolean } | undefined;
  /** Null when the economic calendar is unavailable. */
  readonly economicEvents: readonly EconomicEventRef[] | null;
  breakBuffer(s: Slot): number | null;
  emitSetup(tf: Timeframe, key: string, data: SetupTransitionData): void;
}

/** A structure event decided at the current candle. */
export interface BreakRef {
  key: string;
  direction: Direction;
  level: 'internal' | 'external';
}

interface TargetRec {
  kind: 'level' | 'zone';
  key: string;
  price: number;
}

/**
 * One setup's whole state (plain JSON, for checkpoints). Prices are in units. Patterns are
 * described for the bearish case in the rulebook; `take` below is the side whose liquidity a
 * setup's sweep takes (buy-side for bearish setups).
 */
export interface Setup {
  key: string;
  group: string;
  pattern: PatternName;
  variant: 'A' | 'B' | null;
  direction: Direction;
  contextTf: Timeframe;
  setupTf: Timeframe;
  state: SetupState;
  resolution: SetupResolution | null;
  createdAt: number;
  /** Patterns 1 and 4: the range (or swing structure) it watches. */
  range: RangeRef | null;
  /** Pattern 1: the latest first sweep on the take side (variant A) and on the other side (B). */
  s1: SweepRec | null;
  s1Other: SweepRec | null;
  /** Pattern 3: the latest touch of each candidate zone (slot index). */
  touches: Record<string, number>;
  /** Patterns 2 and 3: zones a setup-timeframe close went beyond. */
  excluded: string[];
  /**
   * Patterns 2–4 while forming: the candidates as of the latest candle (Pattern 2: equal highs/lows
   * and zone; Pattern 3: zones; Pattern 4: FVGs), the evidence when the last of them goes.
   */
  watching: (string | { level: string; poi: string })[];
  /** The sweep that triggered it (Pattern 1: S2). */
  trigger: SweepRec | null;
  /** The candle that triggered it: the MSS window and the price checks start there. */
  armedAt: number | null;
  /**
   * The extreme the MSS and invalidation measure from: the trigger sweep's, extended through the
   * trigger candle when the sweep came earlier (Pattern 3: liquidity taken before the touch).
   */
  extreme: number | null;
  extremeIndex: number | null;
  sweeps: string[];
  poi: { key: string; top: number; bottom: number } | null;
  /** Pattern 2: the equal highs/lows it swept. */
  eq: string | null;
  invalidation: number | null;
  /**
   * When price first went beyond the trigger's extreme (or Pattern 3 closed beyond its zone): no MSS
   * from it. `at` is the candle's open time, `price` its high/low (or close).
   */
  dead: { at: number; by: 'beyond_extreme' | 'close_beyond_poi'; price: number } | null;
  mss: (MssData & { breakIndex: number }) | null;
  /** The confirmation has been decided (passed or failed). */
  attempted: boolean;
  entryZone: { key: string; top: number; bottom: number } | null;
  entry: number | null;
  target1: TargetRec | null;
  target2: TargetRec | null;
  rr: number | null;
  checklist: ChecklistResult[];
  score: number;
  mandatoryPassed: boolean;
  flags: QualityFlag[];
  confirmIndex: number | null;
  entryIndex: number | null;
  entryAt: number | null;
  /** Highest high and lowest low from the entry candle on. */
  hi: number | null;
  lo: number | null;
  outcome: SetupOutcomeData | null;
}

const CODE: Record<PatternName, string> = {
  double_liquidity_trap: 'p1',
  eq_near_poi: 'p2',
  htf_order_block: 'p3',
  sweep_outside_fill_inside: 'p4',
};
const DIRECTIONS: readonly Direction[] = ['bullish', 'bearish'];
const DAY_MS = 86_400_000;
/** §7 low_liquidity: the recent window, and the history it is compared with. */
const LOW_LIQ_RECENT = 20;
const LOW_LIQ_DAYS = 30;

/** §7 item 2: levels that count as marked liquidity (full credit); plain swings get half. */
const MARKED: ReadonlySet<LevelType> = new Set<LevelType>([
  'eqh',
  'eql',
  'pdh',
  'pdl',
  'pwh',
  'pwl',
  'pmh',
  'pml',
  'session_high',
  'session_low',
  'range_high',
  'range_low',
  'weekend_high',
  'weekend_low',
  'sweep_extreme',
]);

const qualifies = (x: SweepRec) => !x.flags.includes('deep') && !x.flags.includes('thin_book');
const opposite = (d: Direction): Direction => (d === 'bullish' ? 'bearish' : 'bullish');
/** The side whose liquidity a setup in direction `d` sweeps first (bearish setups take buy-side). */
const takeSide = (d: Direction): Side => (d === 'bearish' ? 'buy_side' : 'sell_side');
const lastAtr = (tf: TfView | null): number | null => tf?.ring.get(tf.ring.next - 1)?.atr ?? null;

/** Rounds `x` ticks up, tolerating float noise (0.1 × 1.5 is 0.15000000000000002). */
const ceilTicks = (x: number) => Math.ceil(x - 1e-6);

/** a / b floored to 4 decimals, exactly (prices are whole units). */
function ratio4(a: number, b: number): number {
  return Number((BigInt(Math.round(a)) * 10_000n) / BigInt(Math.round(b))) / 10_000;
}

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

/** Gap between two price intervals (0 when they overlap or touch). */
const intervalGap = (a: { top: number; bottom: number }, b: { top: number; bottom: number }) =>
  Math.max(0, Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top));

interface Run {
  v: EngineView;
  st: TfView;
  ctx: TfView | null;
  slot: Slot;
  n: number;
  breaks: readonly BreakRef[];
  pair: { context: Timeframe; setup: Timeframe };
}

type Move = 'none' | 'entry' | 'entry_invalid' | 'target' | 'invalid' | 'cancel' | 'conflict';

/**
 * The rulebook's patterns (§6), checklist (§7) and outcomes (§8): one state machine per (pattern,
 * direction, timeframe pair), at most one live at a time (J10). The engine runs it at every close
 * of a setup timeframe, after that candle's points of interest, so it sees the sweeps, structure
 * and zones the candle produced, and every context candle that closed by then.
 */
export class SetupBook {
  /** Live setups by group. Resolved ones leave the book. */
  private live = new Map<string, Setup>();

  constructor(private readonly p: SmcParams) {}

  /** Live setups in creation order (copies). */
  list(): Setup[] {
    return [...this.live.values()].map((s) => structuredClone(s));
  }

  snapshot(): Setup[] {
    return this.list();
  }

  restore(list: readonly Setup[]): void {
    this.live = new Map(list.map((s) => [s.group, structuredClone(s)]));
  }

  /** §9: a gap on a timeframe flags every live setup that uses it. */
  gap(tf: Timeframe): void {
    for (const s of this.live.values()) if (s.setupTf === tf || s.contextTf === tf) flag(s, 'data_gap');
  }

  /** At the close of candle `n` (slot `slot`) of setup timeframe `st`. */
  run(v: EngineView, st: TfView, slot: Slot, n: number, breaks: readonly BreakRef[]): void {
    for (const pair of v.params.timeframePairs) {
      if (pair.setup !== st.tf) continue;
      const r: Run = { v, st, ctx: v.tf(pair.context) ?? null, slot, n, breaks, pair };
      for (const pattern of PATTERNS) {
        if (!this.p.setups.patterns.includes(pattern)) continue;
        for (const direction of DIRECTIONS) {
          const group = `${pair.setup}:${pair.context}:${CODE[pattern]}:${direction === 'bullish' ? 'bu' : 'be'}`;
          const s = this.live.get(group);
          if (s) {
            this.progress(r, s);
            if (s.state !== 'resolved') continue;
            this.live.delete(group);
          }
          const created = this.form(r, pattern, direction, group);
          if (!created) continue;
          this.live.set(group, created);
          this.progress(r, created);
          if (created.state === 'resolved') this.live.delete(group);
        }
      }
    }
  }

  // ── Forming (rulebook §6.2–§6.5) ────────────────────────────────────────────────────────────

  private form(r: Run, pattern: PatternName, direction: Direction, group: string): Setup | null {
    let range: RangeRef | null = null;
    let evidence: Record<string, unknown> = {};
    let watching: Setup['watching'] = [];
    switch (pattern) {
      case 'double_liquidity_trap':
        if (!r.st.range) return null;
        range = { kind: 'range', ...pick(r.st.range) };
        evidence = { range: range.key };
        break;
      case 'eq_near_poi': {
        const pairs = this.p2Candidates(r, direction, []);
        if (!pairs.length) return null;
        watching = pairs.map((x) => ({ level: x.eq.key, poi: x.z.key }));
        evidence = { candidates: watching };
        break;
      }
      case 'htf_order_block': {
        const zones = this.p3Candidates(r, direction, []);
        if (!zones.length) return null;
        watching = zones.map((z) => z.key);
        evidence = { candidates: watching };
        break;
      }
      case 'sweep_outside_fill_inside': {
        range = this.p4Structure(r, direction);
        if (!range) return null;
        const fvgs = this.p4Fvgs(r, direction, range);
        if (!fvgs.length) return null;
        watching = fvgs.map((z) => z.key);
        evidence = { [structureName(range)]: range.key, fvgs: watching };
        break;
      }
    }
    const time = r.v.time;
    const s: Setup = {
      key: `su:${group}:${time}`,
      group,
      pattern,
      variant: null,
      direction,
      contextTf: r.pair.context,
      setupTf: r.pair.setup,
      state: 'forming',
      resolution: null,
      createdAt: time,
      range,
      s1: null,
      s1Other: null,
      touches: {},
      excluded: [],
      watching: structuredClone(watching),
      trigger: null,
      armedAt: null,
      extreme: null,
      extremeIndex: null,
      sweeps: [],
      poi: null,
      eq: null,
      invalidation: null,
      dead: null,
      mss: null,
      attempted: false,
      entryZone: null,
      entry: null,
      target1: null,
      target2: null,
      rr: null,
      checklist: [],
      score: 0,
      mandatoryPassed: false,
      flags: [],
      confirmIndex: null,
      entryIndex: null,
      entryAt: null,
      hi: null,
      lo: null,
      outcome: null,
    };
    this.transition(r, s, null, 'forming', 'preconditions', evidence);
    return s;
  }

  private progress(r: Run, s: Setup): void {
    if (s.state === 'forming') this.forming(r, s);
    else if (s.state === 'triggered') this.triggered(r, s);
    else if (s.state === 'confirmed' || s.state === 'entry_active') this.track(r, s);
  }

  private forming(r: Run, s: Setup): void {
    switch (s.pattern) {
      case 'double_liquidity_trap':
        return this.p1Forming(r, s);
      case 'eq_near_poi':
        return this.p2Forming(r, s);
      case 'htf_order_block':
        return this.p3Forming(r, s);
      case 'sweep_outside_fill_inside':
        return this.p4Forming(r, s);
    }
  }

  private sweepsNow(r: Run): SweepRec[] {
    return r.st.sweepLog.filter((x) => x.confirmIndex === r.n);
  }

  /**
   * §6.2 Pattern 1 (bearish): S1 sweeps R.high or a buy-side level within 0.5 ATR of it; S2 sweeps
   * R.high again, or S1's sweep extreme, 5 to 60 candles later (variant A). Variant B: S1 sweeps
   * R.low (or a sell-side level within 0.5 ATR of it) and S2 sweeps R.high.
   */
  private p1Forming(r: Run, s: Setup): void {
    const range = r.st.range;
    if (!range || range.key !== s.range!.key)
      return this.resolve(r, s, 'expired', 'range_ended', { range: s.range!.key });
    const bear = s.direction === 'bearish';
    const take = takeSide(s.direction);
    const near = bear
      ? { level: range.highLevel, price: range.high }
      : { level: range.lowLevel, price: range.low };
    const far = bear
      ? { level: range.lowLevel, price: range.low }
      : { level: range.highLevel, price: range.high };
    const pp = this.p.setups.pattern1;
    const within = (g: number) => g >= pp.minBarsBetweenSweeps && g <= pp.maxBarsBetweenSweeps;
    const now = this.sweepsNow(r).filter(qualifies);
    const taken = now.filter((x) => x.side === take);
    // One candle can sweep several levels at once. It is S2 if any of its sweeps qualifies as S2
    // (the range edge first); only otherwise do its sweeps become the latest S1.
    const edgeFirst = (edge: string) => (a: SweepRec, b: SweepRec) =>
      Number(b.level === edge) - Number(a.level === edge);
    if (s.s1 && within(r.n - s.s1.confirmIndex)) {
      const x = [...taken]
        .sort(edgeFirst(near.level))
        .find((x) => x.level === near.level || x.level === s.s1!.extremeLevel);
      if (x) return this.trigger(r, s, x, 'A', s.s1);
    }
    if (s.s1Other && within(r.n - s.s1Other.confirmIndex)) {
      const x = taken.find((x) => x.level === near.level);
      if (x) return this.trigger(r, s, x, 'B', s.s1Other);
    }
    const first = (list: SweepRec[], edge: { level: string; price: number }) =>
      [...list]
        .sort(edgeFirst(edge.level))
        .find(
          (x) => x.level === edge.level || Math.abs(x.levelPrice - edge.price) <= pp.rangeEdgeTolAtr * x.atr,
        );
    s.s1 = first(taken, near) ?? s.s1;
    s.s1Other =
      first(
        now.filter((x) => x.side !== take),
        far,
      ) ?? s.s1Other;
    // A first sweep with no second one in time is dropped: the setup is plainly forming again.
    if (s.s1 && r.n - s.s1.confirmIndex >= pp.maxBarsBetweenSweeps) s.s1 = null;
    if (s.s1Other && r.n - s.s1Other.confirmIndex >= pp.maxBarsBetweenSweeps) s.s1Other = null;
  }

  /**
   * §6.3 Pattern 2 (bearish) candidates: an active EQH E (setup or context timeframe) below a live
   * bearish order block or supply zone Z of the context timeframe that is less than 50 % filled,
   * with Z.bottom − E.price ≤ 1.0 context ATR. A level swept at this very candle still counts.
   */
  private p2Candidates(r: Run, dir: Direction, excluded: readonly string[]): { eq: Level; z: Zone }[] {
    const atr = lastAtr(r.ctx);
    if (atr === null) return [];
    const bear = dir === 'bearish';
    const p2 = this.p.setups.pattern2;
    const sweptNow = new Set(this.sweepsNow(r).map((x) => x.level));
    const eqs = [...r.v.levels.values()].filter(
      (l) =>
        l.type === (bear ? 'eqh' : 'eql') &&
        (l.tf === r.pair.setup || l.tf === r.pair.context) &&
        (l.status === 'active' || sweptNow.has(l.key)),
    );
    const zs = [...r.v.zones.values()].filter(
      (z) =>
        z.tf === r.pair.context &&
        z.direction === dir &&
        (z.type === 'order_block' || z.type === (bear ? 'supply' : 'demand')) &&
        (z.status === 'untouched' || z.status === 'partially_filled') &&
        fillPct(z) < p2.maxPoiFill * 100 &&
        !excluded.includes(z.key),
    );
    const out: { eq: Level; z: Zone }[] = [];
    for (const eq of eqs)
      for (const z of zs) {
        const gap = bear ? z.bottom - eq.price : eq.price - z.top;
        if (gap > 0 && gap <= p2.proximityAtr * atr) out.push({ eq, z });
      }
    return out;
  }

  /** §6.3: a qualifying sweep of E whose extreme reaches Z triggers; a close beyond Z rules Z out. */
  private p2Forming(r: Run, s: Setup): void {
    const bear = s.direction === 'bearish';
    const pairs = this.p2Candidates(r, s.direction, s.excluded);
    for (const x of this.sweepsNow(r)) {
      if (!qualifies(x) || x.side !== takeSide(s.direction)) continue;
      const hit = pairs.find(
        (c) => c.eq.key === x.level && (bear ? x.extreme >= c.z.bottom : x.extreme <= c.z.top),
      );
      if (hit) {
        s.eq = hit.eq.key;
        s.poi = { key: hit.z.key, top: hit.z.top, bottom: hit.z.bottom };
        return this.trigger(r, s, x, null, null);
      }
    }
    for (const c of pairs)
      if ((bear ? r.slot.c > c.z.top : r.slot.c < c.z.bottom) && !s.excluded.includes(c.z.key))
        s.excluded.push(c.z.key);
    s.excluded = s.excluded.filter((k) => r.v.zones.has(k));
    const left = this.p2Candidates(r, s.direction, s.excluded);
    if (!left.length) this.resolve(r, s, 'expired', 'no_candidates', this.lost(r, s));
    else s.watching = left.map((x) => ({ level: x.eq.key, poi: x.z.key }));
  }

  /** Evidence for a forming setup whose candidates are all gone: those watched until now. */
  private lost(r: Run, s: Setup): Record<string, unknown> {
    return {
      lost: structuredClone(s.watching),
      ...(s.excluded.length ? { excluded: [...s.excluded] } : {}),
      close: fromUnits(r.slot.c),
    };
  }

  /**
   * §6.4 Pattern 3 (bearish) candidates: a live `htf` bearish order block Z of the context timeframe,
   * at most 50 % filled, with the setup close no higher than Z.top and at most 2.0 context ATR below
   * Z.bottom.
   */
  private p3Candidates(r: Run, dir: Direction, excluded: readonly string[]): Zone[] {
    const atr = lastAtr(r.ctx);
    if (atr === null) return [];
    const bear = dir === 'bearish';
    const p3 = this.p.setups.pattern3;
    const c = r.slot.c;
    return [...r.v.zones.values()].filter(
      (z) =>
        z.tf === r.pair.context &&
        z.type === 'order_block' &&
        z.htf &&
        z.direction === dir &&
        (z.status === 'untouched' || z.status === 'partially_filled') &&
        fillPct(z) <= p3.maxObFill * 100 &&
        !excluded.includes(z.key) &&
        (bear
          ? c <= z.top && z.bottom - c <= p3.approachAtr * atr
          : c >= z.bottom && c - z.top <= p3.approachAtr * atr),
    );
  }

  /**
   * §6.4: price touches Z on the setup timeframe and, within 12 setup candles before or after the
   * touch, a qualifying sweep takes a buy-side level inside Z or up to 1.0 context ATR below it.
   */
  private p3Forming(r: Run, s: Setup): void {
    const bear = s.direction === 'bearish';
    const p3 = this.p.setups.pattern3;
    const zones = this.p3Candidates(r, s.direction, s.excluded);
    const atr = lastAtr(r.ctx);
    for (const z of zones) if (bear ? r.slot.h >= z.bottom : r.slot.l <= z.top) s.touches[z.key] = r.n;
    if (atr !== null) {
      const recent = r.st.sweepLog
        .filter(
          (x) =>
            qualifies(x) && x.side === takeSide(s.direction) && x.confirmIndex >= r.n - p3.sweepWindowBars,
        )
        .reverse();
      for (const z of zones) {
        const touch = s.touches[z.key];
        if (touch === undefined) continue;
        const lo = bear ? z.bottom - p3.liqProximityAtr * atr : z.bottom;
        const hi = bear ? z.top : z.top + p3.liqProximityAtr * atr;
        const x = recent.find(
          (x) =>
            x.levelPrice >= lo &&
            x.levelPrice <= hi &&
            Math.abs(x.confirmIndex - touch) <= p3.sweepWindowBars &&
            (x.confirmIndex === r.n || touch === r.n),
        );
        if (x) {
          s.poi = { key: z.key, top: z.top, bottom: z.bottom };
          return this.trigger(r, s, x, null, null, { touch: r.st.ring.get(touch)!.t });
        }
      }
    }
    for (const z of zones)
      if ((bear ? r.slot.c > z.top : r.slot.c < z.bottom) && !s.excluded.includes(z.key))
        s.excluded.push(z.key);
    s.excluded = s.excluded.filter((k) => r.v.zones.has(k));
    for (const k of Object.keys(s.touches)) if (!r.v.zones.has(k)) delete s.touches[k];
    const left = this.p3Candidates(r, s.direction, s.excluded);
    if (!left.length) this.resolve(r, s, 'expired', 'no_candidates', this.lost(r, s));
    else s.watching = left.map((z) => z.key);
  }

  /**
   * §6.5 Pattern 4's structure: the active range on the setup timeframe, or without one the most
   * recent active, never-swept swing level on the take side (bearish: a swing high) with the most
   * recent active opposite swing level beyond the inside (a swing low below it).
   */
  private p4Structure(r: Run, dir: Direction): RangeRef | null {
    if (r.st.range) return { kind: 'range', ...pick(r.st.range) };
    const bear = dir === 'bearish';
    let edge: Level | null = null;
    let other: Level | null = null;
    for (const l of r.v.levels.values()) {
      if (l.tf !== r.st.tf || l.status !== 'active') continue;
      if (
        l.type === (bear ? 'swing_high' : 'swing_low') &&
        l.sweepCount === 0 &&
        (!edge || l.knownAt >= edge.knownAt)
      )
        edge = l;
    }
    if (!edge) return null;
    for (const l of r.v.levels.values()) {
      if (l.tf !== r.st.tf || l.status !== 'active' || l.type !== (bear ? 'swing_low' : 'swing_high'))
        continue;
      if ((bear ? l.price < edge.price : l.price > edge.price) && (!other || l.knownAt >= other.knownAt))
        other = l;
    }
    if (!other) return null;
    return bear
      ? {
          kind: 'swing',
          key: edge.key,
          high: edge.price,
          low: other.price,
          highLevel: edge.key,
          lowLevel: other.key,
        }
      : {
          kind: 'swing',
          key: edge.key,
          high: other.price,
          low: edge.price,
          highLevel: other.key,
          lowLevel: edge.key,
        };
  }

  /** §6.5: live opposing FVGs on the setup timeframe inside the structure, < 50 % filled, beyond price. */
  private p4Fvgs(r: Run, dir: Direction, range: RangeRef): Zone[] {
    const bear = dir === 'bearish';
    const max = this.p.setups.pattern4.maxTargetFvgFill * 100;
    return [...r.v.zones.values()].filter(
      (z) =>
        z.tf === r.st.tf &&
        z.type === 'fvg' &&
        z.direction === opposite(dir) &&
        isLive(z) &&
        fillPct(z) < max &&
        z.bottom >= range.low &&
        z.top <= range.high &&
        (bear ? z.top < r.slot.c : z.bottom > r.slot.c),
    );
  }

  /** §6.5: a qualifying sweep of R.high (bearish) that closes back inside R, with an FVG still there. */
  private p4Forming(r: Run, s: Setup): void {
    const bear = s.direction === 'bearish';
    const range = s.range!;
    const edge = bear ? range.highLevel : range.lowLevel;
    const fvgs = this.p4Fvgs(r, s.direction, range);
    if (fvgs.length)
      for (const x of this.sweepsNow(r))
        if (
          qualifies(x) &&
          x.side === takeSide(s.direction) &&
          x.level === edge &&
          x.close < range.high &&
          x.close > range.low
        )
          return this.trigger(r, s, x, null, null);
    // A forming setup follows its structure: a new range or swing replaces the old one.
    const now = this.p4Structure(r, s.direction);
    if (!now)
      return this.resolve(r, s, 'expired', range.kind === 'range' ? 'range_ended' : 'structure_ended', {
        [structureName(range)]: range.key,
      });
    if (now.key !== range.key) s.range = now;
    const left = this.p4Fvgs(r, s.direction, s.range!);
    if (!left.length)
      this.resolve(r, s, 'expired', 'no_fvg', {
        [structureName(s.range!)]: s.range!.key,
        ...this.lost(r, s),
      });
    else s.watching = left.map((z) => z.key);
  }

  // ── Triggered: the sweep-anchored MSS and confirmation (§6.1) ───────────────────────────────

  private trigger(
    r: Run,
    s: Setup,
    x: SweepRec,
    variant: 'A' | 'B' | null,
    first: SweepRec | null,
    evidence: Record<string, unknown> = {},
  ): void {
    const bear = s.direction === 'bearish';
    s.trigger = x;
    s.variant = variant;
    s.sweeps = first ? [first.key, x.key] : [x.key];
    s.armedAt = r.n;
    s.extreme = x.extreme;
    s.extremeIndex = x.extremeIndex;
    // A sweep that came before the trigger candle (Pattern 3) measures from the highest high (lowest
    // low) since it, up to this candle: the touch that followed it is part of the move.
    for (let i = x.confirmIndex + 1; i <= r.n; i++) {
      const c = r.st.ring.get(i);
      if (c && !c.gap && (bear ? c.h >= s.extreme : c.l <= s.extreme)) {
        s.extreme = bear ? c.h : c.l;
        s.extremeIndex = i;
      }
    }
    const atr = r.slot.atr ?? x.atr;
    const buffer = ceilTicks((this.p.setups.levels.slBufferAtr * atr) / r.v.tick) * r.v.tick;
    s.invalidation = bear ? s.extreme + buffer : s.extreme - buffer;
    if (x.flags.includes('liquidity_unverified') || first?.flags.includes('liquidity_unverified'))
      flag(s, 'liquidity_unverified');
    if (x.flags.includes('underlying_closed')) flag(s, 'underlying_closed');
    if (this.lowLiquidity(r)) flag(s, 'low_liquidity');
    this.transition(r, s, 'forming', 'triggered', variant ? `sweeps_${variant}` : 'sweep', {
      sweep: x.key,
      ...(first ? { firstSweep: first.key } : {}),
      ...evidence,
    });
    this.triggered(r, s);
  }

  private triggered(r: Run, s: Setup): void {
    const bear = s.direction === 'bearish';
    const armed = s.armedAt!;
    const { slot, n } = r;
    if (n > armed && (bear ? slot.h >= s.invalidation! : slot.l <= s.invalidation!))
      return this.resolve(r, s, 'invalidated', 'invalidation_price', {
        invalidation: fromUnits(s.invalidation!),
        [bear ? 'high' : 'low']: fromUnits(bear ? slot.h : slot.l),
      });
    if (s.poi) {
      const beyond = (c: number) => (bear ? c > s.poi!.top : c < s.poi!.bottom);
      if (s.pattern === 'eq_near_poi' && beyond(slot.c))
        return this.resolve(r, s, 'invalidated', 'close_beyond_poi', { close: fromUnits(slot.c) });
      if (s.pattern === 'htf_order_block') {
        const ctxLast = r.ctx?.next === r.v.time ? r.ctx.ring.get(r.ctx.ring.next - 1) : undefined;
        if (ctxLast && !ctxLast.gap && beyond(ctxLast.c))
          return this.resolve(r, s, 'invalidated', 'context_close_beyond_poi', {
            close: fromUnits(ctxLast.c),
          });
        if (beyond(slot.c)) s.dead ??= { at: slot.t, by: 'close_beyond_poi', price: slot.c };
      }
    }
    if (n > armed && (bear ? slot.h > s.extreme! : slot.l < s.extreme!))
      s.dead ??= { at: slot.t, by: 'beyond_extreme', price: bear ? slot.h : slot.l };
    const deadline = armed + this.p.setups.mss.maxBars;
    if (!s.mss && !s.dead && n <= deadline) this.findMss(r, s);
    if (s.mss && !s.attempted) this.attempt(r, s);
    if (s.state !== 'triggered') return;
    if (n > deadline && (!s.mss || s.attempted)) {
      // The MSS window: the trigger candle and the next maxBars (open times).
      const evidence: Record<string, unknown> = {
        window: { from: r.st.ring.get(armed)?.t ?? null, to: r.st.ring.get(deadline)?.t ?? null },
      };
      if (s.mss) evidence.mssBreak = s.mss.breakCandleTime;
      else if (s.dead) evidence[s.dead.by] = { at: s.dead.at, price: fromUnits(s.dead.price) };
      this.resolve(r, s, 'expired', s.mss ? 'not_confirmed' : s.dead ? 'beyond_sweep' : 'no_mss', evidence);
    }
  }

  /**
   * §6.1 sweep-anchored MSS (bearish): the most recent internal swing low whose candle comes before
   * the sweep's breach candle (confirmed by now), no more than 6.0 ATR from the sweep extreme; a
   * close below it, with displacement in the leg from the sweep extreme when required.
   */
  private findMss(r: Run, s: Setup): void {
    const bear = s.direction === 'bearish';
    const t = s.trigger!;
    const list = bear ? r.st.lows : r.st.highs;
    let anchor: SwingRef | null = null;
    for (let i = list.length - 1; i >= 0; i--)
      if (list[i]!.index < t.breachIndex) {
        anchor = list[i]!;
        break;
      }
    const atr = r.slot.atr;
    if (!anchor || atr === null) return;
    const extreme = s.extreme!;
    if ((bear ? extreme - anchor.price : anchor.price - extreme) > this.p.setups.mss.maxDistanceAtr * atr)
      return;
    const eps = r.v.breakBuffer(r.slot);
    if (eps === null || !(bear ? r.slot.c <= anchor.price - eps : r.slot.c >= anchor.price + eps)) return;
    const d = findDisplacement(r.st.ring, s.direction, s.extremeIndex!, r.n, this.p.displacement);
    if (this.p.setups.mss.requireDisplacement && !d) return;
    const own = r.breaks.filter((b) => b.direction === s.direction);
    s.mss = {
      anchor: anchor.key,
      anchorPrice: fromUnits(anchor.price),
      breakCandleTime: r.slot.t,
      structureEvent: (own.find((b) => b.level === 'internal') ?? own[0])?.key ?? null,
      displacement: d
        ? { from: r.st.ring.get(d.from)!.t, to: r.st.ring.get(d.to)!.t, bodyAtr: d.bodyAtr }
        : null,
      breakIndex: r.n,
    };
    if (r.slot.uc) flag(s, 'underlying_closed');
  }

  /**
   * The confirmation, decided once: at the break candle when an entry FVG exists by then, else at
   * the candle after it (which may complete one; failing that, the OB of the MSS leg).
   */
  private attempt(r: Run, s: Setup): void {
    const bear = s.direction === 'bearish';
    const b = s.mss!.breakIndex;
    const size = TF_MS[r.st.tf];
    const legStart = r.st.ring.get(s.extremeIndex!)?.t ?? r.st.ring.get(r.st.ring.first)!.t;
    const lastOpen = r.st.ring.get(b)!.t + size;
    const byOrigin = (a: Zone, z: Zone) => a.originFrom - z.originFrom || (a.key < z.key ? -1 : 1);
    let zone: Zone | undefined = [...r.v.zones.values()]
      .filter(
        (z) =>
          z.tf === r.st.tf &&
          z.type === 'fvg' &&
          z.direction === s.direction &&
          isLive(z) &&
          z.originFrom >= legStart &&
          z.originTo <= lastOpen,
      )
      .sort(byOrigin)[0];
    if (!zone && r.n === b) return;
    if (!zone) {
      const lookback = this.p.orderBlocks.lookback;
      const from = legStart - (lookback - 1) * size;
      zone = [...r.v.zones.values()]
        .filter(
          (z) =>
            z.tf === r.st.tf &&
            z.type === 'order_block' &&
            z.direction === s.direction &&
            isLive(z) &&
            z.originTo >= from &&
            z.originTo <= legStart,
        )
        .sort(
          (a, z) => z.originTo - a.originTo || z.originFrom - a.originFrom || (a.key < z.key ? -1 : 1),
        )[0];
    }
    s.attempted = true;
    if (r.n !== b && r.slot.uc) flag(s, 'underlying_closed');
    if (zone) {
      s.entryZone = { key: zone.key, top: zone.top, bottom: zone.bottom };
      s.entry = bear ? zone.bottom : zone.top;
    }
    this.targets(r, s);
    this.evaluate(r, s);
    const blocking = this.blocking(s);
    if (s.mandatoryPassed && !blocking.length) {
      s.confirmIndex = r.n;
      this.transition(
        r,
        s,
        'triggered',
        'confirmed',
        'mss_confirmed',
        { entryZone: s.entryZone?.key ?? null },
        false,
      );
    } else {
      const failed = s.checklist.filter((c) => c.mandatory && c.credit < 1).map((c) => c.item);
      this.transition(r, s, 'triggered', 'triggered', 'not_confirmed', { failed, blocking }, false);
    }
  }

  /** Flags that stop a setup from confirming (§7). */
  private blocking(s: Setup): QualityFlag[] {
    const q = this.p.setups.quality;
    return s.flags.filter(
      (f) =>
        f === 'data_gap' ||
        (f === 'underlying_closed' && q.blockConfirmWhenUnderlyingClosed) ||
        (f === 'low_liquidity' && q.blockConfirmOnLowLiquidity),
    );
  }

  /**
   * §6.1 targets: T1 is the nearest active opposing liquidity level, or the near edge of a live
   * unfilled opposing FVG, at least 1.0 ATR beyond the entry; T2 the next. Pattern 4 (§6.5) targets
   * its internal FVG instead: T1 its near edge, T2 its far edge or the structure's other end,
   * whichever is nearer.
   */
  private targets(r: Run, s: Setup): void {
    s.target1 = null;
    s.target2 = null;
    s.rr = null;
    if (s.entry === null) return;
    const bear = s.direction === 'bearish';
    const entry = s.entry;
    const dist = (price: number) => (bear ? entry - price : price - entry);
    if (s.pattern === 'sweep_outside_fill_inside') {
      const range = s.range!;
      const f = this.p4Fvgs(r, s.direction, range)
        .filter((z) => dist(bear ? z.top : z.bottom) > 0)
        .sort(
          (a, z) => dist(bear ? a.top : a.bottom) - dist(bear ? z.top : z.bottom) || (a.key < z.key ? -1 : 1),
        )[0];
      if (f) {
        s.target1 = { kind: 'zone', key: f.key, price: bear ? f.top : f.bottom };
        const farEdge = bear ? f.bottom : f.top;
        const end = bear ? range.low : range.high;
        s.target2 =
          dist(end) < dist(farEdge)
            ? { kind: 'level', key: bear ? range.lowLevel : range.highLevel, price: end }
            : { kind: 'zone', key: f.key, price: farEdge };
      }
    } else {
      const atr = r.slot.atr;
      if (atr === null) return;
      const min = this.p.setups.levels.targetMinDistanceAtr * atr;
      const side: Side = bear ? 'sell_side' : 'buy_side';
      const found: TargetRec[] = [];
      for (const l of r.v.levels.values())
        if (l.status === 'active' && l.side === side && dist(l.price) >= min)
          found.push({ kind: 'level', key: l.key, price: l.price });
      for (const z of r.v.zones.values()) {
        if (z.type !== 'fvg' || z.direction !== opposite(s.direction) || !isLive(z) || z.status === 'filled')
          continue;
        const price = bear ? z.top : z.bottom;
        if (dist(price) >= min) found.push({ kind: 'zone', key: z.key, price });
      }
      found.sort((a, z) => dist(a.price) - dist(z.price) || (a.key < z.key ? -1 : 1));
      s.target1 = found[0] ?? null;
      s.target2 = s.target1 ? (found.find((x) => dist(x.price) > dist(s.target1!.price)) ?? null) : null;
    }
    if (s.target1 && s.invalidation !== null && s.invalidation !== entry)
      s.rr = ratio4(Math.abs(s.target1.price - entry), Math.abs(entry - s.invalidation));
  }

  // ── §7 Checklist ────────────────────────────────────────────────────────────────────────────

  /** Evaluates the eight items for the setup as it stands (rulebook §7). */
  private evaluate(r: Run, s: Setup): void {
    const c = this.p.setups.checklist;
    const bear = s.direction === 'bearish';
    const t = s.trigger;
    const out: ChecklistResult[] = [];
    const add = (item: ChecklistItem, credit: 0 | 0.5 | 1, evidence: Record<string, unknown>) =>
      out.push({ item, credit, weight: c.weights[item], mandatory: c.mandatory.includes(item), evidence });

    // 1. Higher-timeframe bias.
    const trend = r.ctx?.external?.trend ?? 'undefined';
    if (trend === s.direction) add('htf_bias', 1, { trend });
    else {
      const window = t && r.ctx ? this.ranging(r.ctx) : null;
      const eq = window ? (window.hi + window.lo) / 2 : null;
      if (window && t && (bear ? t.extreme > eq! : t.extreme < eq!))
        add('htf_bias', 0.5, { trend, ranging: true, equilibrium: midpoint(window.hi, window.lo) });
      else add('htf_bias', 0, { trend, ranging: window !== null });
    }

    // 2. Liquidity marked.
    if (!t) add('liquidity_marked', 0, { reason: 'no_sweep' });
    else if (
      MARKED.has(t.levelType) &&
      (t.levelType !== 'eqh' && t.levelType !== 'eql' ? true : t.touches >= 2)
    )
      add('liquidity_marked', 1, { level: t.level, type: t.levelType });
    else if (t.levelType === 'swing_high' || t.levelType === 'swing_low')
      add('liquidity_marked', 0.5, { level: t.level, type: t.levelType });
    else add('liquidity_marked', 0, { level: t.level, type: t.levelType });

    // 3. POI present.
    if (s.pattern === 'eq_near_poi' || s.pattern === 'htf_order_block') {
      const reached = !!(s.poi && t && (bear ? t.extreme >= s.poi.bottom : t.extreme <= s.poi.top));
      add('poi_present', reached ? 1 : 0, { poi: s.poi?.key ?? null, reached });
    } else if (!s.entryZone) add('poi_present', 0, { reason: 'no_entry_zone' });
    else {
      const atr = lastAtr(r.ctx);
      const near =
        atr === null
          ? undefined
          : [...r.v.zones.values()].find(
              (z) =>
                z.tf === r.pair.context &&
                z.direction === s.direction &&
                isLive(z) &&
                intervalGap(z, s.entryZone!) <= 0.5 * atr,
            );
      add('poi_present', near ? 1 : 0.5, near ? { poi: near.key } : { entryZone: s.entryZone.key });
    }

    // 4.–6. Sweep, MSS, levels (mandatory by default).
    add('sweep', t && qualifies(t) ? 1 : 0, t ? { sweep: t.key } : { reason: 'no_sweep' });
    add('mss', s.mss ? 1 : 0, s.mss ? { anchor: s.mss.anchor, breakCandleTime: s.mss.breakCandleTime } : {});
    const ordered =
      s.entry !== null &&
      s.invalidation !== null &&
      s.target1 !== null &&
      (bear
        ? s.target1.price < s.entry && s.entry < s.invalidation
        : s.target1.price > s.entry && s.entry > s.invalidation);
    add(
      'levels_defined',
      ordered ? 1 : 0,
      ordered
        ? {}
        : { missing: [s.entry === null && 'entry', s.target1 === null && 'target1'].filter(Boolean) },
    );

    // 7. Risk-to-reward on T1, compared exactly.
    let rrOk = false;
    if (ordered) {
      const reward = BigInt(Math.abs(s.target1!.price - s.entry!));
      const risk = BigInt(Math.abs(s.entry! - s.invalidation!));
      rrOk = reward * 10_000n >= BigInt(Math.round(c.minRR * 10_000)) * risk;
    }
    add('risk_reward', rrOk ? 1 : 0, { rr: s.rr, minRR: c.minRR });

    // 8. News clear.
    const events = r.v.economicEvents;
    if (events === null) add('news_clear', 0, { reason: 'calendar_unavailable' });
    else {
      const from = r.v.time - c.newsBlackoutMin.before * MINUTE_MS;
      const to = r.v.time + c.newsBlackoutMin.after * MINUTE_MS;
      const hits = events.filter(
        (e) =>
          e.impact === 'high' &&
          c.newsCurrencies.includes(e.currency) &&
          e.scheduledAt >= from &&
          e.scheduledAt <= to,
      );
      add('news_clear', hits.length ? 0 : 1, hits.length ? { events: hits.map((e) => e.id) } : {});
    }

    out.sort((a, z) => CHECKLIST_ITEMS.indexOf(a.item) - CHECKLIST_ITEMS.indexOf(z.item));
    s.checklist = out;
    s.score = out.reduce((sum, x) => sum + x.weight * x.credit, 0);
    s.mandatoryPassed = out.every((x) => !x.mandatory || x.credit === 1);
  }

  /** §2.4's range test over the context timeframe's latest window, without detecting anything. */
  private ranging(ctx: TfView): { hi: number; lo: number } | null {
    const p = this.p.ranges;
    const n = ctx.ring.next - 1;
    const from = n - p.lookback + 1;
    if (!contiguous(ctx.ring, from, n)) return null;
    const atr = ctx.ring.get(n)!.atr;
    if (atr === null) return null;
    let hi = -Infinity;
    let lo = Infinity;
    let path = 0;
    for (let i = from; i <= n; i++) {
      const x = ctx.ring.get(i)!;
      hi = Math.max(hi, x.h);
      lo = Math.min(lo, x.l);
      if (i > from) path += Math.abs(x.c - ctx.ring.get(i - 1)!.c);
    }
    if (hi - lo > p.maxHeightAtr * atr) return null;
    if (Math.abs(ctx.ring.get(n)!.c - ctx.ring.get(from)!.c) > p.maxEfficiency * path) return null;
    const tol = p.touchTolAtr * atr;
    const touches = (test: (s: Slot) => boolean) => {
      let count = 0;
      let last = -Infinity;
      for (let i = from; i <= n; i++)
        if (test(ctx.ring.get(i)!) && i - last >= p.minTouchSeparation) {
          count++;
          last = i;
        }
      return count;
    };
    if (touches((x) => x.h >= hi - tol) < p.minTouches || touches((x) => x.l <= lo + tol) < p.minTouches)
      return null;
    return { hi, lo };
  }

  /** §7 low_liquidity: the median quote volume of the last 20 setup candles below 0.3 × that of 30 days. */
  private lowLiquidity(r: Run): boolean {
    const q = r.st.qv;
    if (!q) return false;
    const values = (count: number) => {
      const out: number[] = [];
      for (let i = q.next - 1; i >= Math.max(q.first, q.next - count); i--) {
        const x = q.get(i);
        if (x !== null && x !== undefined) out.push(x);
      }
      return out;
    };
    const recent = values(LOW_LIQ_RECENT);
    if (recent.length < LOW_LIQ_RECENT) return false;
    const all = values(Math.floor((LOW_LIQ_DAYS * DAY_MS) / TF_MS[r.st.tf]));
    return median(recent) < this.p.setups.quality.lowLiqVolumeRatio * median(all);
  }

  // ── Confirmed and entry_active: outcomes (§6.1, §8) ─────────────────────────────────────────

  private judge(s: Setup, h: number, l: number): Move {
    const bear = s.direction === 'bearish';
    const t1 = s.target1!.price;
    const target = bear ? l <= t1 : h >= t1;
    const invalid = bear ? h >= s.invalidation! : l <= s.invalidation!;
    if (s.state === 'confirmed') {
      const entry = bear ? h >= s.entry! : l <= s.entry!;
      if (entry && target) return 'conflict';
      if (entry && invalid) return 'entry_invalid';
      if (entry) return 'entry';
      return target ? 'cancel' : 'none';
    }
    if (target && invalid) return 'conflict';
    return target ? 'target' : invalid ? 'invalid' : 'none';
  }

  private track(r: Run, s: Setup): void {
    const { slot, n } = r;
    if (s.state === 'entry_active') {
      s.hi = Math.max(s.hi!, slot.h);
      s.lo = Math.min(s.lo!, slot.l);
    }
    const move = this.judge(s, slot.h, slot.l);
    if (move === 'conflict') this.byMinutes(r, s);
    else this.apply(r, s, move, { high: fromUnits(slot.h), low: fromUnits(slot.l) }, null);
    if (s.state === 'resolved') return;
    const timing = this.p.setups.timing;
    // The windows (open times): from the candle after confirmation, or from the entry candle.
    const window = (from: number) => ({ window: { from: r.st.ring.get(from)?.t ?? null, to: slot.t } });
    if (s.state === 'confirmed' && n - s.confirmIndex! >= timing.entryExpiryBars)
      this.resolve(r, s, 'expired_no_entry', 'entry_window_passed', window(s.confirmIndex! + 1));
    else if (s.state === 'entry_active' && n - s.entryIndex! >= timing.maxHoldBars)
      this.resolve(r, s, 'expired_open', 'hold_window_passed', window(s.entryIndex!));
  }

  /** §6.1 ambiguity: one setup candle traded through both outcomes; its 1m candles decide the order. */
  private byMinutes(r: Run, s: Setup): void {
    const start = r.slot.t;
    for (let t = start; t < start + TF_MS[r.st.tf]; t += MINUTE_MS) {
      const m = r.v.minute(t);
      if (!m || m.t !== t || m.gap) return this.resolve(r, s, 'ambiguous', 'no_1m_data', { minute: t }, null);
      const move = this.judge(s, m.h, m.l);
      const evidence = { minute: t, high: fromUnits(m.h), low: fromUnits(m.l) };
      if (move === 'conflict') return this.resolve(r, s, 'ambiguous', 'same_1m_candle', evidence, '1m');
      if (move !== 'none') this.apply(r, s, move, evidence, '1m');
      if (s.state === 'resolved') return;
    }
  }

  /** Applies a move; the evidence is the deciding candle's (or minute's) high and low, plus the level. */
  private apply(r: Run, s: Setup, move: Move, evidence: Record<string, unknown>, tf: '1m' | null): void {
    const target1 = { ...evidence, target1: fromUnits(s.target1!.price) };
    const invalidation = { ...evidence, invalidation: fromUnits(s.invalidation!) };
    switch (move) {
      case 'entry':
      case 'entry_invalid':
        s.entryIndex = r.n;
        s.entryAt = r.v.time;
        s.hi = r.slot.h;
        s.lo = r.slot.l;
        this.transition(r, s, 'confirmed', 'entry_active', 'entry_touched', {
          ...evidence,
          entry: fromUnits(s.entry!),
        });
        if (move === 'entry_invalid')
          this.resolve(r, s, 'invalidated', 'invalidation_price', invalidation, tf);
        return;
      case 'target':
        return this.resolve(r, s, 'target_reached', 'target1_reached', target1, tf);
      case 'invalid':
        return this.resolve(r, s, 'invalidated', 'invalidation_price', invalidation, tf);
      case 'cancel':
        return this.resolve(r, s, 'expired_no_entry', 'target_before_entry', target1, tf);
      default:
    }
  }

  private resolve(
    r: Run,
    s: Setup,
    result: SetupResolution,
    reason: string,
    evidence: Record<string, unknown>,
    tf: '1m' | null = null,
  ): void {
    const from = s.state;
    s.resolution = result;
    if (s.confirmIndex !== null) {
      let mfeR: number | null = null;
      let maeR: number | null = null;
      if (s.entryIndex !== null) {
        const bear = s.direction === 'bearish';
        const risk = Math.abs(s.entry! - s.invalidation!);
        mfeR = ratio4(Math.max(0, bear ? s.entry! - s.lo! : s.hi! - s.entry!), risk);
        maeR = ratio4(Math.max(0, bear ? s.hi! - s.entry! : s.entry! - s.lo!), risk);
      }
      s.outcome = {
        result,
        entryTouchedAt: s.entryAt,
        resolvedAt: r.v.time,
        mfeR,
        maeR,
        barsHeld: s.entryIndex === null ? null : r.n - s.entryIndex + 1,
        resolvedWithTf: tf,
      };
    }
    this.transition(r, s, from, 'resolved', reason, evidence);
  }

  // ── Events ──────────────────────────────────────────────────────────────────────────────────

  private transition(
    r: Run,
    s: Setup,
    from: SetupState | null,
    to: SetupState,
    reason: string,
    evidence: Record<string, unknown>,
    evaluate = true,
  ): void {
    s.state = to;
    if (evaluate) this.evaluate(r, s);
    const price = (x: number | null) => (x === null ? null : fromUnits(x));
    const ref = (x: TargetRec | null): TargetRef | null =>
      x ? { kind: x.kind, key: x.key, price: fromUnits(x.price) } : null;
    const levels: string[] = [];
    const addLevel = (k: string | null | undefined) => {
      if (k && !levels.includes(k)) levels.push(k);
    };
    addLevel(s.s1 && s.sweeps.includes(s.s1.key) ? s.s1.level : null);
    addLevel(s.s1Other && s.sweeps.includes(s.s1Other.key) ? s.s1Other.level : null);
    addLevel(s.trigger?.level);
    addLevel(s.eq);
    for (const x of [s.target1, s.target2]) if (x?.kind === 'level') addLevel(x.key);
    const mss = s.mss ? (({ breakIndex: _, ...rest }) => structuredClone(rest))(s.mss) : null;
    r.v.emitSetup(s.setupTf, s.key, {
      pattern: s.pattern,
      variant: s.variant,
      direction: s.direction,
      contextTf: s.contextTf,
      setupTf: s.setupTf,
      from,
      to,
      reason,
      resolution: s.resolution,
      createdAt: s.createdAt,
      levels: {
        entry: price(s.entry),
        invalidation: price(s.invalidation),
        target1: price(s.target1?.price ?? null),
        target2: price(s.target2?.price ?? null),
        rr: s.rr,
      },
      entryZone: s.entryZone?.key ?? null,
      targets: { target1: ref(s.target1), target2: ref(s.target2) },
      checklist: structuredClone(s.checklist),
      score: s.score,
      mandatoryPassed: s.mandatoryPassed,
      qualityFlags: [...s.flags],
      refs: {
        sweeps: [...s.sweeps],
        mss,
        range: s.range?.kind === 'range' ? s.range.key : null,
        poi: s.poi?.key ?? null,
        levels,
      },
      evidence,
      outcome: s.outcome ? { ...s.outcome } : null,
    });
  }
}

/** The evidence name of a Pattern 1/4 structure: a range, or a swing pair (Pattern 4 without one). */
function structureName(x: RangeRef): 'range' | 'swing' {
  return x.kind === 'range' ? 'range' : 'swing';
}

function flag(s: Setup, f: QualityFlag): void {
  if (!s.flags.includes(f)) s.flags.push(f);
}

function pick(x: { key: string; high: number; low: number; highLevel: string; lowLevel: string }) {
  return { key: x.key, high: x.high, low: x.low, highLevel: x.highLevel, lowLevel: x.lowLevel };
}
