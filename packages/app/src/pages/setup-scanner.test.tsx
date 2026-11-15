import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { channels } from '@cip/contracts';
import { BTC_BINANCE, PAXG_BINANCE } from '../test/fixtures.js';
import { type ApiRequest, mockApi, renderApp, signedIn } from '../test/harness.js';
import { economicEvent, setupDetail, setupSummary } from '../test/smc-fixtures.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ONE = setupSummary(1, {
  score: 60,
  levels: { entry: '98.2', invalidation: '102.48', target1: '96', target2: null, rr: 0.514 },
});
const TWO = setupSummary(2, {
  instrumentId: PAXG_BINANCE.id,
  pattern: 'eq_near_poi',
  direction: 'bullish',
  state: 'triggered',
  displayLabel: 'Watching',
  score: 85,
  levels: { entry: null, invalidation: null, target1: null, target2: null, rr: null },
});
const THREE = setupSummary(3, {
  score: 72.5,
  levels: { entry: '100', invalidation: '99', target1: '103', target2: null, rr: 3 },
});

function api() {
  return mockApi({
    'GET /api/v1/instruments': [BTC_BINANCE, PAXG_BINANCE],
    'GET /api/v1/setups': (r: ApiRequest) => {
      const pattern = r.url.searchParams.get('pattern');
      const items = [THREE, TWO, ONE].filter((s) => !pattern || pattern.split(',').includes(s.pattern));
      return { items, nextCursor: null };
    },
    [`GET /api/v1/setups/${ONE.id}`]: setupDetail(1),
  });
}

const rowIds = () =>
  [...document.querySelectorAll<HTMLElement>('tr[data-setup-id]')].map((r) => r.dataset['setupId']);

describe('Setup Scanner', () => {
  it('lists the open setups with state, score, levels, R:R and the disclaimer', async () => {
    const { find } = api();
    const { session, user } = await signedIn();
    renderApp('/setups', session, user);
    expect(await screen.findByRole('heading', { name: 'Setup Scanner', level: 1 })).toBeTruthy();
    await waitFor(() => expect(rowIds()).toEqual([THREE.id, TWO.id, ONE.id]));
    expect(screen.getAllByText(/Educational analysis — not financial advice/).length).toBeGreaterThan(0);
    const row = document.querySelector<HTMLElement>(`tr[data-setup-id="${ONE.id}"]`)!;
    expect(within(row).getByText('Confirmed')).toBeTruthy();
    expect(row.querySelector('[data-level="entry"]')!.textContent).toBe('98.2');
    expect(row.querySelector('[data-level="invalidation"]')!.textContent).toBe('102.48');
    expect(row.querySelector('[data-level="target1"]')!.textContent).toBe('96');
    expect(row.querySelector('[data-level="rr"]')!.textContent).toBe('1 : 0.514');
    // By default every state but resolved.
    const first = find('GET', '/api/v1/setups')[0]!;
    expect(first.url.searchParams.get('state')).toBe('forming,triggered,confirmed,entry_active');
    expect(first.url.searchParams.get('limit')).toBe('100');
  });

  it('filters through the API: instrument, pattern, direction, state and minimum score', async () => {
    const { find } = api();
    const { session, user } = await signedIn();
    renderApp('/setups', session, user);
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    const u = userEvent.setup();
    await u.selectOptions(screen.getByLabelText('Instrument'), PAXG_BINANCE.id);
    await u.click(screen.getByLabelText('P2'));
    await u.selectOptions(screen.getByLabelText('Direction'), 'bullish');
    await u.click(screen.getByLabelText('Resolved'));
    const score = screen.getByLabelText('Minimum score');
    await u.clear(score);
    await u.type(score, '50');
    await waitFor(() => {
      const q = find('GET', '/api/v1/setups').at(-1)!.url.searchParams;
      expect(Object.fromEntries(q)).toMatchObject({
        instrumentId: PAXG_BINANCE.id,
        pattern: 'eq_near_poi',
        direction: 'bullish',
        state: 'forming,triggered,confirmed,entry_active,resolved',
        minScore: '50',
      });
    });
    await waitFor(() => expect(rowIds()).toEqual([TWO.id]));
  });

  it('sorts the loaded rows by score, R:R or instrument', async () => {
    api();
    const { session, user } = await signedIn();
    renderApp('/setups', session, user);
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    const u = userEvent.setup();
    await u.selectOptions(screen.getByLabelText('Sort by'), 'score');
    await waitFor(() => expect(rowIds()).toEqual([TWO.id, THREE.id, ONE.id]));
    await u.selectOptions(screen.getByLabelText('Sort by'), 'rr');
    await waitFor(() => expect(rowIds()).toEqual([THREE.id, ONE.id, TWO.id]));
    await u.selectOptions(screen.getByLabelText('Sort by'), 'instrument');
    await waitFor(() => expect(rowIds()).toEqual([THREE.id, ONE.id, TWO.id]));
  });

  it("shows a setup's checklist when its row is opened, and reloads on transitions", async () => {
    const { find } = api();
    const { session, user, server } = await signedIn();
    renderApp('/setups', session, user);
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    const row = document.querySelector<HTMLElement>(`tr[data-setup-id="${ONE.id}"]`)!;
    await userEvent
      .setup()
      .click(within(row).getByRole('button', { name: /Show the checklist of P4 on BTC/ }));
    const panel = await screen.findByText('Clear liquidity sweep');
    const list = panel.closest('[data-checklist]')!;
    expect(list.querySelectorAll('[data-item]')).toHaveLength(8);
    expect(list.querySelector('[data-item="news_clear"]')!.textContent).toMatch(/In the blackout window/);
    expect(list.querySelector('[data-item="poi_present"]')!.getAttribute('data-credit')).toBe('0.5');
    const before = find('GET', '/api/v1/setups').length;
    server.push(channels.setups(), 'setup.transition', { ...ONE, transition: setupDetail(1).transitions[1] });
    await waitFor(() => expect(find('GET', '/api/v1/setups').length).toBeGreaterThan(before));
    expect(economicEvent(0).id).toBeTruthy();
  });
});
