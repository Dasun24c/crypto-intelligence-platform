import type { Redis } from 'ioredis';
import {
  AI_EVENTS_STREAM,
  type AiAnalysisSummary,
  type AiBudgetStatus,
  type AiJob,
  type AiMessageType,
  type AiSettings,
  type AiValidation,
} from '@cip/contracts';
import { aiSummaryFromRow, type NewAiAnalysis } from '@cip/db';
import { dec, type Decimal } from '@cip/domain';
import {
  admit,
  budgetStatus,
  type ChatMessage,
  type Checked,
  contextHash,
  costUsd,
  estimateTokens,
  messages,
  PROMPT_VERSION,
  repairMessages,
  RESPONSE_SCHEMA_NAME,
  responseJsonSchema,
  type Spend,
  type TokenUsage,
  triggerText,
  validateResponse,
  worstCaseUsd,
} from '@cip/ai';
import { LlmError, type LlmProvider, type LlmResult } from '@cip/ai/provider';
import type { Logger } from '@cip/observability';
import type { BuiltContext, ContextBuilder } from './context.js';
import type { AiStore } from './store.js';

/** `ai:events` keeps about this many messages. */
const EVENTS_MAXLEN = '10000';

export interface AiWorkerDeps {
  store: AiStore;
  contexts: Pick<ContextBuilder, 'build'>;
  provider: LlmProvider;
  redis: Redis;
  log: Logger;
  /** The model to call now: the configured one, or its fallback when the model check found it missing. */
  model: (settings: AiSettings) => string;
  now?: () => number;
}

const ZERO: TokenUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
const add = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  reasoningTokens: a.reasoningTokens + b.reasoningTokens,
});

/** What the calls of one analysis used and cost so far. */
interface Tally {
  calls: number;
  usage: TokenUsage;
  cost: Decimal;
  latencyMs: number;
  model: string | null;
}

/**
 * One AI analysis (ADR 023): the context, the cache, the budget, the call, validation with one
 * repair attempt, storage of whatever happened, and the announcement on `ai:events`. Only the jobs
 * service runs it: it alone holds the key.
 */
export class AiWorker {
  private readonly now: () => number;
  private readonly schema = responseJsonSchema();
  private lastBudget: string | null = null;

  constructor(private readonly d: AiWorkerDeps) {
    this.now = d.now ?? Date.now;
  }

