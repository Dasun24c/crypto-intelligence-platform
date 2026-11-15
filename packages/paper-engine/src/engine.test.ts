import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { dec } from '@cip/domain';
import { bestPrice, isThin, take } from './book.js';
import { fillDigestLine } from './digest.js';
import { PaperEngine } from './engine.js';
import { checkOrderRules, compareStreamIds, isMultipleOf } from './rules.js';
import type { Book, EngineOrder, InstrumentRules, LedgerEntry, NewOrder, Outputs, Trade } from './types.js';

const BTC: InstrumentRules = {
  instrumentId: 'btc',
  venue: 'binance',
  base: 'BTC',
  quote: 'USDT',
  priceTick: '0.01',
  qtyStep: '0.00001',
  minNotional: '5',
};
const CB: InstrumentRules = { ...BTC, instrumentId: 'cb', venue: 'coinbase', quote: 'USD' };
const FEES: Record<string, { maker: string; taker: string }> = {
  binance: { maker: '0.001', taker: '0.001' },
  coinbase: { maker: '0.005', taker: '0.009' },
};
const RULES: Record<string, InstrumentRules> = { btc: BTC, cb: CB };

function engine(maxOpenOrders?: number): PaperEngine {
  const e = new PaperEngine({
    rules: (id) => RULES[id],
    fees: (venue) => FEES[venue]!,
    fillId: (orderId, n) => `${orderId}#${n}`,
    ...(maxOpenOrders ? { maxOpenOrders } : {}),
  });
  e.load([
    { id: 'acc', venue: 'binance', epoch: 0, available: { USDT: '10000' } },
    { id: 'cbacc', venue: 'coinbase', epoch: 0, available: { USD: '10000' } },
  ]);
  return e;
}

const book = (bids: [string, string][], asks: [string, string][], instrumentId = 'btc'): Book => ({
  instrumentId,
  ts: 1,
  bids,
  asks,
});
const DEEP = book(
  [
    ['99.90', '5'],
    ['95.00', '5'],
  ],
  [
    ['100.00', '5'],
    ['101.00', '5'],
  ],
);
const ctx = (b: Book | null = DEEP, lastTrade = '0-0') => ({
  now: 1000,
  health: 'ok' as const,
  book: b,
  lastTrade,
});

function order(over: Partial<NewOrder> = {}): NewOrder {
  return {
    id: 'o1',
    accountId: 'acc',
    instrumentId: 'btc',
    side: 'buy',
    type: 'market',
    quantity: '0.1',
    limitPrice: null,
    underlyingClosed: false,
    stop: null,
    target: null,
    ocoGroup: null,
    ...over,
  };
}

let tradeN = 0;
function trade(
  price: string,
  quantity: string,
  streamId = `${10 + ++tradeN}-0`,
  instrumentId = 'btc',
): Trade {
  return { instrumentId, id: `t${tradeN}`, streamId, ts: 2000 + tradeN, price, quantity };
}

const byId = (out: Outputs, id: string): EngineOrder => {
  const o = out.orders.find((x) => x.id === id);
  if (!o) throw new Error(`order ${id} not in the outputs`);
  return o;
};
const avail = (e: PaperEngine, asset: string, account = 'acc') => e.account(account).available[asset] ?? '0';

describe('order rules', () => {
  it('checks steps and the minimum value', () => {
    expect(isMultipleOf('0.12345', '0.00001')).toBe(true);
    expect(isMultipleOf('0.123456', '0.00001')).toBe(false);
    expect(isMultipleOf('7.3', '0')).toBe(true);
    const check = (quantity: string, prices: (string | null)[], ref: string | null) =>
      checkOrderRules(BTC, { quantity, prices, referencePrice: ref });
    expect(check('0.1', ['100.00'], '100')).toBeNull();
    expect(check('0.100001', [null], '100')).toBe('quantity_step');
    expect(check('0.1', ['100.001'], '100')).toBe('price_step');
    expect(check('0.01', [null], '100')).toBe('min_value');
    expect(check('0.01', [null], null)).toBeNull();
  });

  it('orders stream ids by time, then sequence', () => {
    expect(compareStreamIds('10-0', '9-5')).toBeGreaterThan(0);
    expect(compareStreamIds('10-1', '10-2')).toBeLessThan(0);
    expect(compareStreamIds('10-1', '10-1')).toBe(0);
    expect(compareStreamIds('10', '10-0')).toBe(0);
  });
});

