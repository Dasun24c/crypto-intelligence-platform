import { MINUTE_MS, TF_MS, TIMEFRAMES, type Timeframe } from '@cip/domain';
import { Atr, type AtrState } from '@cip/indicators';
import { createdFvg, findDisplacement } from './displacement.js';
import {
  addMonths,
  DAY_MS,
  homeTimeframe,
  type Level,
  levelKey,
  locate,
  monthStart,
  WEEK_MS,
  weekendIntervals,
  weekStart,
} from './levels.js';
import {
  MAX_LOOKBACK,
  RULESET_VERSION,
  type RuleTimeframes,
  ruleTimeframes,
  type SessionName,
  sessionHours,
  type SmcParams,
  validateSmcParams,
} from './params.js';
import { fromUnits, midpoint, toUnits, unitsToNumber } from './price.js';
import { Ring, type RingState } from './ring.js';
import { contiguous, restoreSlots, type Slot, type SlotTuple, snapshotSlots } from './slot.js';
import {
  applyBreak,
  type Extreme,
  extendExtremes,
  newStructState,
  type StructState,
  type SwingRef,
  takeSwing,
  testBreak,
} from './structure.js';
import type {
  EngineCandle,
  EngineFlag,
  LevelStatus,
  LevelStatusData,
  LevelType,
  RangeEndReason,
  Side,
  SmcEvent,
  StepContext,
  StepInput,
  StructureLevel,
} from './types.js';

export interface EngineConfig {
  params: SmcParams;
  /** The instrument's price tick, a decimal string: every tolerance is at least one tick. */
  tick: string;
}

interface Pending {
  level: string;
  /** Slot index and open time of the breach candle. */
  index: number;
  t: number;
  extreme: number;
  /** Base volume traded beyond the level so far (rulebook §3.5). */
  volume: number;
  unverified: boolean;
}

interface RangeState {
  key: string;
  high: number;
  low: number;
  index: number;
  up: number;
  down: number;
  highLevel: string;
  lowLevel: string;
}

/** A period's high and low so far (day, week, month, session, closure). */
interface Acc {
  start: number;
  hi: number | null;
  lo: number | null;
  gap: boolean;
  /** Its first candle was seen: levels come only from periods observed from their start. */
  fromStart: boolean;
}

interface TfState {
  tf: Timeframe;
  /** Open time of the next candle. */
  next: number;
  ring: Ring<Slot>;
  atr: Atr;
  inGap: boolean;
  internal: StructState | null;
  external: StructState | null;
  /** Recent internal swings, for equal highs and lows. */
  highs: SwingRef[];
  lows: SwingRef[];
  range: RangeState | null;
  pending: Pending[];
  week: Acc | null;
  month: Acc | null;
  sessions: Partial<Record<SessionName, Acc>>;
  weekend: Acc | null;
}

/** A 1m candle's micro profile, kept for thin-book checks. */
interface Minute {
  t: number;
  l: number;
  h: number;
  p: number[] | null;
  gap: boolean;
}

interface TfSnapshot extends Omit<TfState, 'ring' | 'atr'> {
  ring: RingState<SlotTuple>;
  atr: AtrState;
}

/** The engine's whole state as plain JSON (architecture §7 checkpoints). */
export interface EngineSnapshot {
  v: 1;
  ruleset: string;
  /** The configuration it was built with; a restore must use the same. */
  config: string;
  time: number | null;
  seq: number;
  tfs: TfSnapshot[];
  levels: Level[];
  minutes: { origin: number | null; ring: RingState<Minute> };
}

interface Found {
  kind: 'high' | 'low';
  level: StructureLevel;
  index: number;
  price: number;
  key: string;
}

const NO_CONTEXT: StepContext = { closures: [] };
const HOUR_MS = 3_600_000;
const short = (level: StructureLevel) => (level === 'internal' ? 'int' : 'ext');
const sideCode = (side: Side) => (side === 'buy_side' ? 'b' : 's');
const isTimeframe = (v: unknown): v is Timeframe =>
  typeof v === 'string' && (TIMEFRAMES as readonly string[]).includes(v);
const maxOf = (a: number | null, b: number) => (a === null || b > a ? b : a);
const minOf = (a: number | null, b: number) => (a === null || b < a ? b : a);

/** Base volume of a 1m micro profile beyond `price` (rulebook §3.5): the bucket holding it pro rata. */
export function volumeBeyond(m: Pick<Minute, 'l' | 'h' | 'p'>, price: number, buySide: boolean): number {
  const p = m.p!;
  let total = 0;
  for (const v of p) total += v;
  if (m.h <= m.l) return (buySide ? m.l > price : m.l < price) ? total : 0;
  if (buySide ? price >= m.h : price <= m.l) return 0;
  if (buySide ? price < m.l : price > m.h) return total;
  const width = (m.h - m.l) / p.length;
  let beyond = 0;
  for (let b = 0; b < p.length; b++) {
    const lo = m.l + b * width;
    const share = buySide ? (lo + width - price) / width : (price - lo) / width;
    if (share >= 1) beyond += p[b]!;
    else if (share > 0) beyond += p[b]! * share;
  }
  return beyond;
}

