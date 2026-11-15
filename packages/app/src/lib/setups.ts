import type { ChecklistItem, ChecklistResult, Pattern, SetupState, SetupSummary } from '@cip/contracts';

/** Rulebook §6: the four patterns. */
export const PATTERN_SHORT: Record<Pattern, string> = {
  double_liquidity_trap: 'P1',
  eq_near_poi: 'P2',
  htf_order_block: 'P3',
  sweep_outside_fill_inside: 'P4',
};

export const PATTERN_TITLE: Record<Pattern, string> = {
  double_liquidity_trap: 'Double liquidity trap',
  eq_near_poi: 'Equal highs or lows near a POI',
  htf_order_block: 'Higher-timeframe order block',
  sweep_outside_fill_inside: 'Sweep outside, fill inside',
};

export const PATTERNS: readonly Pattern[] = [
  'double_liquidity_trap',
  'eq_near_poi',
  'htf_order_block',
  'sweep_outside_fill_inside',
];

/** REQUIREMENTS §3.6, in the checklist's order. */
export const CHECKLIST_LABELS: Record<ChecklistItem, string> = {
  htf_bias: 'Higher-timeframe trend aligned',
  liquidity_marked: 'Liquidity marked (EQH, EQL, key levels)',
  poi_present: 'Relevant point of interest present',
  sweep: 'Clear liquidity sweep',
  mss: 'MSS confirmed on the lower timeframe',
  levels_defined: 'Entry, invalidation and target defined',
  risk_reward: 'Risk-to-reward at least the minimum',
  news_clear: 'No high-impact event in the blackout window',
};

export const STATE_TITLE: Record<SetupState, string> = {
  forming: 'Forming',
  triggered: 'Triggered',
  confirmed: 'Confirmed',
  entry_active: 'Entry reached',
  resolved: 'Resolved',
};

/** Every state but `resolved`: the scanner's default view. */
export const OPEN_STATES: readonly SetupState[] = ['forming', 'triggered', 'confirmed', 'entry_active'];

export const RESOLUTION_TITLE: Record<string, string> = {
  target_reached: 'Target reached',
  invalidated: 'Invalidated',
  expired_no_entry: 'Expired before entry',
  expired_open: 'Expired open',
  ambiguous: 'Ambiguous',
  expired: 'Expired before confirming',
};

/** How the Setup Scanner orders its rows. */
export const SETUP_SORTS = {
  updated: 'Latest change',
  score: 'Score, highest first',
  rr: 'R:R, highest first',
  instrument: 'Instrument',
} as const;
export type SetupSort = keyof typeof SETUP_SORTS;

export function isSetupSort(value: unknown): value is SetupSort {
  return typeof value === 'string' && value in SETUP_SORTS;
}

/**
 * Orders setups for the scanner. The API returns the newest change first; the other orders keep that
 * as the tie-break, so equal scores stay newest first. Setups without an R:R sort last by R:R.
 */
export function sortSetups(
  setups: readonly SetupSummary[],
  sort: SetupSort,
  instrumentName: (id: string) => string = (id) => id,
): SetupSummary[] {
  const byUpdate = (a: SetupSummary, b: SetupSummary) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1);
  const list = [...setups];
  switch (sort) {
    case 'updated':
      return list.sort(byUpdate);
    case 'score':
      return list.sort((a, b) => b.score - a.score || byUpdate(a, b));
    case 'rr':
      return list.sort((a, b) => {
        const ra = a.levels.rr;
        const rb = b.levels.rr;
        if (ra === null || rb === null) return ra === rb ? byUpdate(a, b) : ra === null ? 1 : -1;
        return rb - ra || byUpdate(a, b);
      });
    case 'instrument':
      return list.sort(
        (a, b) =>
          instrumentName(a.instrumentId).localeCompare(instrumentName(b.instrumentId)) || byUpdate(a, b),
      );
  }
}

/** A credit as the checklist shows it. */
export function creditText(credit: ChecklistResult['credit']): string {
  return credit === 1 ? 'Pass' : credit === 0.5 ? 'Half' : 'Fail';
}

/** A short reading of an item's evidence; `events` names the calendar entries that blocked item 8. */
export function evidenceText(
  r: ChecklistResult,
  eventTitle: (id: string) => string | null = () => null,
): string {
  const e = r.evidence;
  if (r.item === 'news_clear') {
    if (e['reason'] === 'calendar_unavailable') return 'Economic calendar unavailable';
    const events = Array.isArray(e['events'])
      ? (e['events'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    if (events.length)
      return `In the blackout window: ${events.map((id) => eventTitle(id) ?? id).join(', ')}`;
    return r.credit === 1 ? 'No high-impact event in the window' : '';
  }
  if (r.item === 'risk_reward' && 'rr' in e) return `R:R ${shown(e['rr'])} (minimum ${shown(e['minRR'])})`;
  if (r.item === 'levels_defined' && Array.isArray(e['missing']))
    return `Missing: ${(e['missing'] as string[]).join(', ')}`;
  if (r.item === 'htf_bias' && typeof e['trend'] === 'string')
    return `Context trend: ${e['trend']}${e['ranging'] ? ', ranging' : ''}`;
  return '';
}

/** A number or string from evidence, as text. */
function shown(v: unknown): string {
  return typeof v === 'number' || typeof v === 'string' ? String(v) : 'n/a';
}

export function formatRr(rr: number | null): string {
  return rr === null ? '—' : `1 : ${rr}`;
}
