import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { channels } from '@cip/contracts';
import { type ApiRequest, mockApi, renderApp, signedIn } from '../test/harness.js';
import { calendarStatus, economicEvent } from '../test/smc-fixtures.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CPI = economicEvent(1); // 10 December 2026 13:30 UTC, high, standard time
const GDP = economicEvent(2, {
  source: 'bea',
  release: 'gdp',
  title: 'GDP (Third Estimate), 3rd Quarter 2026',
  category: 'growth',
  impact: 'medium',
  scheduledAt: Date.UTC(2026, 11, 23, 13, 30),
  timeConfirmed: true,
});
const FOMC = economicEvent(3, {
  source: 'manual',
  release: 'fomc',
  title: 'FOMC statement',
  category: 'central_bank',
  scheduledAt: Date.UTC(2026, 11, 9, 19, 0),
  timeConfirmed: true,
});

function api(status = calendarStatus()) {
  return mockApi({
    'GET /api/v1/calendar/events': (r: ApiRequest) =>
      [FOMC, CPI, GDP].filter((e) => r.url.searchParams.get('minImpact') !== 'high' || e.impact === 'high'),
    'GET /api/v1/calendar/status': status,
    'POST /api/v1/calendar/events': (r: ApiRequest) => ({ ...FOMC, ...(r.body as object) }),
    [`DELETE /api/v1/calendar/events/${FOMC.id}`]: new Response(null, { status: 204 }),
    'POST /api/v1/calendar/sync': { queued: true },
  });
}

const item = (id: string) => document.querySelector<HTMLElement>(`li[data-event-id="${id}"]`)!;

describe('Economic Calendar', () => {
  it("lists the next 60 days by day with times, impact and each profile's blackout window", async () => {
    const { find } = api();
    const { session, user } = await signedIn();
    renderApp('/calendar', session, user);
    expect(await screen.findByRole('heading', { name: 'Economic Calendar', level: 1 })).toBeTruthy();
    await waitFor(() => expect(item(CPI.id)).toBeTruthy());
    expect(screen.getByText(/uses the FRED® API but is not endorsed or certified/)).toBeTruthy();
    expect(screen.getByRole('region', { name: /^Thursday,? 10 December 2026$/ })).toBeTruthy();
    const cpi = item(CPI.id);
    expect(within(cpi).getByText('13:30')).toBeTruthy();
    expect(within(cpi).getByText(/standard release time, not confirmed/)).toBeTruthy();
    // High impact: both profiles' blackouts (crypto 30/30, gold 60/60 minutes).
    expect(cpi.querySelector('[data-blackout="crypto-majors"]')!.textContent).toBe(
      'Crypto blackout 13:00–14:00',
    );
    expect(cpi.querySelector('[data-blackout="gold"]')!.textContent).toBe('Gold (PAXG) blackout 12:30–14:30');
    // Medium impact: no blackout.
    expect(item(GDP.id).querySelector('[data-blackout]')).toBeNull();
    expect(within(item(GDP.id)).queryByText(/not confirmed/)).toBeNull();
    // A viewer sees no admin controls.
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Add a calendar entry' })).toBeNull();
    const q = find('GET', '/api/v1/calendar/events')[0]!.url.searchParams;
    expect(Number(q.get('to')) - Number(q.get('from'))).toBe(61 * 86_400_000);
  });

  it('filters by impact and says when checklist item 8 cannot use the calendar', async () => {
    api(
      calendarStatus({
        available: false,
        status: 'down',
        detail: 'Unavailable: FRED: no API key configured',
      }),
    );
    const { session, user } = await signedIn();
    renderApp('/calendar', session, user);
    expect(await screen.findByText('Checklist item 8 cannot use the calendar yet')).toBeTruthy();
    expect(screen.getByText('Unavailable: FRED: no API key configured')).toBeTruthy();
    await waitFor(() => expect(item(GDP.id)).toBeTruthy());
    await userEvent.setup().selectOptions(screen.getByLabelText('Impact'), 'high');
    await waitFor(() => expect(document.querySelector(`li[data-event-id="${GDP.id}"]`)).toBeNull());
    expect(item(CPI.id)).toBeTruthy();
  });

  it('lets an admin add an FOMC statement at a New York time, remove it, and sync now', async () => {
    const { find } = api();
    const { session, user } = await signedIn('admin');
    renderApp('/calendar', session, user);
    const form = await screen.findByRole('form', { name: 'Add a calendar entry' });
    const u = userEvent.setup();
    await u.type(within(form).getByLabelText('Date'), '2026-12-09');
    await u.click(within(form).getByRole('button', { name: 'Add entry' }));
    await waitFor(() => expect(find('POST', '/api/v1/calendar/events')).toHaveLength(1));
    // 14:00 in New York on 9 December (EST) is 19:00 UTC.
    expect(find('POST', '/api/v1/calendar/events')[0]!.body).toEqual({
      release: 'fomc',
      title: 'FOMC statement',
      category: 'central_bank',
      impact: 'high',
      scheduledAt: Date.UTC(2026, 11, 9, 19, 0),
      timeConfirmed: true,
    });
    await waitFor(() => expect(item(FOMC.id)).toBeTruthy());
    await u.click(within(item(FOMC.id)).getByRole('button', { name: /Remove FOMC statement/ }));
    await waitFor(() => expect(find('DELETE', `/api/v1/calendar/events/${FOMC.id}`)).toHaveLength(1));
    // Synced entries follow their source: no remove button.
    expect(within(item(CPI.id)).queryByRole('button')).toBeNull();
    await u.click(screen.getByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(find('POST', '/api/v1/calendar/sync')).toHaveLength(1));
  });

  it('reloads when the calendar changes', async () => {
    const { find } = api();
    const { session, user, server } = await signedIn();
    renderApp('/calendar', session, user);
    await waitFor(() => expect(item(CPI.id)).toBeTruthy());
    const before = find('GET', '/api/v1/calendar/events').length;
    server.push(channels.calendar, 'calendar.updated', { at: Date.now(), reason: 'sync', changed: 2 });
    await waitFor(() => expect(find('GET', '/api/v1/calendar/events').length).toBeGreaterThan(before));
  });
});
