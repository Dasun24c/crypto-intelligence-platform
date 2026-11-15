import type { Tf } from '@cip/contracts';
import { isTimeframe } from './analysis.js';
import { isSetupSort, type SetupSort } from './setups.js';

/**
 * Search parameters of the Phase 7 pages. They live here, not in the pages, so the router can
 * validate them without importing the pages (which load lazily, with the chart library).
 */

/** The structure timeframes (rulebook §1): where the engine detects swings, levels and zones. */
export const MAP_TIMEFRAMES: readonly Tf[] = ['5m', '15m', '1h', '4h', '1d'];

/** `/liquidity?instrument&tf` */
export interface LiquiditySearch {
  instrument?: string;
  tf?: Tf;
}

export function readLiquiditySearch(search: unknown): LiquiditySearch {
  const s = (search ?? {}) as { instrument?: unknown; tf?: unknown };
  return {
    ...(typeof s.instrument === 'string' ? { instrument: s.instrument } : {}),
    ...(isTimeframe(s.tf) && MAP_TIMEFRAMES.includes(s.tf) ? { tf: s.tf } : {}),
  };
}

/** `/setups?instrument&pattern&direction&state&minScore&sort`: the scanner's filters, linkable. */
export interface ScannerSearch {
  instrument?: string;
  /** Comma-separated pattern names. */
  pattern?: string;
  direction?: 'bullish' | 'bearish';
  /** Comma-separated states, or `all`; absent: every state but resolved. */
  state?: string;
  minScore?: number;
  sort?: SetupSort;
}

export function readScannerSearch(search: unknown): ScannerSearch {
  const s = (search ?? {}) as Record<string, unknown>;
  const score = Number(s['minScore']);
  return {
    ...(typeof s['instrument'] === 'string' && s['instrument'] ? { instrument: s['instrument'] } : {}),
    ...(typeof s['pattern'] === 'string' && s['pattern'] ? { pattern: s['pattern'] } : {}),
    ...(s['direction'] === 'bullish' || s['direction'] === 'bearish' ? { direction: s['direction'] } : {}),
    ...(typeof s['state'] === 'string' && s['state'] ? { state: s['state'] } : {}),
    ...(Number.isFinite(score) && score > 0 && score <= 100 ? { minScore: score } : {}),
    ...(isSetupSort(s['sort']) ? { sort: s['sort'] } : {}),
  };
}

/** `/practice?instrument&setup&quantity&limit&stop&target`: a ticket that "Practise this setup" filled in. */
export interface PracticeSearch {
  instrument?: string;
  setup?: string;
  quantity?: string;
  limit?: string;
  stop?: string;
  target?: string;
}

const ID = /^[0-9a-f-]{36}$/;
const DECIMAL_TEXT = /^\d+(\.\d+)?$/;

export function readPracticeSearch(search: unknown): PracticeSearch {
  const s = (search ?? {}) as Record<string, unknown>;
  const out: PracticeSearch = {};
  for (const key of ['instrument', 'setup'] as const) {
    const v = s[key];
    if (typeof v === 'string' && ID.test(v)) out[key] = v;
  }
  for (const key of ['quantity', 'limit', 'stop', 'target'] as const) {
    // The router reads "0.5" typed into the address bar as a number; a link passes a string.
    const v = s[key];
    const text = typeof v === 'number' && Number.isFinite(v) ? String(v) : v;
    if (typeof text === 'string' && DECIMAL_TEXT.test(text)) out[key] = text;
  }
  return out;
}

/** `/ai?analysis&instrument&setup&reason`: an analysis to open, or a request to prefill (a setup review). */
export interface AiSearch {
  analysis?: string;
  instrument?: string;
  setup?: string;
  reason?: 'market_summary' | 'setup_review' | 'refresh';
}

export function readAiSearch(search: unknown): AiSearch {
  const s = (search ?? {}) as Record<string, unknown>;
  const text = (k: string) => (typeof s[k] === 'string' && s[k] ? { [k]: s[k] } : {});
  const reason = s['reason'];
  return {
    ...text('analysis'),
    ...text('instrument'),
    ...text('setup'),
    ...(reason === 'market_summary' || reason === 'setup_review' || reason === 'refresh' ? { reason } : {}),
  };
}
