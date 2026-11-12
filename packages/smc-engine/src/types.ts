import type { Closure, Timeframe } from '@cip/domain';
import type { ChecklistItem, PatternName, SessionName } from './params.js';

/** One closed candle, as the engine takes it. Prices and volume are exact decimal strings. */
export interface EngineCandle {
  tf: Timeframe;
  /** Epoch ms, UTC. */
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  /** `partial` candles lack minutes that can never be repaired: the engine treats them as a gap. */
  quality: 'complete' | 'repaired' | 'partial';
  underlyingClosed: boolean;
  /** 1m only: base volume per price bucket from low to high (rulebook §3.5); null when unknown. */
  microProfile?: readonly number[] | null;
}

/**
 * Everything that closes at one instant (a "boundary"). The engine takes boundaries strictly in
 * order. Every timeframe that has started must appear at each of its boundaries, either with its
 * candle or in `missing`.
 */
export interface StepInput {
  /** The close time shared by every candle here (epoch ms). */
  time: number;
  candles: readonly EngineCandle[];
  /** Timeframes whose candle closing at `time` is missing for good (an unrepairable gap, ADR 005). */
  missing?: readonly Timeframe[];
}

/** A scheduled economic release, as checklist item 8 needs it (rulebook §7). */
export interface EconomicEventRef {
  id: string;
  /** Epoch ms. */
  scheduledAt: number;
  currency: string;
  impact: 'low' | 'medium' | 'high';
}

/**
 * What else is known at `time` (rulebook §1): the gold-market closure calendar and the economic
 * calendar. `economicEvents` absent or null means the calendar is unavailable: checklist item 8
 * then fails with `calendar_unavailable`.
 */
export interface StepContext {
  closures: readonly Closure[];
  economicEvents?: readonly EconomicEventRef[] | null;
}

export type Direction = 'bullish' | 'bearish';
export type StructureLevel = 'internal' | 'external';
export type Side = 'buy_side' | 'sell_side';
export type LevelType =
  | 'eqh'
  | 'eql'
  | 'pdh'
  | 'pdl'
  | 'pwh'
  | 'pwl'
  | 'pmh'
  | 'pml'
  | 'session_high'
  | 'session_low'
  | 'range_high'
  | 'range_low'
  | 'weekend_high'
  | 'weekend_low'
  | 'swing_high'
  | 'swing_low'
  | 'sweep_extreme';
export type LevelStatus = 'active' | 'swept' | 'broken' | 'expired';
export type Location = 'internal' | 'external' | 'straddling' | 'none';
export type RangeEndReason = 'breakout_up' | 'breakout_down' | 'expired' | 'data_gap';

/**
 * Flags the engine itself sets (deterministic, part of the digest). The analyzer adds `warmup`
 * and `late_detection`, which depend on the run and the wall clock, outside the event.
 */
export type EngineFlag = 'deep' | 'thin_book' | 'liquidity_unverified' | 'underlying_closed' | 'data_gap';

export interface SwingData {
  kind: 'high' | 'low';
  level: StructureLevel;
  price: string;
  /** Open time of the swing candle. */
  candleTime: number;
  /** Close of the confirming candle (`candleTime` + k candles). */
  confirmedAt: number;
  flags: EngineFlag[];
}

export interface Displacement {
  /** Open times of the first and last candle. */
  from: number;
  to: number;
  /** Body (summed over a leg) in ATR at the last candle's close. */
  bodyAtr: number;
  /** An FVG in the same direction completed within the leg, by the break candle (§4.2). */
  createdFvg: boolean;
}

export interface StructureData {
  level: StructureLevel;
  type: 'bos' | 'choch' | 'mss';
  direction: Direction;
  /** Key of the swing that was broken; null when the protected level was a plain extreme (§2.2). */
  brokenSwing: string | null;
  /** The price that was broken. */
  breakPrice: string;
  breakCandleTime: number;
  isInitial: boolean;
  displacement: Displacement | null;
  flags: EngineFlag[];
}

export interface RangeDetectedData {
  high: string;
  low: string;
  equilibrium: string;
  /** Open time of the first candle in the detection window. */
  windowStart: number;
  detectedAt: number;
  flags: EngineFlag[];
}

export interface RangeEndedData {
  endedAt: number;
  reason: RangeEndReason;
}

