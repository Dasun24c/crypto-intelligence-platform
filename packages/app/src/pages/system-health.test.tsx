import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { channels } from '@cip/contracts';
import {
  analysisStatus,
  BTC_BINANCE,
  BTC_COINBASE,
  BTC_REPLAY,
  feed,
  health,
  INSTRUMENTS,
  PAXG_BINANCE,
  PAXG_COINBASE,
  USDT_COINBASE,
} from '../test/fixtures.js';
import { mockApi, problem, renderApp, signedIn } from '../test/harness.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const FEEDS = [
  feed(BTC_BINANCE.id, 'trades'),
  feed(BTC_BINANCE.id, 'kline'),
  feed(BTC_COINBASE.id, 'depth', {
    state: 'degraded',
    detail: 'delayed',
    openGaps: 2,
    lagMsP50: 2_400,
    lagMsP95: 3_900,
  }),
  feed(PAXG_COINBASE.id, 'ticker', {
    state: 'disconnected',
    detail: 'not streaming',
    lastMessageAt: null,
    lagMsP50: null,
    lagMsP95: null,
  }),
];

/** The page header: title, overall status and how the figures are kept current. */
const header = () => screen.getByRole('heading', { name: 'System Health', level: 1 }).parentElement!;

describe('System Health', () => {
  it('lists the market data feeds by venue with state, detail, age, lag and open gaps', async () => {
    mockApi({
      'GET /api/v1/system/health': health(FEEDS),
      'GET /api/v1/instruments': [...INSTRUMENTS, BTC_REPLAY],
    });
    const { session, user } = await signedIn();
    renderApp('/system', session, user);
    expect(await screen.findByRole('heading', { name: 'Market data feeds' })).toBeTruthy();
    expect(screen.getByText('2 of 4 streams connected')).toBeTruthy();
    expect(within(header()).getByText('Degraded')).toBeTruthy();

    const binance = await screen.findByRole('region', { name: 'Binance' });
    const rows = within(binance).getAllByRole('row').slice(1);
    // Streams in a fixed order: kline before trades.
    expect(rows.map((r) => within(r).getAllByRole('cell')[1]!.textContent)).toEqual(['kline', 'trades']);
    expect(within(rows[0]!).getByText(BTC_BINANCE.displayName)).toBeTruthy();
    expect(within(rows[0]!).getByText('Connected')).toBeTruthy();
    expect(within(rows[0]!).getByText('120 / 480 ms')).toBeTruthy();

    const coinbase = screen.getByRole('region', { name: 'Coinbase' });
    const delayed = within(coinbase).getByRole('row', { name: /BTC · Coinbase/ });
    expect(within(delayed).getByText('Degraded')).toBeTruthy();
    expect(within(delayed).getByText('delayed')).toBeTruthy();
    expect(within(delayed).getByText('2400 / 3900 ms')).toBeTruthy();
    expect(within(delayed).getByText('2')).toBeTruthy();
    const down = within(coinbase).getByRole('row', { name: /PAXG/ });
    expect(within(down).getByText('Disconnected')).toBeTruthy();
    expect(within(down).getByText('not streaming')).toBeTruthy();
    expect(within(down).getByText('never')).toBeTruthy();
    expect(within(down).getByText('—')).toBeTruthy();
    expect(screen.getByText(/report no feed status/)).toBeTruthy();
  });

  it('switches to live updates pushed on system:health', async () => {
    mockApi({ 'GET /api/v1/system/health': health(FEEDS), 'GET /api/v1/instruments': INSTRUMENTS });
    const { session, server, user } = await signedIn();
    server.snapshots[channels.systemHealth] = health(FEEDS, { checkedAt: Date.now() });
    renderApp('/system', session, user);
    await waitFor(() => expect(within(header()).getByText(/live updates/)).toBeTruthy());

    server.push(
      channels.systemHealth,
      'health.update',
      health([feed(BTC_BINANCE.id, 'trades')], { checkedAt: Date.now() + 1 }),
    );
    await waitFor(() => expect(within(header()).getByText('OK')).toBeTruthy());
    expect(screen.getByText('1 of 1 streams connected')).toBeTruthy();
  });

  it('says so when no feed is reported', async () => {
    mockApi({ 'GET /api/v1/system/health': health([]), 'GET /api/v1/instruments': [] });
    const { session, user } = await signedIn();
    renderApp('/system', session, user);
    expect(await screen.findByText(/No feed is reported/)).toBeTruthy();
    expect(screen.getByText('No instrument is enabled, so nothing is analysed.')).toBeTruthy();
  });

  it('lists the analysis of every enabled instrument, including those no analyzer reports', async () => {
    const usdt = { ...USDT_COINBASE, profile: { name: 'crypto-majors', version: 1 } };
    mockApi({
      'GET /api/v1/system/health': health(FEEDS, {
        analysis: [
          analysisStatus(BTC_BINANCE.id, { lagSec: 0.4 }),
          analysisStatus(PAXG_BINANCE.id, {
            paused: true,
            pauseReason: 'data_gap',
            detail: '1m: missing 2026-11-10 12:01 (backfill running)',
            lagSec: 180,
          }),
          analysisStatus(BTC_COINBASE.id, {
            status: 'warming_up',
            paused: true,
            pauseReason: 'warming_up',
            detail: '1d: waiting for history',
            lagSec: null,
          }),
          // Reported, but not in the instrument list (yet).
          analysisStatus(BTC_REPLAY.id),
        ],
      }),
      'GET /api/v1/instruments': [BTC_BINANCE, PAXG_BINANCE, BTC_COINBASE, PAXG_COINBASE, usdt],
    });
    const { session, user } = await signedIn();
    renderApp('/system', session, user);
    const card = (await screen.findByRole('heading', { name: 'Analysis' })).closest('section')!;
    await waitFor(() =>
      expect(within(card).getByText('4 of 6 instruments analysed · 2 paused')).toBeTruthy(),
    );
    const table = within(card).getByRole('table', { name: 'Analysis state of each enabled instrument' });
    // Command Center order; instruments known only from a status come last.
    expect(
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((r) => within(r).getAllByRole('cell')[0]!.textContent),
    ).toEqual([
      BTC_BINANCE.displayName,
      BTC_COINBASE.displayName,
      PAXG_BINANCE.displayName,
      PAXG_COINBASE.displayName,
      usdt.displayName,
      `Instrument ${BTC_REPLAY.id}`,
    ]);

    const btc = within(table).getByRole('row', { name: /^BTC · Binance/ });
    expect(within(btc).getByText('Live')).toBeTruthy();
    expect(within(btc).getByText('No')).toBeTruthy();
    expect(within(btc).getByText('0 s')).toBeTruthy();
    expect(within(btc).getByText('2 s ago')).toBeTruthy();

    const gap = within(table).getByRole('row', { name: /^PAXG \(gold-backed token\) · Binance/ });
    expect(within(gap).getByText('Data gap')).toBeTruthy();
    expect(within(gap).getByText('1m: missing 2026-11-10 12:01 (backfill running)')).toBeTruthy();
    expect(within(gap).getByText('3 min')).toBeTruthy();

    const warming = within(table).getByRole('row', { name: /^BTC · Coinbase/ });
    expect(within(warming).getByText('Warming up')).toBeTruthy();
    expect(within(warming).getByText('Waiting for history')).toBeTruthy();
    expect(within(warming).getByText('1d: waiting for history')).toBeTruthy();
    expect(within(warming).getByText('no candle analysed yet')).toBeTruthy();

    const unheld = within(table).getByRole('row', { name: /^USDT · Coinbase/ });
    expect(within(unheld).getByText('Not analysed')).toBeTruthy();
    expect(within(unheld).getByText('Not analysed: no analyzer holds this instrument')).toBeTruthy();
    const noProfile = within(table).getByRole('row', { name: /^PAXG \(gold-backed token\) · Coinbase/ });
    expect(within(noProfile).getByText('Not analysed: the instrument has no profile')).toBeTruthy();
  });

  it('shows that it is checking until the first answer arrives', async () => {
    let release = () => {};
    const answered = new Promise<void>((resolve) => (release = resolve));
    mockApi({
      'GET /api/v1/system/health': async () => {
        await answered;
        return health(FEEDS);
      },
      'GET /api/v1/instruments': INSTRUMENTS,
    });
    const { session, user } = await signedIn();
    renderApp('/system', session, user);
    expect(await screen.findByText('Checking services')).toBeTruthy();
    release();
    expect(await screen.findByRole('heading', { name: 'Market data feeds' })).toBeTruthy();
  });

  it('reports when system health is unavailable', async () => {
    mockApi({
      'GET /api/v1/system/health': problem(503, 'The database is unreachable.'),
      'GET /api/v1/instruments': INSTRUMENTS,
    });
    const { session, user } = await signedIn();
    renderApp('/system', session, user);
    expect(await screen.findByText('System health is unavailable')).toBeTruthy();
    expect(screen.getByText('The database is unreachable.')).toBeTruthy();
  });
});
