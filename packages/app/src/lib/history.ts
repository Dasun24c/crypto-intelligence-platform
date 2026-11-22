import {
  CHECKLIST_ITEM_NAMES,
  type ChecklistItem,
  FEW_OBSERVATIONS,
  type FoundFilter,
  type OutcomeResult,
  PATTERN_NAMES,
  type Pattern,
  REPLAY_SETTING_PATHS,
  type ReplaySettings,
  type ReplaySettingValues,
  type RunComparison,
  type SessionBucket,
  type SetupSide,
  type SetupStatsRow,
  type StatsDimension,
  type StatsKey,
} from '@cip/contracts';
import { CHECKLIST_LABELS, PATTERN_SHORT, PATTERN_TITLE, RESOLUTION_TITLE, STATE_TITLE } from './setups.js';

// ── Outcome statistics (Phase 12, ADR 026) ──────────────────────────────────────────────────────

/** What the statistics can be grouped by, as the page names them. */
export const DIMENSION_LABELS: Record<StatsDimension, string> = {
  pattern: 'Pattern',
  variant: 'Variant',
  direction: 'Direction',
  tfPair: 'Timeframes',
  instrument: 'Instrument',
  session: 'Session',
  rules: 'Rules version',
};

export const SESSION_LABELS: Record<SessionBucket, string> = {
  asia: 'Asia',
  london: 'London',
  new_york: 'New York',
  outside: 'Outside the sessions',
};

export const FOUND_LABELS: Record<FoundFilter, string> = {
  all: 'On stored history and live',
  live: 'Live only',
  warmup: 'On stored history only',
};

export const OUTCOME_LABELS: Record<OutcomeResult, string> = {
  target_reached: 'Target reached',
  invalidated: 'Invalidated',
  expired_no_entry: 'Expired before entry',
  expired_open: 'Expired open',
  ambiguous: 'Ambiguous',
};

/** The periods the statistics can cover, ending now. */
export const STATS_PERIODS = [
  { id: '24h', label: 'Last 24 hours', ms: 86_400_000 },
  { id: '7d', label: 'Last 7 days', ms: 7 * 86_400_000 },
  { id: '30d', label: 'Last 30 days', ms: 30 * 86_400_000 },
  { id: '90d', label: 'Last 90 days', ms: 90 * 86_400_000 },
  { id: 'all', label: 'Everything stored', ms: null },
] as const;
export type StatsPeriod = (typeof STATS_PERIODS)[number]['id'];

/** The text of one dimension of a group's key. */
export function keyText(key: StatsKey, d: StatsDimension, instrumentName: (id: string) => string): string {
  switch (d) {
    case 'pattern':
      return key.pattern ? `${PATTERN_SHORT[key.pattern]} · ${PATTERN_TITLE[key.pattern]}` : '—';
    case 'variant':
      return key.variant ? `Variant ${key.variant}` : '—';
    case 'direction':
      return key.direction === 'bullish' ? 'Bullish' : key.direction === 'bearish' ? 'Bearish' : '—';
    case 'tfPair':
      return key.tfPair ? `${key.tfPair.context} / ${key.tfPair.setup}` : '—';
    case 'instrument':
      return key.instrumentId ? instrumentName(key.instrumentId) : '—';
    case 'session':
      return key.session ? SESSION_LABELS[key.session] : '—';
    case 'rules':
      return key.rules
        ? `${key.rules.rulesetVersion} · ${key.rules.profile.name} v${key.rules.profile.version}${
            key.rules.changedSettings ? ` · changed settings (${key.rules.paramsHash.slice(0, 8)})` : ''
          }`
        : '—';
  }
}

/** A stable identifier of a group (the e2e test matches rows by it). */
export function rowId(key: StatsKey, groupBy: readonly StatsDimension[]): string {
  return groupBy
    .map((d) => {
      switch (d) {
        case 'tfPair':
          return key.tfPair ? `${key.tfPair.context}/${key.tfPair.setup}` : '';
        case 'instrument':
          return key.instrumentId ?? '';
        case 'rules':
          return key.rules
            ? `${key.rules.rulesetVersion}|${key.rules.profile.name}|${key.rules.profile.version}|${key.rules.paramsHash}`
            : '';
        case 'variant':
          return key.variant ?? '';
        default:
          return key[d] ?? '';
      }
    })
    .join('·');
}