export interface LevelData {
  type: LevelType;
  side: Side;
  price: string;
  touches: number;
  sessionName: SessionName | null;
  /** Keys of what it came from: swings, a range, sweeps. */
  sourceRefs: string[];
  location: Location;
  knownAt: number;
  status: LevelStatus;
  sweepCount: number;
  flags: EngineFlag[];
}

export interface LevelStatusData {
  status: LevelStatus;
  price: string;
  touches: number;
  sweepCount: number;
  statusChangedAt: number | null;
  /** What changed: a new touch (equal highs/lows), a status, or an end with its range. */
  reason: 'touch' | 'swept' | 'broken' | 'expired' | 'superseded' | 'range_ended';
}

export interface SweepData {
  /** Key of the swept level. */
  level: string;
  /** Sweeps confirmed by the same candle on the same side share a group (§3.4 rule 8). */
  group: string;
  kind: 'wick' | 'false_breakout';
  side: Side;
  levelType: LevelType;
  levelPrice: string;
  extremePrice: string;
  penetrationAtr: number;
  breachCandleTime: number;
  confirmedCandleTime: number;
  /** Notional traded beyond the level in the sweep window; null when micro profiles are missing. */
  notionalBeyondUsd: string | null;
  flags: EngineFlag[];
  /** The level's sweep count and status after this sweep, for the projection. */
  levelSweepCount: number;
  levelStatus: LevelStatus;
}

export type ZoneType = 'order_block' | 'fvg' | 'supply' | 'demand';
export type ZoneStatus = 'untouched' | 'partially_filled' | 'filled' | 'invalidated' | 'expired';

/**
 * A point of interest (rulebook §4). Bullish zones (demand, bullish order blocks and FVGs) sit
 * below price: their proximal edge is the top, their distal edge the bottom. Bearish zones mirror
 * this.
 */
export interface ZoneData {
  type: ZoneType;
  direction: Direction;
  top: string;
  bottom: string;
  /** Open times of the first and last candle forming the zone. */
  originFrom: number;
  originTo: number;
  knownAt: number;
  /** Order blocks on 1h, 4h and 1d (§4.1). */
  htf: boolean;
  location: Location;
  /** Order blocks: key of the structure break whose leg they start. */
  structureEvent: string | null;
  /** An order block, or supply/demand zone, of the other kind that it overlaps by more than half (§4.3). */
  linkedZone: string | null;
  /** Order blocks: liquidity on the other side was swept just before the leg (§4.1). */
  sweptLiquidityAtOrigin: boolean;
  status: ZoneStatus;
  fillPct: number;
  flags: EngineFlag[];
}

export interface ZoneStatusData {
  status: ZoneStatus;
  /** The deepest penetration from the proximal edge so far, in % of the zone's height (§4.4). */
  fillPct: number;
  /** Close of the first candle that traded into it; null until touched. */
  firstTouchAt: number | null;
  /** When the status last changed. */
  statusChangedAt: number | null;
  /** What happened: the first touch, a deeper fill, a close beyond the distal edge, or its lifetime ended. */
  reason: 'touch' | 'fill' | 'invalidated' | 'expired';
}

/** Rulebook §6.1 states. `resolved` carries a resolution. */
export type SetupState = 'forming' | 'triggered' | 'confirmed' | 'entry_active' | 'resolved';

/**
 * How a setup ended. The first five are rulebook §6.1's. `expired` ends a setup that never confirmed
 * (its preconditions went, or a sweep or MSS window passed): see rulebook §14.
 */
export type SetupResolution =
  'target_reached' | 'invalidated' | 'expired_no_entry' | 'expired_open' | 'ambiguous' | 'expired';

/**
 * Rulebook §7 quality flags the engine sets. `thin_book` makes a sweep non-qualifying instead;
 * `late_detection` depends on the wall clock and is added by the analyzer.
 */
export type QualityFlag = 'underlying_closed' | 'liquidity_unverified' | 'low_liquidity' | 'data_gap';

export interface ChecklistResult {
  item: ChecklistItem;
  credit: 0 | 0.5 | 1;
  weight: number;
  mandatory: boolean;
  evidence: Record<string, unknown>;
}

