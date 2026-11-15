import type { EconomicEventRef, StepContext } from './types.js';

/**
 * The economic calendar as the platform knew it at `t` (rulebook I38): null when there is no
 * calendar or it was not yet available at `t`, else the event versions known at `t`. A version
 * counts from its `knownFrom` (inclusive) until its `knownUntil` (exclusive).
 */
export function calendarAt(context: StepContext, t: number): readonly EconomicEventRef[] | null {
  const events = context.economicEvents;
  if (events == null) return null;
  if (context.calendarAvailableFrom !== undefined && t < context.calendarAvailableFrom) return null;
  return events.filter(
    (e) => (e.knownFrom === undefined || e.knownFrom <= t) && (e.knownUntil == null || e.knownUntil > t),
  );
}