describe('book walks', () => {
  it('takes levels best first, up to a limit, and says when the book ran out', () => {
    const t = take(DEEP.asks, 'buy', dec('6'), null);
    expect(t.parts).toEqual([
      { price: '100', quantity: '5' },
      { price: '101', quantity: '1' },
    ]);
    expect(t.value.toString()).toBe('601');
    expect(t.exhausted).toBe(false);
    const limited = take(DEEP.asks, 'buy', dec('6'), dec('100'));
    expect(limited.filled.toString()).toBe('5');
    expect(limited.exhausted).toBe(true);
    const sell = take(DEEP.bids, 'sell', dec('7'), dec('96'));
    expect(sell.parts).toEqual([{ price: '99.9', quantity: '5' }]);
    expect(bestPrice(DEEP, 'buy')).toBe('100.00');
    expect(bestPrice(DEEP, 'sell')).toBe('99.90');
    expect(bestPrice(null, 'buy')).toBeNull();
    expect(bestPrice(book([], []), 'sell')).toBeNull();
  });

  it('flags an order that takes more than a fifth of the depth near the best price', () => {
    expect(isThin(DEEP.asks, 'buy', dec('1'), false)).toBe(false); // 1 of 5 within 0.5 %
    expect(isThin(DEEP.asks, 'buy', dec('1.1'), false)).toBe(true);
    expect(isThin(DEEP.bids, 'sell', dec('0.5'), false)).toBe(false);
    expect(isThin(DEEP.asks, 'buy', dec('0.1'), true)).toBe(true);
    expect(isThin([], 'buy', dec('0.1'), false)).toBe(true);
  });
});

describe('market orders', () => {
  it('walk the book with slippage, pay the taker fee and settle the balances', () => {
    const e = engine();
    const out = e.place(order({ quantity: '6' }), ctx());
    expect(out.fills.map((f) => [f.price, f.quantity, f.fee, f.liquidity])).toEqual([
      ['100', '5', '0.5', 'taker'],
      ['101', '1', '0.101', 'taker'],
    ]);
    expect(byId(out, 'o1')).toMatchObject({
      status: 'filled',
      filled: '6',
      filledValue: '601',
      reserved: '0',
    });
    expect(avail(e, 'USDT')).toBe('9398.399'); // 10000 − 601 − 0.601
    expect(avail(e, 'BTC')).toBe('6');
    expect(out.fills[0]!.basis).toEqual({
      book: {
        ts: 1,
        levels: [
          ['100', '5'],
          ['101', '1'],
        ],
      },
    });
    expect(out.fills[0]!.flags).toEqual(['thin_book']);
  });

  it('cancel what the book cannot fill', () => {
    const e = engine();
    const out = e.place(order({ quantity: '11' }), ctx());
    expect(byId(out, 'o1')).toMatchObject({ status: 'cancelled', filled: '10' });
    expect(out.fills.every((f) => f.flags.includes('thin_book'))).toBe(true);
  });

  it('sell only what the account holds', () => {
    const e = engine();
    expect(byId(e.place(order({ side: 'sell' }), ctx()), 'o1')).toMatchObject({
      status: 'refused',
      refusalReason: 'insufficient_balance',
    });
    e.place(order({ id: 'b', quantity: '1' }), ctx());
    const out = e.place(order({ id: 's', side: 'sell', quantity: '1' }), ctx());
    expect(out.fills.map((f) => [f.price, f.quantity])).toEqual([['99.9', '1']]);
    expect(avail(e, 'BTC')).toBe('0');
    expect(avail(e, 'USDT')).toBe('9999.7001'); // 10000 − 100.1 + 99.9 − 0.0999
  });

  it('are refused without a market, or without the balance for what the book would cost', () => {
    const e = engine();
    expect(byId(e.place(order(), ctx(null)), 'o1').refusalReason).toBe('no_market');
    expect(byId(e.place(order(), ctx(book([], []))), 'o1').refusalReason).toBe('no_market');
    expect(
      byId(e.place(order({ quantity: '100' }), ctx(book([], [['100', '200']]))), 'o1').refusalReason,
    ).toBe('insufficient_balance');
  });
});