/**
 * The SMC rulebook (v0.1, §2–§3 and §9) as a deterministic reducer (ADR 004). It takes closed
 * candles one boundary at a time and returns the confirmed detections they cause. It reads no
 * clock, uses no randomness and does no I/O, so the same candles always give the same events, and
 * {@link snapshot}/{@link restore} continue a run exactly where it stopped.
 *
 * At each boundary the longest timeframe is evaluated first; within a timeframe the rules run in
 * the rulebook's order: swings, structure (with displacement), ranges, liquidity levels, sweeps.
 */
export class SmcEngine {
  readonly params: SmcParams;
  private readonly tick: number;
  private readonly rules: RuleTimeframes;
  private readonly configJson: string;
  private readonly sessionWindows: { name: SessionName; start: number; end: number }[];
  private readonly minuteSpan: number;

  private time: number | null = null;
  private seq = 0;
  private readonly tfs = new Map<Timeframe, TfState>();
  private levels = new Map<string, Level>();
  private minuteOrigin: number | null = null;
  private minutes: Ring<Minute>;

  private events: SmcEvent[] = [];
  private context: StepContext = NO_CONTEXT;
  private weekendCache: { from: StepContext; list: { start: number; end: number }[] } | null = null;

  constructor(config: EngineConfig) {
    validateSmcParams(config.params);
    this.params = JSON.parse(JSON.stringify(config.params)) as SmcParams;
    this.tick = toUnits(config.tick);
    if (!(this.tick > 0)) throw new RangeError('the price tick must be positive');
    this.rules = ruleTimeframes(this.params);
    this.configJson = JSON.stringify({ ruleset: RULESET_VERSION, params: this.params, tick: config.tick });
    this.sessionWindows = this.params.sessions.map((s) => ({ name: s.name, ...sessionHours(s) }));
    this.minuteSpan = Math.max(1, ...[...this.rules.sweeps].map((tf) => TF_MS[tf] / MINUTE_MS));
    this.minutes = new Ring<Minute>(this.minuteSpan);
  }

  /** The last boundary processed, or null before the first. */
  get lastTime(): number | null {
    return this.time;
  }

  /** The number of events emitted so far (the last `seq`). */
  get lastSeq(): number {
    return this.seq;
  }

  /** Active levels in creation order (a copy), for inspection and tests. */
  activeLevels(): Level[] {
    return [...this.levels.values()].filter((l) => l.status === 'active').map((l) => structuredClone(l));
  }

  /** The current trend on a timeframe, or null when structure does not run there. */
  trend(tf: Timeframe, level: StructureLevel): StructState['trend'] | null {
    const st = this.tfs.get(tf);
    return (level === 'internal' ? st?.internal : st?.external)?.trend ?? null;
  }

  /** Processes one boundary and returns the events it confirms, in order. */
  step(input: StepInput, context: StepContext = NO_CONTEXT): SmcEvent[] {
    const time = input.time;
    if (!Number.isSafeInteger(time) || time % MINUTE_MS !== 0)
      throw new RangeError(`boundary ${time} is not a whole minute`);
    if (this.time !== null && time <= this.time)
      throw new RangeError(`boundaries must increase: ${time} after ${this.time}`);
    const due = new Map<Timeframe, EngineCandle | null>();
    for (const c of input.candles) {
      if (!isTimeframe(c.tf)) throw new RangeError(`unknown timeframe ${String(c.tf)}`);
      if (c.openTime + TF_MS[c.tf] !== time)
        throw new RangeError(`${c.tf} candle at ${c.openTime} does not close at ${time}`);
      if (due.has(c.tf)) throw new RangeError(`two ${c.tf} candles close at ${time}`);
      due.set(c.tf, c);
    }
    for (const tf of input.missing ?? []) {
      if (!isTimeframe(tf) || time % TF_MS[tf] !== 0)
        throw new RangeError(`no ${String(tf)} candle closes at ${time}`);
      if (due.has(tf)) throw new RangeError(`${tf} at ${time} is both given and missing`);
      due.set(tf, null);
    }
    for (const tf of this.tfs.keys())
      if (time % TF_MS[tf] === 0 && !due.has(tf))
        throw new RangeError(`the ${tf} candle closing at ${time} is absent`);

    this.events = [];
    this.time = time;
    this.context = context;
    if (due.has('1m')) this.takeMinute(time - MINUTE_MS, due.get('1m')!);
    for (let k = TIMEFRAMES.length - 1; k >= 0; k--) {
      const tf = TIMEFRAMES[k]!;
      if (due.has(tf)) this.processTimeframe(tf, due.get(tf)!);
    }
    this.expire();
    const out = this.events;
    this.events = [];
    return out;
  }

  // ── State per timeframe ─────────────────────────────────────────────────────────────────────

