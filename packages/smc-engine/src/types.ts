import type { Closure, Timeframe } from '@cip/domain';
import type { SessionName } from './params.js';

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

/** What else is known at `time` (rulebook §1): the gold-market closure calendar. */
export interface StepContext {
  closures: readonly Closure[];
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
  | EventOf<'gap_marker', GapMarkerData>;

export type SmcEventType = SmcEvent['type'];