describe('refusals (TRD-07 and the venue rules)', () => {
  it('refuse orders when the data is not sound, or the order breaks the rules', () => {
    const e = engine();
    for (const health of ['data_delayed', 'data_gap', 'pair_halted'] as const)
      expect(byId(e.place(order(), { ...ctx(), health }), 'o1').refusalReason).toBe(health);
    const reason = (o: Partial<NewOrder>) => byId(e.place(order(o), ctx()), o.id ?? 'o1').refusalReason;
    expect(reason({ type: 'limit', limitPrice: '99.001' })).toBe('price_step');
    expect(reason({ quantity: '0.000001' })).toBe('quantity_step');
    expect(reason({ quantity: '0.01' })).toBe('min_value');
    expect(reason({ instrumentId: 'nope' })).toBe('not_practice_pair');
    expect(reason({ instrumentId: 'cb' })).toBe('not_practice_pair'); // a Coinbase pair on the Binance account
    expect(reason({ type: 'limit', limitPrice: '100.00', quantity: '200' })).toBe('insufficient_balance');
  });

  it('refuse an order beyond the open-order limit, with its legs', () => {
    const e = engine(2);
    e.place(order({ id: 'a', type: 'limit', limitPrice: '90.00' }), ctx());
    e.place(order({ id: 'b', type: 'limit', limitPrice: '90.00' }), ctx());
    const out = e.place(
      order({
        id: 'c',
        type: 'limit',
        limitPrice: '90.00',
        stop: { id: 'cs', price: '80.00' },
        ocoGroup: 'g',
      }),
      ctx(),
    );
    expect(out.orders.map((o) => [o.id, o.status, o.refusalReason])).toEqual([
      ['c', 'refused', 'too_many_open_orders'],
      ['cs', 'refused', 'too_many_open_orders'],
    ]);
  });
});

describe('limit orders', () => {
  it('hold their cost and fill only on trades through their price, at their price, up to the traded quantity', () => {
    const e = engine();
    const placed = e.place(order({ type: 'limit', limitPrice: '99.00', quantity: '0.2' }), ctx());
    expect(byId(placed, 'o1')).toMatchObject({ status: 'open', reserved: '19.8198' }); // 0.2 × 99 × 1.001
    expect(avail(e, 'USDT')).toBe('9980.1802');
    expect(e.trade(trade('99.00', '5'), { health: 'ok', book: null }).fills).toEqual([]); // at the limit: no
    const first = e.trade(trade('98.99', '0.05'), { health: 'ok', book: null });
    expect(first.fills.map((f) => [f.price, f.quantity, f.fee, f.liquidity])).toEqual([
      ['99.00', '0.05', '0.00495', 'maker'],
    ]);
    expect(byId(first, 'o1')).toMatchObject({
      status: 'partially_filled',
      filled: '0.05',
      reserved: '14.86485',
    });
    expect(first.fills[0]!.basis).toMatchObject({ trade: { price: '98.99', quantity: '0.05' } });
    const rest = e.trade(trade('98.00', '1'), { health: 'ok', book: null });
    expect(byId(rest, 'o1')).toMatchObject({ status: 'filled', filled: '0.2', reserved: '0' });
    expect(avail(e, 'USDT')).toBe('9980.1802');
    expect(avail(e, 'BTC')).toBe('0.2');
  });

  it('take at once what the book offers within their limit, and rest the remainder', () => {
    const e = engine();
    const out = e.place(order({ type: 'limit', limitPrice: '100.00', quantity: '6' }), ctx());
    expect(out.fills.map((f) => [f.price, f.quantity, f.liquidity])).toEqual([['100', '5', 'taker']]);
    expect(byId(out, 'o1')).toMatchObject({ status: 'partially_filled', filled: '5', reserved: '100.1' });
  });

  it('keep the difference when a maker fee is below the taker fee they held for', () => {
    const e = engine();
    e.place(
      order({
        id: 'c',
        accountId: 'cbacc',
        instrumentId: 'cb',
        type: 'limit',
        limitPrice: '100.00',
        quantity: '1',
      }),
      {
        ...ctx(book([], [], 'cb')),
      },
    );
    expect(avail(e, 'USD', 'cbacc')).toBe('9899.1'); // 100 × 1.009 held
    e.trade(trade('99.00', '5', '50-0', 'cb'), { health: 'ok', book: null });
    expect(avail(e, 'USD', 'cbacc')).toBe('9899.5'); // 100 + 0.5 maker fee spent
  });

  it('ignore trades printed before they were accepted, and fill nothing while the data is not sound', () => {
    const e = engine();
    e.place(order({ type: 'limit', limitPrice: '99.00' }), ctx(DEEP, '20-0'));
    expect(e.trade(trade('98.00', '1', '19-9'), { health: 'ok', book: null }).fills).toEqual([]);
    expect(e.trade(trade('98.00', '1', '20-1'), { health: 'data_gap', book: null }).fills).toEqual([]);
    expect(e.trade(trade('98.00', '1', '20-2'), { health: 'ok', book: null }).fills).toHaveLength(1);
  });

  it('share a trade between resting orders by price, then time', () => {
    const e = engine();
    e.place(order({ id: 'low', type: 'limit', limitPrice: '99.00' }), ctx());
    e.place(order({ id: 'high', type: 'limit', limitPrice: '99.50' }), ctx());
    e.place(order({ id: 'high2', type: 'limit', limitPrice: '99.50' }), ctx());
    const out = e.trade(trade('98.00', '0.15'), { health: 'ok', book: null });
    expect(out.fills.map((f) => [f.orderId, f.quantity])).toEqual([
      ['high', '0.1'],
      ['high2', '0.05'],
    ]);
  });

  it('sell on trades above their price', () => {
    const e = engine();
    e.place(order({ id: 'b', quantity: '1' }), ctx());
    e.place(order({ id: 's', side: 'sell', type: 'limit', limitPrice: '105.00', quantity: '1' }), ctx());
    expect(avail(e, 'BTC')).toBe('0');
    expect(e.trade(trade('105.00', '1'), { health: 'ok', book: null }).fills).toEqual([]);
    const out = e.trade(trade('105.01', '2'), { health: 'ok', book: null });
    expect(byId(out, 's')).toMatchObject({ status: 'filled', reserved: '0' });
    expect(avail(e, 'USDT')).toBe('10004.795'); // 10000 − 100.1 + 105 − 0.105
  });

  it('release what they hold when cancelled; cancelling twice changes nothing', () => {
    const e = engine();
    e.place(order({ type: 'limit', limitPrice: '99.00', quantity: '0.2' }), ctx());
    const out = e.cancel('o1');
    expect(byId(out, 'o1')).toMatchObject({ status: 'cancelled', reserved: '0' });
    expect(avail(e, 'USDT')).toBe('10000');
    expect(e.cancel('o1')).toEqual({ orders: [], fills: [], ledger: [] });
  });
});

