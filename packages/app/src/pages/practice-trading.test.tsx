import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  channels,
  DEFAULT_PRACTICE_SETTINGS,
  PRACTICE_BANNER,
  type PracticeAccount,
  type PracticeFill,
  type PracticeOrder,
} from '@cip/contracts';
import { BTC_BINANCE, BTC_COINBASE, ticker, USDT_COINBASE } from '../test/fixtures.js';
import { type ApiRequest, json, mockApi, renderApp, signedIn } from '../test/harness.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const T = Date.UTC(2026, 10, 14, 10, 0);
const SETUP_ID = '019a7400-0000-7000-8000-000000000001';
const id = (n: number) => `019a7500-0000-7000-8000-${String(n).padStart(12, '0')}`;

function account(
  venue: 'binance' | 'coinbase',
  balances: PracticeAccount['balances'],
  resetEpoch = 0,
): PracticeAccount {
  const quote = venue === 'binance' ? 'USDT' : 'USD';
  return {
    id: id(venue === 'binance' ? 900 : 901),
    venue,
    startingBalances: { [quote]: '10000' },
    resetEpoch,
    balances,
  };
}
const BINANCE = account('binance', [{ asset: 'USDT', available: '10000', reserved: '0' }]);
const COINBASE = account('coinbase', [{ asset: 'USD', available: '10000', reserved: '0' }]);

function order(n: number, extra: Partial<PracticeOrder> = {}): PracticeOrder {
  return {
    id: id(n),
    clientOrderId: `c-${n}`,
    venue: 'binance',
    instrumentId: BTC_BINANCE.id,
    side: 'buy',
    type: 'limit',
    quantity: '0.1',
    limitPrice: '95',
    stopPrice: null,
    filledQuantity: '0',
    averagePrice: null,
    status: 'open',
    refusalReason: null,
    parentId: null,
    ocoGroup: null,
    source: 'manual',
    setupId: null,
    underlyingClosed: false,
    createdAt: T + n,
    updatedAt: T + n,
    ...extra,
  };
}

function fill(n: number, o: PracticeOrder, extra: Partial<PracticeFill> = {}): PracticeFill {
  return {
    id: id(500 + n),
    orderId: o.id,
    venue: o.venue,
    instrumentId: o.instrumentId,
    side: o.side,
    price: '100',
    quantity: o.quantity,
    fee: '0.05',
    feeAsset: 'USDT',
    liquidity: 'taker',
    flags: [],
    basis: { book: [['100', o.quantity]] },
    filledAt: T + 10_000 + n,
    ...extra,
  };
}

function api(opts: { open?: PracticeOrder[]; done?: PracticeOrder[]; extra?: Record<string, unknown> } = {}) {
  return mockApi({
    'GET /api/v1/instruments': [BTC_BINANCE, BTC_COINBASE, USDT_COINBASE],
    'GET /api/v1/practice/account': { accounts: [BINANCE, COINBASE], fees: DEFAULT_PRACTICE_SETTINGS.fees },
    'GET /api/v1/practice/orders': (r: ApiRequest) => ({
      items: r.url.searchParams.get('status') === 'open' ? (opts.open ?? []) : (opts.done ?? []),
      nextCursor: null,
    }),
    'GET /api/v1/practice/fills': { items: [], nextCursor: null },
    'GET /api/v1/practice/positions': [],
    ...opts.extra,
  });
}

async function practicePage(path = '/practice', role: 'viewer' | 'admin' = 'viewer') {
  const { session, server, user } = await signedIn(role);
  server.snapshots[channels.ticker(BTC_BINANCE.id)] = ticker(BTC_BINANCE.id, '100', {
    bid: '99.99',
    ask: '100',
  });
  renderApp(path, session, user);
  await screen.findByRole('heading', { name: 'Practice Trading' });
  // The account and the pairs have loaded: the ticket is shown.
  await screen.findByRole('button', { name: 'Review order' });
  return { session, server, user };
}

const openTable = () => within(screen.getByRole('table', { name: 'Open practice orders' }));