  private newTimeframe(tf: Timeframe, openTime: number): TfState {
    const used = this.rules.structure.has(tf) || this.rules.ranges.has(tf) || this.rules.sweeps.has(tf);
    const structure = this.rules.structure.has(tf);
    return {
      tf,
      next: openTime,
      ring: new Ring<Slot>(used ? MAX_LOOKBACK : 2),
      atr: new Atr(this.params.atrPeriod),
      inGap: false,
      internal: structure ? newStructState() : null,
      external: structure ? newStructState() : null,
      highs: [],
      lows: [],
      range: null,
      pending: [],
      week: null,
      month: null,
      sessions: {},
      weekend: null,
    };
  }

  private processTimeframe(tf: Timeframe, candle: EngineCandle | null): void {
    const openTime = this.time! - TF_MS[tf];
    let st = this.tfs.get(tf);
    if (!st) {
      st = this.newTimeframe(tf, openTime);
      this.tfs.set(tf, st);
    }
    if (st.next !== openTime)
      throw new RangeError(`${tf}: expected the candle at ${st.next}, got ${openTime}`);
    st.next = this.time!;

    let slot: Slot;
    if (candle === null) {
      slot = { t: openTime, o: 0, h: 0, l: 0, c: 0, atr: null, gap: true, uc: false };
    } else {
      const o = toUnits(candle.open);
      const h = toUnits(candle.high);
      const l = toUnits(candle.low);
      const c = toUnits(candle.close);
      if (!(l <= Math.min(o, c) && h >= Math.max(o, c)))
        throw new RangeError(`${tf} candle at ${openTime} has inconsistent prices`);
      const atr = st.atr.next(h, l, c);
      slot = { t: openTime, o, h, l, c, atr, gap: candle.quality === 'partial', uc: candle.underlyingClosed };
    }
    const n = st.ring.push(slot);

    if (slot.gap) {
      if (!st.inGap) this.gapMarker(st, slot);
      st.inGap = true;
    } else {
      st.inGap = false;
    }

    let found: Found[] = [];
    if (!slot.gap && st.internal) found = this.structure(st, slot, n);
    if (!slot.gap && this.rules.ranges.has(tf)) this.ranges(st, slot, n);
    if (found.length) this.levelsFromSwings(st, found);
    const hasData = candle !== null;
    if (tf === '1d') this.periods(st, slot, hasData);
    if (tf === '1h') {
      this.sessions(st, slot, hasData);
      this.weekend(st, slot, hasData);
    }
    if (!slot.gap && this.rules.sweeps.has(tf)) this.sweeps(st, slot, n);
  }

  private takeMinute(openTime: number, candle: EngineCandle | null): void {
    if (this.minuteOrigin === null) this.minuteOrigin = openTime;
    if (this.minuteOrigin + this.minutes.next * MINUTE_MS !== openTime)
      throw new RangeError(`1m: candles must be consecutive (${openTime})`);
    this.minutes.push(
      candle === null
        ? { t: openTime, l: 0, h: 0, p: null, gap: true }
        : {
            t: openTime,
            l: toUnits(candle.low),
            h: toUnits(candle.high),
            p: candle.microProfile ? [...candle.microProfile] : null,
            gap: candle.quality === 'partial',
          },
    );
  }

  private minute(t: number): Minute | undefined {
    if (this.minuteOrigin === null) return undefined;
    return this.minutes.get((t - this.minuteOrigin) / MINUTE_MS);
  }

  // ── Events ──────────────────────────────────────────────────────────────────────────────────

  private emit<E extends SmcEvent>(type: E['type'], tf: Timeframe, key: string, data: E['data']): void {
    this.events.push({ seq: ++this.seq, type, tf, time: this.time!, key, data } as SmcEvent);
  }

  // ── §9 Gaps ─────────────────────────────────────────────────────────────────────────────────

  /** The first missing or partial candle of a gap: pending breaches and the active range end. */
  private gapMarker(st: TfState, slot: Slot): void {
    const dropped = st.pending.map((p) => p.level);
    st.pending = [];
    this.emit('gap_marker', st.tf, `gm:${st.tf}:${slot.t}`, {
      from: slot.t,
      droppedBreaches: dropped,
      endedRange: st.range?.key ?? null,
    });
    if (st.range) this.endRange(st, 'data_gap');
  }

  // ── §2.1 Swings and §2.2 structure ──────────────────────────────────────────────────────────

  private swingsAt(st: TfState, n: number, k: number, level: StructureLevel): Found[] {
    const i = n - k;
    if (!contiguous(st.ring, i - k, n)) return [];
    const ring = st.ring;
    const s = ring.get(i)!;
    let high = true;
    let low = true;
    for (let j = i - k; j < i; j++) {
      const x = ring.get(j)!;
      if (x.h >= s.h) high = false;
      if (x.l <= s.l) low = false;
    }
    for (let j = i + 1; j <= n; j++) {
      const x = ring.get(j)!;
      if (x.h > s.h) high = false;
      if (x.l < s.l) low = false;
    }
    const out: Found[] = [];
    const key = (kind: 'h' | 'l') => `sw:${st.tf}:${short(level)}:${kind}:${s.t}`;
    if (high) out.push({ kind: 'high', level, index: i, price: s.h, key: key('h') });
    if (low) out.push({ kind: 'low', level, index: i, price: s.l, key: key('l') });
    return out;
  }

