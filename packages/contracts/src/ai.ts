import { z } from 'zod';
import { pageSchema, PageQuerySchema, TsSchema, UuidSchema } from './common.js';
import { DecimalSchema, TimeframeSchema } from './market.js';
import { ChecklistItemSchema, LevelTypeSchema, PatternSchema, SetupStateSchema } from './smc.js';

// ---------------------------------------------------------------------------------------------
// AI intelligence (Phase 9): Grok explains significant events from a context the server builds;
// the server checks every reference and number before anything is shown (ADR 011, ADR 023).
// ---------------------------------------------------------------------------------------------

/** On every AI text (REQUIREMENTS §4: never a guaranteed prediction; risk R12). */
export const AI_DISCLAIMER =
  "AI-generated observations from the platform's data. Not financial advice and not a prediction." as const;

/** On-demand requests choose a reason from this list: no free text reaches the model (ADR 011). */
export const AI_REASONS = ['market_summary', 'setup_review', 'refresh'] as const;
export const AiReasonSchema = z.enum(AI_REASONS);
export type AiReason = z.infer<typeof AiReasonSchema>;

export const AI_TRIGGERS = ['event', 'digest', 'on_demand'] as const;
export const AiTriggerSchema = z.enum(AI_TRIGGERS);
export type AiTrigger = z.infer<typeof AiTriggerSchema>;

/**
 * `accepted` and `rejected` (by validation, after one repair attempt); `failed`: no usable answer
 * (timeout, HTTP errors, no key); `skipped_budget`: the call did not fit the caps; `cache_hit`: an
 * identical context's accepted analysis from the last 30 min was reused.
 */
export const AI_STATUSES = ['accepted', 'rejected', 'failed', 'skipped_budget', 'cache_hit'] as const;
export const AiStatusSchema = z.enum(AI_STATUSES);
export type AiStatus = z.infer<typeof AiStatusSchema>;

export const AI_STANCES = ['bullish', 'bearish', 'neutral'] as const;
export const AI_CONFIDENCES = ['low', 'medium', 'high'] as const;

const Direction = z.enum(['bullish', 'bearish']);
const ContextId = z.string().min(1).max(64);

// ── The context sent to the model (API contracts §6.1, version 1) ────────────────────────────────

/** Every item has an `id` the model must cite. Prices are the database's decimal strings. */
export const AiContextSchema = z.object({
  contextVersion: z.literal('1'),
  asOf: TsSchema,
  instrument: z.object({
    id: z.literal('instr'),
    displayName: z.string(),
    assetClass: z.string(),
    venue: z.string(),
  }),
  market: z.object({
    id: z.literal('mkt'),
    last: DecimalSchema.nullable(),
    change24hPct: z.number().nullable(),
    volume24hUsd: z.number().nullable(),
    spreadBps: z.number().nullable(),
  }),
  /** PAXG only: the underlying gold market. */
  goldMarket: z
    .object({
      id: z.literal('gold'),
      status: z.enum(['open', 'closed']),
      nextChangeAt: TsSchema.nullable(),
      crossVenueSpreadBps: z.number().nullable(),
    })
    .optional(),
  indicators: z.array(z.object({ id: ContextId, tf: TimeframeSchema, name: z.string(), value: z.number() })),
  structure: z.array(
    z.object({
      id: ContextId,
      tf: TimeframeSchema,
      trend: z.enum(['bullish', 'bearish', 'undefined']),
      lastEvent: z
        .object({ type: z.string(), direction: Direction, price: DecimalSchema, at: TsSchema })
        .nullable(),
    }),
  ),
  levels: z.array(
    z.object({
      id: ContextId,
      tf: TimeframeSchema,
      type: LevelTypeSchema,
      price: DecimalSchema,
      distanceAtr: z.number().nullable(),
      status: z.string(),
    }),
  ),
  zones: z.array(
    z.object({
      id: ContextId,
      tf: TimeframeSchema,
      type: z.string(),
      direction: Direction,
      top: DecimalSchema,
      bottom: DecimalSchema,
      status: z.string(),
      fillPct: z.number(),
    }),
  ),
  setups: z.array(
    z.object({
      id: ContextId,
      pattern: PatternSchema,
      direction: Direction,
      state: SetupStateSchema,
      entry: DecimalSchema.nullable(),
      invalidation: DecimalSchema.nullable(),
      target1: DecimalSchema.nullable(),
      rr: z.number().nullable(),
      score: z.number(),
      checklist: z.array(z.object({ item: ChecklistItemSchema, credit: z.number() })),
      flags: z.array(z.string()),
    }),
  ),
  /** The last 6 h of detections and setup transitions. */
  recentEvents: z.array(z.object({ id: ContextId, at: TsSchema, type: z.string(), summary: z.string() })),
  /** The next 48 h of economic events. */
  calendar: z.array(z.object({ id: ContextId, at: TsSchema, title: z.string(), impact: z.string() })),
  dataQuality: z.array(z.object({ id: ContextId, code: z.string(), detail: z.string() })),
});
export type AiContext = z.infer<typeof AiContextSchema>;