describe('a stop and a target', () => {
  const bracket = (over: Partial<NewOrder> = {}) =>
    order({
      quantity: '1',
      stop: { id: 'stop', price: '90.00' },
      target: { id: 'target', price: '110.00' },
      ocoGroup: 'g',
      ...over,
    });

  it('wait for the buy, then protect what it bought, holding its base', () => {
    const e = engine();
    const out = e.place(bracket(), ctx());
    expect(byId(out, 'stop')).toMatchObject({ status: 'open', quantity: '1', reserved: '0' });
    expect(byId(out, 'target')).toMatchObject({ status: 'open', quantity: '1', reserved: '1' });
    expect(avail(e, 'BTC')).toBe('0');
    expect(e.needsBook('btc')).toBe(true);

    const resting = engine();
    const placed = resting.place(bracket({ type: 'limit', limitPrice: '95.00' }), ctx());
    expect(byId(placed, 'stop').status).toBe('pending');
    expect(resting.needsBook('btc')).toBe(false);
    const filled = resting.trade(trade('94.00', '0.4'), { health: 'ok', book: null });
    expect(byId(filled, 'target')).toMatchObject({ status: 'open', quantity: '0.4', reserved: '0.4' });
  });

  it('target filling cancels the stop (one-cancels-other) and keeps selling the rest', () => {
    const e = engine();
    e.place(bracket(), ctx());
    const out = e.trade(trade('110.01', '0.4'), { health: 'ok', book: null });
    expect(byId(out, 'target')).toMatchObject({ status: 'partially_filled', filled: '0.4', reserved: '0.6' });
    expect(byId(out, 'stop')).toMatchObject({ status: 'cancelled' });
    expect(e.needsBook('btc')).toBe(false);
    e.trade(trade('110.50', '5'), { health: 'ok', book: null });
    expect(avail(e, 'BTC')).toBe('0');
  });

  it('a stop triggers on a trade at its price and sells against the book', () => {
    const e = engine();
    e.place(bracket(), ctx());
    const out = e.trade(trade('90.00', '0.01'), { health: 'ok', book: DEEP });
    expect(out.fills.map((f) => [f.orderId, f.price, f.quantity, f.liquidity])).toEqual([
      ['stop', '99.9', '1', 'taker'],
    ]);
    expect(out.fills[0]!.basis).toMatchObject({
      trade: { price: '90.00' },
      book: { levels: [['99.9', '1']] },
    });
    expect(byId(out, 'stop')).toMatchObject({ status: 'filled', reserved: '0' });
    expect(byId(out, 'target')).toMatchObject({ status: 'cancelled', reserved: '0' });
    expect(avail(e, 'BTC')).toBe('0');
  });

  it('a triggered stop with no book waits for the next trade with one', () => {
    const e = engine();
    e.place(bracket(), ctx());
    expect(e.trade(trade('89.00', '1'), { health: 'ok', book: null }).fills).toEqual([]);
    expect(e.trade(trade('89.00', '1'), { health: 'ok', book: DEEP }).fills).toHaveLength(1);
  });

  it('cancelling one leg cancels both and frees the base; cancelling an unfilled buy takes its legs with it', () => {
    const e = engine();
    e.place(bracket(), ctx());
    const out = e.cancel('stop');
    expect(out.orders.map((o) => [o.id, o.status])).toEqual([
      ['stop', 'cancelled'],
      ['target', 'cancelled'],
    ]);
    expect(avail(e, 'BTC')).toBe('1');

    const resting = engine();
    resting.place(bracket({ type: 'limit', limitPrice: '95.00' }), ctx());
    expect(resting.cancel('o1').orders.map((o) => [o.id, o.status])).toEqual([
      ['o1', 'cancelled'],
      ['stop', 'cancelled'],
      ['target', 'cancelled'],
    ]);
  });

  it('cancelling a partly filled buy keeps its legs for what it bought', () => {
    const e = engine();
    e.place(bracket({ type: 'limit', limitPrice: '95.00' }), ctx());
    e.trade(trade('94.00', '0.4'), { health: 'ok', book: null });
    const out = e.cancel('o1');
    expect(out.orders.map((o) => o.id)).toEqual(['o1']);
    expect(e.liveOrders().map((o) => [o.id, o.quantity])).toEqual([
      ['stop', '0.4'],
      ['target', '0.4'],
    ]);
  });
});