  /** The opposite extreme over the candles after swing candle `i`, up to `n` (ties: the latest). */
  private legAfter(ring: Ring<Slot>, kind: 'high' | 'low', i: number, n: number): Extreme {
    let e: Extreme = { price: kind === 'high' ? ring.get(n)!.l : ring.get(n)!.h, index: n };
    for (let j = n - 1; j > i; j--) {
      const x = ring.get(j)!;
      if (kind === 'high' ? x.l < e.price : x.h > e.price)
        e = { price: kind === 'high' ? x.l : x.h, index: j };
    }
    return e;
  }

  private breakBuffer(s: Slot): number | null {
    const buffer = this.params.structure.breakBufferAtr;
    if (buffer === 0) return this.tick;
    return s.atr === null ? null : Math.max(buffer * s.atr, this.tick);
  }

  private structure(st: TfState, s: Slot, n: number): Found[] {
    const found = [
      ...this.swingsAt(st, n, this.params.swings.internalOrder, 'internal'),
      ...this.swingsAt(st, n, this.params.swings.externalOrder, 'external'),
    ];
    const confirmedAt = this.time!;
    for (const f of found) {
      const x = st.ring.get(f.index)!;
      this.emit('swing_confirmed', st.tf, f.key, {
        kind: f.kind,
        level: f.level,
        price: fromUnits(f.price),
        candleTime: x.t,
        confirmedAt,
        flags: [],
      });
    }
    const eps = this.breakBuffer(s);
    for (const level of ['internal', 'external'] as const) {
      const ss = level === 'internal' ? st.internal! : st.external!;
      extendExtremes(ss, s, n);
      for (const f of found)
        if (f.level === level)
          takeSwing(
            ss,
            { key: f.key, price: f.price, index: f.index },
            f.kind,
            this.legAfter(st.ring, f.kind, f.index, n),
          );
      if (eps === null) continue;
      const b = testBreak(ss, s.c, eps);
      if (!b) continue;
      const d = findDisplacement(st.ring, b.direction, b.anchor.leg.index, n, this.params.displacement);
      const type = b.type === 'choch' && d ? 'mss' : b.type;
      this.emit('structure', st.tf, `st:${st.tf}:${short(level)}:${type}:${s.t}`, {
        level,
        type,
        direction: b.direction,
        brokenSwing: b.anchor.key,
        breakPrice: fromUnits(b.anchor.price),
        breakCandleTime: s.t,
        isInitial: b.isInitial,
        displacement: d
          ? {
              from: st.ring.get(d.from)!.t,
              to: st.ring.get(d.to)!.t,
              bodyAtr: d.bodyAtr,
              createdFvg: createdFvg(st.ring, b.direction, d.from, d.to, n, this.params.fvg.minSizeAtr),
            }
          : null,
        flags: s.uc ? ['underlying_closed'] : [],
      });
      applyBreak(ss, b, s, n, eps);
    }
    return found;
  }

  // ── §2.4 Trading ranges ─────────────────────────────────────────────────────────────────────

  private spacedTouches(ring: Ring<Slot>, from: number, to: number, touches: (s: Slot) => boolean): number {
    const separation = this.params.ranges.minTouchSeparation;
    let count = 0;
    let last = -Infinity;
    for (let i = from; i <= to; i++) {
      if (touches(ring.get(i)!) && i - last >= separation) {
        count++;
        last = i;
      }
    }
    return count;
  }

