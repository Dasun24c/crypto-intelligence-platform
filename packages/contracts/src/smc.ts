import { z } from 'zod';
import { RunRefSchema } from './analysis.js';
import { TsSchema, UuidSchema } from './common.js';
import { DecimalSchema, TimeframeSchema } from './market.js';
import { CHECKLIST_ITEM_NAMES, PATTERN_NAMES } from './smc-params.js';

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
// ── Setups (rulebook §6–§8, data model §5.2) ──────────────────────────────────────────────────

export const PatternSchema = z.enum(PATTERN_NAMES);
export type Pattern = z.infer<typeof PatternSchema>;
export const SETUP_STATES = ['forming', 'triggered', 'confirmed', 'entry_active', 'resolved'] as const;
export const SetupStateSchema = z.enum(SETUP_STATES);
export type SetupState = z.infer<typeof SetupStateSchema>;
/** Rulebook §6.1's five, and `expired` for a setup that ended before it ever confirmed (§14). */
export const SETUP_RESOLUTIONS = [
  'target_reached',
  'invalidated',
  'expired_no_entry',
  'expired_open',
  'ambiguous',
  'expired',
] as const;
export const SetupResolutionSchema = z.enum(SETUP_RESOLUTIONS);
export type SetupResolution = z.infer<typeof SetupResolutionSchema>;
export const ChecklistItemSchema = z.enum(CHECKLIST_ITEM_NAMES);
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;
/** REQUIREMENTS §3.7: shown wherever setup levels appear. */
export const SETUP_DISCLAIMER = 'Educational analysis — not financial advice' as const;
/** Rulebook §6.1 UI labels: forming and triggered setups are only being watched. */
export const SETUP_LABELS = {
  forming: 'Watching',
  triggered: 'Watching',
  confirmed: 'Confirmed',
  entry_active: 'Entry reached',
  resolved: 'Resolved',
} as const satisfies Record<SetupState, string>;

/** A setup as lists and the `setups` channels carry it (API contracts §4 SetupSummary). */
export const SetupSummarySchema = z.object({
  id: UuidSchema,
  instrumentId: UuidSchema,
  runId: UuidSchema,
  pattern: PatternSchema,
  /** Pattern 1: `A` (both sweeps on one side) or `B` (one on each); null otherwise. */
  variant: z.enum(['A', 'B']).nullable(),
  direction: Direction,
  contextTf: TimeframeSchema,
  setupTf: TimeframeSchema,
  state: SetupStateSchema,
  resolution: SetupResolutionSchema.nullable(),
  displayLabel: z.enum(['Watching', 'Confirmed', 'Entry reached', 'Resolved']),
  /** Hypothetical levels (§6.1): entry at the entry zone's proximal edge; R:R on T1. */
  levels: z.object({
    entry: DecimalSchema.nullable(),
    invalidation: DecimalSchema.nullable(),
    target1: DecimalSchema.nullable(),
    target2: DecimalSchema.nullable(),
    rr: z.number().nullable(),
  }),
  /** Σ weight × credit of the latest checklist evaluation, 0–100 (can end in .5). */
  score: z.number(),
  mandatoryPassed: z.boolean(),
  /** Rulebook §7 quality flags (`underlying_closed`, `liquidity_unverified`, `low_liquidity`, `data_gap`). */
  qualityFlags: z.array(z.string()),
  /** The run's flags on its latest transition: `warmup`, `late_detection`. */
  flags: FlagsSchema,
  /** Decision times: when it started forming, its latest transition, its resolution. */
  createdAt: TsSchema,
  updatedAt: TsSchema,
  resolvedAt: TsSchema.nullable(),
  disclaimer: z.literal(SETUP_DISCLAIMER),
});
export type SetupSummary = z.infer<typeof SetupSummarySchema>;

export const ChecklistResultSchema = z.object({
  item: ChecklistItemSchema,
  credit: z.union([z.literal(0), z.literal(0.5), z.literal(1)]),
  weight: z.number().int(),
  mandatory: z.boolean(),
  evidence: z.record(z.string(), z.unknown()),
});
export type ChecklistResult = z.infer<typeof ChecklistResultSchema>;