// ── The response (API contracts §6.2): Grok's structured output ─────────────────────────────────

const Text = (max: number) => z.string().min(1).max(max);
const Ref = z.string().min(1).max(64);
const Cited = (max: number) => z.strictObject({ text: Text(max), refs: z.array(Ref).min(1).max(6) });

/**
 * The model's answer. Its JSON Schema (`z.toJSONSchema`) is what Grok's structured output follows; it
 * stays inside Grok's guaranteed subset (ADR 011): every field required, no `not` or `if/then/else`.
 */
export const AiResponseSchema = z.strictObject({
  stance: z.enum(AI_STANCES),
  confidence: z.enum(AI_CONFIDENCES),
  headline: Text(120),
  summary: Text(800),
  observations: z.array(Cited(300)).min(1).max(6),
  supportingIndicators: z.array(z.strictObject({ ref: Ref, reading: Text(160) })).max(6),
  risks: z.array(Cited(240)).min(1).max(5),
  invalidation: Cited(240),
  competingScenario: Cited(240),
  dataQualityNotes: z.array(Text(160)).max(4),
});
export type AiResponse = z.infer<typeof AiResponseSchema>;

/** ADR 011: V1–V5 reject; V6 is a warning. */
export const AI_RULES = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6'] as const;
export const AiValidationIssueSchema = z.object({
  rule: z.enum(AI_RULES),
  /** Where in the response, e.g. `observations.1.text`. */
  path: z.string(),
  message: z.string(),
});
export type AiValidationIssue = z.infer<typeof AiValidationIssueSchema>;

export const AiValidationSchema = z.object({
  errors: z.array(AiValidationIssueSchema),
  warnings: z.array(AiValidationIssueSchema),
  /** The first answer's errors, when a repair was tried. */
  firstAttemptErrors: z.array(AiValidationIssueSchema).optional(),
});
export type AiValidation = z.infer<typeof AiValidationSchema>;

// ── Analyses (data model §6) ────────────────────────────────────────────────────────────────────

/** Why an analysis ran: the events (with their scores), the digest slot, or the request. */
export const AiTriggerRefSchema = z.object({
  kind: z.string(),
  id: z.string(),
  score: z.number(),
  at: TsSchema,
});
export type AiTriggerRef = z.infer<typeof AiTriggerRefSchema>;

export const AiUsageFiguresSchema = z.object({
  inputTokens: z.number().int().nullable(),
  cachedInputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  reasoningTokens: z.number().int().nullable(),
  costUsd: DecimalSchema.nullable(),
  latencyMs: z.number().int().nullable(),
});
export type AiUsageFigures = z.infer<typeof AiUsageFiguresSchema>;

export const AiAnalysisSummarySchema = z.object({
  id: UuidSchema,
  instrumentId: UuidSchema.nullable(),
  trigger: AiTriggerSchema,
  /** On-demand: why it was asked for. */
  reason: AiReasonSchema.nullable(),
  status: AiStatusSchema,
  stance: z.enum(AI_STANCES).nullable(),
  confidence: z.enum(AI_CONFIDENCES).nullable(),
  headline: z.string().nullable(),
  /** `failed`: why (`no_key`, `timeout`, `http_401`, …); `skipped_budget`: which cap. */
  error: z.string().nullable(),
  /** `cache_hit`: the analysis reused. */
  cacheSourceId: UuidSchema.nullable(),
  modelReported: z.string().nullable(),
  costUsd: DecimalSchema.nullable(),
  createdAt: TsSchema,
});
export type AiAnalysisSummary = z.infer<typeof AiAnalysisSummarySchema>;

