import type { Redis } from 'ioredis';
import { AI_STATUS_KEY, type AiSettings, type AiStatusReport } from '@cip/contracts';
import { budgetStatus } from '@cip/ai';
import { LlmError, type LlmProvider } from '@cip/ai/provider';
import type { Logger } from '@cip/observability';
import type { AiStore } from './store.js';

/** The model list is read again this often, and a minute after a failed read. */
export const MODELS_EVERY_MS = 15 * 60_000;
export const MODELS_RETRY_MS = 60_000;
/** `ai:status` outlives a few missed refreshes, then lapses: a stopped jobs service shows as unknown. */
export const STATUS_TTL_MS = 120_000;

/**
 * Grok's state for the system health (`ai:status`) and the model to call (ADR 023): no key is
 * `down`; a configured model the account does not offer falls back to the fallback model
 * (`degraded`); a key the API refuses, or an API out of reach, is `down`.
 */
export class AiStatusReporter {
  private offered: Set<string> | null = null;
  private checkedAt = -Infinity;
  private failure: string | null = null;
  private keyed = false;

  constructor(
    private readonly d: {
      store: AiStore;
      provider: LlmProvider;
      redis: Redis;
      log: Logger;
      hasKey: () => boolean;
      now?: () => number;
    },
  ) {}

  /** The model to call: the configured one, unless the account does not offer it and offers the fallback. */
  model(settings: AiSettings): string {
    const offered = this.offered;
    if (!offered || offered.has(settings.model)) return settings.model;
    if (settings.fallbackModel && offered.has(settings.fallbackModel)) return settings.fallbackModel;
    return settings.model;
  }

  /** Checks again and stores the report. */
  async refresh(): Promise<AiStatusReport> {
    const now = (this.d.now ?? Date.now)();
    const settings = await this.d.store.settings();
    const budget = budgetStatus(await this.d.store.spend(now), settings);
    const keyed = this.d.hasKey();
    if (keyed !== this.keyed) this.checkedAt = -Infinity; // a key added or changed: look again now
    this.keyed = keyed;
    if (keyed && now - this.checkedAt >= (this.failure ? MODELS_RETRY_MS : MODELS_EVERY_MS)) {
      this.checkedAt = now;
      try {
        this.offered = new Set(await this.d.provider.models());
        this.failure = null;
      } catch (err) {
        this.failure = err instanceof LlmError ? err.failure : 'error';
        this.d.log.warn({ failure: this.failure }, 'Grok model check failed');
      }
    }
    if (!keyed) {
      this.offered = null;
      this.failure = null;
    }
    const report: AiStatusReport = {
      ...this.state(settings, keyed),
      keyConfigured: keyed,
      budget,
      checkedAt: now,
    };
    await this.d.redis.set(AI_STATUS_KEY, JSON.stringify(report), 'PX', STATUS_TTL_MS);
    return report;
  }

  private state(settings: AiSettings, keyed: boolean): Pick<AiStatusReport, 'status' | 'detail' | 'model'> {
    const off = settings.enabled ? '' : '; analyses are switched off';
    if (!keyed) return { status: 'down', detail: `no Grok API key is configured${off}`, model: null };
    if (this.failure === 'http_401' || this.failure === 'http_403')
      return { status: 'down', detail: `the Grok API refused the key${off}`, model: null };
    if (this.failure && !this.offered)
      return { status: 'down', detail: `the Grok API is out of reach (${this.failure})${off}`, model: null };
    const model = this.model(settings);
    if (this.offered && !this.offered.has(model))
      return {
        status: 'down',
        detail: `the account offers neither ${settings.model} nor its fallback${off}`,
        model: null,
      };
    if (model !== settings.model)
      return { status: 'degraded', detail: `${settings.model} is not offered; using ${model}${off}`, model };
    return { status: 'ok', detail: `${model}${off}`, model };
  }
}
