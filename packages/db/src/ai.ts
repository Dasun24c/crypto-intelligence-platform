import { type Kysely, sql } from 'kysely';
import {
  type AiAnalysisDetail,
  type AiAnalysisSummary,
  type AiContext,
  type AiSettings,
  AiSettingsSchema,
  type AiTriggerRef,
  type AiValidation,
  DEFAULT_AI_SETTINGS,
} from '@cip/contracts';
import { dec } from '@cip/domain';
import type { AiAnalysisRow, Database } from './types.js';

/** `app.settings` key of the AI settings (ADR 023): admins write them, the jobs service reads them. */
export const AI_SETTINGS_KEY = 'ai';

/** The admins' AI settings, or the defaults when there are none or they no longer validate. */
export async function aiSettings(db: Kysely<Database>): Promise<AiSettings> {
  const row = await db
    .selectFrom('app.settings')
    .select('value')
    .where('key', '=', AI_SETTINGS_KEY)
    .executeTakeFirst();
  const parsed = row ? AiSettingsSchema.safeParse(row.value) : null;
  return parsed?.success ? parsed.data : DEFAULT_AI_SETTINGS;
}

/** A UTC day and month, [start, end) in epoch ms. */
export interface AiPeriods {
  dayStart: number;
  dayEnd: number;
  monthStart: number;
  monthEnd: number;
}

/** What analyses cost in a UTC day and month (USD, as decimal strings): the budget's spend. */
export async function aiSpend(db: Kysely<Database>, p: AiPeriods): Promise<{ day: string; month: string }> {
  const r = await db
    .selectFrom('ai.analyses')
    .select([
      sql<string>`coalesce(sum(cost_usd) filter (where created_at >= ${new Date(p.dayStart)} and created_at < ${new Date(p.dayEnd)}), 0)::text`.as(
        'day',
      ),
      sql<string>`coalesce(sum(cost_usd), 0)::text`.as('month'),
    ])
    .where('created_at', '>=', new Date(p.monthStart))
    .where('created_at', '<', new Date(p.monthEnd))
    .executeTakeFirstOrThrow();
  return { day: r.day, month: r.month };
}

const num = (v: string | null) => (v === null ? null : dec(v).toString());

/** An analysis as lists and the `ai` channel carry it (data model §6, ADR 023). */
export function aiSummaryFromRow(r: AiAnalysisRow): AiAnalysisSummary {
  const response = r.response as { headline?: unknown } | null;
  const shown = r.status === 'accepted' || r.status === 'cache_hit';
  return {
    id: r.id,
    instrumentId: r.instrument_id,
    trigger: r.trigger,
    reason: r.request_reason,
    status: r.status,
    stance: r.stance,
    confidence: r.confidence,
    headline: shown && typeof response?.headline === 'string' ? response.headline : null,
    error: r.error,
    cacheSourceId: r.cache_source_id,
    modelReported: r.model_reported,
    costUsd: num(r.cost_usd),
    createdAt: r.created_at.getTime(),
  };
}

/** An analysis in full: what was sent and received, what validation found, and what it cost. */
export function aiDetailFromRow(r: AiAnalysisRow): AiAnalysisDetail {
  const validation = (r.validation ?? {}) as Partial<AiValidation>;
  return {
    ...aiSummaryFromRow(r),
    triggerRefs: (r.trigger_refs ?? []) as AiTriggerRef[],
    setupId: r.setup_id,
    requestedBy: r.requested_by,
    context: r.context_hash ? (r.context as AiContext) : null,
    contextHash: r.context_hash,
    promptVersion: r.prompt_version,
    modelRequested: r.model_requested,
    response: r.response ?? null,
    validation: {
      errors: validation.errors ?? [],
      warnings: validation.warnings ?? [],
      ...(validation.firstAttemptErrors ? { firstAttemptErrors: validation.firstAttemptErrors } : {}),
    },
    repairAttempted: r.repair_attempted,
    usage: {
      inputTokens: r.input_tokens,
      cachedInputTokens: r.cached_input_tokens,
      outputTokens: r.output_tokens,
      reasoningTokens: r.reasoning_tokens,
      costUsd: num(r.cost_usd),
      latencyMs: r.latency_ms,
    },
  };
}
