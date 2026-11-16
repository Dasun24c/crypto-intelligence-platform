import type {
  AiAnalysisSummary,
  AiBudgetState,
  AiContext,
  AiReason,
  AiStatus,
  AiTrigger,
  LevelType,
} from '@cip/contracts';
import { PATTERN_TITLE, STATE_TITLE } from './setups.js';

/** How each analysis outcome is named on screen. */
export const STATUS_LABEL: Record<AiStatus, string> = {
  accepted: 'Accepted',
  rejected: 'Rejected by the checks',
  failed: 'Failed',
  skipped_budget: 'Not called (budget)',
  cache_hit: 'From cache',
};

export const STATUS_TONE: Record<AiStatus, 'ok' | 'warn' | 'crit' | 'info'> = {
  accepted: 'ok',
  rejected: 'crit',
  failed: 'crit',
  skipped_budget: 'warn',
  cache_hit: 'info',
};

export const REASON_LABEL: Record<AiReason, string> = {
  market_summary: 'Market summary',
  setup_review: 'Setup review',
  refresh: 'Refresh',
};

const TRIGGER_LABEL: Record<AiTrigger, string> = {
  event: 'Significant events',
  digest: '4-hourly digest',
  on_demand: 'On request',
};

/** Why an analysis ran: the trigger, and the reason of a request. */
export function triggerLabel(a: Pick<AiAnalysisSummary, 'trigger' | 'reason'>): string {
  return a.trigger === 'on_demand' && a.reason
    ? `${TRIGGER_LABEL.on_demand}: ${REASON_LABEL[a.reason].toLowerCase()}`
    : TRIGGER_LABEL[a.trigger];
}

/** The budget's state in words: `exhausted` is "AI budget reached" (criterion 9.3). */
export const BUDGET_LABEL: Record<AiBudgetState, string> = {
  ok: 'Within budget',
  throttled: 'Throttled: significant events only',
  exhausted: 'AI budget reached',
};

const FAILURES: Record<string, string> = {
  no_key: 'No Grok API key was configured.',
  timeout: 'Grok did not answer in time. The call may still be billed: its worst case is counted.',
  network: 'Grok could not be reached.',
  rate_limited: 'Grok asked us to slow down, and kept doing so.',
  http_400: 'Grok refused the request as malformed.',
  http_401: 'Grok refused the API key.',
  http_403: 'The API key may not use this model.',
  http_404: 'Grok does not know this model.',
  http_4xx: 'Grok refused the request.',
  http_5xx: 'Grok had an error, and kept having it.',
  bad_response: 'Grok answered without a usable answer.',
  context_unavailable: 'The context could not be built from the platform’s data.',
  daily_cap: 'The call could have passed the daily cap.',
  monthly_cap: 'The call could have passed the monthly cap.',
  throttled: 'Over 80 % of a cap: only significant events are analysed.',
  disabled: 'AI analyses were switched off.',
};

/** A failed or skipped analysis's reason in words (or the code itself when it is a new one). */
export function failureText(error: string | null): string {
  if (!error) return '';
  const repair = /^(no repair|repair failed): (.+)$/.exec(error);
  if (repair)
    return repair[1] === 'no repair'
      ? `No repair attempt: ${failureText(repair[2]!).toLowerCase()}`
      : `The repair attempt failed: ${failureText(repair[2]!).toLowerCase()}`;
  return FAILURES[error] ?? error;
}