export const SetupTransitionSchema = z.object({
  from: SetupStateSchema.nullable(),
  to: SetupStateSchema,
  reason: z.string(),
  /** The deciding candle's open time, and its close (when the transition was decided). */
  candleTime: TsSchema,
  decidedAt: TsSchema,
  /** Wall clock when the analyzer stored it; `late` when that was more than 120 s after decidedAt. */
  processedAt: TsSchema,
  late: z.boolean(),
  evidence: z.record(z.string(), z.unknown()),
});
export type SetupTransition = z.infer<typeof SetupTransitionSchema>;

export const SetupOutcomeSchema = z.object({
  result: SetupResolutionSchema,
  entryTouchedAt: TsSchema.nullable(),
  resolvedAt: TsSchema,
  mfeR: z.number().nullable(),
  maeR: z.number().nullable(),
  barsHeld: z.number().int().nullable(),
  /** `1m` when 1m candles decided the order of events inside one setup candle. */
  resolvedWithTf: z.literal('1m').nullable(),
});
export type SetupOutcome = z.infer<typeof SetupOutcomeSchema>;

const TargetRefSchema = z.object({ kind: z.enum(['level', 'zone']), id: UuidSchema, price: DecimalSchema });

/** `GET /setups/{id}`: the summary with its history, checklist, outcome and what it refers to. */
export const SetupDetailSchema = SetupSummarySchema.extend({
  transitions: z.array(SetupTransitionSchema),
  /** The checklist as evaluated at the latest state, and at each state the setup reached. */
  checklist: z.array(ChecklistResultSchema),
  checklistByState: z.partialRecord(SetupStateSchema, z.array(ChecklistResultSchema)),
  outcome: SetupOutcomeSchema.nullable(),
  targets: z.object({ target1: TargetRefSchema.nullable(), target2: TargetRefSchema.nullable() }),
  refs: z.object({
    sweeps: z.array(SweepSchema),
    /** The sweep-anchored MSS (§6.1), and the engine's structure event at its break if there is one. */
    mss: z
      .object({
        anchorId: UuidSchema,
        anchorPrice: DecimalSchema,
        breakCandleTime: TsSchema,
        displacement: z.object({ from: TsSchema, to: TsSchema, bodyAtr: z.number() }).nullable(),
        structureEvent: StructureEventSchema.nullable(),
      })
      .nullable(),
    entryZone: PoiZoneSchema.nullable(),
    levels: z.array(LiquidityLevelSchema),
    range: TradingRangeSchema.nullable(),
    poi: PoiZoneSchema.nullable(),
  }),
});
export type SetupDetail = z.infer<typeof SetupDetailSchema>;

const ms = z.coerce.number().int().nonnegative();
const list = <T extends z.ZodType>(item: T) =>
  z.preprocess((v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v), z.array(item).min(1));

/**
 * `GET /setups`: newest change first. Without `runId`, each instrument's live run (else its
 * latest); `from`/`to` bound the latest transition's decision time.
 */
export const SetupsQuerySchema = z.strictObject({
  instrumentId: UuidSchema.optional(),
  pattern: list(PatternSchema).optional(),
  direction: Direction.optional(),
  state: list(SetupStateSchema).optional(),
  minScore: z.coerce.number().min(0).max(100).optional(),
  from: ms.optional(),
  to: ms.optional(),
  runId: UuidSchema.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});
export type SetupsQuery = z.infer<typeof SetupsQuerySchema>;

/** `setup.transition` on `setups` and `setups:{instrumentId}`: the setup after it, and the transition. */
export const SetupTransitionMessageSchema = SetupSummarySchema.extend({ transition: SetupTransitionSchema });
export type SetupTransitionMessage = z.infer<typeof SetupTransitionMessageSchema>;

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
  /** The run's setups on this setup timeframe that were alive in the window (Phase 6). */
  setups: z.array(SetupSummarySchema),
  /** Gold-market closures in the window (gold instruments only). */
  closures: z.array(z.object({ from: TsSchema, to: TsSchema, reason: z.string() })),
});
export type ChartOverlay = z.infer<typeof ChartOverlaySchema>;

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

const unique = <T>(xs: readonly T[]) => new Set(xs).size === xs.length;

/**
 * The settings a replay may change for itself (Phase 12, ADR 026): rulebook §6–§7 settings of the
 * profile's `smc.setups`. Everything else is the live run's (or the instrument's) profile, and the
 * live analysis never changes. At least one setting is named.
 */