  async run(job: AiJob): Promise<AiAnalysisSummary> {
    // A job run again (a crash after storing) finds its analysis there.
    const done = await this.d.store.get(job.analysisId);
    if (done) return aiSummaryFromRow(done);
    const settings = await this.d.store.settings();
    const model = this.d.model(settings);
    const started = this.now();
    await this.announce('ai.started', {
      analysisId: job.analysisId,
      instrumentId: job.instrumentId,
      trigger: job.trigger,
    });
    const base = baseRow(job, model, started);

    let built: BuiltContext;
    try {
      built = await this.d.contexts.build(job.instrumentId, started, { setupId: job.setupId });
    } catch (err) {
      this.d.log.warn({ err, analysisId: job.analysisId }, 'AI context could not be built');
      return this.finish('ai.failed', {
        ...base,
        error: 'context_unavailable',
        cost_usd: '0',
        latency_ms: this.now() - started,
      });
    }
    const context = built.context;
    const hash = contextHash(context);
    const withContext: NewAiAnalysis = { ...base, context_hash: hash, context: JSON.stringify(context) };

    // An identical context's accepted analysis from the last 30 min is reused (architecture §8).
    const source = await this.d.store.cacheSource(job.instrumentId, hash, started);
    if (source)
      return this.finish('ai.completed', {
        ...withContext,
        status: 'cache_hit',
        cache_source_id: source.id,
        model_requested: source.model_requested,
        model_reported: source.model_reported,
        stance: source.stance,
        confidence: source.confidence,
        response: JSON.stringify(source.response),
        cost_usd: '0',
        latency_ms: this.now() - started,
      });

    // The budget, counting this call's worst case (NFR-08, criterion 9.3).
    const first = messages(context, triggerText(job.trigger, job.reason, built.setupRef));
    const spend = await this.d.store.spend(started);
    const firstWorst = worstCaseUsd(estimateTokens(JSON.stringify(first)), settings, model);
    const refusal = admit({ spend, worstCase: firstWorst, score: job.score, settings });
    if (refusal) {
      const summary = await this.finish('ai.failed', {
        ...withContext,
        status: 'skipped_budget',
        error: refusal,
        cost_usd: '0',
        latency_ms: this.now() - started,
      });
      await this.budget(settings, true);
      return summary;
    }

    // The call, then validation; one repair attempt when V1–V5 fail (ADR 011).
    const tally: Tally = { calls: 0, usage: ZERO, cost: dec(0), latencyMs: 0, model: null };
    let answer: LlmResult;
    try {
      answer = await this.call(tally, model, settings, first);
    } catch (err) {
      const summary = await this.failed(withContext, started, err, firstWorst, settings, model);
      await this.budget(settings, false);
      return summary;
    }
    let checked: Checked = validateResponse(context, answer.content);
    let validation: AiValidation = { errors: checked.errors, warnings: checked.warnings };
    let repaired = false;
    let note: string | null = null;
    if (checked.errors.length) {
      const again = repairMessages(first, answer.content, checked.errors);
      const repairWorst = worstCaseUsd(estimateTokens(JSON.stringify(again)), settings, model);
      // The analysis was admitted: the repair needs only to fit the caps, not to beat the throttle.
      const repairRefusal = admit({
        spend: plus(spend, tally.cost),
        worstCase: repairWorst,
        score: Number.MAX_SAFE_INTEGER,
        settings,
      });
      if (repairRefusal) note = `no repair: ${repairRefusal}`;
      else {
        repaired = true;
        try {
          const second = await this.call(tally, model, settings, again);
          const firstAttemptErrors = checked.errors;
          checked = validateResponse(context, second.content);
          validation = { errors: checked.errors, warnings: checked.warnings, firstAttemptErrors };
          answer = second;
        } catch (err) {
          const failure = err instanceof LlmError ? err.failure : 'error';
          note = `repair failed: ${failure}`;
          this.charge(tally, err, repairWorst, settings, model);
          this.d.log.warn({ err, analysisId: job.analysisId, failure }, 'AI repair call failed');
        }
      }
    }
    const accepted = checked.errors.length === 0 && checked.response !== null;
    const summary = await this.finish(accepted ? 'ai.completed' : 'ai.rejected', {
      ...withContext,
      status: accepted ? 'accepted' : 'rejected',
      model_reported: answer.model,
      // Only an accepted answer has a stance: a rejected one is kept, never shown as the platform's view.
      stance: accepted ? checked.response!.stance : null,
      confidence: accepted ? checked.response!.confidence : null,
      response: JSON.stringify(checked.response ?? { raw: answer.content.slice(0, 20_000) }),
      validation: JSON.stringify(validation),
      repair_attempted: repaired,
      error: note,
      ...usageColumns(tally),
    });
    await this.budget(settings, false);
    return summary;
  }

  /** The budget now, announced when its state changed (or always, after a call was skipped for it). */
  async budget(settings: AiSettings, always: boolean): Promise<AiBudgetStatus> {
    const status = budgetStatus(await this.d.store.spend(this.now()), settings);
    if (always || status.state !== this.lastBudget) await this.announce('ai.budget', { budget: status });
    this.lastBudget = status.state;
    return status;
  }

  async announce(type: AiMessageType, data: unknown): Promise<void> {
    await this.d.redis.xadd(
      AI_EVENTS_STREAM,
      'MAXLEN',
      '~',
      EVENTS_MAXLEN,
      '*',
      'type',
      type,
      'data',
      JSON.stringify(data),
    );
  }

