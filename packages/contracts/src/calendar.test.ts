import { describe, expect, it } from 'vitest';
import {
  CalendarEventsQuerySchema,
  CalendarStatusSchema,
  CalendarUpdatedSchema,
  CreateEconomicEventRequestSchema,
  EconomicEventSchema,
  UpdateEconomicEventRequestSchema,
} from './calendar.js';
import { CHANNEL_PATTERN, channels, CONFIG_CHANNELS, isDurableChannel } from './market.js';

const ID = '019a7000-0000-7000-8000-000000000001';

describe('economic calendar contracts (Phase 7)', () => {
  it('reads the events query: numbers from the query string, a window that ends after it starts', () => {
    expect(CalendarEventsQuerySchema.parse({ from: '1000', to: '2000', minImpact: 'high' })).toEqual({
      from: 1000,
      to: 2000,
      minImpact: 'high',
    });
    expect(CalendarEventsQuerySchema.parse({})).toEqual({});
    expect(CalendarEventsQuerySchema.parse({ from: '5' })).toEqual({ from: 5 });
    expect(CalendarEventsQuerySchema.safeParse({ from: '2000', to: '1000' }).success).toBe(false);
    expect(CalendarEventsQuerySchema.safeParse({ minImpact: 'extreme' }).success).toBe(false);
    expect(CalendarEventsQuerySchema.safeParse({ extra: '1' }).success).toBe(false);
  });

  it('defaults a manual entry to USD and the US, and refuses bad codes and empty titles', () => {
    const entry = CreateEconomicEventRequestSchema.parse({
      title: ' FOMC statement ',
      category: 'central_bank',
      impact: 'high',
      scheduledAt: 1_796_850_000_000,
      timeConfirmed: true,
    });
    expect(entry).toEqual({
      release: null,
      title: 'FOMC statement',
      category: 'central_bank',
      impact: 'high',
      scheduledAt: 1_796_850_000_000,
      timeConfirmed: true,
      currency: 'USD',
      country: 'US',
    });
    const base = { title: 'x', category: 'other', impact: 'low', scheduledAt: 1, timeConfirmed: false };
    expect(CreateEconomicEventRequestSchema.safeParse({ ...base, currency: 'usd' }).success).toBe(false);
    expect(CreateEconomicEventRequestSchema.safeParse({ ...base, country: 'USA' }).success).toBe(false);
    expect(CreateEconomicEventRequestSchema.safeParse({ ...base, title: '  ' }).success).toBe(false);
  });

  it('needs something to change in an update', () => {
    expect(UpdateEconomicEventRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateEconomicEventRequestSchema.parse({ release: null, impact: 'medium' })).toEqual({
      release: null,
      impact: 'medium',
    });
  });

  it('describes events, the status and the change message', () => {
    expect(
      EconomicEventSchema.parse({
        id: ID,
        source: 'bea',
        sourceRef: 'uid',
        release: 'gdp',
        title: 'GDP (Second Estimate)',
        country: 'US',
        currency: 'USD',
        category: 'growth',
        impact: 'medium',
        scheduledAt: 1,
        timeConfirmed: true,
        actual: null,
        forecast: null,
        previous: null,
        updatedAt: 2,
      }).release,
    ).toBe('gdp');
    const status = CalendarStatusSchema.parse({
      available: false,
      availableFrom: null,
      status: 'down',
      detail: 'FRED: no API key configured',
      sources: [{ source: 'fred', configured: false, lastSync: null, lastSuccessAt: null }],
      blackouts: [
        {
          profile: 'gold',
          version: 4,
          beforeMin: 60,
          afterMin: 60,
          currencies: ['USD'],
          instrumentIds: [ID],
        },
      ],
    });
    expect(status.blackouts[0]?.beforeMin).toBe(60);
    expect(CalendarUpdatedSchema.safeParse({ at: 1, reason: 'sync', changed: 3 }).success).toBe(true);
    expect(CalendarUpdatedSchema.safeParse({ at: 1, reason: 'other', changed: 3 }).success).toBe(false);
  });

  it('has a channel that needs no instrument and is not durable', () => {
    expect(channels.calendar).toBe('calendar');
    expect(CHANNEL_PATTERN.test('calendar')).toBe(true);
    expect(CHANNEL_PATTERN.test('calendar:x')).toBe(false);
    expect(isDurableChannel('calendar')).toBe(false);
    expect(CONFIG_CHANNELS.calendar).toBe('config:calendar');
  });
});
