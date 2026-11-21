import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  channels,
  type ExchangeFlow,
  type ExchangeLabel,
  type OnchainEvent,
  type OnchainPage,
  type OnchainStatusResponse,
} from '@cip/contracts';
import { BTC_BINANCE, INSTRUMENTS, largeTrade, PAXG_COINBASE, wall } from '../test/fixtures.js';
import { type ApiRequest, type ApiRoutes, mockApi, renderApp, signedIn } from '../test/harness.js';

const flow = (): ExchangeFlow => ({
  from: Date.now() - 86_400_000,
  to: Date.now(),
  instruments: [
    {
      instrumentId: BTC_BINANCE.id,
      largeTrades: 2,
      buys: 1,
      sells: 1,
      boughtUsd: '185030.875',
      soldUsd: '400000',
      netUsd: '-214969.125',
      largestUsd: '400000',
      wallsAppeared: 1,
      wallsFilled: 0,
      wallsPulled: 1,
      wallsStanding: 1,
    },
  ],
  largeTrades: [largeTrade(2, BTC_BINANCE.id), largeTrade(1, BTC_BINANCE.id, { notionalUsd: '400000' })],
  largeTradesTotal: 2,
  walls: [wall(1, PAXG_COINBASE.id), wall(2, BTC_BINANCE.id, { endedReason: 'pulled' })],
});

const onchainEvent = (over: Partial<OnchainEvent>): OnchainEvent => ({
  id: '019a7200-0000-7000-8000-000000000001',
  chain: 'bitcoin',
  asset: 'BTC',
  kind: 'transfer',
  txHash: '7663e888950a2341d27366e341408671127e4f989b126872969e0a8ae9e018ec',
  position: 0,
  blockNumber: 976_172,
  blockTime: Date.now() - 600_000,
  from: '33uVWjMEXvu1xBWjydjPod9K87jgjm7WXm',
  to: '1KbDEg1tDz2ErYgaDbaDhhawnLrSQFaFx5',
  fromOwner: null,
  toOwner: 'Binance',
  flow: 'to_exchange',
  amount: '100.00095775',
  usdValue: '6500062.25',
  provider: 'mempool.space',
  receivedAt: Date.now() - 588_000,
  ...over,
});

const onchain = (): OnchainPage => ({
  from: Date.now() - 86_400_000,
  to: Date.now(),
  items: [
    onchainEvent({
      id: '019a7200-0000-7000-8000-000000000002',
      chain: 'ethereum',
      asset: 'PAXG',
      kind: 'mint',
      txHash: '0xef39a122bccb55760d2568db1b832ff9ebf42e2140dcc51e80a1b9719702e2ff',
      from: null,
      to: '0xedd40fe35a559b8f5340b77af93083f3462ebb42',
      toOwner: null,
      flow: 'other',
      amount: '62.9874',
      usdValue: null,
      provider: 'alchemy',
    }),
    onchainEvent({}),
  ],
  nextCursor: null,
  summary: [
    {
      asset: 'BTC',
      transfers: 1,
      transferUsd: '6500062.25',
      toExchangeUsd: '6500062.25',
      fromExchangeUsd: '0',
      minted: '0',
      burned: '0',
      mints: 0,
      burns: 0,
    },
    {
      asset: 'ETH',
      transfers: 0,
      transferUsd: '0',
      toExchangeUsd: '0',
      fromExchangeUsd: '0',
      minted: '0',
      burned: '0',
      mints: 0,
      burns: 0,
    },
    {
      asset: 'SOL',
      transfers: 0,
      transferUsd: '0',
      toExchangeUsd: '0',
      fromExchangeUsd: '0',
      minted: '0',
      burned: '0',
      mints: 0,
      burns: 0,
    },
    {
      asset: 'PAXG',
      transfers: 0,
      transferUsd: '0',
      toExchangeUsd: '0',
      fromExchangeUsd: '0',
      minted: '62.9874',
      burned: '0',
      mints: 1,
      burns: 0,
    },
  ],
});