/** US dollars with enough decimals for a few cents' worth of tokens. */
export function formatUsd(value: string | null): string {
  if (value === null) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return `$${n === 0 ? '0' : n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
}

export function formatTokens(n: number | null): string {
  return n === null ? '—' : n.toLocaleString('en-GB');
}

const LEVEL_LABEL: Record<LevelType, string> = {
  eqh: 'equal highs',
  eql: 'equal lows',
  pdh: 'previous day high',
  pdl: 'previous day low',
  pwh: 'previous week high',
  pwl: 'previous week low',
  pmh: 'previous month high',
  pml: 'previous month low',
  session_high: 'session high',
  session_low: 'session low',
  range_high: 'range high',
  range_low: 'range low',
  weekend_high: 'weekend high',
  weekend_low: 'weekend low',
  swing_high: 'swing high',
  swing_low: 'swing low',
  sweep_extreme: 'sweep extreme',
};

const INDICATOR_LABEL: Record<string, string> = {
  rsi: 'RSI',
  macd_hist: 'MACD histogram',
  atr: 'ATR',
  volume_z: 'Volume z-score',
  ema_fast: 'Fast EMA',
  ema_slow: 'Slow EMA',
};

/**
 * What a reference in an answer points at, from the context that was sent: the answer cites ids,
 * this shows the item itself. Null when the context has no such item.
 */
export function describeRef(ctx: AiContext, ref: string): string | null {
  if (ref === ctx.instrument.id) return ctx.instrument.displayName;
  if (ref === ctx.market.id)
    return ctx.market.last === null
      ? 'The market (no live price)'
      : `The market: last ${ctx.market.last}${ctx.market.change24hPct === null ? '' : `, ${ctx.market.change24hPct} % in 24 h`}`;
  if (ctx.goldMarket && ref === ctx.goldMarket.id)
    return `The gold market: ${ctx.goldMarket.status === 'closed' ? 'closed' : 'open'}`;
  const ind = ctx.indicators.find((i) => i.id === ref);
  if (ind) return `${INDICATOR_LABEL[ind.name] ?? ind.name} (${ind.tf}): ${ind.value}`;
  const str = ctx.structure.find((s) => s.id === ref);
  if (str)
    return `Structure (${str.tf}): ${str.trend}${str.lastEvent ? `, last ${str.lastEvent.direction} ${str.lastEvent.type.toUpperCase()} at ${str.lastEvent.price}` : ''}`;
  const lvl = ctx.levels.find((l) => l.id === ref);
  if (lvl) return `${capitalise(LEVEL_LABEL[lvl.type])} at ${lvl.price} (${lvl.tf}, ${lvl.status})`;
  const zone = ctx.zones.find((z) => z.id === ref);
  if (zone)
    return `${capitalise(zone.direction)} ${zone.type.replace(/_/g, ' ')} ${zone.bottom}–${zone.top} (${zone.tf})`;
  const setup = ctx.setups.find((s) => s.id === ref);
  if (setup)
    return `${PATTERN_TITLE[setup.pattern]}, ${setup.direction}, ${STATE_TITLE[setup.state].toLowerCase()}`;
  const event = ctx.recentEvents.find((e) => e.id === ref);
  if (event) return event.summary;
  const cal = ctx.calendar.find((c) => c.id === ref);
  if (cal) return `${cal.title} (${cal.impact} impact)`;
  const dq = ctx.dataQuality.find((d) => d.id === ref);
  if (dq) return dq.detail;
  return null;
}

const capitalise = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** The parts of an accepted answer, read defensively: the stored answer is shown, never trusted blindly. */
export interface AnswerView {
  headline: string;
  summary: string;
  stance: string;
  confidence: string;
  observations: { text: string; refs: string[] }[];
  supportingIndicators: { ref: string; reading: string }[];
  risks: { text: string; refs: string[] }[];
  invalidation: { text: string; refs: string[] } | null;
  competingScenario: { text: string; refs: string[] } | null;
  dataQualityNotes: string[];
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const refsOf = (v: unknown) => (Array.isArray(v) ? v.filter((r): r is string => typeof r === 'string') : []);
const cited = (v: unknown) => {
  const o = v as { text?: unknown; refs?: unknown } | null;
  return o && typeof o === 'object' && typeof o.text === 'string'
    ? { text: o.text, refs: refsOf(o.refs) }
    : null;
};
const citedList = (v: unknown) =>
  Array.isArray(v) ? v.map(cited).filter((c): c is { text: string; refs: string[] } => c !== null) : [];

export function answerView(response: unknown): AnswerView | null {
  if (!response || typeof response !== 'object') return null;
  const r = response as Record<string, unknown>;
  if (typeof r['headline'] !== 'string') return null;
  return {
    headline: r['headline'],
    summary: str(r['summary']),
    stance: str(r['stance']),
    confidence: str(r['confidence']),
    observations: citedList(r['observations']),
    supportingIndicators: Array.isArray(r['supportingIndicators'])
      ? (r['supportingIndicators'] as unknown[])
          .map((s) => s as { ref?: unknown; reading?: unknown } | null)
          .filter((s) => s && typeof s.ref === 'string' && typeof s.reading === 'string')
          .map((s) => ({ ref: s!.ref as string, reading: s!.reading as string }))
      : [],
    risks: citedList(r['risks']),
    invalidation: cited(r['invalidation']),
    competingScenario: cited(r['competingScenario']),
    dataQualityNotes: Array.isArray(r['dataQualityNotes'])
      ? (r['dataQualityNotes'] as unknown[]).filter((n): n is string => typeof n === 'string')
      : [],
  };
}

/** An analysis on its way: queued, then running, until its result arrives on the `ai` channel. */
export interface InFlight {
  analysisId: string;
  instrumentId: string;
  trigger: AiTrigger;
  state: 'queued' | 'running';
  since: number;
}
