import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PRACTICE_SETTINGS } from '@cip/contracts';
import { BTC_BINANCE, candle } from '../test/fixtures.js';
import { mockApi, renderApp, signedIn } from '../test/harness.js';
import { H, overlay, setupDetail, T0 } from '../test/smc-fixtures.js';

vi.mock('../charts/use-chart.js', () => ({
  useChart: () => ({ ref: () => undefined, chart: null, annotate: () => undefined }),
  toChartTime: (ms: number) => Math.floor(ms / 1000),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SETUP = setupDetail(1, { setupTf: '1h' });

function api(setup = SETUP) {
  return mockApi({
    'GET /api/v1/instruments': [BTC_BINANCE],
    [`GET /api/v1/setups/${setup.id}`]: setup,
    [`GET /api/v1/market/${BTC_BINANCE.id}/candles`]: Array.from({ length: 5 }, (_, i) =>
      candle(T0 + i * H, '100'),
    ),
    [`GET /api/v1/smc/${BTC_BINANCE.id}/overlay`]: overlay(),
  });
}

const fact = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling!.textContent;

describe('Setup detail', () => {
  it('shows the hypothetical levels, the position size, the checklist and the history, with the disclaimer', async () => {
    const { find } = api();
    const { session, user } = await signedIn();
    renderApp(`/setups/${SETUP.id}`, session, user);
    expect(
      await screen.findByRole('heading', { name: /P4: Sweep outside, fill inside, bearish/ }),
    ).toBeTruthy();
    expect(
      screen.getByText(/All levels are hypothetical\. Educational analysis — not financial advice/),
    ).toBeTruthy();
    expect(fact('Entry')).toBe('98.2');
    expect(fact('Invalidation')).toBe('102.48');
    expect(fact('Target 1')).toBe('96');
    expect(fact('R:R (on target 1)')).toBe('1 : 0.514');

    // 10,000 USDT at 1 %: 100 at risk over 4.28; quantity rounded down to the 0.00001 step.
    expect(fact('Side')).toBe('Short');
    expect(fact('Amount at risk (USDT)')).toBe('100');
    expect(fact('Distance to invalidation')).toBe('4.28 (4.3584 %)');
    expect(fact('Quantity (BTC, rounded down to 0.00001)')).toBe('23.36448');
    expect(fact('Notional (USDT)')).toBe('2294.391936');
    expect(fact('Leverage needed')).toBe('0.2294×');
    expect(fact('R:R and reward at target 1')).toBe('1 : 0.514 (51.401856 USDT)');
    const u = userEvent.setup();
    await u.clear(screen.getByLabelText('Risk per trade (%)'));
    await u.type(screen.getByLabelText('Risk per trade (%)'), '0');
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.queryByText('Leverage needed')).toBeNull();

    const checklist = screen.getByRole('table', { name: "The checklist at the setup's current state" });
    expect(within(checklist).getAllByRole('row')).toHaveLength(9);
    expect(within(checklist).getByText('R:R 0.514 (minimum 2)')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Checklist: score 62.5' })).toBeTruthy();
    expect(screen.getByText('mss confirmed')).toBeTruthy();

    // The chart covers the setup on its own timeframe and run.
    await waitFor(() => expect(find('GET', `/api/v1/smc/${BTC_BINANCE.id}/overlay`)).toHaveLength(1));
    const q = find('GET', `/api/v1/smc/${BTC_BINANCE.id}/overlay`)[0]!.url.searchParams;
    expect(q.get('tf')).toBe('1h');
    expect(q.get('runId')).toBe(SETUP.runId);
    expect(screen.getByRole('link', { name: 'Open the Liquidity Map' }).getAttribute('href')).toContain(
      `instrument=${BTC_BINANCE.id}`,
    );
  });

  it('explains when there is nothing to size, and shows the outcome of a resolved setup', async () => {
    const resolved = setupDetail(2, {
      setupTf: '1h',
      state: 'resolved',
      displayLabel: 'Resolved',
      resolution: 'target_reached',
      levels: { entry: null, invalidation: null, target1: null, target2: null, rr: null },
      outcome: {
        result: 'target_reached',
        entryTouchedAt: T0 + 2 * H,
        resolvedAt: T0 + 3 * H,
        mfeR: 1.25,
        maeR: 0.2,
        barsHeld: 3,
        resolvedWithTf: '1m',
      },
    });
    api(resolved);
    const { session, user } = await signedIn();
    renderApp(`/setups/${resolved.id}`, session, user);
    expect(await screen.findByText(/no entry and invalidation yet/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Outcome: Target reached' })).toBeTruthy();
    expect(fact('MFE (R)')).toBe('1.25');
    expect(fact('Bars held')).toBe('3');
    expect(screen.getByText(/its 1m candles decided the order/)).toBeTruthy();
  });

  it('offers "Practise this setup" for a bullish setup: the ticket is filled in and nothing is placed (14.6)', async () => {
    const bullish = setupDetail(3, {
      setupTf: '1h',
      direction: 'bullish',
      levels: { entry: '100.005', invalidation: '95.123', target1: '110.009', target2: null, rr: 2 },
    });
    const { find } = mockApi({
      'GET /api/v1/instruments': [BTC_BINANCE],
      [`GET /api/v1/setups/${bullish.id}`]: bullish,
      [`GET /api/v1/market/${BTC_BINANCE.id}/candles`]: Array.from({ length: 5 }, (_, i) =>
        candle(T0 + i * H, '100'),
      ),
      [`GET /api/v1/smc/${BTC_BINANCE.id}/overlay`]: overlay(),
      'GET /api/v1/practice/account': {
        accounts: [
          {
            id: '019a7500-0000-7000-8000-000000000900',
            venue: 'binance',
            startingBalances: { USDT: '10000' },
            resetEpoch: 0,
            balances: [{ asset: 'USDT', available: '10000', reserved: '0' }],
          },
        ],
        fees: DEFAULT_PRACTICE_SETTINGS.fees,
      },
      'GET /api/v1/practice/orders': { items: [], nextCursor: null },
      'GET /api/v1/practice/fills': { items: [], nextCursor: null },
      'GET /api/v1/practice/positions': [],
    });
    const { session, user } = await signedIn();
    renderApp(`/setups/${bullish.id}`, session, user);
    // 10,000 USDT at 1 %: 100 at risk over 4.882, rounded down to the 0.00001 step.
    expect(await screen.findByText('20.4834')).toBeTruthy();
    const u = userEvent.setup();
    await u.click(screen.getByRole('link', { name: 'Practise this setup' }));

    await screen.findByText('Filled in from a setup');
    // The levels on the pair's 0.01 price steps (rounded down), the calculator's quantity.
    expect(screen.getByLabelText<HTMLInputElement>('Quantity (BTC)').value).toBe('20.4834');
    expect(screen.getByLabelText<HTMLInputElement>('Limit price (USDT)').value).toBe('100');
    expect(screen.getByLabelText<HTMLInputElement>('Protective stop (USDT, optional)').value).toBe('95.12');
    expect(screen.getByLabelText<HTMLInputElement>('Target (USDT, optional)').value).toBe('110');
    expect(find('POST', '/api/v1/practice/orders')).toHaveLength(0);
  });

  it('explains that a bearish setup cannot be practised: practice trading is spot only', async () => {
    api();
    const { session, user } = await signedIn();
    renderApp(`/setups/${SETUP.id}`, session, user);
    expect(await screen.findByText(/a bearish setup cannot be practised by selling short/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Practise this setup' })).toBeNull();
  });
});
