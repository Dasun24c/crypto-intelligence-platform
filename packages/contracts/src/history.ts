import { z } from 'zod';
import { TsSchema, UuidSchema } from './common.js';
import { TimeframeSchema } from './market.js';
import { PatternSchema } from './smc.js';

// ── Historical analytics (Phase 12, ADR 026; REQUIREMENTS §3.9, rulebook §8) ────────────────────

/**
 * Criterion 12.2: every statistic is labelled as a historical observation, never as expected
 * performance (REQUIREMENTS §3.9, risk R31). The page, the API and the CSV file names carry it.
 */
export const HISTORICAL_OBSERVATIONS = 'Historical observations' as const;
export const HISTORICAL_NOTICE =
  'Historical observations: how past setups found by these rules ended. They describe the past only and are not a forecast or a measure of future results.' as const;

/** What the statistics can be grouped by (rulebook §8). */
export const STATS_DIMENSIONS = [
  'pattern',
  'variant',
  'direction',
  'tfPair',
  'instrument',
  'session',
  'rules',
] as const;
export const StatsDimensionSchema = z.enum(STATS_DIMENSIONS);
export type StatsDimension = z.infer<typeof StatsDimensionSchema>;

/**
 * The trading session a setup started forming in, from its run's profile (rulebook §3.3: whole UTC
 * hours, by default Asia 00–07, London 07–13, New York 13–21); `outside` when it is in none.
 */
export const SESSION_BUCKETS = ['asia', 'london', 'new_york', 'outside'] as const;
export const SessionBucketSchema = z.enum(SESSION_BUCKETS);
export type SessionBucket = z.infer<typeof SessionBucketSchema>;

/**
 * Which setups count: those a run found while warming up on stored history (decided at or before
 * the run's start), those it found live, or both.
 */
export const FOUND_FILTERS = ['all', 'live', 'warmup'] as const;
export const FoundFilterSchema = z.enum(FOUND_FILTERS);
export type FoundFilter = z.infer<typeof FoundFilterSchema>;

/** Rulebook §8: how a setup that confirmed ended. */
export const OUTCOME_RESULTS = [
  'target_reached',
  'invalidated',
  'expired_no_entry',
  'expired_open',
  'ambiguous',
] as const;
export type OutcomeResult = (typeof OUTCOME_RESULTS)[number];

const ms = z.coerce.number().int().nonnegative();
const list = <T extends z.ZodType>(item: T) =>
  z.preprocess((v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v), z.array(item).min(1));

const periodOk = (q: { from?: number | undefined; to?: number | undefined }) =>
  q.from === undefined || q.to === undefined || q.from < q.to;

/** The setups the statistics and the setups export read. */
const SetupFilterShape = {
  /** Setups that started forming after `from`, up to and including `to` (decision times). */
  from: ms.optional(),
  to: ms.optional(),
  instrumentId: UuidSchema.optional(),
  found: FoundFilterSchema.default('all'),
  /** One run's setups (for example a replay's) instead of the live runs'. */
  runId: UuidSchema.optional(),
};

/**
 * `GET /setups/stats?groupBy&from&to&instrumentId&found&runId`. Without `runId` it reads every
 * live run; a setup two live runs of one instrument found under the same rules counts once.
 */
export const SetupStatsQuerySchema = z
  .strictObject({
    groupBy: list(StatsDimensionSchema)
      .refine((xs) => new Set(xs).size === xs.length, 'a dimension is named twice')
      .default(['pattern']),
    ...SetupFilterShape,
  })
  .refine(periodOk, '`from` must be before `to`');
export type SetupStatsQuery = z.infer<typeof SetupStatsQuerySchema>;

/** `GET /exports/setups.csv?from&to&instrumentId&found&runId`: one row per setup. */
export const SetupExportQuerySchema = z
  .strictObject(SetupFilterShape)
  .refine(periodOk, '`from` must be before `to`');
export type SetupExportQuery = z.infer<typeof SetupExportQuerySchema>;

/** `GET /exports/run-comparison.csv?runId&compareWith`. */
export const RunComparisonExportQuerySchema = z.strictObject({
  runId: UuidSchema,
  compareWith: UuidSchema.optional(),
});
export type RunComparisonExportQuery = z.infer<typeof RunComparisonExportQuerySchema>;

/** A rules version: the analysis code's version with the run's profile and settings. */
export const RulesKeySchema = z.object({
  rulesetVersion: z.string(),
  profile: z.object({ name: z.string(), version: z.number().int() }),
  paramsHash: z.string(),
  /** A replay that changed some of its profile's settings. */
  changedSettings: z.boolean(),
});
export type RulesKey = z.infer<typeof RulesKeySchema>;

/** A group's key: only the dimensions grouped by are present. */
export const StatsKeySchema = z.object({
  pattern: PatternSchema.optional(),
  variant: z.enum(['A', 'B']).nullable().optional(),
  direction: z.enum(['bullish', 'bearish']).optional(),
  tfPair: z.object({ context: TimeframeSchema, setup: TimeframeSchema }).optional(),
  instrumentId: UuidSchema.optional(),
  session: SessionBucketSchema.optional(),
  rules: RulesKeySchema.optional(),
});
export type StatsKey = z.infer<typeof StatsKeySchema>;

const count = z.number().int().nonnegative();

/**
 * One group's historical observations (rulebook §8):
 * - `detected`: setups that started forming; `warmup` of them found while warming up;
 * - `confirmed`: those that reached "confirmed"; `open` of them not resolved yet; `resolved` the rest;
 * - `outcomes`: the resolved ones by result; `entered` of them had their entry touched;
 * - `avgMfeR` / `avgMaeR`: mean excursions in R of the resolved setups whose entry was touched.
 */
export const SetupStatsRowSchema = z.object({
  key: StatsKeySchema,
  detected: count,
  warmup: count,
  confirmed: count,
  open: count,
  resolved: count,
  entered: count,
  outcomes: z.object({
    target_reached: count,
    invalidated: count,
    expired_no_entry: count,
    expired_open: count,
    ambiguous: count,
  }),
  avgMfeR: z.number().nullable(),
  avgMaeR: z.number().nullable(),
});
export type SetupStatsRow = z.infer<typeof SetupStatsRowSchema>;

/** `GET /setups/stats`: groups with the most setups first, and every group together. */
export const SetupStatsSchema = z.object({
  label: z.literal(HISTORICAL_OBSERVATIONS),
  notice: z.literal(HISTORICAL_NOTICE),
  groupBy: z.array(StatsDimensionSchema),
  from: TsSchema.nullable(),
  to: TsSchema.nullable(),
  instrumentId: UuidSchema.nullable(),
  found: FoundFilterSchema,
  runId: UuidSchema.nullable(),
  /** How many runs the setups came from. */
  runs: count,
  totals: SetupStatsRowSchema,
  rows: z.array(SetupStatsRowSchema),
});
export type SetupStats = z.infer<typeof SetupStatsSchema>;

/** Groups with fewer resolved setups than this are marked "few observations" in the app. */
export const FEW_OBSERVATIONS = 20;

/** CSV exports (architecture §14: every export is audited as `export.downloaded`). */
export const EXPORT_KINDS = ['setup-stats', 'setups', 'run-comparison'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];
export const EXPORT_AUDIT_ACTION = 'export.downloaded' as const;
/** The setups export refuses more rows than this: narrow the period or the filters. */
export const SETUP_EXPORT_MAX_ROWS = 100_000;
