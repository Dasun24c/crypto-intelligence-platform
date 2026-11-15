import type { QuietHours } from '@cip/contracts';
import { timeZoneOffset } from '@cip/domain';

const DAY_MIN = 24 * 60;
const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

/**
 * Whether `at` falls inside the rule's quiet hours, read in their time zone. A window that crosses
 * midnight (22:00–07:00) belongs to the day it starts on, so `days` lists starting days.
 */
export function inQuietHours(quiet: QuietHours | null, at: number): boolean {
  if (!quiet) return false;
  const local = new Date(at + timeZoneOffset(at, quiet.timeZone));
  const now = local.getUTCHours() * 60 + local.getUTCMinutes();
  const weekday = local.getUTCDay();
  const [start, end] = [minutes(quiet.start), minutes(quiet.end)];
  const startsOn = (day: number) => !quiet.days || quiet.days.includes(day);
  if (start < end) return now >= start && now < end && startsOn(weekday);
  // Crosses midnight: the evening part started today, the morning part yesterday.
  if (now >= start) return startsOn(weekday);
  if (now < end) return startsOn((weekday + 6) % 7);
  return false;
}

/** Minutes of the day in the quiet-hours window (for the rule form's summary). */
export function quietMinutes(quiet: QuietHours): number {
  const [start, end] = [minutes(quiet.start), minutes(quiet.end)];
  return (end - start + DAY_MIN) % DAY_MIN;
}
