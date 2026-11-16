import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AlertRule,
  type AutoDecision,
  channels,
  DEFAULT_AUTO_RULES,
  DEFAULT_PRACTICE_SETTINGS,
  PRACTICE_BANNER,
  type PracticeAccount,
  type PracticeFill,
  type PracticeOrder,
  type PracticeStrategy,
} from '@cip/contracts';
import { AUTO_TRADE_ALERTS } from '../lib/alert-rules.js';
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

const STRATEGY: PracticeStrategy = {
  enabled: false,
  rules: DEFAULT_AUTO_RULES,
  version: 0,
  pausedUntil: null,
  updatedAt: null,
  today: { orders: 0, result: '0', asset: 'USDT' },
};

/** One of the user's alert rules, as `GET /alerts/rules` lists it. */
function alertRule(n: number, extra: Partial<AlertRule> = {}): AlertRule {
  return {
    id: id(900 + n),
    ownerId: id(1),
    name: `Rule ${n}`,
    enabled: true,
    scope: {},
    condition: { kind: 'practice_auto_order' },
    severity: 'info',
    cooldownSec: 300,
    channels: ['in_app'],
    quietHours: null,
    version: 1,
    createdAt: T,
    updatedAt: T,
    ...extra,
  };
}

function api(
  opts: {
    open?: PracticeOrder[];
    done?: PracticeOrder[];
    /** The user's alert rules: `POST /alerts/rules` adds to them. */
    rules?: AlertRule[];
    extra?: Record<string, unknown>;
  } = {},
) {
  const rules = [...(opts.rules ?? [])];
  return mockApi({
    'GET /api/v1/alerts/rules': () => rules,
    'POST /api/v1/alerts/rules': (r: ApiRequest) => {
      const created = alertRule(rules.length, r.body as Partial<AlertRule>);
      rules.push(created);
      return json(201, created);
    },
    'GET /api/v1/instruments': [BTC_BINANCE, BTC_COINBASE, USDT_COINBASE],
    'GET /api/v1/practice/account': { accounts: [BINANCE, COINBASE], fees: DEFAULT_PRACTICE_SETTINGS.fees },
    'GET /api/v1/practice/orders': (r: ApiRequest) => ({
      items: r.url.searchParams.get('status') === 'open' ? (opts.open ?? []) : (opts.done ?? []),
      nextCursor: null,
    }),
    'GET /api/v1/practice/fills': { items: [], nextCursor: null },
    'GET /api/v1/practice/positions': [],
    'GET /api/v1/practice/automatic': STRATEGY,
    'GET /api/v1/practice/automatic/decisions': { items: [], nextCursor: null },
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

describe('Automatic practice trading (Phase 16)', () => {
  const card = () => within(screen.getByRole('region', { name: 'Automatic trading (simulated)' }));
  const decision = (n: number, extra: Partial<AutoDecision> = {}): AutoDecision => ({
    id: id(700 + n),
    setupId: id(800 + n),
    instrumentId: BTC_BINANCE.id,
    pattern: 'htf_order_block',
    outcome: 'skipped',
    reason: 'score',
    orderId: null,
    order: null,
    strategyVersion: 1,
    decidedAt: T + n,
    ...extra,
  });

  it('switches on only after the user confirms the saved rules, and says it is simulated (16.9)', async () => {
    const { find } = api({
      extra: {
        'POST /api/v1/practice/automatic/on': { ...STRATEGY, enabled: true, version: 1 },
      },
    });
    await practicePage();
    const c = await waitFor(() => card());
    expect(c.getByText('Off')).toBeTruthy();
    expect(c.getByText(/no real money, and nothing reaches an exchange/)).toBeTruthy();
    expect(c.getByText(/The AI never decides an order/)).toBeTruthy();

    const u = userEvent.setup();
    await u.click(c.getByRole('switch', { name: 'Automatic practice trading' }));
    const confirm = c.getByRole('group', { name: 'Switch on automatic practice trading' });
    // The default since 2026-11-16: a fixed 10 USDT a buy.
    expect(within(confirm).getByText(/each spending about 10 USDT, with a stop and a target/)).toBeTruthy();
    expect(find('POST', '/api/v1/practice/automatic/on')).toHaveLength(0);
    await u.click(within(confirm).getByRole('button', { name: 'Keep it off' }));
    expect(find('POST', '/api/v1/practice/automatic/on')).toHaveLength(0);

    await u.click(c.getByRole('switch', { name: 'Automatic practice trading' }));
    // Changed 2026-11-16: it offers notifications of each automatic trade, ticked.
    expect(c.getByLabelText<HTMLInputElement>(/Notify me of each automatic buy and sale/).checked).toBe(true);
    await u.click(c.getByRole('button', { name: 'Switch on' }));
    await waitFor(() => expect(c.getByText('On')).toBeTruthy());
    expect(find('POST', '/api/v1/practice/automatic/on')[0]!.body).toEqual({ version: 0 });
    expect(
      screen.getByText(
        'Automatic practice trading is on. You will be notified of each automatic buy and sale.',
      ),
    ).toBeTruthy();
    expect(find('POST', '/api/v1/alerts/rules').map((r) => r.body)).toEqual(AUTO_TRADE_ALERTS);
    await waitFor(() =>
      expect(c.getByText(/Notifications are on for each automatic buy placed/)).toBeTruthy(),
    );
    expect(c.getByRole('link', { name: 'Alert Center' }).getAttribute('href')).toBe('/alerts');
    expect(c.getByRole('button', { name: 'Stop and cancel its orders' })).toBeTruthy();
  });

  it('offers to notify of each automatic trade with one click, making only the rules still missing (changed 2026-11-16)', async () => {
    const { find } = api({
      rules: [
        alertRule(0, { condition: { kind: 'practice_auto_order' } }),
        alertRule(1, { condition: { kind: 'practice_exit', on: ['stop'] } }),
        alertRule(2, { condition: { kind: 'practice_order_filled' }, enabled: false }),
        alertRule(3, { condition: { kind: 'practice_auto_paused' }, scope: { venues: ['binance'] } }),
      ],
    });
    await practicePage();
    const c = await waitFor(() => card());
    await waitFor(() => expect(c.getByText('You are not notified of every automatic trade.')).toBeTruthy());
    const u = userEvent.setup();
    await u.click(c.getByRole('button', { name: 'Notify me of automatic trades' }));
    await waitFor(() =>
      expect(c.getByText(/Notifications are on for each automatic buy placed/)).toBeTruthy(),
    );
    expect(find('POST', '/api/v1/alerts/rules').map((r) => r.body)).toEqual([
      AUTO_TRADE_ALERTS[1],
      {
        ...AUTO_TRADE_ALERTS[2],
        name: 'Practice target sold',
        condition: { kind: 'practice_exit', on: ['target'] },
      },
      AUTO_TRADE_ALERTS[3],
    ]);
    expect(screen.getByText('You will be notified of each automatic buy and sale.')).toBeTruthy();
    // Notified of everything: switching on offers nothing more and makes no rule.
    await u.click(c.getByRole('switch', { name: 'Automatic practice trading' }));
    const confirm = c.getByRole('group', { name: 'Switch on automatic practice trading' });
    expect(within(confirm).queryByLabelText(/Notify me/)).toBeNull();
  });

  it('switches on without notifications when the box is cleared, and says when they could not be made', async () => {
    let refuse = false;
    const { find } = api({
      extra: {
        'POST /api/v1/practice/automatic/on': { ...STRATEGY, enabled: true, version: 1 },
        'POST /api/v1/alerts/rules': () =>
          refuse
            ? json(409, {
                type: 'about:blank',
                title: 'Conflict',
                status: 409,
                code: 'CONFLICT',
                detail: 'You can have at most 100 alert rules.',
              })
            : json(201, alertRule(0)),
      },
    });
    await practicePage();
    const c = await waitFor(() => card());
    await waitFor(() => expect(c.getByText('You are not notified of automatic trades.')).toBeTruthy());
    const u = userEvent.setup();
    await u.click(c.getByRole('switch', { name: 'Automatic practice trading' }));
    await u.click(c.getByLabelText(/Notify me of each automatic buy and sale/));
    await u.click(c.getByRole('button', { name: 'Switch on' }));
    await waitFor(() => expect(c.getByText('On')).toBeTruthy());
    expect(screen.getByText('Automatic practice trading is on.')).toBeTruthy();
    expect(find('POST', '/api/v1/alerts/rules')).toHaveLength(0);

    // The button, when the rules cannot be made: it says why.
    refuse = true;
    await u.click(c.getByRole('button', { name: 'Notify me of automatic trades' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The notifications could not be set up');
    expect(alert.textContent).toContain('You can have at most 100 alert rules.');
  });

  it('checks the rules before saving them against the version it read, and says when they changed elsewhere', async () => {
    let conflict = true;
    const { find } = api({
      extra: {
        'PUT /api/v1/practice/automatic': (r: ApiRequest) =>
          conflict
            ? json(409, {
                type: 'about:blank',
                title: 'Conflict',
                status: 409,
                code: 'CONFLICT',
                detail: 'stale',
              })
            : { ...STRATEGY, version: 1, rules: (r.body as { rules: PracticeStrategy['rules'] }).rules },
      },
    });
    await practicePage();
    const c = await waitFor(() => card());
    const u = userEvent.setup();
    await u.click(c.getByLabelText('A share of the balance at risk'));
    expect(c.queryByLabelText('Amount per buy (USDT)')).toBeNull();
    const risk = c.getByLabelText('Risk per trade (% of the free balance)');
    await u.clear(risk);
    await u.type(risk, '3');
    for (const p of [
      'Double liquidity trap',
      'Equal highs or lows near a POI',
      'Higher-timeframe order block',
      'Sweep outside, fill inside',
    ])
      await u.click(c.getByLabelText(p));
    // Unsaved changes: it cannot be switched on with them.
    expect(c.getByRole<HTMLButtonElement>('switch', { name: 'Automatic practice trading' }).disabled).toBe(
      true,
    );
    await u.click(c.getByRole('button', { name: 'Save rules' }));
    expect(c.getByText('From 0.1 to 2.')).toBeTruthy();
    expect(c.getByText('Choose at least one pattern.')).toBeTruthy();
    expect(risk.getAttribute('aria-invalid')).toBe('true');
    expect(find('PUT', '/api/v1/practice/automatic')).toHaveLength(0);

    await u.clear(risk);
    await u.type(risk, '0.5');
    await u.click(c.getByLabelText('Higher-timeframe order block'));
    await u.click(c.getByLabelText('BTC/USDT'));
    await u.click(c.getByRole('button', { name: 'Save rules' }));
    await waitFor(() => expect(c.getByText('Changed in another tab or device')).toBeTruthy());

    conflict = false;
    await u.click(c.getByRole('button', { name: 'Save rules' }));
    await waitFor(() => expect(screen.getByText('Automatic trading rules saved.')).toBeTruthy());
    expect(find('PUT', '/api/v1/practice/automatic').at(-1)!.body).toEqual({
      version: 0,
      rules: {
        ...DEFAULT_AUTO_RULES,
        instrumentIds: [BTC_BINANCE.id],
        patterns: ['htf_order_block'],
        sizing: 'risk',
        riskPct: 0.5,
      },
    });
  });

  it('sizes each buy at a fixed amount by default, in the account’s quote currency, and checks it', async () => {
    const { find } = api({
      extra: {
        'PUT /api/v1/practice/automatic': (r: ApiRequest) => ({
          ...STRATEGY,
          version: 1,
          rules: (r.body as { rules: PracticeStrategy['rules'] }).rules,
        }),
      },
    });
    await practicePage();
    const c = await waitFor(() => card());
    const u = userEvent.setup();
    expect(c.getByLabelText<HTMLInputElement>('A fixed amount').checked).toBe(true);
    const amount = c.getByLabelText<HTMLInputElement>('Amount per buy (USDT)');
    expect(amount.value).toBe('10');
    expect(c.queryByLabelText('Risk per trade (% of the free balance)')).toBeNull();
    await u.clear(amount);
    await u.type(amount, '0.5');
    await u.click(c.getByRole('button', { name: 'Save rules' }));
    expect(c.getByText('From 1 to 100,000.')).toBeTruthy();
    expect(find('PUT', '/api/v1/practice/automatic')).toHaveLength(0);
    await u.clear(amount);
    await u.type(amount, '25');
    await u.click(c.getByRole('button', { name: 'Save rules' }));
    await waitFor(() => expect(screen.getByText('Automatic trading rules saved.')).toBeTruthy());
    expect(find('PUT', '/api/v1/practice/automatic').at(-1)!.body).toEqual({
      version: 0,
      rules: { ...DEFAULT_AUTO_RULES, amount: 25 },
    });
    // On the Coinbase practice account the amount is in US dollars.
    await u.selectOptions(c.getByLabelText('Practice account'), 'coinbase');
    expect(c.getByLabelText('Amount per buy (USD)')).toBeTruthy();
  });

  it('stops after confirming, cancelling its working orders; labels them Automatic (16.3, 16.7)', async () => {
    const auto = order(30, { source: 'auto', setupId: SETUP_ID });
    const { find } = api({
      open: [auto],
      extra: {
        'GET /api/v1/practice/automatic': { ...STRATEGY, enabled: true, version: 4 },
        'POST /api/v1/practice/automatic/stop': () => json(202, { ...STRATEGY, enabled: false, version: 5 }),
      },
    });
    await practicePage();
    await waitFor(() => expect(openTable().getByText('Automatic')).toBeTruthy());
    const c = card();
    const u = userEvent.setup();
    await u.click(await c.findByRole('button', { name: 'Stop and cancel its orders' }));
    const confirm = c.getByRole('group', { name: 'Stop automatic practice trading' });
    expect(within(confirm).getByText(/its working order is cancelled/)).toBeTruthy();
    expect(find('POST', '/api/v1/practice/automatic/stop')).toHaveLength(0);
    await u.click(within(confirm).getByRole('button', { name: 'Stop it' }));
    await waitFor(() => expect(c.getByText('Stopping')).toBeTruthy());
    expect(c.getByText(/What it bought stays in your practice balance/)).toBeTruthy();
    expect(find('POST', '/api/v1/practice/automatic/stop')).toHaveLength(1);
  });

  it('shows today’s figures, the pause, and every decision with its reason, page by page (16.1, 16.2)', async () => {
    const until = Date.UTC(2026, 10, 15);
    api({
      extra: {
        'GET /api/v1/practice/automatic': {
          ...STRATEGY,
          enabled: true,
          version: 2,
          pausedUntil: until,
          today: { orders: 3, result: '-310.5', asset: 'USDT' },
        },
        'GET /api/v1/practice/automatic/decisions': (r: ApiRequest) =>
          r.url.searchParams.get('cursor')
            ? {
                items: [decision(1, { outcome: 'cancelled', reason: 'stopped', orderId: id(31) })],
                nextCursor: null,
              }
            : {
                items: [
                  decision(4, { outcome: 'skipped', reason: 'paused' }),
                  decision(3, { outcome: 'refused', reason: 'data_delayed', orderId: id(32) }),
                  decision(2, {
                    outcome: 'placed',
                    reason: null,
                    orderId: id(33),
                    order: { quantity: '0.5', limitPrice: '99', stop: '97', target: '105' },
                  }),
                ],
                nextCursor: 'next',
              },
      },
    });
    await practicePage();
    const c = await waitFor(() => card());
    await waitFor(() => expect(c.getByText('Paused for today', { selector: 'span' })).toBeTruthy());
    expect(c.getByText(/3 automatic buys placed/)).toBeTruthy();
    expect(c.getByText('−310.5 USDT')).toBeTruthy();
    const log = within(await c.findByRole('table', { name: 'Automatic trading decisions, newest first' }));
    expect(log.getByText('Paused for the day: the daily loss limit was reached.')).toBeTruthy();
    expect(log.getByText(/The order checks refused it/)).toBeTruthy();
    expect(log.getByText('Buy 0.5 at 99, stop 97, target 105')).toBeTruthy();
    expect(log.getByText('Matched your rules.')).toBeTruthy();
    const u = userEvent.setup();
    await u.click(c.getByRole('button', { name: 'Show older decisions' }));
    await waitFor(() => expect(log.getByText('You stopped automatic trading.')).toBeTruthy());
  });

  it('reads its state again and announces a placed order when the practice channel says so', async () => {
    let calls = 0;
    api({
      extra: {
        'GET /api/v1/practice/automatic': () => {
          calls += 1;
          return {
            ...STRATEGY,
            enabled: true,
            version: 1,
            today: { orders: calls > 1 ? 1 : 0, result: '0', asset: 'USDT' },
          };
        },
      },
    });
    const { server } = await practicePage();
    const c = await waitFor(() => card());
    await waitFor(() => expect(c.getByText(/0 automatic buys placed/)).toBeTruthy());
    await waitFor(() => expect(server.subscribed()).toContain(channels.practice));
    server.push(channels.practice, 'practice.automatic', {
      event: 'decision',
      decision: decision(9, {
        outcome: 'placed',
        reason: null,
        orderId: id(40),
        order: { quantity: '1', limitPrice: '99', stop: '97', target: '105' },
      }),
    });
    await waitFor(() => expect(c.getByText(/1 automatic buy placed/)).toBeTruthy());
    expect(screen.getByText('Automatic practice buy placed on BTC/USDT. Simulated.')).toBeTruthy();
  });
});