  private ranges(st: TfState, s: Slot, n: number): void {
    const r = this.params.ranges;
    const atr = s.atr;
    if (atr === null) return;
    if (st.range) {
      const rg = st.range;
      const buffer = r.breakBufferAtr * atr;
      if (s.c > rg.high && s.c - rg.high >= buffer) {
        rg.up++;
        rg.down = 0;
      } else if (s.c < rg.low && rg.low - s.c >= buffer) {
        rg.down++;
        rg.up = 0;
      } else {
        rg.up = 0;
        rg.down = 0;
      }
      if (rg.up >= r.breakCloses) this.endRange(st, 'breakout_up');
      else if (rg.down >= r.breakCloses) this.endRange(st, 'breakout_down');
      else if (n - rg.index >= r.maxAge) this.endRange(st, 'expired');
      // A new range can start only from the candle after the end.
      return;
    }
    const from = n - r.lookback + 1;
    if (!contiguous(st.ring, from, n)) return;
    let hi = -Infinity;
    let lo = Infinity;
    let path = 0;
    for (let i = from; i <= n; i++) {
      const x = st.ring.get(i)!;
      if (x.h > hi) hi = x.h;
      if (x.l < lo) lo = x.l;
      if (i > from) path += Math.abs(x.c - st.ring.get(i - 1)!.c);
    }
    if (hi - lo > r.maxHeightAtr * atr) return;
    const net = Math.abs(s.c - st.ring.get(from)!.c);
    if (net > r.maxEfficiency * path) return;
    const tol = r.touchTolAtr * atr;
    if (this.spacedTouches(st.ring, from, n, (x) => x.h >= hi - tol) < r.minTouches) return;
    if (this.spacedTouches(st.ring, from, n, (x) => x.l <= lo + tol) < r.minTouches) return;

    const key = `rg:${st.tf}:${this.time}`;
    this.emit('range_detected', st.tf, key, {
      high: fromUnits(hi),
      low: fromUnits(lo),
      equilibrium: midpoint(hi, lo),
      windowStart: st.ring.get(from)!.t,
      detectedAt: this.time!,
      flags: [],
    });
    const make = (type: LevelType, side: Side, price: number) =>
      this.createLevel(st.tf, type, side, price, {
        sourceRefs: [key],
        location: 'external',
        expiresAt: null,
        range: key,
      });
    const high = make('range_high', 'buy_side', hi);
    const low = make('range_low', 'sell_side', lo);
    st.range = { key, high: hi, low: lo, index: n, up: 0, down: 0, highLevel: high.key, lowLevel: low.key };
  }

  private endRange(st: TfState, reason: RangeEndReason): void {
    const rg = st.range!;
    st.range = null;
    this.emit('range_ended', st.tf, rg.key, { endedAt: this.time!, reason });
    for (const [key, broken] of [
      [rg.highLevel, reason === 'breakout_up'],
      [rg.lowLevel, reason === 'breakout_down'],
    ] as const) {
      const lvl = this.levels.get(key);
      if (!lvl || lvl.status !== 'active') continue;
      lvl.range = null;
      this.setStatus(lvl, broken ? 'broken' : 'expired', broken ? 'broken' : 'range_ended');
    }
  }

  // ── §3 Liquidity levels ─────────────────────────────────────────────────────────────────────

  private createLevel(
    tf: Timeframe,
    type: LevelType,
    side: Side,
    price: number,
    opts: {
      sourceRefs: string[];
      location?: Level['location'];
      expiresAt: number | null;
      range?: string | null;
      touches?: number;
      sessionName?: SessionName | null;
      flags?: EngineFlag[];
      lastTouch?: number | null;
    },
  ): Level {
    const knownAt = this.time!;
    const key = levelKey(tf, type, side, knownAt);
    if (this.levels.has(key)) throw new Error(`level ${key} exists already`);
    const lvl: Level = {
      key,
      type,
      side,
      tf,
      price,
      touches: opts.touches ?? 1,
      sessionName: opts.sessionName ?? null,
      sourceRefs: opts.sourceRefs,
      location: opts.location ?? locate(price, this.tfs.get(tf)?.range ?? null),
      knownAt,
      status: 'active',
      sweepCount: 0,
      flags: opts.flags ?? [],
      expiresAt: opts.expiresAt,
      home: homeTimeframe(tf, this.rules.sweeps),
      consumed: [],
      range: opts.range ?? null,
      lastTouch: opts.lastTouch ?? null,
    };
    this.levels.set(key, lvl);
    this.emit('level_created', tf, key, {
      type,
      side,
      price: fromUnits(price),
      touches: lvl.touches,
      sessionName: lvl.sessionName,
      sourceRefs: [...lvl.sourceRefs],
      location: lvl.location,
      knownAt,
      status: 'active',
      sweepCount: 0,
      flags: [...lvl.flags],
    });
    return lvl;
  }

  private levelStatus(lvl: Level, reason: LevelStatusData['reason']): void {
    this.emit('level_status', lvl.tf, lvl.key, {
      status: lvl.status,
      price: fromUnits(lvl.price),
      touches: lvl.touches,
      sweepCount: lvl.sweepCount,
      statusChangedAt: lvl.status === 'active' ? null : this.time!,
      reason,
    });
  }

  private setStatus(lvl: Level, status: LevelStatus, reason: LevelStatusData['reason']): void {
    lvl.status = status;
    this.levelStatus(lvl, reason);
  }

  /** No candle strictly between slots a and b goes beyond `bound` (and none is a gap). */
  private clearBetween(ring: Ring<Slot>, a: number, b: number, high: boolean, bound: number): boolean {
    for (let i = a + 1; i < b; i++) {
      const x = ring.get(i);
      if (!x || x.gap || (high ? x.h > bound : x.l < bound)) return false;
    }
    return true;
  }