const status = (): OnchainStatusResponse => ({
  updatedAt: Date.now(),
  stale: false,
  sources: [
    {
      chain: 'bitcoin',
      provider: 'mempool.space',
      state: 'unreachable',
      detail: 'mempool.space cannot be reached from this network (closed (1006))',
      lastBlock: null,
      lastBlockTime: null,
      watching: null,
    },
    {
      chain: 'ethereum',
      provider: 'alchemy',
      state: 'no_key',
      detail: 'no Alchemy key in .secrets-jobs/alchemy-api-key',
      lastBlock: null,
      lastBlockTime: null,
      watching: null,
    },
    {
      chain: 'solana',
      provider: 'alchemy',
      state: 'idle',
      detail: 'no Solana exchange wallet is listed',
      lastBlock: null,
      lastBlockTime: null,
      watching: 0,
    },
  ],
  thresholdsUsd: { BTC: '1000000', ETH: '1000000', SOL: '1000000', PAXG: '250000' },
});

const LABEL: ExchangeLabel = {
  id: '019a7300-0000-7000-8000-000000000001',
  chain: 'bitcoin',
  address: '1KbDEg1tDz2ErYgaDbaDhhawnLrSQFaFx5',
  owner: 'Binance',
  wallet: 'cold',
  source: 'https://www.binance.com/en/proof-of-reserves',
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

function api(routes: ApiRoutes = {}) {
  return mockApi({
    'GET /api/v1/instruments': INSTRUMENTS,
    'GET /api/v1/whales/exchange': flow(),
    'GET /api/v1/whales/onchain': onchain(),
    'GET /api/v1/whales/onchain/status': status(),
    'GET /api/v1/admin/whales/labels': [LABEL],
    'POST /api/v1/admin/whales/labels': (r: ApiRequest) => ({ ...LABEL, ...(r.body as object) }),
    [`DELETE /api/v1/admin/whales/labels/${LABEL.id}`]: new Response(null, { status: 204 }),
    ...routes,
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Whale Tracker', () => {
  it('shows the exchange flow per instrument, its large trades and walls, and reads the totals again on a live one', async () => {
    const { find } = api();
    const { session, server, user } = await signedIn();
    renderApp('/whales', session, user);
    expect(await screen.findByRole('heading', { name: 'Whale Tracker', level: 1 })).toBeTruthy();
    const tabs = screen.getByRole('tablist', { name: 'Whale Tracker views' });
    expect(within(tabs).getByRole('tab', { name: 'Exchange flow' }).getAttribute('aria-selected')).toBe(
      'true',
    );

    const summary = await screen.findByRole('table', {
      name: 'Large trades and walls per instrument in the window',
    });
    const row = within(summary).getAllByRole('row')[1]!;
    expect(within(row).getByText(BTC_BINANCE.displayName)).toBeTruthy();
    expect(within(row).getByText('$185,031')).toBeTruthy();
    expect(within(row).getByText('-$214,969')).toBeTruthy();
    expect(within(row).getByText('1 buys, 1 sells')).toBeTruthy();
    const trades = screen.getByRole('table', { name: 'Large trades in the window, newest first' });
    expect(within(trades).getAllByRole('row')).toHaveLength(3);
    expect(within(trades).getByText('$400,000.00')).toBeTruthy();
    const walls = screen.getByRole('table', { name: /^Walls standing now/ });
    expect(within(walls).getByText('Standing')).toBeTruthy();
    expect(within(walls).getByText('Pulled')).toBeTruthy();
    // 24 hours by default; the hour asks for an hour.
    const q = () => find('GET', '/api/v1/whales/exchange').at(-1)!.url.searchParams;
    expect(Number(q().get('to')) - Number(q().get('from'))).toBe(86_400_000);
    await userEvent.selectOptions(screen.getByLabelText('Window'), 'Last hour');
    await waitFor(() => expect(Number(q().get('to')) - Number(q().get('from'))).toBe(3_600_000));
    await userEvent.selectOptions(screen.getByLabelText('Instrument'), BTC_BINANCE.displayName);
    await waitFor(() => expect(q().get('instrumentId')).toBe(BTC_BINANCE.id));

    // A large trade pushed on an instrument's channel: the totals are read again.
    await waitFor(() => expect(server.subscribed()).toContain(channels.trades(BTC_BINANCE.id)));
    const before = find('GET', '/api/v1/whales/exchange').length;
    server.push(channels.trades(BTC_BINANCE.id), 'trade.large', largeTrade(3, BTC_BINANCE.id));
    await waitFor(() => expect(find('GET', '/api/v1/whales/exchange').length).toBeGreaterThan(before), {
      timeout: 3_000,
    });
  });

  it('shows on-chain sources and events in their own tab, never mixed with the exchange flow (criterion 11.3)', async () => {
    const { find } = api();
    const { session, user } = await signedIn();
    renderApp('/whales', session, user);
    const exchangeTab = await screen.findByRole('tab', { name: 'Exchange flow' });
    await screen.findByRole('table', { name: 'Large trades in the window, newest first' });
    expect(document.querySelector('[data-onchain-event]')).toBeNull();

    // Keyboard: the arrow moves to the other tab.
    exchangeTab.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'On-chain' }).getAttribute('aria-selected')).toBe('true');
    const panel = screen.getByRole('tabpanel');
    await within(panel).findByRole('table', { name: 'On-chain events in the window, newest first' });
    expect(document.querySelector('[data-trade-id]')).toBeNull();
    expect(document.querySelector('[data-flow-instrument]')).toBeNull();

    expect(document.querySelector('[data-source="bitcoin"]')!.getAttribute('data-source-state')).toBe(
      'unreachable',
    );
    expect(within(panel).getByText('Unreachable')).toBeTruthy();
    expect(within(panel).getByText('Waiting for a key')).toBeTruthy();
    expect(within(panel).getByText('Nothing to watch')).toBeTruthy();
    expect(within(panel).getByText(/every PAXG mint and burn, whatever its size/)).toBeTruthy();

    const events = within(panel).getByRole('table', { name: 'On-chain events in the window, newest first' });
    const [, mint, btc] = within(events).getAllByRole('row');
    expect(within(mint!).getByText('Minted')).toBeTruthy();
    expect(within(mint!).getByText('62.9874')).toBeTruthy();
    expect(within(btc!).getByText('Binance')).toBeTruthy();
    expect(within(btc!).getByText('Into an exchange')).toBeTruthy();
    expect(within(btc!).getByText('$6,500,062')).toBeTruthy();
    expect(
      within(btc!)
        .getByRole('link', { name: /7663e8…18ec/ })
        .getAttribute('href'),
    ).toBe('https://mempool.space/tx/7663e888950a2341d27366e341408671127e4f989b126872969e0a8ae9e018ec');
    const summary = within(panel).getByRole('table', { name: 'On-chain events per asset in the window' });
    expect(within(summary).getByText('62.9874 / 0')).toBeTruthy();

    await userEvent.selectOptions(within(panel).getByLabelText('Asset'), 'PAXG');
    await userEvent.selectOptions(within(panel).getByLabelText('Kind'), 'PAXG mints');
    await waitFor(() => {
      const q = find('GET', '/api/v1/whales/onchain').at(-1)!.url.searchParams;
      expect([q.get('asset'), q.get('kind')]).toEqual(['PAXG', 'mint']);
    });
    // A viewer does not see the exchange addresses.
    expect(within(panel).queryByRole('form', { name: 'Add an exchange address' })).toBeNull();
  });

  it('lets an admin add and remove exchange addresses', async () => {
    const { find } = api();
    const { session, user } = await signedIn('admin');
    renderApp('/whales', session, user);
    await userEvent.click(await screen.findByRole('tab', { name: 'On-chain' }));
    const form = await screen.findByRole('form', { name: 'Add an exchange address' });
    await userEvent.selectOptions(within(form).getByLabelText('Chain'), 'Ethereum');
    await userEvent.type(within(form).getByLabelText('Exchange'), 'Coinbase');
    await userEvent.type(
      within(form).getByLabelText('Address'),
      '0x71660c4005ba85c37ccec55d0c4493e66fe775d3',
    );
    await userEvent.selectOptions(within(form).getByLabelText('Wallet'), 'Hot');
    await userEvent.type(within(form).getByLabelText('Published at'), 'https://example.com/reserves');
    await userEvent.click(within(form).getByRole('button', { name: 'Add address' }));
    await waitFor(() => expect(find('POST', '/api/v1/admin/whales/labels')).toHaveLength(1));
    expect(find('POST', '/api/v1/admin/whales/labels')[0]!.body).toEqual({
      chain: 'ethereum',
      address: '0x71660c4005ba85c37ccec55d0c4493e66fe775d3',
      owner: 'Coinbase',
      wallet: 'hot',
      source: 'https://example.com/reserves',
    });
    expect(await screen.findByText('Address added.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Remove Binance's 1KbDEg…aFx5/ }));
    await waitFor(() => expect(find('DELETE', `/api/v1/admin/whales/labels/${LABEL.id}`)).toHaveLength(1));
  });
});