/** `GET /ai/analyses/{id}`: everything that was sent and received, and what validation found. */
export const AiAnalysisDetailSchema = AiAnalysisSummarySchema.extend({
  triggerRefs: z.array(AiTriggerRefSchema),
  setupId: UuidSchema.nullable(),
  requestedBy: UuidSchema.nullable(),
  /** Exactly what was sent (or would have been); null when it could not be built. */
  context: AiContextSchema.nullable(),
  contextHash: z.string(),
  promptVersion: z.string(),
  modelRequested: z.string(),
  /** The answer as validated (or as rejected); null when there was none. */
  response: z.unknown().nullable(),
  validation: AiValidationSchema,
  repairAttempted: z.boolean(),
  usage: AiUsageFiguresSchema,
});
export type AiAnalysisDetail = z.infer<typeof AiAnalysisDetailSchema>;

const ms = z.coerce.number().int().nonnegative();
const list = <T extends z.ZodType>(item: T) =>
  z.preprocess((v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v), z.array(item).min(1));

/** `GET /ai/analyses`: newest first. */
export const AiAnalysesQuerySchema = PageQuerySchema.extend({
  instrumentId: UuidSchema.optional(),
  status: list(AiStatusSchema).optional(),
  from: ms.optional(),
  to: ms.optional(),
});
export type AiAnalysesQuery = z.infer<typeof AiAnalysesQuerySchema>;
export const AiAnalysesPageSchema = pageSchema(AiAnalysisSummarySchema);

/** `POST /ai/analyses` → `202 { analysisId }`. A setup review names its setup. */
export const AiRequestSchema = z
  .strictObject({
    instrumentId: UuidSchema,
    reason: AiReasonSchema,
    setupId: UuidSchema.optional(),
  })
  .refine((r) => (r.reason === 'setup_review') === (r.setupId !== undefined), {
    message: 'a setup review names its setup, and only a setup review does',
    path: ['setupId'],
  });
export type AiRequest = z.infer<typeof AiRequestSchema>;

// ── Budget, usage and settings (NFR-08) ─────────────────────────────────────────────────────────

/** `ok`; `throttled` at 80 % of a cap (only triggers scoring 100 or more); `exhausted`: no calls. */
export const AiBudgetStateSchema = z.enum(['ok', 'throttled', 'exhausted']);
export type AiBudgetState = z.infer<typeof AiBudgetStateSchema>;

const CapStatus = z.object({ spentUsd: DecimalSchema, capUsd: DecimalSchema, usedPct: z.number() });
export const AiBudgetStatusSchema = z.object({
  state: AiBudgetStateSchema,
  /** The UTC day and month. */
  daily: CapStatus,
  monthly: CapStatus,
  enabled: z.boolean(),
});
export type AiBudgetStatus = z.infer<typeof AiBudgetStatusSchema>;

/** `GET /ai/usage?from&to`: per UTC day, and the budget now. */
export const AiUsageQuerySchema = z.strictObject({ from: ms.optional(), to: ms.optional() });
export const AiUsageDaySchema = z.object({
  day: z.string(),
  calls: z.number().int(),
  accepted: z.number().int(),
  rejected: z.number().int(),
  failed: z.number().int(),
  cacheHits: z.number().int(),
  skipped: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costUsd: DecimalSchema,
});
export type AiUsageDay = z.infer<typeof AiUsageDaySchema>;
export const AiUsageSchema = z.object({ days: z.array(AiUsageDaySchema), budget: AiBudgetStatusSchema });
export type AiUsage = z.infer<typeof AiUsageSchema>;

const Price = z.number().min(0).max(1000);
/** USD per 1M tokens. */
export const AiPriceSchema = z.strictObject({ input: Price, cachedInput: Price, output: Price });
export type AiPrice = z.infer<typeof AiPriceSchema>;