export const ReplaySettingsSchema = z
  .strictObject({
    /** The patterns evaluated (§6); the engine keeps its own order. */
    patterns: z.array(PatternSchema).min(1).refine(unique, 'a pattern is named twice').optional(),
    /** Checklist item 7: the reward-to-risk of T1 must reach this. */
    minRR: z.number().positive().max(20).optional(),
    /** The checklist items a confirmation needs (§7). */
    mandatory: z.array(ChecklistItemSchema).refine(unique, 'an item is named twice').optional(),
    /** §6.1: a market structure shift counts only with displacement. */
    requireDisplacement: z.boolean().optional(),
    /** §6.1: setup candles a confirmed setup waits for its entry. */
    entryExpiryBars: z.number().int().min(1).max(10_000).optional(),
    /** §6.1: setup candles a setup is held after its entry before it expires open. */
    maxHoldBars: z.number().int().min(1).max(100_000).optional(),
    /** Checklist item 8: minutes before and after a high-impact event. */
    newsBlackoutMin: z
      .strictObject({ before: z.number().int().min(0).max(1_440), after: z.number().int().min(0).max(1_440) })
      .optional(),
    /** §7: the `low_liquidity` flag blocks confirmation. */
    blockConfirmOnLowLiquidity: z.boolean().optional(),
  })
  .refine((s) => Object.keys(s).length > 0, 'name at least one setting to change');
export type ReplaySettings = z.infer<typeof ReplaySettingsSchema>;

/** Where each replay setting lives in a profile's settings (`market.instrument_profiles.params`). */
export const REPLAY_SETTING_PATHS = {
  patterns: 'smc.setups.patterns',
  minRR: 'smc.setups.checklist.minRR',
  mandatory: 'smc.setups.checklist.mandatory',
  requireDisplacement: 'smc.setups.mss.requireDisplacement',
  entryExpiryBars: 'smc.setups.timing.entryExpiryBars',
  maxHoldBars: 'smc.setups.timing.maxHoldBars',
  newsBlackoutMin: 'smc.setups.checklist.newsBlackoutMin',
  blockConfirmOnLowLiquidity: 'smc.setups.quality.blockConfirmOnLowLiquidity',
} as const satisfies Record<keyof ReplaySettings, string>;

/** The part of a profile's settings the replay settings live in (`smc.setups`), if it has one. */
interface SetupsPart {
  patterns: Pattern[];
  mss: { requireDisplacement: boolean };
  timing: { entryExpiryBars: number; maxHoldBars: number };
  checklist: {
    minRR: number;
    mandatory: ChecklistItem[];
    newsBlackoutMin: { before: number; after: number };
  };
  quality: { blockConfirmOnLowLiquidity: boolean };
}
const setupsOf = (params: unknown): SetupsPart | undefined =>
  (params as { smc?: { setups?: SetupsPart } } | null | undefined)?.smc?.setups;

/**
 * A copy of a profile's settings with a replay's changes applied. Patterns and mandatory items are
 * kept in the rulebook's order, so the same choice always gives the same settings. Throws when the
 * profile has no setup settings (versions before 4). The result still needs the engine's checks.
 */
export function applyReplaySettings<T>(params: T, settings: ReplaySettings): T {
  const out = structuredClone(params);
  const s = setupsOf(out);
  if (!s) throw new Error('the profile has no setup settings (version 4 or later is needed)');
  const ordered = <K extends string>(all: readonly K[], chosen: readonly K[]) =>
    all.filter((x) => chosen.includes(x));
  if (settings.patterns) s.patterns = ordered(PATTERN_NAMES, settings.patterns);
  if (settings.minRR !== undefined) s.checklist.minRR = settings.minRR;
  if (settings.mandatory) s.checklist.mandatory = ordered(CHECKLIST_ITEM_NAMES, settings.mandatory);
  if (settings.requireDisplacement !== undefined) s.mss.requireDisplacement = settings.requireDisplacement;
  if (settings.entryExpiryBars !== undefined) s.timing.entryExpiryBars = settings.entryExpiryBars;
  if (settings.maxHoldBars !== undefined) s.timing.maxHoldBars = settings.maxHoldBars;
  if (settings.newsBlackoutMin) s.checklist.newsBlackoutMin = { ...settings.newsBlackoutMin };
  if (settings.blockConfirmOnLowLiquidity !== undefined)
    s.quality.blockConfirmOnLowLiquidity = settings.blockConfirmOnLowLiquidity;
  return out;
}

