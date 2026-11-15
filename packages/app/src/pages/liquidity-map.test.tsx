import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { channels } from '@cip/contracts';
import { BTC_BINANCE, candle, PAXG_BINANCE } from '../test/fixtures.js';
import { type ApiRequest, mockApi, renderApp, signedIn } from '../test/harness.js';
import { H, overlay, T0 } from '../test/smc-fixtures.js';

// The chart draws on a canvas, which jsdom lacks: the chart is not created, but its container,
// caption, overlay table and the data the page gives it are real.
vi.mock('../charts/use-chart.js', () => ({
  useChart: () => ({ ref: () => undefined, chart: null, annotate: () => undefined }),
  toChartTime: (ms: number) => Math.floor(ms / 1000),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CANDLES = Array.from({ length: 12 }, (_, i) =>
  candle(T0 + i * H, '100', { o: '100', h: '106', l: '98' }),
);

function api(extra: Record<string, unknown> = {}) {
  return mockApi({
    'GET /api/v1/instruments': [BTC_BINANCE, PAXG_BINANCE],
    [`GET /api/v1/market/${BTC_BINANCE.id}/candles`]: CANDLES,
    [`GET /api/v1/smc/${BTC_BINANCE.id}/overlay`]: overlay(),
    [`GET /api/v1/market/${PAXG_BINANCE.id}/candles`]: CANDLES,
    [`GET /api/v1/smc/${PAXG_BINANCE.id}/overlay`]: (r: ApiRequest) =>
      overlay({
        instrumentId: PAXG_BINANCE.id,
        tf: '1h',
        closures: [{ from: T0 + 4 * H, to: T0 + 5 * H, reason: 'daily_break' }],
        ...(r.url.searchParams.get('tf') ? {} : {}),
      }),
    ...extra,
  });
}

const chart = () => document.querySelector<HTMLElement>('[data-chart="liquidity"]')!;

describe('Liquidity Map', () => {
  it("asks for the overlay of exactly the candles' window and lists what it draws", async () => {
    const { find } = api();
    const { session, user } = await signedIn();
    renderApp(`/liquidity?instrument=${BTC_BINANCE.id}&tf=1h`, session, user);
    expect(await screen.findByRole('heading', { name: 'Liquidity Map', level: 1 })).toBeTruthy();
    await waitFor(() => expect(find('GET', `/api/v1/smc/${BTC_BINANCE.id}/overlay`)).toHaveLength(1));
    const candlesUrl = find('GET', `/api/v1/market/${BTC_BINANCE.id}/candles`)[0]!.url;
    expect(Object.fromEntries(candlesUrl.searchParams)).toEqual({ tf: '1h', limit: '300' });
    const overlayUrl = find('GET', `/api/v1/smc/${BTC_BINANCE.id}/overlay`)[0]!.url;
    expect(Object.fromEntries(overlayUrl.searchParams)).toEqual({
      tf: '1h',
      from: String(T0),
      to: String(T0 + 12 * H),
    });
    await waitFor(() => expect(chart().dataset['ready']).toBe('false')); // no chart in jsdom
    expect(chart().dataset).toMatchObject({
      tf: '1h',
      from: String(T0),
      to: String(T0 + 12 * H),
      instrument: BTC_BINANCE.id,
    });
    expect(
      screen.getByRole('img', { name: /BTC · Binance BTC\/USDT, 1 hour candles with SMC overlays/ }),
    ).toBeTruthy();
    expect(await screen.findByText(/^12 candles from .*Drawn: 1 ranges, 1 zones/)).toBeTruthy();
    expect(screen.getByText(/TradingView Lightweight Charts™/)).toBeTruthy();
    expect(
      screen.getByText(/Setup levels are hypothetical\. Educational analysis — not financial advice/),
    ).toBeTruthy();

    // The table alternative lists every drawn item; turning a layer off removes its rows.
    const table = screen.getByRole('table');
    expect(within(table).getByText(/Thin-book wick of the Session high at 104\.5/)).toBeTruthy();
    expect(within(table).getAllByRole('row')).toHaveLength(8);
    await userEvent.setup().click(screen.getByLabelText(/Sweeps and thin-book wicks/));
    await waitFor(() => expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(7));
    // No gold-market closures layer for a crypto instrument.
    expect(screen.queryByLabelText(/Gold-market closures/)).toBeNull();
  });

  it('shades gold-market closures on PAXG and says how PAXG differs from spot gold', async () => {
    api();
    const { session, user } = await signedIn();
    renderApp(`/liquidity?instrument=${PAXG_BINANCE.id}&tf=1h`, session, user);
    expect(await screen.findByLabelText(/Gold-market closures/)).toBeTruthy();
    expect(screen.getByText(/can differ from spot gold and from a broker's XAUUSD quotes/)).toBeTruthy();
    expect(await screen.findByText(/Gold market closed \(daily break\)/)).toBeTruthy();
  });

  it('says when the instrument was never analysed, and reloads when a candle closes', async () => {
    const { find } = api({
      [`GET /api/v1/smc/${BTC_BINANCE.id}/overlay`]: {
        ...overlay(),
        run: null,
        swings: [],
        structure: [],
        ranges: [],
        levels: [],
        sweeps: [],
        zones: [],
        setups: [],
      },
    });
    const { session, user, server } = await signedIn();
    renderApp(`/liquidity?instrument=${BTC_BINANCE.id}&tf=1h`, session, user);
    expect(await screen.findByText('Not analysed yet')).toBeTruthy();
    const before = find('GET', `/api/v1/market/${BTC_BINANCE.id}/candles`).length;
    server.push(channels.candles(BTC_BINANCE.id, '1h'), 'candle.closed', candle(T0 + 12 * H, '101'));
    await waitFor(() =>
      expect(find('GET', `/api/v1/market/${BTC_BINANCE.id}/candles`).length).toBeGreaterThan(before),
    );
  });
});
