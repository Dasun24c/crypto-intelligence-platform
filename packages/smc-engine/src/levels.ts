import { type Closure, TF_MS, TIMEFRAMES, type Timeframe } from '@cip/domain';
import type { SessionName } from './params.js';
import type { EngineFlag, LevelStatus, LevelType, Location, Side } from './types.js';

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

/** A liquidity level the engine tracks (rulebook §3.1). Prices are in units. */
export interface Level {
  key: string;
  type: LevelType;
  side: Side;
  /** Origin timeframe. */
  tf: Timeframe;
  price: number;
  touches: number;
  sessionName: SessionName | null;
  sourceRefs: string[];
  location: Location;
  knownAt: number;
  status: LevelStatus;
  sweepCount: number;
  flags: EngineFlag[];
  /** When it expires; null for range levels, which end with their range. */
  expiresAt: number | null;
  /**
   * The timeframe whose sweeps and breaks change its status: the longest sweep timeframe no longer
   * than its origin. Shorter sweep timeframes record their own sweeps of it without using it up for
   * the others (see the README, "Sweeps on several timeframes").
   */
  home: Timeframe | null;
  /** Sweep timeframes on which it was swept or broken, and is no longer evaluated. */
  consumed: Timeframe[];
  /** Range levels: the key of their range, while it is active. */
  range: string | null;
  /** Equal highs/lows: slot index of the latest touching swing candle on the origin timeframe. */
  lastTouch: number | null;
}

export const levelKey = (tf: Timeframe, type: LevelType, side: Side, knownAt: number) =>
  `lv:${tf}:${type}:${side === 'buy_side' ? 'b' : 's'}:${knownAt}`;

/** The longest sweep timeframe whose candles are no longer than the origin's, or null. */
export function homeTimeframe(origin: Timeframe, sweepTfs: ReadonlySet<Timeframe>): Timeframe | null {
  let home: Timeframe | null = null;
  for (const tf of TIMEFRAMES) if (sweepTfs.has(tf) && TF_MS[tf] <= TF_MS[origin]) home = tf;
  return home;
}

/**
 * Rulebook §4.5 for a price level: with an active range on its timeframe, `internal` strictly
 * inside it and `external` at or beyond its high or low; `none` without a range.
 */
export function locate(price: number, range: { high: number; low: number } | null): Location {
  if (!range) return 'none';
  return price > range.low && price < range.high ? 'internal' : 'external';
}

/** Monday 00:00 UTC of the week containing `t`. 1970-01-01 was a Thursday. */
export function weekStart(t: number): number {
  const day = Math.floor(t / DAY_MS);
  return (day - ((day + 3) % 7)) * DAY_MS;
}

export function monthStart(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export function addMonths(t: number, months: number): number {
  const d = new Date(t);
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth() + months,
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
  );
}

/**
 * Gold-market closures that make weekend levels (rulebook §3.3): weekend and holiday closures,
 * merged when they touch or overlap. Daily one-hour breaks are not weekends.
 */
export function weekendIntervals(closures: readonly Closure[]): { start: number; end: number }[] {
  const list = closures
    .filter((c) => c.reason !== 'daily_break')
    .map((c) => ({ start: c.startsAt, end: c.endsAt }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: { start: number; end: number }[] = [];
  for (const c of list) {
    const last = out.at(-1);
    if (last && c.start <= last.end) last.end = Math.max(last.end, c.end);
    else out.push({ ...c });
  }
  return out;
}