describe('Practice Trading (Phase 14)', () => {
  it('is labelled as simulated, shows the balances, and places nothing before the confirmation (14.1, 14.7)', async () => {
    const placed = order(7, { type: 'market', quantity: '0.5', limitPrice: null, status: 'new' });
    const { find } = api({
      extra: {
        'POST /api/v1/practice/orders': (r: ApiRequest) =>
          json(201, { ...placed, clientOrderId: (r.body as { clientOrderId: string }).clientOrderId }),
      },
    });
    await practicePage();
    expect(screen.getAllByText(PRACTICE_BANNER).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Practice Trading' }).getAttribute('aria-current')).toBe('page');
    const binance = within(screen.getByRole('table', { name: 'Binance practice balances' }));
    expect(binance.getByText('10,000', { selector: 'td:nth-child(2)' })).toBeTruthy();
    // The reference pair (USDT-USD) is not offered.
    expect(screen.queryByRole('option', { name: /USDT · Coinbase USDT\/USD/ })).toBeNull();

    const u = userEvent.setup();
    await u.type(screen.getByLabelText('Quantity (BTC)'), '0.5');
    await waitFor(() => expect(screen.getByText(/Worth about 50 USDT/)).toBeTruthy());
    await u.click(screen.getByRole('button', { name: 'Review order' }));
    const heading = screen.getByRole('heading', { name: 'Confirm your practice order' });
    expect(document.activeElement).toBe(heading);
    expect(find('POST', '/api/v1/practice/orders')).toHaveLength(0);

    // Escape goes back to the form, and nothing was sent.
    await u.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Review order' })).toBeTruthy();
    expect(find('POST', '/api/v1/practice/orders')).toHaveLength(0);

    await u.click(screen.getByRole('button', { name: 'Review order' }));
    await u.click(screen.getByRole('button', { name: 'Place practice order' }));
    await screen.findByText('Practice order submitted');
    const [post] = find('POST', '/api/v1/practice/orders');
    expect(post!.body).toEqual({
      clientOrderId: expect.stringMatching(/^web-/) as string,
      instrumentId: BTC_BINANCE.id,
      side: 'buy',
      type: 'market',
      quantity: '0.5',
    });
    expect(openTable().getByText('Submitted')).toBeTruthy();
  });

  it('says why an order was refused, and checks the form before anything is sent (14.5)', async () => {
    const { find } = api({
      extra: {
        'POST /api/v1/practice/orders': json(422, {
          type: 'about:blank',
          title: 'Order refused',
          status: 422,
          code: 'ORDER_REFUSED',
          reason: 'insufficient_balance',
          detail: 'The order needs 20020 USDT with fees; the practice balance has 10000 USDT free.',
        }),
      },
    });
    await practicePage();
    const u = userEvent.setup();
    await u.click(screen.getByLabelText('Limit'));
    await u.type(screen.getByLabelText('Quantity (BTC)'), '0.000001');
    await u.type(screen.getByLabelText('Limit price (USDT)'), '100.005');
    await u.type(screen.getByLabelText('Protective stop (USDT, optional)'), '101');
    await u.click(screen.getByRole('button', { name: 'Review order' }));
    expect(screen.getByText('The quantity must be a whole number of steps of 0.00001.')).toBeTruthy();
    expect(screen.getByText('The limit price must be a whole number of steps of 0.01.')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Quantity (BTC)'));
    expect(find('POST', '/api/v1/practice/orders')).toHaveLength(0);

    await u.clear(screen.getByLabelText('Quantity (BTC)'));
    await u.type(screen.getByLabelText('Quantity (BTC)'), '200');
    await u.clear(screen.getByLabelText('Limit price (USDT)'));
    await u.type(screen.getByLabelText('Limit price (USDT)'), '100');
    await u.click(screen.getByRole('button', { name: 'Review order' }));
    expect(screen.getByText('The stop must be below the buying price (100).')).toBeTruthy();
    await u.clear(screen.getByLabelText('Protective stop (USDT, optional)'));
    await u.click(screen.getByRole('button', { name: 'Review order' }));
    await u.click(screen.getByRole('button', { name: 'Place practice order' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The practice order was refused');
    expect(alert.textContent).toContain('The order needs 20020 USDT with fees');
  });

  it('keeps open orders and balances current from the practice channel, and resynchronises after a reconnect (14.9)', async () => {
    const a = order(1);
    const b = order(2, { side: 'sell', limitPrice: '120' });
    api({ open: [a] });
    const { server } = await practicePage();
    await waitFor(() => expect(openTable().getByText('Open')).toBeTruthy());
    await waitFor(() => expect(server.subscribed()).toContain(channels.practice));

    server.push(channels.practice, 'practice.order', {
      order: { ...a, status: 'partially_filled', filledQuantity: '0.04', updatedAt: T + 50 },
    });
    await waitFor(() => expect(openTable().getByText('Partly filled')).toBeTruthy());
    const filled = {
      ...a,
      status: 'filled' as const,
      filledQuantity: '0.1',
      averagePrice: '95',
      updatedAt: T + 60,
    };
    server.push(channels.practice, 'practice.fill', {
      fill: fill(1, filled, { price: '95' }),
      order: filled,
    });
    await waitFor(() => expect(screen.getByText('No open practice orders.')).toBeTruthy());
    expect(screen.getByText(/Practice buy filled: 0\.1 BTC at 95\. Simulated\./)).toBeTruthy();

    server.push(channels.practice, 'practice.account', {
      account: account('binance', [
        { asset: 'BTC', available: '0.1', reserved: '0' },
        { asset: 'USDT', available: '9990.4905', reserved: '0' },
      ]),
    });
    const binance = within(screen.getByRole('table', { name: 'Binance practice balances' }));
    await waitFor(() => expect(binance.getByText('9,990.4905')).toBeTruthy());

    // Away too long to replay: the server's snapshot replaces the balances and the open orders.
    server.resyncSnapshots[channels.practice] = {
      accounts: [account('binance', [{ asset: 'USDT', available: '9000', reserved: '1000' }]), COINBASE],
      openOrders: [b],
    };
    const socket = server.sockets.last;
    act(() => socket.drop());
    act(() => socket.open());
    await waitFor(() => expect(openTable().getByText('Sell')).toBeTruthy());
    await waitFor(() => expect(binance.getByText('9,000')).toBeTruthy());
  });

  it('fills in the ticket from a setup and submits nothing until the user confirms (14.6)', async () => {
    const { find } = api({
      extra: {
        'POST /api/v1/practice/orders': (r: ApiRequest) =>
          json(
            201,
            order(9, {
              setupId: SETUP_ID,
              source: 'setup',
              clientOrderId: (r.body as { clientOrderId: string }).clientOrderId,
              status: 'new',
            }),
          ),
      },
    });
    await practicePage(
      `/practice?instrument=${BTC_BINANCE.id}&setup=${SETUP_ID}&quantity=0.25&limit=99.5&stop=95&target=110`,
    );
    expect(screen.getByText('Filled in from a setup')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Limit').checked).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('Quantity (BTC)').value).toBe('0.25');
    expect(screen.getByLabelText<HTMLInputElement>('Limit price (USDT)').value).toBe('99.5');
    expect(screen.getByLabelText<HTMLInputElement>('Protective stop (USDT, optional)').value).toBe('95');
    expect(screen.getByLabelText<HTMLInputElement>('Target (USDT, optional)').value).toBe('110');
    // Nothing is sent by opening the ticket.
    expect(find('POST', '/api/v1/practice/orders')).toHaveLength(0);

    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: 'Review order' }));
    expect(find('POST', '/api/v1/practice/orders')).toHaveLength(0);
    await u.click(screen.getByRole('button', { name: 'Place practice order' }));
    await screen.findByText('Practice order submitted');
    expect(find('POST', '/api/v1/practice/orders')[0]!.body).toMatchObject({
      instrumentId: BTC_BINANCE.id,
      side: 'buy',
      type: 'limit',
      quantity: '0.25',
      limitPrice: '99.5',
      stop: '95',
      target: '110',
      setupId: SETUP_ID,
    });
  });

  it('keeps a finished order finished when its own answer arrives after the channel said how it ended', async () => {
    let server: Awaited<ReturnType<typeof practicePage>>['server'] | null = null;
    const submitted = order(11, {
      type: 'market',
      side: 'sell',
      limitPrice: null,
      status: 'new',
      updatedAt: T + 11,
    });
    api({
      extra: {
        // The broker fills the order, and the channel says so, before the api's answer is read.
        'POST /api/v1/practice/orders': () => {
          server!.push(channels.practice, 'practice.order', {
            order: {
              ...submitted,
              status: 'filled',
              filledQuantity: '0.1',
              averagePrice: '99.99',
              updatedAt: T + 99,
            },
          });
          return json(201, submitted);
        },
      },
    });
    ({ server } = await practicePage());
    await waitFor(() => expect(server.subscribed()).toContain(channels.practice));
    const u = userEvent.setup();
    await u.click(screen.getByLabelText('Sell'));
    await u.type(screen.getByLabelText('Quantity (BTC)'), '0.1');
    await u.click(screen.getByRole('button', { name: 'Review order' }));
    await u.click(screen.getByRole('button', { name: 'Place practice order' }));
    await screen.findByText('Practice order submitted');
    expect(screen.getByText('No open practice orders.')).toBeTruthy();
    expect(screen.queryByText('Submitted')).toBeNull();
  });

  it('cancels an open order, and resets an account only after confirming', async () => {
    const a = order(3);
    const { find } = api({
      open: [a],
      extra: {
        [`POST /api/v1/practice/orders/${a.id}/cancel`]: { ...a, status: 'cancelled', updatedAt: T + 99 },
        'POST /api/v1/practice/account/reset': { ...BINANCE, resetEpoch: 1 },
      },
    });
    await practicePage();
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Cancel Buy 0.1 BTC/USDT, limit 95.00' }));
    await waitFor(() => expect(screen.getByText('No open practice orders.')).toBeTruthy());
    expect(find('POST', `/api/v1/practice/orders/${a.id}/cancel`)).toHaveLength(1);

    await u.click(screen.getByRole('button', { name: 'Reset Binance account' }));
    expect(find('POST', '/api/v1/practice/account/reset')).toHaveLength(0);
    const confirm = within(screen.getByRole('group', { name: 'Reset Binance account' }));
    expect(confirm.getByText(/start again at 10,000 USDT/)).toBeTruthy();
    await u.click(confirm.getByRole('button', { name: 'Reset the account' }));
    await waitFor(() => expect(find('POST', '/api/v1/practice/account/reset')).toHaveLength(1));
    expect(find('POST', '/api/v1/practice/account/reset')[0]!.body).toEqual({ venue: 'binance' });
  });

  it('shows the settings card to admins only, and saves fees as fractions', async () => {
    api();
    await practicePage();
    expect(screen.queryByRole('heading', { name: 'Practice settings (admin)' })).toBeNull();
    cleanup();

    const { find } = api({
      extra: {
        'GET /api/v1/admin/settings/practice': DEFAULT_PRACTICE_SETTINGS,
        'PUT /api/v1/admin/settings/practice': (r: ApiRequest) => r.body,
      },
    });
    await practicePage('/practice', 'admin');
    const u = userEvent.setup();
    const maker = await screen.findByLabelText('Binance maker fee, percent');
    expect((maker as HTMLInputElement).value).toBe('0.1');
    await u.clear(maker);
    await u.type(maker, '0.075');
    await u.click(screen.getByRole('button', { name: 'Save practice settings' }));
    await screen.findByText('Practice settings saved');
    const [put] = find('PUT', '/api/v1/admin/settings/practice');
    expect((put!.body as typeof DEFAULT_PRACTICE_SETTINGS).fees.binance).toEqual({
      maker: '0.00075',
      taker: '0.001',
    });
    expect((put!.body as typeof DEFAULT_PRACTICE_SETTINGS).startingBalances).toEqual(
      DEFAULT_PRACTICE_SETTINGS.startingBalances,
    );
  });
});