  /** §3.2: a new internal swing joins an active equal high/low or pairs with an earlier swing. */
  private equalLevel(st: TfState, f: Found): void {
    const p = this.params.equalLevels;
    const high = f.kind === 'high';
    const list = high ? st.highs : st.lows;
    const atr = st.ring.get(f.index)!.atr;
    if (atr !== null) {
      const tol = Math.max(p.tolAtr * atr, this.tick);
      const type: LevelType = high ? 'eqh' : 'eql';
      const bound = (a: number) => (high ? Math.max(a, f.price) + tol : Math.min(a, f.price) - tol);
      let join: Level | null = null;
      for (const lvl of this.levels.values()) {
        if (lvl.type !== type || lvl.tf !== st.tf || lvl.status !== 'active' || lvl.lastTouch === null)
          continue;
        const gap = f.index - lvl.lastTouch;
        if (gap < p.minGap || gap > p.maxGap || Math.abs(lvl.price - f.price) > tol) continue;
        if (!this.clearBetween(st.ring, lvl.lastTouch, f.index, high, bound(lvl.price))) continue;
        if (!join || Math.abs(lvl.price - f.price) < Math.abs(join.price - f.price)) join = lvl;
      }
      if (join) {
        join.touches++;
        join.price = high ? Math.max(join.price, f.price) : Math.min(join.price, f.price);
        join.lastTouch = f.index;
        join.sourceRefs.push(f.key);
        this.levelStatus(join, 'touch');
      } else {
        for (let j = list.length - 1; j >= 0; j--) {
          const a = list[j]!;
          const gap = f.index - a.index;
          if (gap < p.minGap) continue;
          if (gap > p.maxGap) break;
          if (Math.abs(a.price - f.price) > tol) continue;
          if (!this.clearBetween(st.ring, a.index, f.index, high, bound(a.price))) continue;
          this.createLevel(
            st.tf,
            type,
            high ? 'buy_side' : 'sell_side',
            high ? Math.max(a.price, f.price) : Math.min(a.price, f.price),
            {
              sourceRefs: [a.key, f.key],
              expiresAt: this.time! + this.params.expiry.equalCandles * TF_MS[st.tf],
              touches: 2,
              lastTouch: f.index,
            },
          );
          break;
        }
      }
    }
    list.push({ key: f.key, price: f.price, index: f.index });
    while (list.length && list[0]!.index < f.index - p.maxGap) list.shift();
  }

  private levelsFromSwings(st: TfState, found: Found[]): void {
    const e = this.params.expiry;
    for (const f of found) {
      if (f.level === 'internal') this.equalLevel(st, f);
      else
        this.createLevel(
          st.tf,
          f.kind === 'high' ? 'swing_high' : 'swing_low',
          f.kind === 'high' ? 'buy_side' : 'sell_side',
          f.price,
          {
            sourceRefs: [f.key],
            expiresAt: this.time! + e.swingCandles * TF_MS[st.tf],
          },
        );
    }
  }

  private accumulate(acc: Acc | null, start: number, s: Slot, hasData: boolean): Acc {
    const a =
      acc && acc.start === start ? acc : { start, hi: null, lo: null, gap: false, fromStart: s.t <= start };
    if (hasData) {
      a.hi = maxOf(a.hi, s.h);
      a.lo = minOf(a.lo, s.l);
    }
    if (s.gap) a.gap = true;
    return a;
  }

  /** Levels at a period's high and low, when the period was seen from its start. */
  private periodLevels(
    tf: Timeframe,
    acc: Acc,
    types: [LevelType, LevelType],
    expiresAt: number,
    sessionName: SessionName | null = null,
  ): void {
    if (!acc.fromStart || acc.hi === null || acc.lo === null) return;
    const flags: EngineFlag[] = acc.gap ? ['data_gap'] : [];
    this.createLevel(tf, types[0], 'buy_side', acc.hi, {
      sourceRefs: [],
      expiresAt,
      sessionName,
      flags: [...flags],
    });
    this.createLevel(tf, types[1], 'sell_side', acc.lo, {
      sourceRefs: [],
      expiresAt,
      sessionName,
      flags: [...flags],
    });
  }

  /** §3.3 previous day, week and month, from 1d candles. */
  private periods(st: TfState, s: Slot, hasData: boolean): void {
    const time = this.time!;
    const e = this.params.expiry;
    if (hasData)
      this.periodLevels(
        '1d',
        { start: s.t, hi: s.h, lo: s.l, gap: s.gap, fromStart: true },
        ['pdh', 'pdl'],
        time + e.dayDays * DAY_MS,
      );
    st.week = this.accumulate(st.week, weekStart(s.t), s, hasData);
    if (time === st.week.start + WEEK_MS) {
      this.periodLevels('1d', st.week, ['pwh', 'pwl'], time + e.weekWeeks * WEEK_MS);
      st.week = null;
    }
    st.month = this.accumulate(st.month, monthStart(s.t), s, hasData);
    if (time === addMonths(st.month.start, 1)) {
      this.periodLevels('1d', st.month, ['pmh', 'pml'], addMonths(time, e.monthMonths));
      st.month = null;
    }
  }