describe('accounts', () => {
  it('reset cancels live orders and starts a new period at the starting balances', () => {
    const e = engine();
    e.place(order({ id: 'b', quantity: '1' }), ctx());
    e.place(order({ id: 'l', type: 'limit', limitPrice: '90.00' }), ctx());
    const out = e.reset('acc', { USDT: '10000' });
    expect(out.orders.map((o) => [o.id, o.status])).toEqual([['l', 'cancelled']]);
    expect(out.ledger.at(-1)).toEqual({
      accountId: 'acc',
      epoch: 1,
      asset: 'USDT',
      amount: '10000',
      reason: 'start',
      orderId: null,
      fillId: null,
    });
    expect(e.account('acc')).toEqual({ id: 'acc', venue: 'binance', epoch: 1, available: { USDT: '10000' } });
    expect(e.liveOrders()).toEqual([]);
  });

  it('flags fills of an order placed while the gold market was closed', () => {
    const e = engine();
    const out = e.place(order({ underlyingClosed: true, quantity: '0.1' }), ctx());
    expect(out.fills[0]!.flags).toEqual(['underlying_closed']);
  });

  it('carries live orders over a restart', () => {
    const e = engine();
    e.place(order({ type: 'limit', limitPrice: '99.00', quantity: '0.2' }), ctx());
    const restarted = engine();
    restarted.load([e.account('acc')], e.liveOrders());
    expect(restarted.hasAccount('acc')).toBe(true);
    expect(restarted.trade(trade('98.00', '1'), { health: 'ok', book: null }).fills).toHaveLength(1);
    expect(() => restarted.place(order({ accountId: 'nobody' }), ctx())).toThrow(/not loaded/);
  });
});

// ----- properties: random sessions -----

