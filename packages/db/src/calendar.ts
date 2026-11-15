import type { Kysely } from 'kysely';
import type { Database } from './types.js';

const MINUTE_MS = 60_000;

/**
 * When a calendar change recorded at `recordedAt` (epoch ms) starts to count for the engine
 * (rulebook I38): at the second whole minute after it. The live analyzer reloads the calendar at
 * least every 30 s, so every live decision from then on sees the change, and so does any replay of
 * the same period: both read the same versions, and their digests stay equal.
 */
export function calendarKnownFrom(recordedAt: number): number {
  return Math.ceil(recordedAt / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
}

/** One version of an event, as the engine's `EconomicEventRef` takes it. */
export interface CalendarVersion {
  id: string;
  scheduledAt: number;
  currency: string;
  impact: 'low' | 'medium' | 'high';
  knownFrom: number;
  knownUntil: number | null;
}

/** The economic calendar for the engine (rulebook I38). */
export interface EngineCalendar {
  /** Null until the first complete FRED sync: checklist item 8 then fails as `calendar_unavailable`. */
  availableFrom: number | null;
  /** Every version of every event that was ever scheduled in the window, cancelled ones excluded. */
  events: CalendarVersion[];
}

/**
 * The calendar's versions for events scheduled, in any of their versions, within [from, to]. A
 * version counts from its revision's `calendarKnownFrom` until the next revision's; a cancelled or
 * superseded revision only ends the one before it.
 */
export async function loadEngineCalendar(
  db: Kysely<Database>,
  from: number,
  to: number,
): Promise<EngineCalendar> {
  const [rows, first] = await Promise.all([
    db
      .selectFrom('market.economic_event_revisions as r')
      .select([
        'r.event_id',
        'r.revision',
        'r.recorded_at',
        'r.scheduled_at',
        'r.currency',
        'r.impact',
        'r.status',
      ])
      .where('r.event_id', 'in', (eb) =>
        eb
          .selectFrom('market.economic_event_revisions as w')
          .select('w.event_id')
          .where('w.scheduled_at', '>=', new Date(from))
          .where('w.scheduled_at', '<=', new Date(to)),
      )
      .orderBy('r.event_id')
      .orderBy('r.revision')
      .execute(),
    db
      .selectFrom('market.calendar_syncs')
      .select((eb) => eb.fn.min('finished_at').as('at'))
      .where('source', '=', 'fred')
      .where('status', '=', 'ok')
      .executeTakeFirst(),
  ]);
  const events: CalendarVersion[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.status !== 'scheduled') continue;
    const next = rows[i + 1];
    const knownFrom = calendarKnownFrom(r.recorded_at.getTime());
    const knownUntil =
      next && next.event_id === r.event_id ? calendarKnownFrom(next.recorded_at.getTime()) : null;
    // A version replaced within the same minute never counted for any decision.
    if (knownUntil !== null && knownUntil <= knownFrom) continue;
    events.push({
      id: r.event_id,
      scheduledAt: r.scheduled_at.getTime(),
      currency: r.currency,
      impact: r.impact,
      knownFrom,
      knownUntil,
    });
  }
  const at = first?.at ? new Date(first.at).getTime() : null;
  return { availableFrom: at === null ? null : calendarKnownFrom(at), events };
}
