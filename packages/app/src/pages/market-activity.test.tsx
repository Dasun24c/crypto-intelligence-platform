import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BookMetrics, channels, type DataGap } from '@cip/contracts';
import {
  BTC_BINANCE,
  BTC_REPLAY,
  INSTRUMENTS,
  largeTrade,
  PAXG_BINANCE,
  spread,
  wall,
} from '../test/fixtures.js';
import { type ApiRequest, type ApiRoutes, mockApi, problem, renderApp, signedIn } from '../test/harness.js';

const MINUTE = 60_000;
const ID = BTC_BINANCE.id;

const metrics = (): BookMetrics => ({
  ts: Date.now() - 1_000,
  mid: '74012.35',
  spreadBps: 0.27,
  bidDepth10bp: 1_234_567,
  askDepth10bp: 987_654,
  bidDepth50bp: 5_000_000,
  askDepth50bp: 4_000_000,
  bidDepth100bp: 9_000_000,
  askDepth100bp: 8_500_000,
  imbalance10bp: 0.11,
  imbalance50bp: -0.05,
  imbalance100bp: null,
  coverageBps: 120,
});

const repairedGap: DataGap = {
  id: '019a7200-0000-7000-8000-000000000001',
  instrumentId: ID,
  stream: 'trades',
  from: Date.now() - 50 * MINUTE,
  to: Date.now() - 49 * MINUTE,
  detectedAt: Date.now() - 48 * MINUTE,
  detectedBy: 'reconnect',
  status: 'repaired',
  resolvedAt: Date.now() - 47 * MINUTE,
  details: {},
};