/** Where a hypothetical target came from: a liquidity level or a zone (its proximal edge). */
export interface TargetRef {
  kind: 'level' | 'zone';
  key: string;
  price: string;
}

/** The sweep-anchored MSS (rulebook §6.1). */
export interface MssData {
  /** Key of the internal swing it broke, and its price. */
  anchor: string;
  anchorPrice: string;
  /** Open time of the candle that closed beyond the anchor. */
  breakCandleTime: number;
  /** The engine's structure event at that candle in the same direction, if there is one. */
  structureEvent: string | null;
  displacement: { from: number; to: number; bodyAtr: number } | null;
}

/** Rulebook §8, for setups that reached `confirmed`. */
export interface SetupOutcomeData {
  result: SetupResolution;
  /** Close of the candle that touched the entry; null when it never did. */
  entryTouchedAt: number | null;
  resolvedAt: number;
  /** Excursions in R from the entry candle to the resolving candle; null without an entry. */
  mfeR: number | null;
  maeR: number | null;
  /** Setup candles from the entry candle to the resolving one, both included. */
  barsHeld: number | null;
  /** `1m` when 1m candles decided the order of events inside one setup candle. */
  resolvedWithTf: '1m' | null;
}

/**
 * One state transition of a setup (rulebook §6.1), with everything the setup holds at that moment:
 * a projection can rebuild the setup from its latest transition. `from === to === 'triggered'`
 * records a confirmation that failed its checklist, with the reasons (the setup keeps "watching").
 */
export interface SetupTransitionData {
  pattern: PatternName;
  /** Pattern 1: `A` (both sweeps on one side) or `B` (one on each side); null otherwise. */
  variant: 'A' | 'B' | null;
  direction: Direction;
  contextTf: Timeframe;
  setupTf: Timeframe;
  from: SetupState | null;
  to: SetupState;
  reason: string;
  resolution: SetupResolution | null;
  /** Close of the candle at which the setup started forming. */
  createdAt: number;
  levels: {
    entry: string | null;
    invalidation: string | null;
    target1: string | null;
    target2: string | null;
    rr: number | null;
  };
  /** Key of the entry zone. */
  entryZone: string | null;
  targets: { target1: TargetRef | null; target2: TargetRef | null };
  checklist: ChecklistResult[];
  /** Σ weight × credit, 0–100 (can end in .5). */
  score: number;
  mandatoryPassed: boolean;
  qualityFlags: QualityFlag[];
  refs: {
    /** Keys of the sweeps the setup used, oldest first. */
    sweeps: string[];
    mss: MssData | null;
    range: string | null;
    /** Patterns 2 and 3: the context-timeframe zone. */
    poi: string | null;
    /** Keys of the levels it swept or targets. */
    levels: string[];
  };
  /** What decided this transition (the candle's prices, the 1m candle, the failed items, …). */
  evidence: Record<string, unknown>;
  outcome: SetupOutcomeData | null;
}

export interface GapMarkerData {
  /** Open time of the first missing (or partial) candle. */
  from: number;
  /** Keys of the levels whose pending breach on this timeframe was dropped. */
  droppedBreaches: string[];
  /** Key of the range the gap ended, if any. */
  endedRange: string | null;
}

interface EventOf<T extends string, D> {
  /** Per-run sequence number, from 1. */
  seq: number;
  type: T;
  /** The timeframe it was decided on (levels: their origin timeframe). */
  tf: Timeframe;
  /** Close time of the deciding candle: the boundary being processed. */
  time: number;
  /** Natural key of the entity, the same in every run (`sw:15m:int:h:1700000000000`, …). */
  key: string;
  data: D;
}

export type SmcEvent =
  | EventOf<'swing_confirmed', SwingData>
  | EventOf<'structure', StructureData>
  | EventOf<'range_detected', RangeDetectedData>
  | EventOf<'range_ended', RangeEndedData>
  | EventOf<'level_created', LevelData>
  | EventOf<'level_status', LevelStatusData>
  | EventOf<'sweep', SweepData>
  | EventOf<'zone_created', ZoneData>
  | EventOf<'zone_status', ZoneStatusData>
  | EventOf<'setup_transition', SetupTransitionData>
  | EventOf<'gap_marker', GapMarkerData>;

export type SmcEventType = SmcEvent['type'];
