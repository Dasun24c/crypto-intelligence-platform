import type { AiBudgetState, AiBudgetStatus, AiPrice, AiSettings } from '@cip/contracts';
import { dec, type Decimal } from '@cip/domain';
import { TRIGGER_THRESHOLD } from './triggers.js';

/** Tokens as the provider reports them: `outputTokens` is the visible answer; reasoning is apart. */
export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

/** At 80 % of a cap only triggers scoring 100 or more go through (architecture §8). */
export const THROTTLE_AT = 0.8;
/** A typical call's input, for the budget's state when no context is at hand (ADR 023: about 8k). */
export const TYPICAL_INPUT_TOKENS = 8_000;

const MILLION = 1_000_000;

/** What a call cost: uncached input, cached input, and output with reasoning, at the model's prices. */
export function costUsd(u: TokenUsage, price: AiPrice): Decimal {
  const cached = Math.min(u.cachedInputTokens, u.inputTokens);
  return dec(u.inputTokens - cached)
    .times(price.input)
    .plus(dec(cached).times(price.cachedInput))
    .plus(dec(u.outputTokens + u.reasoningTokens).times(price.output))
    .div(MILLION)
    .round(6, 3);
}

/** The most a call can cost: its input at the full price, the answer's limit and the reasoning allowance. */
export function worstCaseUsd(inputTokens: number, settings: AiSettings, model: string): Decimal {
  const price = settings.prices[model] ?? settings.prices[settings.model]!;
  return dec(inputTokens)
    .times(price.input)
    .plus(dec(settings.maxCompletionTokens + settings.reasoningAllowanceTokens).times(price.output))
    .div(MILLION)
    .round(6, 3);
}

/** Spend so far in the UTC day and month (USD). */
export interface Spend {
  day: string | Decimal;
  month: string | Decimal;
}

export type Refusal = 'disabled' | 'daily_cap' | 'monthly_cap' | 'throttled';

/**
 * Whether a call may be made (NFR-08, criterion 9.3): never past a cap, counting the call's worst
 * case; at 80 % of a cap, only for a trigger scoring 100 or more.
 */
export function admit(a: {
  spend: Spend;
  worstCase: Decimal;
  score: number;
  settings: AiSettings;
}): Refusal | null {
  const { settings } = a;
  if (!settings.enabled) return 'disabled';
  const day = dec(a.spend.day);
  const month = dec(a.spend.month);
  if (day.plus(a.worstCase).gt(settings.dailyCapUsd)) return 'daily_cap';
  if (month.plus(a.worstCase).gt(settings.monthlyCapUsd)) return 'monthly_cap';
  const throttled =
    day.gte(dec(settings.dailyCapUsd).times(THROTTLE_AT)) ||
    month.gte(dec(settings.monthlyCapUsd).times(THROTTLE_AT));
  if (throttled && a.score < TRIGGER_THRESHOLD) return 'throttled';
  return null;
}

const pct = (spent: Decimal, cap: number) =>
  cap <= 0 ? 100 : Math.round(Number(spent.div(cap).times(100)) * 10) / 10;

/**
 * The budget now: `exhausted` when a typical call no longer fits a cap, `throttled` at 80 % of
 * either, else `ok`.
 */
export function budgetStatus(spend: Spend, settings: AiSettings): AiBudgetStatus {
  const day = dec(spend.day);
  const month = dec(spend.month);
  const typical = worstCaseUsd(TYPICAL_INPUT_TOKENS, settings, settings.model);
  let state: AiBudgetState = 'ok';
  if (day.plus(typical).gt(settings.dailyCapUsd) || month.plus(typical).gt(settings.monthlyCapUsd))
    state = 'exhausted';
  else if (
    day.gte(dec(settings.dailyCapUsd).times(THROTTLE_AT)) ||
    month.gte(dec(settings.monthlyCapUsd).times(THROTTLE_AT))
  )
    state = 'throttled';
  return {
    state,
    daily: {
      spentUsd: day.toString(),
      capUsd: dec(settings.dailyCapUsd).toString(),
      usedPct: pct(day, settings.dailyCapUsd),
    },
    monthly: {
      spentUsd: month.toString(),
      capUsd: dec(settings.monthlyCapUsd).toString(),
      usedPct: pct(month, settings.monthlyCapUsd),
    },
    enabled: settings.enabled,
  };
}

/** The UTC day and month `at` falls in, as the spend is counted: [start, end). */
export function budgetPeriods(at: number): {
  dayStart: number;
  dayEnd: number;
  monthStart: number;
  monthEnd: number;
} {
  const d = new Date(at);
  const [y, m, day] = [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
  return {
    dayStart: Date.UTC(y, m, day),
    dayEnd: Date.UTC(y, m, day + 1),
    monthStart: Date.UTC(y, m, 1),
    monthEnd: Date.UTC(y, m + 1, 1),
  };
}
