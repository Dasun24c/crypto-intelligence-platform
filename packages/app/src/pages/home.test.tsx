import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { channels } from '@cip/contracts';
import {
  BTC_BINANCE,
  BTC_COINBASE,
  BTC_REPLAY,
  feed,
  health,
  INSTRUMENTS,
  PAXG_BINANCE,
  spread,
  ticker,
} from '../test/fixtures.js';
import { type ApiRoutes, mockApi, problem, renderApp, signedIn } from '../test/harness.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function api(routes: ApiRoutes = {}) {
  return mockApi({
    'GET /api/v1/instruments': INSTRUMENTS,
    'GET /api/v1/system/health': health([feed(BTC_BINANCE.id, 'trades'), feed(BTC_BINANCE.id, 'ticker')]),
    'GET /api/v1/market/closures': [],
    ...routes,
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The tile's "Last price" line, e.g. "Last price 74,012.35 USDT". */
const lastPrice = (tile: HTMLElement) => within(tile).queryByText('Last price')?.parentElement?.textContent;

describe('Command Center', () => {
  it('shows one tile per instrument, grouped by base asset, priced from the ticker channel', async () => {
    let release = () => {};
    const answered = new Promise<void>((resolve) => (release = resolve));
    api({
      'GET /api/v1/instruments': async () => {
        await answered;
        return INSTRUMENTS;
      },
    });
    const { session, server, user } = await signedIn();
    server.snapshots[channels.ticker(BTC_BINANCE.id)] = ticker(BTC_BINANCE.id, '74012.35', {
      bid: '74012.3',
      ask: '74012.4',
      change24hPct: 1.234,
    });
    renderApp('/', session, user);
    expect(await screen.findByText('Loading instruments')).toBeTruthy();
    release();

    const btc = await screen.findByRole('article', { name: BTC_BINANCE.displayName });
    const groups = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(groups).toEqual(['BTC', 'PAXG (gold-backed token)', 'Reference rates']);
    await waitFor(() => expect(lastPrice(btc)).toBe('Last price 74,012.35 USDT'));
    expect(within(btc).getByText('74,012.30')).toBeTruthy(); // bid, at tick precision
    expect(within(btc).getByText('74,012.40')).toBeTruthy(); // ask
    expect(within(btc).getByText('+1.23%')).toBeTruthy();
    expect(within(btc).getByText('0.01 bps')).toBeTruthy();
    expect(within(btc).getByText('Primary venue')).toBeTruthy();
    expect(within(btc).getByText('Streaming')).toBeTruthy();
    expect(screen.getByText('Live')).toBeTruthy(); // the shell's live connection badge

    // No snapshot for Coinbase BTC: the feed is not streaming.
    const coinbase = screen.getByRole('article', { name: BTC_COINBASE.displayName });
    expect(within(coinbase).getByText('No live data')).toBeTruthy();

    server.push(channels.ticker(BTC_BINANCE.id), 'ticker', ticker(BTC_BINANCE.id, '74020.1'));
    await waitFor(() => expect(lastPrice(btc)).toBe('Last price 74,020.10 USDT'));
    expect(within(btc).getByText(/^updated \d+ s ago$/)).toBeTruthy();
    // The tile links to its Market Activity and Technical Analysis views.
    const link = within(btc).getByRole('link', { name: /^Market activity/ });
    expect(link.getAttribute('href')).toBe(`/market?instrument=${BTC_BINANCE.id}`);
    const analysis = within(btc).getByRole('link', { name: /^Technical analysis/ });
    expect(analysis.getAttribute('href')).toBe(`/analysis?instrument=${BTC_BINANCE.id}`);
  });

  it('labels replay instruments and says plainly when there is no live data', async () => {
    api({ 'GET /api/v1/instruments': [BTC_REPLAY], 'GET /api/v1/system/health': health([]) });
    const { session, user } = await signedIn();
    renderApp('/', session, user);
    const tile = await screen.findByRole('article', { name: BTC_REPLAY.displayName });
    expect(within(tile).getByText('Replay')).toBeTruthy();
    expect(screen.getByText('Replay instruments are shown')).toBeTruthy();
    expect(await within(tile).findByText('No live data')).toBeTruthy();
    expect(within(tile).getByText('Replay: no feed status')).toBeTruthy();
  });

  it('shows feed health and applies live feed.status changes, marking the last price as not current', async () => {
    api();
    const { session, server, user } = await signedIn();
    server.snapshots[channels.ticker(BTC_BINANCE.id)] = ticker(BTC_BINANCE.id, '74012.35');
    renderApp('/', session, user);
    const btc = await screen.findByRole('article', { name: BTC_BINANCE.displayName });
    expect(await within(btc).findByText('Streaming')).toBeTruthy();
    await waitFor(() => expect(lastPrice(btc)).toBe('Last price 74,012.35 USDT'));
    await waitFor(() => expect(server.subscribed()).toContain(channels.market(BTC_BINANCE.id)));

    server.push(channels.market(BTC_BINANCE.id), 'feed.status', {
      ...feed(BTC_BINANCE.id, 'trades', { state: 'disconnected', detail: 'disconnected' }),
      previous: 'connected',
    });
    expect(await within(btc).findByText('Feed down · trades: disconnected')).toBeTruthy();
    expect(within(btc).getByText('Last known price: the feed is down.')).toBeTruthy();
  });

  it('shows the gold market closed until it reopens, and the live cross-venue spread', async () => {
    const now = Date.now();
    api({
      'GET /api/v1/market/closures': [
        {
          calendar: 'gold',
          from: now - HOUR,
          to: now + 2 * HOUR + 30 * MINUTE,
          reason: 'weekend',
          source: 'generated',
        },
        {
          calendar: 'gold',
          from: now + 26 * HOUR,
          to: now + 27 * HOUR,
          reason: 'daily_break',
          source: 'generated',
        },
      ],
    });
    const { session, server, user } = await signedIn();
    renderApp('/', session, user);
    expect(await screen.findByText('Gold market closed (weekend close)')).toBeTruthy();
    expect(screen.getByText(/^Reopens .+ \(in 2 h (29|30) min\)$/)).toBeTruthy();
    expect(screen.getByText('No live spread')).toBeTruthy();
    expect(screen.getByText(/can differ from spot gold and from a broker's XAUUSD quotes/)).toBeTruthy();

    await waitFor(() => expect(server.subscribed()).toContain(channels.market(PAXG_BINANCE.id)));
    server.push(channels.market(PAXG_BINANCE.id), 'spread', spread(Date.now(), 2.3456));
    expect(await screen.findByText('+2.35 bps')).toBeTruthy();
    expect(screen.getByText('0.99985')).toBeTruthy(); // the USDT-USD rate used
    expect(screen.getByText('$4,106.99')).toBeTruthy(); // Binance leg converted to USD
    expect(screen.getByText('$4,107.95')).toBeTruthy();
  });

  it('says when the gold market is open and when it next closes', async () => {
    const now = Date.now();
    api({
      'GET /api/v1/market/closures': [
        {
          calendar: 'gold',
          from: now - 5 * HOUR,
          to: now - 4 * HOUR,
          reason: 'daily_break',
          source: 'generated',
        },
        {
          calendar: 'gold',
          from: now + 3 * HOUR,
          to: now + 4 * HOUR,
          reason: 'daily_break',
          source: 'generated',
        },
      ],
    });
    const { session, user } = await signedIn();
    renderApp('/', session, user);
    expect(await screen.findByText('Gold market open')).toBeTruthy();
    expect(screen.getByText(/^Closes .+ \(in (2 h 59|3 h 00) min\)$/)).toBeTruthy();
  });

  it('reports when the instruments cannot be loaded', async () => {
    api({ 'GET /api/v1/instruments': problem(500, 'The database is unreachable.') });
    const { session, user } = await signedIn();
    renderApp('/', session, user);
    expect(await screen.findByText('Instruments could not be loaded')).toBeTruthy();
    expect(screen.getByText('The database is unreachable.')).toBeTruthy();
  });

  it('says so when feed health cannot be loaded, instead of guessing', async () => {
    api({ 'GET /api/v1/system/health': problem(503, 'Redis is unreachable.') });
    const { session, user } = await signedIn();
    renderApp('/', session, user);
    const btc = await screen.findByRole('article', { name: BTC_BINANCE.displayName });
    expect(await within(btc).findByText('Feed status unavailable')).toBeTruthy();
  });
});
