import { z } from 'zod';
import { RunRefSchema } from './analysis.js';
import { TsSchema, UuidSchema } from './common.js';
import { DecimalSchema, TimeframeSchema } from './market.js';

/**
 * SMC detections (API contracts §3 "Indicators and SMC", data model §5.1, rulebook §2–§3). Prices
 * are decimal strings, times epoch ms. Candle times (`candleTime`, `breakCandleTime`, `windowStart`,
 * `breachAt`) are open times; decision times (`confirmedAt`, `detectedAt`, `knownAt`, `endedAt`) are
 * the close of the deciding candle. `flags` holds the engine's flags (`deep`, `thin_book`,
 * `liquidity_unverified`, `underlying_closed`, `data_gap`) and the run's (`warmup`: decided before
 * the run started; `late_detection`: decided more than 120 s after its candle closed).
 */
const FlagsSchema = z.array(z.string());
const Direction = z.enum(['bullish', 'bearish']);
const Level = z.enum(['internal', 'external']);
const Side = z.enum(['buy_side', 'sell_side']);

export const SwingPointSchema = z.object({
  id: UuidSchema,
  tf: TimeframeSchema,
  kind: z.enum(['high', 'low']),
  level: Level,
  price: DecimalSchema,
  candleTime: TsSchema,
  confirmedAt: TsSchema,
  flags: FlagsSchema,
});
export type SwingPoint = z.infer<typeof SwingPointSchema>;

export const DisplacementSchema = z.object({
  /** Open times of its first and last candle. */
  from: TsSchema,
  to: TsSchema,
  bodyAtr: z.number(),
  createdFvg: z.boolean(),
});

export const StructureEventSchema = z.object({
  id: UuidSchema,
  tf: TimeframeSchema,
  level: Level,
  type: z.enum(['bos', 'choch', 'mss']),
  direction: Direction,
  brokenSwingId: UuidSchema.nullable(),
  breakPrice: DecimalSchema,
  breakCandleTime: TsSchema,
  isInitial: z.boolean(),
  displacement: DisplacementSchema.nullable(),
  flags: FlagsSchema,
});
export type StructureEvent = z.infer<typeof StructureEventSchema>;

export const RANGE_END_REASONS = ['breakout_up', 'breakout_down', 'expired', 'data_gap'] as const;
export const TradingRangeSchema = z.object({
  id: UuidSchema,
  tf: TimeframeSchema,
  high: DecimalSchema,
  low: DecimalSchema,
  equilibrium: DecimalSchema,
  windowStart: TsSchema,
  detectedAt: TsSchema,
  endedAt: TsSchema.nullable(),
  endReason: z.enum(RANGE_END_REASONS).nullable(),
  flags: FlagsSchema,
});
export type TradingRange = z.infer<typeof TradingRangeSchema>;

export const LEVEL_TYPES = [
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
  'swing_high',
  'swing_low',
  'sweep_extreme',
] as const;
export const LevelTypeSchema = z.enum(LEVEL_TYPES);
export type LevelType = z.infer<typeof LevelTypeSchema>;
export const LEVEL_STATUSES = ['active', 'swept', 'broken', 'expired'] as const;
export const LevelStatusSchema = z.enum(LEVEL_STATUSES);

export const LiquidityLevelSchema = z.object({
  id: UuidSchema,
  /** Origin timeframe. */
  tf: TimeframeSchema,
  type: LevelTypeSchema,
  side: Side,
  price: DecimalSchema,
  touches: z.number().int(),
  sessionName: z.enum(['asia', 'london', 'new_york']).nullable(),
  location: z.enum(['internal', 'external', 'straddling', 'none']),
  knownAt: TsSchema,
  status: LevelStatusSchema,
  statusChangedAt: TsSchema.nullable(),
  sweepCount: z.number().int(),
  flags: FlagsSchema,
});
export type LiquidityLevel = z.infer<typeof LiquidityLevelSchema>;

export const SweepSchema = z.object({
  id: UuidSchema,
  /** The timeframe it was evaluated on. */
  tf: TimeframeSchema,
  levelId: UuidSchema,
  levelType: LevelTypeSchema,
  groupId: UuidSchema,
  kind: z.enum(['wick', 'false_breakout']),
  side: Side,
  levelPrice: DecimalSchema,
  extremePrice: DecimalSchema,
  penetrationAtr: z.number(),
  /** Open time of the breach candle. */
  breachAt: TsSchema,
  /** Close of the confirming candle. */
  confirmedAt: TsSchema,
  notionalBeyondUsd: DecimalSchema.nullable(),
  flags: FlagsSchema,
});
export type Sweep = z.infer<typeof SweepSchema>;

