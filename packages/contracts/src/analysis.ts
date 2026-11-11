import { z } from 'zod';
import { TsSchema, UuidSchema } from './common.js';
import { TimeframeSchema } from './market.js';

/** Technical analysis: indicators and analysis runs (API contracts §3 "Analysis", §4, §5). */

const period = (min: number) => z.number().int().min(min).max(100_000);

/**
 * Indicator settings, the `indicators` part of an instrument profile's params (data model §4).
 * The same shape as `IndicatorParams` in packages/indicators, which validates the same rules.
 */
export const IndicatorParamsSchema = z.strictObject({
  rsi: z.strictObject({ period: period(2) }),
  macd: z
    .strictObject({ fast: period(2), slow: period(2), signal: period(2) })
    .refine((m) => m.slow > m.fast, 'the slow period must be longer than the fast'),
  ema: z
    .strictObject({ fast: period(2), mid: period(2), slow: period(2) })
    .refine((e) => e.fast < e.mid && e.mid < e.slow, 'the EMA periods must increase: fast < mid < slow'),
  atr: z.strictObject({ period: period(2) }),
  volume: z.strictObject({ lookback: period(2), zThreshold: z.number().positive() }),
  trend: z.strictObject({ slopeBars: period(1), minStrength: z.number().positive() }),
});
export type IndicatorParams = z.infer<typeof IndicatorParamsSchema>;

/** `market.instrument_profiles.params`. Later phases add their settings next to `indicators`. */
export const ProfileParamsSchema = z.object({ indicators: IndicatorParamsSchema });
export type ProfileParams = z.infer<typeof ProfileParamsSchema>;

export const TrendSchema = z.enum(['bullish', 'bearish', 'neutral']);
export type Trend = z.infer<typeof TrendSchema>;

/**
 * One closed candle's indicator values (data model: `analysis.indicator_values`). Values are null
 * during each indicator's own warm-up. `warmup` marks candles before the run started: they were
 * computed from history to prime the indicators, and never raise alerts.
 */
export const IndicatorPointSchema = z.object({
  t: TsSchema,
  rsi: z.number().nullable(),
  macd: z.number().nullable(),
  macdSignal: z.number().nullable(),
  macdHist: z.number().nullable(),
  emaFast: z.number().nullable(),
  emaMid: z.number().nullable(),
  emaSlow: z.number().nullable(),
  vwap: z.number().nullable(),
  atr: z.number().nullable(),
  volumeZ: z.number().nullable(),
  volumeAnomaly: z.boolean().nullable(),
  trend: TrendSchema.nullable(),
  trendStrength: z.number().nullable(),
  warmup: z.boolean(),
});
export type IndicatorPoint = z.infer<typeof IndicatorPointSchema>;

export const RUN_STATUSES = ['warming_up', 'running', 'completed', 'failed', 'superseded'] as const;
export const RunStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const PauseReasonSchema = z.enum(['data_gap', 'warming_up']);
export type PauseReason = z.infer<typeof PauseReasonSchema>;

/** The run whose values a response carries. */
export const RunRefSchema = z.object({
  id: UuidSchema,
  status: RunStatusSchema,
  /** Candles that open before this are warm-up. */
  from: TsSchema,
  profile: z.object({ name: z.string(), version: z.number().int() }),
});
export type RunRef = z.infer<typeof RunRefSchema>;

/**
 * `GET /indicators/{instrumentId}?tf&from&to&limit`: the instrument's current live run (the open
 * one, else the latest), its indicator settings and its points in time order. `run` is null when
 * the instrument has never been analysed.
 */
export const IndicatorSeriesSchema = z.object({
  instrumentId: UuidSchema,
  tf: TimeframeSchema,
  run: RunRefSchema.nullable(),
  params: IndicatorParamsSchema.nullable(),
  points: z.array(IndicatorPointSchema),
});
export type IndicatorSeries = z.infer<typeof IndicatorSeriesSchema>;

const ms = z.coerce.number().int().nonnegative();
export const IndicatorsQuerySchema = z.strictObject({
  tf: TimeframeSchema,
  from: ms.optional(),
  to: ms.optional(),
  limit: z.coerce.number().int().min(1).max(5_000).default(1_000),
});
export type IndicatorsQuery = z.infer<typeof IndicatorsQuerySchema>;

/**
 * One instrument's analysis state, written by the analyzer that holds its lease every few seconds
 * (with a TTL) and shown in `SystemHealth.analysis`.
 */
export const AnalysisStatusSchema = z.object({
  instrumentId: UuidSchema,
  runId: UuidSchema,
  status: RunStatusSchema,
  /** Seconds from the latest closed 1m candle boundary to the last one analysed; null before any. */
  lagSec: z.number().nullable(),
  paused: z.boolean(),
  pauseReason: PauseReasonSchema.optional(),
  /** Timeframes held back, with why (e.g. "15m: waiting for 2026-11-10 12:15 (data gap)"). */
  detail: z.string(),
  updatedAt: TsSchema,
});
export type AnalysisStatus = z.infer<typeof AnalysisStatusSchema>;

/** `GET /system/runs`: live and replay runs, newest first, with the live state where known. */
export const DetectionRunSchema = z.object({
  id: UuidSchema,
  mode: z.enum(['live', 'replay']),
  instrumentId: UuidSchema,
  profile: z.object({ name: z.string(), version: z.number().int() }),
  rulesetVersion: z.string(),
  paramsHash: z.string(),
  from: TsSchema,
  to: TsSchema.nullable(),
  status: RunStatusSchema,
  startedAt: TsSchema,
  finishedAt: TsSchema.nullable(),
  lagSec: z.number().nullable(),
  paused: z.boolean(),
  pauseReason: PauseReasonSchema.nullable(),
});
export type DetectionRun = z.infer<typeof DetectionRunSchema>;

export const RunsQuerySchema = z.strictObject({
  instrumentId: UuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type RunsQuery = z.infer<typeof RunsQuerySchema>;

/** `indicators:{instrumentId}:{tf}` message `indicators.closed`. */
export const IndicatorsClosedEventSchema = z.object({
  instrumentId: UuidSchema,
  tf: TimeframeSchema,
  runId: UuidSchema,
  point: IndicatorPointSchema,
});
export type IndicatorsClosedEvent = z.infer<typeof IndicatorsClosedEventSchema>;

/** Redis stream of analysis events (architecture §6), read by every api instance. */
export const ANALYSIS_EVENTS_STREAM = 'an:events';
/** Redis key of one instrument's `AnalysisStatus` (15 s TTL). */
export const analysisStatusKey = (instrumentId: string) => `analysis:status:${instrumentId}`;