/** `app.settings` key `ai`, at `GET` and `PUT /admin/settings/ai` (ADR 023). */
export const AiSettingsSchema = z
  .strictObject({
    enabled: z.boolean(),
    model: z.string().trim().min(1).max(64),
    fallbackModel: z.string().trim().min(1).max(64).nullable(),
    /** Sent to reasoning models (it cannot switch reasoning off); null: the model's default. */
    reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']).nullable(),
    /** The visible answer's limit, sent with each call. */
    maxCompletionTokens: z.number().int().min(256).max(16_000),
    /**
     * Reasoning tokens are billed as output but not limited by `maxCompletionTokens`: the budget
     * reserves this many for each call too (ADR 023).
     */
    reasoningAllowanceTokens: z.number().int().min(0).max(64_000),
    dailyCapUsd: z.number().min(0).max(1_000),
    monthlyCapUsd: z.number().min(0).max(10_000),
    prices: z.record(z.string().min(1).max(64), AiPriceSchema),
  })
  .refine((s) => s.prices[s.model] !== undefined, {
    message: 'the model needs its prices',
    path: ['prices'],
  })
  .refine((s) => s.fallbackModel === null || s.prices[s.fallbackModel] !== undefined, {
    message: 'the fallback model needs its prices',
    path: ['prices'],
  });
export type AiSettings = z.infer<typeof AiSettingsSchema>;

/** Feasibility §5.2 and decision D5: grok-4.3 at low reasoning effort, $5 a day and $100 a month. */
export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: true,
  model: 'grok-4.3',
  fallbackModel: 'grok-4.20-0309-non-reasoning',
  reasoningEffort: 'low',
  maxCompletionTokens: 2_000,
  reasoningAllowanceTokens: 4_000,
  dailyCapUsd: 5,
  monthlyCapUsd: 100,
  prices: {
    'grok-4.3': { input: 1.25, cachedInput: 0.2, output: 2.5 },
    'grok-4.7': { input: 2, cachedInput: 0.5, output: 6 },
    'grok-4.20-0309-non-reasoning': { input: 1.25, cachedInput: 0.2, output: 2.5 },
  },
};

// ── Queue, stream and channel ───────────────────────────────────────────────────────────────────

/** The BullMQ queue of AI analyses, worked by the jobs service (ADR 023). */
export const AI_QUEUE = 'ai';
/** Redis stream behind the durable `ai` channel. */
export const AI_EVENTS_STREAM = 'ai:events';
/** The provider's state and the budget, kept fresh by the jobs service for the system health. */
export const AI_STATUS_KEY = 'ai:status';

export interface AiJob {
  analysisId: string;
  trigger: AiTrigger;
  instrumentId: string;
  /** The trigger's score: event windows add up their events'; a digest is 30; a request counts 100. */
  score: number;
  triggerRefs: AiTriggerRef[];
  requestedBy: string | null;
  reason: AiReason | null;
  setupId: string | null;
  queuedAt: number;
}

/** `ai:status` and the system health's `ai`. */
export const AiStatusReportSchema = z.object({
  /** Grok: `down` without a key or when unreachable; `degraded` on the fallback model. */
  status: z.enum(['ok', 'degraded', 'down']),
  detail: z.string(),
  /** Whether the jobs service has a key (never the key): without one, requests are refused. */
  keyConfigured: z.boolean(),
  model: z.string().nullable(),
  budget: AiBudgetStatusSchema,
  checkedAt: TsSchema,
});
export type AiStatusReport = z.infer<typeof AiStatusReportSchema>;

/** Messages on the `ai` channel (API contracts §5.3). */
export const AiQueuedMessageSchema = z.object({
  analysisId: UuidSchema,
  instrumentId: UuidSchema,
  trigger: AiTriggerSchema,
  reason: AiReasonSchema.nullable(),
  queuedAt: TsSchema,
});
export const AiStartedMessageSchema = AiQueuedMessageSchema.pick({
  analysisId: true,
  instrumentId: true,
  trigger: true,
});
export const AiDoneMessageSchema = z.object({ analysis: AiAnalysisSummarySchema });
export const AiBudgetMessageSchema = z.object({ budget: AiBudgetStatusSchema });
/** The `ai` channel's snapshot, when a replay is impossible: the budget and the latest analyses. */
export const AiSnapshotSchema = z.object({
  budget: AiBudgetStatusSchema,
  latest: z.array(AiAnalysisSummarySchema),
});
export type AiSnapshot = z.infer<typeof AiSnapshotSchema>;
/** API contracts §8: on-demand analyses per user per hour (plus the global budget). */
export const AI_REQUESTS_PER_HOUR = 10;
export const AI_MESSAGE_TYPES = [
  'ai.queued',
  'ai.started',
  'ai.completed',
  'ai.rejected',
  'ai.failed',
  'ai.budget',
] as const;
export type AiMessageType = (typeof AI_MESSAGE_TYPES)[number];
