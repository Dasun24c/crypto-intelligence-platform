import { describe, expect, it } from 'vitest';
import { calendarAt } from './calendar.js';
import type { EconomicEventRef } from './types.js';

const ev = (id: string, extra: Partial<EconomicEventRef> = {}): EconomicEventRef => ({
  id,
  scheduledAt: 10_000,
  currency: 'USD',
  impact: 'high',
  ...extra,
});

describe('calendarAt (rulebook I38)', () => {
  it('has no calendar when the context has none', () => {
    expect(calendarAt({ closures: [] }, 5)).toBeNull();
    expect(calendarAt({ closures: [], economicEvents: null }, 5)).toBeNull();
  });

  it('counts the calendar as unavailable before it became available', () => {
    const context = { closures: [], economicEvents: [ev('a')], calendarAvailableFrom: 100 };
    expect(calendarAt(context, 99)).toBeNull();
    expect(calendarAt(context, 100)).toEqual([ev('a')]);
  });

  it('keeps a version from knownFrom (inclusive) until knownUntil (exclusive)', () => {
    const first = ev('cpi', { scheduledAt: 1_000, knownUntil: 200 });
    const second = ev('cpi', { scheduledAt: 2_000, knownFrom: 200 });
    const later = ev('fomc', { knownFrom: 300, knownUntil: null });
    const context = { closures: [], economicEvents: [first, second, later] };
    expect(calendarAt(context, 199)).toEqual([first]);
    expect(calendarAt(context, 200)).toEqual([second]);
    expect(calendarAt(context, 300)).toEqual([second, later]);
  });

  it('never counts a version that was replaced as soon as it was recorded', () => {
    const empty = ev('x', { knownFrom: 500, knownUntil: 500 });
    expect(calendarAt({ closures: [], economicEvents: [empty] }, 500)).toEqual([]);
  });
});