/** "3 (25 %)": a count and its share of the resolved setups, or the count alone with none resolved. */
export function countAndShare(n: number, resolved: number): string {
  if (resolved === 0) return String(n);
  return `${n} (${Math.round((n / resolved) * 100)} %)`;
}

/** Excursions in R, two decimals. */
export function formatR(r: number | null): string {
  return r === null ? '—' : r.toFixed(2);
}

/** Too few resolved setups for their shares to say much. */
export const fewObservations = (row: SetupStatsRow) => row.resolved < FEW_OBSERVATIONS;

// ── Replays ─────────────────────────────────────────────────────────────────────────────────────

/** How the page names each setting a replay may change, and the other settings a comparison lists. */
const SETTING_LABELS: Record<string, string> = {
  rulesetVersion: 'Rules version',
  profile: 'Profile',
  [REPLAY_SETTING_PATHS.patterns]: 'Patterns',
  [REPLAY_SETTING_PATHS.minRR]: 'Minimum reward-to-risk (item 7)',
  [REPLAY_SETTING_PATHS.mandatory]: 'Mandatory checklist items',
  [REPLAY_SETTING_PATHS.requireDisplacement]: 'MSS needs displacement',
  [REPLAY_SETTING_PATHS.entryExpiryBars]: 'Entry window (setup candles)',
  [REPLAY_SETTING_PATHS.maxHoldBars]: 'Longest hold (setup candles)',
  [`${REPLAY_SETTING_PATHS.newsBlackoutMin}.before`]: 'News blackout before an event (minutes)',
  [`${REPLAY_SETTING_PATHS.newsBlackoutMin}.after`]: 'News blackout after an event (minutes)',
  [REPLAY_SETTING_PATHS.blockConfirmOnLowLiquidity]: 'Low liquidity blocks confirmation',
};

/** A setting's name: its label, or its path in the profile when it has none. */
export const settingLabel = (path: string): string => SETTING_LABELS[path] ?? path;

/** A setting's value as text. */
export function settingValue(path: string, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'None';
    if (path === REPLAY_SETTING_PATHS.patterns)
      return value
        .map((p) => (typeof p === 'string' && p in PATTERN_SHORT ? PATTERN_SHORT[p as Pattern] : String(p)))
        .join(', ');
    if (path === REPLAY_SETTING_PATHS.mandatory)
      return value
        .map((i) =>
          typeof i === 'string' && i in CHECKLIST_LABELS ? CHECKLIST_LABELS[i as ChecklistItem] : String(i),
        )
        .join('; ');
    return value.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ');
  }
  return typeof value === 'number' || typeof value === 'string' ? String(value) : JSON.stringify(value);
}

