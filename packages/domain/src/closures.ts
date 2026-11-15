/**
 * The gold-market closure calendar (architecture §5.5): closed from Friday 17:00 to Sunday 18:00 and
 * every Monday–Thursday from 17:00 to 18:00, New York time. Daylight saving moves these instants in
 * UTC, so they are computed from local New York dates.
 */
export interface WeeklyClosureRule {
  timeZone: string;
  /** Weekend closure: from `closeDay` at `closeTime` to `openDay` at `openTime` (0 = Sunday … 6 = Saturday). */
  weekend: { closeDay: number; closeTime: string; openDay: number; openTime: string };
  /** Daily maintenance break on the listed weekdays. */
  dailyBreak: { days: number[]; start: string; end: string };
}

export const GOLD_CLOSURE_RULE: WeeklyClosureRule = {
  timeZone: 'America/New_York',
  weekend: { closeDay: 5, closeTime: '17:00', openDay: 0, openTime: '18:00' },
  dailyBreak: { days: [1, 2, 3, 4], start: '17:00', end: '18:00' },
};

export interface Closure {
  startsAt: number;
  endsAt: number;
  reason: 'weekend' | 'daily_break' | 'holiday';
}

const DAY_MS = 86_400_000;

/** Offset of `timeZone` from UTC at instant `utcMs`, in ms (New York in summer: −4 h). */
export function timeZoneOffset(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** The UTC instant of a wall-clock time in `timeZone` (for times that exist; closures avoid the 2 a.m. gap). */
export function zonedTimeToUtc(y: number, m: number, d: number, hhmm: string, timeZone: string): number {
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - timeZoneOffset(guess, timeZone);
  return guess - timeZoneOffset(first, timeZone);
}

/** Closures that overlap [fromMs, toMs), sorted by start; the weekend closure absorbs Friday's break. */
export function generateClosures(rule: WeeklyClosureRule, fromMs: number, toMs: number): Closure[] {
  const out: Closure[] = [];
  // Walk local calendar dates from a week before `from` (to catch a weekend already in progress).
  const startLocal = new Date(fromMs + timeZoneOffset(fromMs, rule.timeZone) - 7 * DAY_MS);
  for (
    let day = Date.UTC(startLocal.getUTCFullYear(), startLocal.getUTCMonth(), startLocal.getUTCDate());
    ;
    day += DAY_MS
  ) {
    const date = new Date(day);
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    const weekday = date.getUTCDay();
    const dayStart = zonedTimeToUtc(y, m, d, '00:00', rule.timeZone);
    if (dayStart >= toMs) break;

    if (weekday === rule.weekend.closeDay) {
      const daysToOpen = (rule.weekend.openDay - rule.weekend.closeDay + 7) % 7 || 7;
      const open = new Date(day + daysToOpen * DAY_MS);
      out.push({
        startsAt: zonedTimeToUtc(y, m, d, rule.weekend.closeTime, rule.timeZone),
        endsAt: zonedTimeToUtc(
          open.getUTCFullYear(),
          open.getUTCMonth() + 1,
          open.getUTCDate(),
          rule.weekend.openTime,
          rule.timeZone,
        ),
        reason: 'weekend',
      });
    }
    if (rule.dailyBreak.days.includes(weekday)) {
      out.push({
        startsAt: zonedTimeToUtc(y, m, d, rule.dailyBreak.start, rule.timeZone),
        endsAt: zonedTimeToUtc(y, m, d, rule.dailyBreak.end, rule.timeZone),
        reason: 'daily_break',
      });
    }
  }
  return out.filter((c) => c.endsAt > fromMs && c.startsAt < toMs).sort((a, b) => a.startsAt - b.startsAt);
}

/** True when [start, end) overlaps any closure (rulebook §3.6). */
export function overlapsClosure(start: number, end: number, closures: readonly Closure[]): boolean {
  return closures.some((c) => c.startsAt < end && c.endsAt > start);
}