export const ZONE_TYPES = ['order_block', 'fvg', 'supply', 'demand'] as const;
export const ZoneTypeSchema = z.enum(ZONE_TYPES);
export type ZoneType = z.infer<typeof ZoneTypeSchema>;
export const ZONE_STATUSES = ['untouched', 'partially_filled', 'filled', 'invalidated', 'expired'] as const;
export const ZoneStatusSchema = z.enum(ZONE_STATUSES);
export type ZoneStatus = z.infer<typeof ZoneStatusSchema>;

/**
 * A point of interest (rulebook §4). Bullish zones (demand, bullish order blocks and FVGs) are
 * approached from above: `top` is their proximal edge. Bearish zones mirror this. `fillPct` is the
 * deepest penetration from the proximal edge, in % of the height.
 */
export const PoiZoneSchema = z.object({
  id: UuidSchema,
  tf: TimeframeSchema,
  type: ZoneTypeSchema,
  direction: Direction,
  top: DecimalSchema,
  bottom: DecimalSchema,
  /** Open times of the first and last candle forming it. */
  originFrom: TsSchema,
  originTo: TsSchema,
  knownAt: TsSchema,
  /** Order blocks on 1h, 4h and 1d. */
  htf: z.boolean(),
  location: z.enum(['internal', 'external', 'straddling', 'none']),
  status: ZoneStatusSchema,
  fillPct: z.number(),
  /** Close of the first candle that traded into it. */
  firstTouchAt: TsSchema.nullable(),
  statusChangedAt: TsSchema.nullable(),
  /** Order blocks: the structure break whose leg they start. */
  structureEventId: UuidSchema.nullable(),
  /** An order block or supply/demand zone of the other kind that it overlaps by more than half. */
  linkedZoneId: UuidSchema.nullable(),
  /** Order blocks: opposite liquidity was swept just before the leg. */
  sweptLiquidityAtOrigin: z.boolean(),
  flags: FlagsSchema,
});
export type PoiZone = z.infer<typeof PoiZoneSchema>;

/** `zone.status`: what changed on a zone (merge it into the zone by id). */
export const ZoneStatusChangeSchema = z.object({
  id: UuidSchema,
  status: ZoneStatusSchema,
  fillPct: z.number(),
  firstTouchAt: TsSchema.nullable(),
  statusChangedAt: TsSchema.nullable(),
});
export type ZoneStatusChange = z.infer<typeof ZoneStatusChangeSchema>;

/** `GET /smc/{instrumentId}/overlay`: everything a chart needs in one call. */
export const ChartOverlaySchema = z.object({
  instrumentId: UuidSchema,
  tf: TimeframeSchema,
  /** The live run (or the one `runId` chose); null when the instrument was never analysed. */
  run: RunRefSchema.nullable(),
  swings: z.array(SwingPointSchema),
  structure: z.array(StructureEventSchema),
  ranges: z.array(TradingRangeSchema),
  levels: z.array(LiquidityLevelSchema),
  sweeps: z.array(SweepSchema),
  zones: z.array(PoiZoneSchema),
  /** Setups arrive in Phase 6: empty until then. */
  setups: z.array(z.unknown()),
  /** Gold-market closures in the window (gold instruments only). */
  closures: z.array(z.object({ from: TsSchema, to: TsSchema, reason: z.string() })),
});
export type ChartOverlay = z.infer<typeof ChartOverlaySchema>;

const ms = z.coerce.number().int().nonnegative();
/** `?tf&from&to&runId&limit` for the SMC list endpoints; by default the latest `limit`. */
export const SmcQuerySchema = z.strictObject({
  tf: TimeframeSchema,
  from: ms.optional(),
  to: ms.optional(),
  runId: UuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(5_000).default(1_000),
});
export type SmcQuery = z.infer<typeof SmcQuerySchema>;

export const SwingsQuerySchema = SmcQuerySchema.extend({ level: Level.optional() });
export type SwingsQuery = z.infer<typeof SwingsQuerySchema>;

/** A comma-separated query value as a list. */
const list = <T extends z.ZodType>(item: T) =>
  z.preprocess((v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v), z.array(item).min(1));

/**
 * `GET /smc/{instrumentId}/levels?tf&status&types&runId`: levels a `tf` chart can show (origin
 * timeframe `tf` or longer), by default the active ones.
 */