  private async call(
    tally: Tally,
    model: string,
    settings: AiSettings,
    msgs: ChatMessage[],
  ): Promise<LlmResult> {
    const result = await this.d.provider.complete({
      model,
      messages: msgs,
      schema: this.schema,
      schemaName: RESPONSE_SCHEMA_NAME,
      maxCompletionTokens: settings.maxCompletionTokens,
      reasoningEffort: settings.reasoningEffort,
    });
    tally.calls++;
    tally.usage = add(tally.usage, result.usage);
    tally.cost = tally.cost.plus(this.price(result.usage, settings, model));
    tally.latencyMs += result.latencyMs;
    tally.model = result.model;
    return result;
  }

  /**
   * A call that failed may still have been billed: an unusable answer by what it used; a timed-out
   * one, whose usage nobody reported, by its worst case, so the caps hold (criterion 9.3).
   */
  private charge(tally: Tally, err: unknown, worst: Decimal, settings: AiSettings, model: string): void {
    if (!(err instanceof LlmError)) return;
    if (err.usage) {
      tally.usage = add(tally.usage, err.usage);
      tally.cost = tally.cost.plus(this.price(err.usage, settings, model));
      tally.model = err.model ?? tally.model;
    } else if (err.failure === 'timeout') tally.cost = tally.cost.plus(worst);
  }

  private price(usage: TokenUsage, settings: AiSettings, model: string): Decimal {
    return costUsd(usage, settings.prices[model] ?? settings.prices[settings.model]!);
  }

  /** The call gave no usable answer: stored as `failed`, with what it may have cost. */
  private async failed(
    row: NewAiAnalysis,
    started: number,
    err: unknown,
    worst: Decimal,
    settings: AiSettings,
    model: string,
  ): Promise<AiAnalysisSummary> {
    const failure = err instanceof LlmError ? err.failure : 'error';
    if (failure === 'no_key') this.d.log.info({ analysisId: row.id }, 'AI analysis failed: no Grok API key');
    else this.d.log.warn({ err, analysisId: row.id, failure }, 'AI call failed');
    const tally: Tally = { calls: 0, usage: ZERO, cost: dec(0), latencyMs: 0, model: null };
    this.charge(tally, err, worst, settings, model);
    const reported = err instanceof LlmError && err.usage !== null;
    return this.finish('ai.failed', {
      ...row,
      status: 'failed',
      model_reported: tally.model,
      error: failure,
      ...(reported ? usageColumns(tally) : {}),
      cost_usd: tally.cost.toString(),
      latency_ms: this.now() - started,
    });
  }

  private async finish(type: AiMessageType, row: NewAiAnalysis): Promise<AiAnalysisSummary> {
    await this.d.store.insert(row);
    const stored = await this.d.store.get(row.id);
    if (!stored) throw new Error(`analysis ${row.id} was not stored`);
    const summary = aiSummaryFromRow(stored);
    await this.announce(type, { analysis: summary });
    return summary;
  }
}

const plus = (s: Spend, cost: Decimal): Spend => ({
  day: dec(s.day).plus(cost),
  month: dec(s.month).plus(cost),
});

function usageColumns(t: Tally) {
  return {
    input_tokens: t.usage.inputTokens,
    cached_input_tokens: t.usage.cachedInputTokens,
    output_tokens: t.usage.outputTokens,
    reasoning_tokens: t.usage.reasoningTokens,
    cost_usd: t.cost.toString(),
    latency_ms: t.latencyMs,
  };
}

/** The row before anything happened: a failure with no context, no answer and no cost. */
function baseRow(job: AiJob, model: string, started: number): NewAiAnalysis {
  return {
    id: job.analysisId,
    instrument_id: job.instrumentId,
    trigger: job.trigger,
    trigger_refs: JSON.stringify(job.triggerRefs),
    request_reason: job.reason,
    setup_id: job.setupId,
    requested_by: job.requestedBy,
    context_hash: '',
    context: '{}',
    prompt_version: PROMPT_VERSION,
    model_requested: model,
    model_reported: null,
    status: 'failed',
    cache_source_id: null,
    stance: null,
    confidence: null,
    response: null,
    validation: JSON.stringify({ errors: [], warnings: [] }),
    error: null,
    input_tokens: null,
    cached_input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    cost_usd: null,
    latency_ms: null,
    created_at: new Date(started),
  };
}