  /** §3.3 session highs and lows, from 1h candles, when each session ends. */
  private sessions(st: TfState, s: Slot, hasData: boolean): void {
    const day = Math.floor(s.t / DAY_MS) * DAY_MS;
    for (const w of this.sessionWindows) {
      const start = day + w.start * HOUR_MS;
      const end = day + w.end * HOUR_MS;
      if (s.t < start || s.t >= end) continue;
      const acc = this.accumulate(st.sessions[w.name] ?? null, start, s, hasData);
      st.sessions[w.name] = acc;
      if (this.time === end) {
        this.periodLevels(
          '1h',
          acc,
          ['session_high', 'session_low'],
          end + this.params.expiry.sessionDays * DAY_MS,
          w.name,
        );
        delete st.sessions[w.name];
      }
    }
  }

  /** §3.3 weekend levels: the high and low during a gold-market closure, when it reopens. */
  private weekend(st: TfState, s: Slot, hasData: boolean): void {
    if (this.weekendCache?.from !== this.context)
      this.weekendCache = { from: this.context, list: weekendIntervals(this.context.closures) };
    const time = this.time!;
    const closure = this.weekendCache.list.find((c) => c.start < time && c.end > s.t);
    if (!closure) return;
    const acc = this.accumulate(st.weekend, closure.start, s, hasData);
    st.weekend = acc;
    if (time < closure.end) return;
    st.weekend = null;
    if (!acc.fromStart || acc.hi === null) return;
    for (const lvl of this.levels.values())
      if ((lvl.type === 'weekend_high' || lvl.type === 'weekend_low') && lvl.status === 'active')
        this.setStatus(lvl, 'expired', 'superseded');
    this.periodLevels(
      '1d',
      acc,
      ['weekend_high', 'weekend_low'],
      time + this.params.expiry.weekendDays * DAY_MS,
    );
  }

  private expire(): void {
    const time = this.time!;
    for (const lvl of this.levels.values())
      if (lvl.status === 'active' && lvl.expiresAt !== null && lvl.expiresAt <= time)
        this.setStatus(lvl, 'expired', 'expired');
    for (const [key, lvl] of this.levels) if (lvl.status !== 'active') this.levels.delete(key);
  }

  // ── §3.4 Sweeps and §3.5 thin-book wicks ────────────────────────────────────────────────────

  private addVolume(p: Pending, lvl: Level, s: Slot, tf: Timeframe): void {
    if (p.unverified) return;
    for (let t = s.t; t < s.t + TF_MS[tf]; t += MINUTE_MS) {
      const m = this.minute(t);
      if (!m || m.gap || m.p === null || m.t !== t) {
        p.unverified = true;
        return;
      }
      p.volume += volumeBeyond(m, lvl.price, lvl.side === 'buy_side');
    }
  }

  /** A breach that never closed back: the level is broken on this timeframe (a genuine breakout). */
  private breakLevel(lvl: Level, tf: Timeframe): void {
    if (lvl.range !== null) return; // an active range's high and low end only with the range (§3.4 rule 7)
    lvl.consumed.push(tf);
    if (lvl.home === tf) this.setStatus(lvl, 'broken', 'broken');
  }

  private sweeps(st: TfState, s: Slot, n: number): void {
    const atr = s.atr;
    if (atr === null) return;
    const sp = this.params.sweeps;
    const tf = st.tf;
    const minPenetration = Math.max(sp.minPenetrationAtr * atr, this.tick);
    const confirmed: { p: Pending; lvl: Level; kind: 'wick' | 'false_breakout' }[] = [];
    const resolved = new Set<string>();
    const closedBack = (lvl: Level) => (lvl.side === 'buy_side' ? s.c < lvl.price : s.c > lvl.price);

    const still: Pending[] = [];
    for (const p of st.pending) {
      const lvl = this.levels.get(p.level);
      if (!lvl || lvl.status !== 'active') continue;
      p.extreme = lvl.side === 'buy_side' ? Math.max(p.extreme, s.h) : Math.min(p.extreme, s.l);
      this.addVolume(p, lvl, s, tf);
      resolved.add(lvl.key);
      if (closedBack(lvl)) confirmed.push({ p, lvl, kind: 'false_breakout' });
      else if (n - p.index >= sp.closeBackBars) this.breakLevel(lvl, tf);
      else {
        still.push(p);
        resolved.delete(lvl.key);
      }
    }
    st.pending = still;
    const pendingKeys = new Set(still.map((p) => p.level));

    for (const lvl of this.levels.values()) {
      if (lvl.status !== 'active' || resolved.has(lvl.key) || pendingKeys.has(lvl.key)) continue;
      if (TF_MS[lvl.tf] < TF_MS[tf] || lvl.consumed.includes(tf) || lvl.knownAt > s.t) continue;
      const buy = lvl.side === 'buy_side';
      if (!(buy ? s.h >= lvl.price + minPenetration : s.l <= lvl.price - minPenetration)) continue;
      const p: Pending = {
        level: lvl.key,
        index: n,
        t: s.t,
        extreme: buy ? s.h : s.l,
        volume: 0,
        unverified: false,
      };
      this.addVolume(p, lvl, s, tf);
      if (closedBack(lvl)) confirmed.push({ p, lvl, kind: 'wick' });
      else if (sp.closeBackBars === 0) this.breakLevel(lvl, tf);
      else st.pending.push(p);
    }
    if (confirmed.length) this.confirm(st, s, atr, confirmed);
  }