export const LevelsQuerySchema = z.strictObject({
  tf: TimeframeSchema,
  status: list(LevelStatusSchema).optional(),
  types: list(LevelTypeSchema).optional(),
  runId: UuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(5_000).default(1_000),
});
export type LevelsQuery = z.infer<typeof LevelsQuerySchema>;

/**
 * `GET /smc/{instrumentId}/zones?tf&status&types&runId`: zones a `tf` chart can show (their own
 * timeframe `tf` or longer), by default the live ones (untouched, partially filled or filled).
 */
export const ZonesQuerySchema = z.strictObject({
  tf: TimeframeSchema,
  status: list(ZoneStatusSchema).optional(),
  types: list(ZoneTypeSchema).optional(),
  runId: UuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(5_000).default(1_000),
});
export type ZonesQuery = z.infer<typeof ZonesQuerySchema>;

// ── Replays (API contracts §3 "Setups and replays") ───────────────────────────────────────────

/** `POST /replays`: replay a stored period with the instrument's current profile. */
export const ReplayRequestSchema = z
  .strictObject({ instrumentId: UuidSchema, from: TsSchema, to: TsSchema })
  .refine((r) => r.to > r.from, 'to must be after from')
  .refine((r) => r.to - r.from <= 31 * 86_400_000, 'a replay covers at most 31 days');
export type ReplayRequest = z.infer<typeof ReplayRequestSchema>;

/** The digests of the replay and of the live run over the same period (criterion 4.3). */
export const DigestComparisonSchema = z.object({
  liveRunId: UuidSchema,
  /** The period compared: decisions after `from`, up to and including `to`. */
  from: TsSchema,
  to: TsSchema,
  liveEvents: z.number().int(),
  replayEvents: z.number().int(),
  liveDigest: z.string(),
  replayDigest: z.string(),
  equal: z.boolean(),
});
export type DigestComparison = z.infer<typeof DigestComparisonSchema>;

/** `GET /replays/{runId}`. */
export const ReplayStatusSchema = z.object({
  runId: UuidSchema,
  instrumentId: UuidSchema,
  status: z.enum(['queued', 'warming_up', 'running', 'completed', 'failed']),
  from: TsSchema,
  to: TsSchema,
  /** sha256 over the replay's events decided in (from, to]; null until it completes. */
  digest: z.string().nullable(),
  events: z.number().int().nullable(),
  /** Null when no live run covers the period. */
  comparison: DigestComparisonSchema.nullable(),
  error: z.string().nullable(),
});
export type ReplayStatus = z.infer<typeof ReplayStatusSchema>;

/** The BullMQ queue the analyzer takes replays from (ADR 017). */
export const REPLAY_QUEUE = 'replay';
export interface ReplayJob {
  runId: string;
  instrumentId: string;
  from: number;
  to: number;
  requestedBy: string | null;
}

// ── The `smc:{instrumentId}` channel ──────────────────────────────────────────────────────────

/** Message types on `smc:{instrumentId}` (API contracts §5.3). */
export type SmcMessageType =
  | 'swing.confirmed'
  | 'structure'
  | 'range.detected'
  | 'range.ended'
  | 'level.created'
  | 'level.status'
  | 'sweep'
  | 'zone.created'
  | 'zone.status';

/** `level.status`: what changed on a level (merge it into the level by id). */
export const LevelStatusChangeSchema = z.object({
  id: UuidSchema,
  status: LevelStatusSchema,
  price: DecimalSchema,
  touches: z.number().int(),
  sweepCount: z.number().int(),
  statusChangedAt: TsSchema.nullable(),
});
export type LevelStatusChange = z.infer<typeof LevelStatusChangeSchema>;

/** `range.ended`. */
export const RangeEndSchema = z.object({
  id: UuidSchema,
  endedAt: TsSchema,
  endReason: z.enum(RANGE_END_REASONS),
});
export type RangeEnd = z.infer<typeof RangeEndSchema>;

/**
 * One SMC detection on `an:events` (entry type `smc`) and as the data of an `smc:` message: the
 * run, the event's sequence number in it, and the entity in its API form.
 */
export interface SmcEventMessage {
  instrumentId: string;
  runId: string;
  seq: number;
  tf: string;
  /** When it was decided: the close of the deciding candle (epoch ms). */
  time: number;
  type: SmcMessageType;
  data:
    | SwingPoint
    | StructureEvent
    | TradingRange
    | RangeEnd
    | LiquidityLevel
    | LevelStatusChange
    | Sweep
    | PoiZone
    | ZoneStatusChange;
}