const sameList = <T>(a: readonly T[], b: readonly T[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/**
 * The settings the form changed from the instrument's (what `POST /replays` sends), or null when it
 * changed none: a replay then runs on the live run's settings and must match it.
 */
export function changedSettings(base: ReplaySettingValues, form: ReplaySettingValues): ReplaySettings | null {
  const out: ReplaySettings = {};
  if (!sameList(base.patterns, form.patterns))
    out.patterns = PATTERN_NAMES.filter((p) => form.patterns.includes(p));
  if (base.minRR !== form.minRR) out.minRR = form.minRR;
  if (!sameList(base.mandatory, form.mandatory))
    out.mandatory = CHECKLIST_ITEM_NAMES.filter((i) => form.mandatory.includes(i));
  if (base.requireDisplacement !== form.requireDisplacement)
    out.requireDisplacement = form.requireDisplacement;
  if (base.entryExpiryBars !== form.entryExpiryBars) out.entryExpiryBars = form.entryExpiryBars;
  if (base.maxHoldBars !== form.maxHoldBars) out.maxHoldBars = form.maxHoldBars;
  if (
    base.newsBlackoutMin.before !== form.newsBlackoutMin.before ||
    base.newsBlackoutMin.after !== form.newsBlackoutMin.after
  )
    out.newsBlackoutMin = { ...form.newsBlackoutMin };
  if (base.blockConfirmOnLowLiquidity !== form.blockConfirmOnLowLiquidity)
    out.blockConfirmOnLowLiquidity = form.blockConfirmOnLowLiquidity;
  return Object.keys(out).length ? out : null;
}

/** "Minimum reward-to-risk (item 7): 3; Patterns: P1, P4", or that it used the live settings. */
export function settingsSummary(settings: ReplaySettings | null): string {
  if (!settings) return 'Live settings';
  return (Object.keys(REPLAY_SETTING_PATHS) as (keyof ReplaySettings)[])
    .filter((k) => settings[k] !== undefined)
    .map((k) => {
      if (k === 'newsBlackoutMin') {
        const b = settings.newsBlackoutMin!;
        return `News blackout: ${b.before} min before, ${b.after} min after`;
      }
      const path = REPLAY_SETTING_PATHS[k];
      return `${settingLabel(path)}: ${settingValue(path, settings[k])}`;
    })
    .join('; ');
}

/** A setup as one run left it: its state, how it ended, and its score. */
export function sideText(s: SetupSide | null): string {
  if (!s) return 'Not found';
  const ended = s.resolution ? ` (${RESOLUTION_TITLE[s.resolution] ?? s.resolution})` : '';
  return `${STATE_TITLE[s.state]}${ended}, score ${s.score}`;
}

export interface Verdict {
  tone: 'ok' | 'warn' | 'crit' | 'info';
  title: string;
  detail: string;
}

/** What a comparison says, in words (criterion 12.3). */
export function comparisonVerdict(c: RunComparison): Verdict {
  const against = c.base.mode === 'live' ? 'the live run' : 'the other replay';
  if (c.incomplete)
    return {
      tone: 'info',
      title: 'Not comparable yet',
      detail: `${against === 'the live run' ? 'The live run' : 'The other run'} has not analysed the whole period yet. Compare again in a few minutes.`,
    };
  const differences = c.onlyInBase + c.onlyInOther + c.changed;
  const differ = `${differences} detection${differences === 1 ? ' differs' : 's differ'}`;
  // Changed settings come first: a replay with other settings never "matches", even when they
  // happen to change nothing in the period.
  if (c.settings.length > 0)
    return {
      tone: 'info',
      title: `Settings differ from ${against}`,
      detail:
        differences === 0 && c.equal
          ? 'The changed settings made no difference to the detections in this period: the digests are equal.'
          : differences === 0
            ? 'Every detection matches, but the runs number their events differently.'
            : `${differ}, from the settings listed below.`,
    };
  if (c.equal)
    return {
      tone: 'ok',
      title: `Matches ${against}`,
      detail: `Both runs decided the same ${c.other.events} events over this period: their digests are equal.`,
    };
  if (!c.sameOrigins && differences === 0)
    return {
      tone: 'info',
      title: 'Same detections, numbered differently',
      detail:
        'The runs started at different candles, so their event numbers and digests differ, but every detection matches.',
    };
  return {
    tone: 'crit',
    title: `Differs from ${against} with the same settings`,
    detail: `${differ} although nothing was changed. Replays should reproduce the live run exactly: please report this.`,
  };
}

/** Saves a file the API sent (a CSV export) through the browser's download. */
export function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** A UTC instant as the value of a `datetime-local` input ("2026-11-22T09:30"). */
export function toUtcInput(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16);
}

/** A `datetime-local` value read as UTC; null when it is not a full date and time. */
export function fromUtcInput(value: string): number | null {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value)) return null;
  const ms = Date.parse(`${value}:00Z`);
  return Number.isNaN(ms) ? null : ms;
}
