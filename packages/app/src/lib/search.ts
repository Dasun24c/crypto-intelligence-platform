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