/** Every replay setting, as a profile has them. */
export type ReplaySettingValues = Required<ReplaySettings>;

/** The values a profile's settings give the settings a replay may change. */
export function replaySettingsOf(params: unknown): ReplaySettingValues {
  const s = setupsOf(params);
  if (!s) throw new Error('the profile has no setup settings (version 4 or later is needed)');
  return {
    patterns: [...s.patterns],
    minRR: s.checklist.minRR,
    mandatory: [...s.checklist.mandatory],
    requireDisplacement: s.mss.requireDisplacement,
    entryExpiryBars: s.timing.entryExpiryBars,
    maxHoldBars: s.timing.maxHoldBars,
    newsBlackoutMin: { ...s.checklist.newsBlackoutMin },
    blockConfirmOnLowLiquidity: s.quality.blockConfirmOnLowLiquidity,
  };
}

/** `GET /replays/settings?instrumentId`: what a replay of the instrument starts from. */
export const ReplayBaseQuerySchema = z.strictObject({ instrumentId: UuidSchema });
export type ReplayBaseQuery = z.infer<typeof ReplayBaseQuerySchema>;
export const ReplayBaseSettingsSchema = z.object({
  instrumentId: UuidSchema,
  /** The instrument's profile now (a replay of a period a live run covers uses that run's). */
  profile: z.object({ name: z.string(), version: z.number().int() }),
  settings: z.object({
    patterns: z.array(PatternSchema),
    minRR: z.number(),
    mandatory: z.array(ChecklistItemSchema),
    requireDisplacement: z.boolean(),
    entryExpiryBars: z.number().int(),
    maxHoldBars: z.number().int(),
    newsBlackoutMin: z.object({ before: z.number().int(), after: z.number().int() }),
    blockConfirmOnLowLiquidity: z.boolean(),
  }),
});
export type ReplayBaseSettings = z.infer<typeof ReplayBaseSettingsSchema>;

/**
 * `POST /replays`: replay a stored period, at most 31 days, ending in the past. It starts from the
 * live run that covers the period (its profile and series origins, ADR 017), else the instrument's
 * current profile; `settings` changes some of that profile's settings for this replay only.
 */
export const ReplayRequestSchema = z
  .strictObject({
    instrumentId: UuidSchema,
    from: TsSchema,
    to: TsSchema,
    settings: ReplaySettingsSchema.optional(),
  })
  .refine((r) => r.to > r.from, 'to must be after from')
  .refine((r) => r.to - r.from <= 31 * 86_400_000, 'a replay covers at most 31 days');
export type ReplayRequest = z.infer<typeof ReplayRequestSchema>;

const RunModeSchema = z.enum(['live', 'replay']);

/** One run's side of a comparison: its digest over the compared period (ADR 017). */
export const RunDigestSchema = z.object({
  runId: UuidSchema,
  mode: RunModeSchema,
  /** Its profile, and its rules version (indicators and SMC). */
  profile: z.object({ name: z.string(), version: z.number().int() }),
  rulesetVersion: z.string(),
  /** sha256 over its events decided in the period, in order. */
  digest: z.string(),
  events: z.number().int(),
  /** The settings it changed, for a replay that changed some. */
  settings: ReplaySettingsSchema.nullable(),
});
export type RunDigest = z.infer<typeof RunDigestSchema>;

/**
 * A setting that differs between the two runs: a path in the profile's settings (for example
 * `smc.setups.checklist.minRR`), or `rulesetVersion` or `profile`. Values are as stored (JSON).
 */
export const SettingDifferenceSchema = z.object({ path: z.string(), base: z.json(), other: z.json() });
export type SettingDifference = z.infer<typeof SettingDifferenceSchema>;

/** A setup as one run left it at the end of the compared period (its latest transition by then). */
export const SetupSideSchema = z.object({
  state: SetupStateSchema,
  resolution: SetupResolutionSchema.nullable(),
  score: z.number(),
  mandatoryPassed: z.boolean(),
  /** Its transitions in the period. */
  transitions: z.number().int(),
});
export type SetupSide = z.infer<typeof SetupSideSchema>;