function api(routes: ApiRoutes = {}) {
  return mockApi({
    'GET /api/v1/instruments': INSTRUMENTS,
    [`GET /api/v1/market/${ID}/large-trades`]: {
      items: [largeTrade(2, ID), largeTrade(1, ID)],
      nextCursor: null,
    },
    [`GET /api/v1/market/${ID}/walls`]: (r: ApiRequest) =>
      r.url.searchParams.get('active') === 'true'
        ? [wall(1, ID)]
        : [
            wall(2, ID, {
              side: 'ask',
              price: '74100',
              endedReason: 'pulled',
              firstSeen: Date.now() - 9 * MINUTE,
              lastSeen: Date.now() - 5 * MINUTE,
            }),
          ],
    [`GET /api/v1/market/${ID}/book/metrics`]: [metrics()],
    'GET /api/v1/market/gaps': { items: [repairedGap], nextCursor: null },
    ...routes,
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Market Activity', () => {
  it('lists large trades newest first, adding live ones once each', async () => {
    api();
    const { session, server, user } = await signedIn();
    renderApp(`/market?instrument=${ID}`, session, user);
    const table = await screen.findByRole('table', { name: /^Large trades on/ });
    let rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Buy')).toBeTruthy();
    expect(within(rows[0]!).getByText('$185,030.88')).toBeTruthy();
    expect(within(rows[0]!).getByText('74,012.35')).toBeTruthy();
    expect(within(rows[0]!).getByText('2.5')).toBeTruthy();
    expect(within(rows[0]!).getByText('Taker order')).toBeTruthy();
    expect(within(rows[0]!).getByText('7 / 3')).toBeTruthy();
    expect(within(rows[0]!).getByText('$150,000')).toBeTruthy();

    await waitFor(() => expect(server.subscribed()).toContain(channels.trades(ID)));
    server.push(channels.trades(ID), 'trade.large', largeTrade(3, ID, { notionalUsd: '999999.5' }));
    server.push(channels.trades(ID), 'trade.large', largeTrade(2, ID)); // already listed
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(4));
    rows = within(table).getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByText('$999,999.50')).toBeTruthy();
    expect(within(rows[0]!).getByText('Sell')).toBeTruthy();
  });

  it('shows standing walls and recently ended ones, and moves a wall when it ends', async () => {
    api();
    const { session, server, user } = await signedIn();
    renderApp(`/market?instrument=${ID}`, session, user);
    const standing = await screen.findByRole('table', { name: /^Walls standing/ });
    expect(within(standing).getByText('Bid')).toBeTruthy();
    expect(within(standing).getByText('74,000.00')).toBeTruthy();
    expect(within(standing).getByText('$2,500,000')).toBeTruthy();
    const ended = await screen.findByRole('table', { name: 'Walls that ended in the last hour' });
    expect(within(ended).getByText('Pulled (cancelled)')).toBeTruthy();
    expect(within(ended).getByText('74,100.00')).toBeTruthy();

    await waitFor(() => expect(server.subscribed()).toContain(channels.market(ID)));
    server.push(
      channels.market(ID),
      'wall.ended',
      wall(1, ID, { endedReason: 'filled', lastSeen: Date.now() }),
    );
    expect(await screen.findByText('No wall is standing in the book now.')).toBeTruthy();
    expect(
      within(screen.getByRole('table', { name: 'Walls that ended in the last hour' })).getByText(
        'Filled (traded through)',
      ),
    ).toBeTruthy();
  });

  it('shows the top of the live book with stored depth metrics', async () => {
    api();
    const { session, server, user } = await signedIn();
    server.snapshots[channels.book(ID)] = {
      instrumentId: ID,
      ts: Date.now(),
      bids: [
        ['74012.34', '1.5'],
        ['74012', '0.25'],
      ],
      asks: [['74012.36', '0.75']],
      coverageBps: 118.4,
    };
    renderApp(`/market?instrument=${ID}`, session, user);
    const book = await screen.findByRole('table', { name: /order book$/ });
    expect(await within(book).findByText('74,012.34')).toBeTruthy();
    expect(within(book).getByText('74,012.00')).toBeTruthy();
    expect(within(book).getByText('1.5')).toBeTruthy();
    expect(within(book).getByText('74,012.36')).toBeTruthy();
    expect(within(book).getByText('Asks (sell side)')).toBeTruthy();
    expect(within(book).getByText('Bids (buy side)')).toBeTruthy();
    expect(within(book).getByText('Spread 0.00 bps · book covers ±118 bps around mid')).toBeTruthy();

    const depth = await screen.findByRole('table', { name: /^Book depth/ });
    const band = within(depth).getByRole('row', { name: /±0.1%/ });
    expect(within(band).getByText('$1.23M')).toBeTruthy();
    expect(within(band).getByText('+0.11')).toBeTruthy();
    expect(within(within(depth).getByRole('row', { name: /±1%/ })).getByText('—')).toBeTruthy();

    server.push(channels.book(ID), 'book.snapshot', {
      instrumentId: ID,
      ts: Date.now(),
      bids: [['74013.5', '3']],
      asks: [['74013.6', '1']],
      coverageBps: 90,
    });
    expect(await within(book).findByText('74,013.50')).toBeTruthy();
  });

  it('says there is no live data when the book feed is not streaming', async () => {
    api();
    const { session, user } = await signedIn();
    renderApp(`/market?instrument=${ID}`, session, user);
    expect(await screen.findByText('The book feed is not streaming.')).toBeTruthy();
    expect(screen.getByText('No live data')).toBeTruthy();
  });

  it('lists data gaps and follows them as they open and close', async () => {
    api();
    const { session, server, user } = await signedIn();
    renderApp(`/market?instrument=${ID}`, session, user);
    const table = await screen.findByRole('table', { name: /^Data gaps/ });
    expect(within(table).getByText('Repaired')).toBeTruthy();
    expect(within(table).getByText('Reconnect')).toBeTruthy();

    await waitFor(() => expect(server.subscribed()).toContain(channels.market(ID)));
    const gapId = '019a7200-0000-7000-8000-000000000002';
    server.push(channels.market(ID), 'gap.opened', {
      gapId,
      instrumentId: ID,
      stream: 'depth',
      from: Date.now() - 5_000,
      to: null,
      detectedBy: 'sequence',
    });
    const open = await within(table).findByRole('row', { name: /depth/ });
    expect(within(open).getByText('Open')).toBeTruthy();
    expect(within(open).getByText('Sequence gap')).toBeTruthy();
    expect(within(open).getByText('ongoing')).toBeTruthy();

    server.push(channels.market(ID), 'gap.closed', { gapId, instrumentId: ID, status: 'repaired' });
    await waitFor(() => expect(within(table).getAllByText('Repaired')).toHaveLength(2));
  });

  it('charts the PAXG cross-venue spread over the last hour, with live points', async () => {
    const now = Date.now();
    api({
      [`GET /api/v1/market/${PAXG_BINANCE.id}/large-trades`]: { items: [], nextCursor: null },
      [`GET /api/v1/market/${PAXG_BINANCE.id}/walls`]: [],
      [`GET /api/v1/market/${PAXG_BINANCE.id}/book/metrics`]: [],
      'GET /api/v1/market/gaps': { items: [], nextCursor: null },
      'GET /api/v1/market/spreads/PAXG': [spread(now - 30 * MINUTE, 1.5), spread(now - 20 * MINUTE, -0.75)],
    });
    const { session, server, user } = await signedIn();
    renderApp(`/market?instrument=${PAXG_BINANCE.id}`, session, user);
    const chart = await screen.findByRole('img', { name: /PAXG cross-venue spread in bps/ });
    expect(chart.querySelectorAll('circle').length).toBeGreaterThan(0);
    expect(
      screen.getByText(/Latest -0.75 bps; lowest -0.75 bps, highest \+1.50 bps over 2 points/, {
        selector: 'figcaption',
      }),
    ).toBeTruthy();
    expect(screen.getByText('No large trades recorded for this instrument yet.')).toBeTruthy();
    expect(screen.getByText('No depth metrics stored in the last 2 minutes.')).toBeTruthy();

    await waitFor(() => expect(server.subscribed()).toContain(channels.market(PAXG_BINANCE.id)));
    server.push(channels.market(PAXG_BINANCE.id), 'spread', spread(Date.now(), 3.1));
    expect(
      await screen.findByText(/Latest \+3.10 bps; lowest -0.75 bps, highest \+3.10 bps over 3 points/, {
        selector: 'figcaption',
      }),
    ).toBeTruthy();
  });

  it('shows each panel loading, and an error when its data cannot be loaded', async () => {
    let release = () => {};
    const answered = new Promise<void>((resolve) => (release = resolve));
    api({
      [`GET /api/v1/market/${ID}/large-trades`]: async () => {
        await answered;
        return problem(500, 'The database is unreachable.');
      },
    });
    const { session, user } = await signedIn();
    renderApp(`/market?instrument=${ID}`, session, user);
    expect(await screen.findByText('Loading large trades…')).toBeTruthy();
    release();
    expect(await screen.findByText('Large trades could not be loaded')).toBeTruthy();
    expect(screen.getByText('The database is unreachable.')).toBeTruthy();
    // The other panels are unaffected.
    expect(await screen.findByRole('table', { name: /^Walls standing/ })).toBeTruthy();
  });

  it('labels a replay instrument, and falls back when the link names an unknown instrument', async () => {
    mockApi({
      'GET /api/v1/instruments': [BTC_REPLAY],
      [`GET /api/v1/market/${BTC_REPLAY.id}/large-trades`]: { items: [], nextCursor: null },
      [`GET /api/v1/market/${BTC_REPLAY.id}/walls`]: [],
      [`GET /api/v1/market/${BTC_REPLAY.id}/book/metrics`]: [],
      'GET /api/v1/market/gaps': { items: [], nextCursor: null },
    });
    const { session, user } = await signedIn();
    renderApp('/market?instrument=019a6f00-0000-7000-8000-00000000ffff', session, user);
    expect(await screen.findByText('That instrument is not available')).toBeTruthy();
    expect(screen.getByText('Replay instrument')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Replay');
    expect(screen.getByLabelText<HTMLSelectElement>('Instrument').value).toBe(BTC_REPLAY.id);
  });
});
