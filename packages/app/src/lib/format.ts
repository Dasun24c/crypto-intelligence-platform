/** The zone if the runtime knows it, otherwise UTC: a bad preference must not break a page. */
export function safeTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

/** Formats an epoch-ms instant in the user's display time zone (storage and APIs stay in UTC). */
export function formatInstant(ms: number, timeZone = 'UTC'): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: safeTimeZone(timeZone),
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).format(ms);
}

/** "14:05:09": a time of day for dense tables (the full instant goes in a tooltip). */
export function formatTime(ms: number, timeZone = 'UTC'): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: safeTimeZone(timeZone),
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(ms);
}

/** "4 s", "3 min", "2 h": how old a piece of data is. */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

/** "1 h 05 min", "35 min", "2 d 4 h": a span until or since an event, to the minute. */
export function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  if (totalMin < 1) return 'less than a minute';
  const d = Math.floor(totalMin / 1_440);
  const h = Math.floor((totalMin % 1_440) / 60);
  const m = totalMin % 60;
  if (d > 0) return h > 0 ? `${d} d ${h} h` : `${d} d`;
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`;
  return `${m} min`;
}