/** A setup whose transitions in the period differ between the runs. */
export const SetupDifferenceSchema = z.object({
  /** The setup's natural key (the same in every run, ADR 017). */
  key: z.string(),
  pattern: PatternSchema,
  variant: z.enum(['A', 'B']).nullable(),
  direction: Direction,
  contextTf: TimeframeSchema,
  setupTf: TimeframeSchema,
  /** When it started forming (decision time). */
  createdAt: TsSchema,
  /** Null when that run has no transition of it in the period. */
  base: SetupSideSchema.nullable(),
  other: SetupSideSchema.nullable(),
});
export type SetupDifference = z.infer<typeof SetupDifferenceSchema>;

/**
 * Two runs of one instrument compared over the period both cover (criteria 4.3 and 12.3): their
 * digests, the settings that differ, and the detections that differ. Events are matched by type,
 * timeframe, natural key and decision time, so runs that started at different points can still be
 * compared event by event although their digests (which number the events) differ.
 */
export const RunComparisonSchema = z.object({
  base: RunDigestSchema,
  other: RunDigestSchema,
  /** The period compared: decisions after `from`, up to and including `to`. */
  from: TsSchema,
  to: TsSchema,
  /** The digests are equal: the same events in the same order. */
  equal: z.boolean(),
  /** Both runs started each timeframe at the same candle (otherwise their event numbers differ). */
  sameOrigins: z.boolean(),
  /** A live run that has not analysed the whole period yet: compare again later. */
  incomplete: z.boolean(),
  /** Empty when the rules versions, profiles and settings are the same. */
  settings: z.array(SettingDifferenceSchema),
  /** Events in the period per type, in each run. */
  eventTypes: z.array(z.object({ type: z.string(), base: z.number().int(), other: z.number().int() })),
  onlyInBase: z.number().int(),
  onlyInOther: z.number().int(),
  /** The same event in both, with different contents. */
  changed: z.number().int(),
  /** Setups that differ, oldest first; at most `SETUP_DIFFERENCES_SHOWN` (the CSV export has all). */
  setups: z.array(SetupDifferenceSchema),
  setupsTotal: z.number().int(),
});
export type RunComparison = z.infer<typeof RunComparisonSchema>;

/** How many differing setups a comparison lists (`setupsTotal` counts them all). */
export const SETUP_DIFFERENCES_SHOWN = 200;

export const REPLAY_STATUSES = ['queued', 'warming_up', 'running', 'completed', 'failed'] as const;
const ReplayStatusValue = z.enum(REPLAY_STATUSES);

/** A replay in the list (`GET /replays`), newest first, queued ones included. */
export const ReplaySummarySchema = z.object({
  runId: UuidSchema,
  instrumentId: UuidSchema,
  status: ReplayStatusValue,
  from: TsSchema,
  to: TsSchema,
  /** The settings it changed; null: the live run's settings. */
  settings: ReplaySettingsSchema.nullable(),
  /** The live run it started from (ADR 017), if one covered the period. */
  sourceRunId: UuidSchema.nullable(),
  /** sha256 over its events decided in (from, to]; null until it completes. */
  digest: z.string().nullable(),
  requestedAt: TsSchema,
  finishedAt: TsSchema.nullable(),
  /** Requested by the signed-in user. */
  mine: z.boolean(),
  error: z.string().nullable(),
});
export type ReplaySummary = z.infer<typeof ReplaySummarySchema>;

/** `GET /replays?instrumentId&limit`. */
export const ReplaysQuerySchema = z.strictObject({
  instrumentId: UuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ReplaysQuery = z.infer<typeof ReplaysQuerySchema>;

/** `GET /replays/{runId}?compareWith`: by default the comparison is with the live run it started from. */
export const ReplayStatusQuerySchema = z.strictObject({ compareWith: UuidSchema.optional() });
export type ReplayStatusQuery = z.infer<typeof ReplayStatusQuerySchema>;

/** `GET /replays/{runId}`. */
export const ReplayStatusSchema = ReplaySummarySchema.omit({ mine: true }).extend({
  /** The replay's events decided in (from, to]; null until it completes. */
  events: z.number().int().nullable(),
  /**
   * With the run `compareWith` named, else with the live run it started from; null until it
   * completes, or when no live run covered the period and none was named.
   */
  comparison: RunComparisonSchema.nullable(),
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
  /** Phase 12: settings changed for this replay (absent or null: none). */
  settings?: ReplaySettings | null;
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