type Step =
  | {
      kind: 'place';
      side: 'buy' | 'sell';
      type: 'market' | 'limit';
      quantity: string;
      offset: number;
      bracket: boolean;
    }
  | { kind: 'cancel'; pick: number }
  | { kind: 'trade'; offset: number; quantity: string };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constant('place' as const),
    side: fc.constantFrom('buy' as const, 'sell' as const),
    type: fc.constantFrom('market' as const, 'limit' as const),
    quantity: fc.integer({ min: 1, max: 300 }).map((n) => (n / 100).toString()),
    offset: fc.integer({ min: -300, max: 300 }),
    bracket: fc.boolean(),
  }),
  fc.record({ kind: fc.constant('cancel' as const), pick: fc.nat() }),
  fc.record({
    kind: fc.constant('trade' as const),
    offset: fc.integer({ min: -600, max: 600 }),
    quantity: fc.integer({ min: 1, max: 500 }).map((n) => (n / 100).toString()),
  }),
);

/** Plays a session; returns every output and the engine. Prices move around 100.00 in cents. */
function play(steps: readonly Step[]): { e: PaperEngine; outputs: Outputs[] } {
  const e = engine(500);
  const outputs: Outputs[] = [];
  let n = 0;
  const cents = (offset: number) => (100 + offset / 100).toFixed(2);
  steps.forEach((s, i) => {
    const stream = `${1000 + i}-0`;
    if (s.kind === 'place') {
      n += 1;
      const price = cents(s.offset);
      const bracket = s.bracket && s.side === 'buy';
      outputs.push(
        e.place(
          order({
            id: `o${n}`,
            side: s.side,
            type: s.type,
            quantity: s.quantity,
            limitPrice: s.type === 'limit' ? price : null,
            stop: bracket ? { id: `o${n}s`, price: '95.00' } : null,
            target: bracket ? { id: `o${n}t`, price: '105.00' } : null,
            ocoGroup: bracket ? `g${n}` : null,
          }),
          ctx(DEEP, stream),
        ),
      );
    } else if (s.kind === 'cancel') {
      const live = e.liveOrders();
      if (live.length) outputs.push(e.cancel(live[s.pick % live.length]!.id));
    } else {
      const t: Trade = {
        instrumentId: 'btc',
        id: `t${i}`,
        streamId: `${1000 + i}-1`,
        ts: 5000 + i,
        price: cents(s.offset),
        quantity: s.quantity,
      };
      outputs.push(e.trade(t, { health: 'ok', book: DEEP }));
    }
  });
  return { e, outputs };
}

describe('properties of random sessions', () => {
  it('balances never go negative, the ledger sums to them, and what live orders hold is accounted for', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 1, maxLength: 60 }), (steps) => {
        const { e, outputs } = play(steps);
        const ledger: LedgerEntry[] = outputs.flatMap((o) => o.ledger);
        const sums = new Map<string, ReturnType<typeof dec>>([['USDT', dec('10000')]]);
        const held = new Map<string, ReturnType<typeof dec>>();
        for (const l of ledger) {
          sums.set(l.asset, (sums.get(l.asset) ?? dec(0)).plus(l.amount));
          if (l.reason === 'reserve' || l.reason === 'release')
            held.set(l.asset, (held.get(l.asset) ?? dec(0)).minus(l.amount));
        }
        const available = e.account('acc').available;
        for (const [asset, sum] of sums) {
          expect(sum.toString()).toBe(dec(available[asset] ?? '0').toString());
          expect(sum.gte(0)).toBe(true);
        }
        // What the ledger moved into holds equals what the live orders still hold.
        const liveHeld = new Map<string, ReturnType<typeof dec>>();
        for (const o of e.liveOrders()) {
          const asset = o.side === 'buy' ? 'USDT' : 'BTC';
          liveHeld.set(asset, (liveHeld.get(asset) ?? dec(0)).plus(o.reserved));
        }
        for (const asset of new Set([...held.keys(), ...liveHeld.keys()]))
          expect((held.get(asset) ?? dec(0)).toString()).toBe((liveHeld.get(asset) ?? dec(0)).toString());
        // No order sells more than it was given, and no fill is empty.
        for (const f of outputs.flatMap((o) => o.fills)) expect(dec(f.quantity).gt(0)).toBe(true);
        for (const o of outputs.flatMap((x) => x.orders))
          if (o.type !== 'stop' && o.type !== 'target') expect(dec(o.filled).lte(o.quantity)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('the same inputs give the same fills (the digest a replay must reproduce)', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 1, maxLength: 60 }), (steps) => {
        const a = play(steps).outputs.flatMap((o) => o.fills.map(fillDigestLine));
        const b = play(steps).outputs.flatMap((o) => o.fills.map(fillDigestLine));
        expect(b).toEqual(a);
      }),
      { numRuns: 100 },
    );
  });
});