  private confirm(
    st: TfState,
    s: Slot,
    atr: number,
    list: { p: Pending; lvl: Level; kind: 'wick' | 'false_breakout' }[],
  ): void {
    const tf = st.tf;
    const time = this.time!;
    const groups = new Map<Side, { key: string; extreme: number; sweeps: string[] }>();
    for (const { p, lvl, kind } of list) {
      const buy = lvl.side === 'buy_side';
      let g = groups.get(lvl.side);
      if (!g) {
        g = { key: `sg:${tf}:${sideCode(lvl.side)}:${time}`, extreme: p.extreme, sweeps: [] };
        groups.set(lvl.side, g);
      }
      g.extreme = buy ? Math.max(g.extreme, p.extreme) : Math.min(g.extreme, p.extreme);
      const penetration = buy ? p.extreme - lvl.price : lvl.price - p.extreme;
      const flags: EngineFlag[] = [];
      if (penetration > this.params.sweeps.maxPenetrationAtr * atr) flags.push('deep');
      let notional: string | null = null;
      if (p.unverified) flags.push('liquidity_unverified');
      else {
        const usd = p.volume * unitsToNumber(lvl.price);
        notional = usd.toFixed(2);
        if (usd < this.params.thinBook.notionalUsd) flags.push('thin_book');
      }
      if (s.uc) flags.push('underlying_closed');
      lvl.sweepCount++;
      let swept = false;
      if (lvl.range === null) {
        lvl.consumed.push(tf);
        if (lvl.home === tf) {
          lvl.status = 'swept';
          swept = true;
        }
      }
      const key = `sp:${tf}:${lvl.key}:${p.t}`;
      g.sweeps.push(key);
      this.emit('sweep', tf, key, {
        level: lvl.key,
        group: g.key,
        kind,
        side: lvl.side,
        levelType: lvl.type,
        levelPrice: fromUnits(lvl.price),
        extremePrice: fromUnits(p.extreme),
        penetrationAtr: penetration / atr,
        breachCandleTime: p.t,
        confirmedCandleTime: s.t,
        notionalBeyondUsd: notional,
        flags,
        levelSweepCount: lvl.sweepCount,
        levelStatus: lvl.status,
      });
      if (swept) this.levelStatus(lvl, 'swept');
    }
    for (const [side, g] of groups)
      this.createLevel(tf, 'sweep_extreme', side, g.extreme, {
        sourceRefs: g.sweeps,
        expiresAt: time + this.params.expiry.sweepExtremeCandles * TF_MS[tf],
      });
  }

  // ── Checkpoints ─────────────────────────────────────────────────────────────────────────────

  /** The whole state as plain JSON, for a checkpoint. */
  snapshot(): EngineSnapshot {
    const tfs: TfSnapshot[] = [];
    for (const st of this.tfs.values()) {
      const { ring, atr, ...rest } = st;
      tfs.push({ ...structuredClone(rest), ring: snapshotSlots(ring), atr: atr.snapshot() });
    }
    return {
      v: 1,
      ruleset: RULESET_VERSION,
      config: this.configJson,
      time: this.time,
      seq: this.seq,
      tfs,
      levels: [...this.levels.values()].map((l) => structuredClone(l)),
      minutes: { origin: this.minuteOrigin, ring: structuredClone(this.minutes.snapshot()) },
    };
  }

  /** An engine that continues exactly where `snapshot` was taken. The configuration must match. */
  static restore(snapshot: EngineSnapshot, config: EngineConfig): SmcEngine {
    const engine = new SmcEngine(config);
    if (snapshot.v !== 1) throw new RangeError(`unknown checkpoint format ${String(snapshot.v)}`);
    if (snapshot.ruleset !== RULESET_VERSION || snapshot.config !== engine.configJson)
      throw new RangeError('the checkpoint was taken with other rules, parameters or tick');
    engine.time = snapshot.time;
    engine.seq = snapshot.seq;
    for (const t of snapshot.tfs) {
      const { ring, atr, ...rest } = structuredClone(t);
      const st: TfState = {
        ...rest,
        ring: restoreSlots(ring),
        atr: new Atr(engine.params.atrPeriod).restore(atr),
      };
      engine.tfs.set(t.tf, st);
    }
    engine.levels = new Map(snapshot.levels.map((l) => [l.key, structuredClone(l)]));
    engine.minuteOrigin = snapshot.minutes.origin;
    engine.minutes = Ring.restore(structuredClone(snapshot.minutes.ring));
    return engine;
  }
}
