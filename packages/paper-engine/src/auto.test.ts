import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTO_RULES } from '@cip/contracts';
import { dec } from '@cip/domain';
import {
  AUTO_LIVE_WINDOW_MS,
  type AutoContext,
  autoDigestLines,
  type AutoResult,
  type AutoSetup,
  autoSetup,
  type AutoStrategy,
  AutoTrader,
  DECIDED_TTL_MS,
  nextUtcMidnight,
  orderLevels,
  realized,
  utcDay,
} from './auto.js';
import { fillDigestLine } from './digest.js';
import { PaperEngine } from './engine.js';
import { applyInput, type JournalEntry, type JournalInput, replayJournal } from './replay.js';
import type { Book, EngineOptions, InstrumentRules, Trade } from './types.js';

const BTC: InstrumentRules = {
  instrumentId: 'btc',
  venue: 'binance',
  base: 'BTC',
  quote: 'USDT',
  priceTick: '0.01',
  qtyStep: '0.00001',
  minNotional: '5',
};
const ETH: InstrumentRules = { ...BTC, instrumentId: 'eth', base: 'ETH' };
const SOL: InstrumentRules = { ...BTC, instrumentId: 'sol', base: 'SOL' };
const CB: InstrumentRules = { ...BTC, instrumentId: 'cb', venue: 'coinbase', quote: 'USD' };
/** A pair whose minimum order is worth more than 1 % at risk buys at these levels. */
const BIG: InstrumentRules = { ...BTC, instrumentId: 'big', base: 'BIG', minNotional: '5000' };
const RULES: Record<string, InstrumentRules> = { btc: BTC, eth: ETH, sol: SOL, cb: CB, big: BIG };
const OPTS: EngineOptions = {
  rules: (id) => RULES[id],
  fees: () => ({ maker: '0.001', taker: '0.001' }),
  fillId: (orderId, n) => `${orderId}#${n}`,
};
const nameId = (name: string) => name;

/** Monday 16 November 2026, 10:00 UTC. */
const T0 = Date.UTC(2026, 10, 16, 10, 0);
const HOUR = 3_600_000;

/** Asks above the entries: a buy at 100 rests. Bids for a stop to sell into. */
const book = (instrumentId = 'btc'): Book => ({
  instrumentId,
  ts: T0,
  bids: [
    ['94.80', '1000'],
    ['90.00', '1000'],
  ],
  asks: [['101.00', '1000']],
});

function desk(available = '10000') {
  const engine = new PaperEngine(OPTS);
  engine.load([
    { id: 'acc', venue: 'binance', epoch: 0, available: { USDT: available }, starting: { USDT: '10000' } },
  ]);
  const trader = new AutoTrader(engine, { nameId });
  return { engine, trader };
}

/** Phase 16's sizing: the calculator's size at the risk per trade (the default before 2026-11-16). */
const RISK_RULES = { ...DEFAULT_AUTO_RULES, sizing: 'risk' as const };

const strategy = (over: Partial<AutoStrategy> = {}): AutoStrategy => ({
  id: 'st1',
  userId: 'u1',
  accountId: 'acc',
  enabled: true,
  rules: { ...RISK_RULES },
  version: 1,
  pausedUntil: null,
  ...over,
});

const setup = (over: Partial<AutoSetup> = {}): AutoSetup => ({
  id: 'set1',
  runId: 'run1',
  instrumentId: 'btc',
  pattern: 'htf_order_block',
  direction: 'bullish',
  to: 'confirmed',
  resolution: null,
  entry: '100.00',
  invalidation: '95.00',
  target1: '115.00',
  score: 80,
  mandatoryPassed: true,
  qualityFlags: [],
  flags: [],
  decidedAt: T0,
  processedAt: T0,
  ...over,
});

const ctx = (over: Partial<AutoContext> = {}): AutoContext => ({
  now: T0 + 1_000,
  health: 'ok',
  book: book(),
  lastTrade: '1-0',
  underlyingClosed: false,
  ...over,
});

let streamN = 10;
const trade = (price: string, quantity: string, ts = T0 + 2_000, instrumentId = 'btc'): Trade => ({
  instrumentId,
  id: `t${streamN}`,
  streamId: `${(streamN += 1)}-0`,
  ts,
  price,
  quantity,
});

const reasons = (r: AutoResult) => r.decisions.map((d) => d.reason ?? d.outcome);
const ID = 'practice-auto:st1:set1';

describe('automatic practice trading: placing (ADR 022)', () => {
  it('turns a confirmed bullish setup that matches the rules into a limit buy with its stop and target', () => {
    const { engine, trader } = desk();
    trader.setStrategy(strategy(), false, T0);
    const r = trader.setup(setup(), ctx());
    expect(r.decisions).toEqual([
      {
        id: `practice-auto-decision:st1:set1:placed:`,
        strategyId: 'st1',
        userId: 'u1',
        setupId: 'set1',
        runId: 'run1',
        instrumentId: 'btc',
        pattern: 'htf_order_block',
        outcome: 'placed',
        reason: null,
        orderId: ID,
        strategyVersion: 1,
        decidedAt: T0 + 1_000,
      },
    ]);
    // 1 % of 10000 at risk over a distance of 5: 20 BTC, at the entry, stop and target 1.
    expect(
      r.orders.map((o) => [o.id, o.clientOrderId, o.type, o.side, o.quantity, o.limitPrice, o.stopPrice]),
    ).toEqual([
      [ID, 'auto:set1', 'limit', 'buy', '20', '100', null],
      [`${ID}:stop`, 'auto:set1:stop', 'stop', 'sell', '20', null, '95'],
      [`${ID}:target`, 'auto:set1:target', 'target', 'sell', '20', '115', null],
    ]);
    expect(r.orders.map((o) => [o.parentId, o.ocoGroup])).toEqual([
      [null, null],
      [ID, `${ID}:oco`],
      [ID, `${ID}:oco`],
    ]);
    const buy = r.outputs.orders.find((o) => o.id === ID)!;
    expect(buy).toMatchObject({ status: 'open', quantity: '20', limitPrice: '100', reserved: '2002' });
    expect(engine.account('acc').available['USDT']).toBe('7998');
    expect(r.days).toEqual([{ accountId: 'acc', day: '2026-11-16', orders: 1, result: '0' }]);
    expect(trader.openTrades('st1').map((t) => t.setupId)).toEqual(['set1']);
    // The same setup is never decided twice.
    expect(trader.setup(setup(), ctx({ now: T0 + 5_000 })).decisions).toEqual([]);
  });

  it('decides nothing for setups that are not confirmed bullish ones, or while it is off', () => {
    const { trader } = desk();
    trader.setStrategy(strategy(), false, T0);
    for (const s of [
      setup({ direction: 'bearish' }),
      setup({ to: 'forming' }),
      setup({ to: 'triggered' }),
      setup({ to: 'entry_active' }),
    ]) {
      expect(trader.wants(s)).toBe(false);
      expect(trader.setup(s, ctx()).decisions).toEqual([]);
    }
    trader.setStrategy(strategy({ enabled: false }), false, T0);
    expect(trader.wants(setup())).toBe(false);
    expect(trader.setup(setup(), ctx()).decisions).toEqual([]);
  });

  it('skips with the first check that fails, in ADR 022 order', () => {
    const cases: [Partial<AutoStrategy>, Partial<AutoSetup>, Partial<AutoContext>, string][] = [
      [{ pausedUntil: T0 + HOUR }, { instrumentId: 'cb' }, {}, 'paused'],
      [{}, { instrumentId: 'cb' }, {}, 'pair'],
      [{ rules: { ...RISK_RULES, instrumentIds: ['eth'] } }, {}, {}, 'pair'],
      [{}, { instrumentId: 'unknown' }, {}, 'pair'],
      [{ rules: { ...RISK_RULES, patterns: ['eq_near_poi'] } }, { score: 0 }, {}, 'pattern'],
      [{}, { mandatoryPassed: false, score: 0 }, {}, 'not_live'],
      [{}, { flags: ['warmup'] }, {}, 'not_live'],
      [{}, { flags: ['late_detection'] }, {}, 'not_live'],
      [{}, {}, { now: T0 + AUTO_LIVE_WINDOW_MS + 1 }, 'not_live'],
      [{}, { qualityFlags: ['data_gap'], score: 0 }, {}, 'data_gap'],
      [{}, { score: 69.5 }, {}, 'score'],
      [{}, { target1: null }, {}, 'reward'],
      [{}, { invalidation: '101.00' }, {}, 'reward'],
      [{}, { target1: '109.99' }, {}, 'reward'], // 1.998 for the risk: below 2
      [{ accountId: null }, {}, {}, 'balance'],
      [{}, { instrumentId: 'big' }, {}, 'size'],
    ];
    for (const [st, s, c, reason] of cases) {
      const { trader } = desk();
      trader.setStrategy(strategy(st), false, T0);
      const r = trader.setup(setup(s), ctx(c));
      expect(
        r.decisions.map((d) => [d.outcome, d.reason]),
        reason,
      ).toEqual([['skipped', reason]]);
      expect(r.orders).toEqual([]);
    }
  });

  it('keeps to one trade per pair, the open trades limit and the daily orders limit', () => {
    const { trader } = desk('1000000');
    trader.setStrategy(
      strategy({ rules: { ...RISK_RULES, maxOpenTrades: 2, maxOrdersPerDay: 3 } }),
      false,
      T0,
    );
    expect(reasons(trader.setup(setup({ id: 'a' }), ctx()))).toEqual(['placed']);
    expect(reasons(trader.setup(setup({ id: 'b' }), ctx()))).toEqual(['open_limit']); // same pair
    expect(
      reasons(trader.setup(setup({ id: 'c', instrumentId: 'eth' }), ctx({ book: book('eth') }))),
    ).toEqual(['placed']);
    expect(
      reasons(trader.setup(setup({ id: 'd', instrumentId: 'sol' }), ctx({ book: book('sol') }))),
    ).toEqual(['open_limit']);
    // The day's third order is refused by the engine (no market), and still counts.
    trader.setStrategy(strategy({ rules: { ...RISK_RULES, maxOrdersPerDay: 3 } }), false, T0);
    const refused = trader.setup(setup({ id: 'e', instrumentId: 'sol' }), ctx({ health: 'data_delayed' }));
    expect(refused.decisions.map((d) => [d.outcome, d.reason])).toEqual([['refused', 'data_delayed']]);
    expect(refused.outputs.orders.map((o) => o.status)).toEqual(['refused', 'refused', 'refused']);
    expect(trader.openTrades('st1')).toHaveLength(2);
    expect(reasons(trader.setup(setup({ id: 'f', instrumentId: 'sol' }), ctx()))).toEqual(['daily_orders']);
    // A new UTC day starts the count again.
    const tomorrow = Date.UTC(2026, 10, 17, 0, 0, 1);
    expect(
      reasons(
        trader.setup(
          setup({ id: 'g', instrumentId: 'sol', processedAt: tomorrow }),
          ctx({ now: tomorrow, book: book('sol') }),
        ),
      ),
    ).toEqual(['placed']);
    expect(trader.today('acc', tomorrow)).toMatchObject({ day: '2026-11-17', orders: 1 });
  });

  it("caps the size at what the free balance buys, and skips when that is below the pair's minimum", () => {
    // A tight stop: 1 % of 1000 at risk over 0.5 wants 20 BTC (2000 USDT); 1000 buys 9.99 with the fee.
    const { trader } = desk('1000');
    trader.setStrategy(strategy(), false, T0);
    const r = trader.setup(setup({ invalidation: '99.50', target1: '101.00' }), ctx());
    expect(r.orders[0]).toMatchObject({ quantity: '9.99', limitPrice: '100' });
    // 1 % of 4.5 over 0.1 wants 0.45 (worth 45), but 4.5 buys only 0.04495 (worth 4.50; the minimum is 5).
    const poor = desk('4.5');
    poor.trader.setStrategy(strategy(), false, T0);
    expect(reasons(poor.trader.setup(setup({ invalidation: '99.90', target1: '101.00' }), ctx()))).toEqual([
      'balance',
    ]);
    const empty = desk('0');
    empty.trader.setStrategy(strategy(), false, T0);
    expect(reasons(empty.trader.setup(setup(), ctx()))).toEqual(['balance']);
  });

  it('rounds the levels down to the price step and refuses levels in the wrong order', () => {
    expect(orderLevels({ entry: '100.019', invalidation: '95.011', target1: '115.999' }, BTC)).toEqual({
      entry: '100.01',
      stop: '95.01',
      target: '115.99',
    });
    expect(orderLevels({ entry: '100', invalidation: '100.001', target1: '120' }, BTC)).toBeNull();
    expect(orderLevels({ entry: '100', invalidation: '95', target1: '100.001' }, BTC)).toBeNull();
    expect(orderLevels({ entry: '1', invalidation: '0.001', target1: '2' }, BTC)).toBeNull();
    expect(
      orderLevels({ entry: '1.23456789', invalidation: '1', target1: '2' }, { ...BTC, priceTick: '0' })
        ?.entry,
    ).toBe('1.23456789');
  });

  it('reads a setup transition message', () => {
    const s = autoSetup({
      id: 'set1',
      instrumentId: 'btc',
      runId: 'run1',
      pattern: 'eq_near_poi',
      variant: null,
      direction: 'bullish',
      contextTf: '1h',
      setupTf: '15m',
      state: 'confirmed',
      resolution: null,
      displayLabel: 'Confirmed',
      levels: { entry: '100', invalidation: '95', target1: '115', target2: null, rr: 3 },
      score: 82.5,
      mandatoryPassed: true,
      qualityFlags: ['low_liquidity'],
      flags: [],
      createdAt: T0 - HOUR,
      updatedAt: T0,
      resolvedAt: null,
      disclaimer: 'Educational analysis — not financial advice',
      transition: {
        from: 'triggered',
        to: 'confirmed',
        reason: 'mss',
        candleTime: T0 - 900_000,
        decidedAt: T0,
        processedAt: T0 + 400,
        late: false,
        evidence: {},
      },
    });
    expect(s).toEqual(
      setup({
        pattern: 'eq_near_poi',
        entry: '100',
        invalidation: '95',
        target1: '115',
        score: 82.5,
        qualityFlags: ['low_liquidity'],
        processedAt: T0 + 400,
      }),
    );
  });
});

describe('automatic practice trading: a fixed amount per buy (the default since 2026-11-16)', () => {
  const fixed = (amount: number) => ({ ...DEFAULT_AUTO_RULES, amount });

  it('spends the default 10 of the quote currency at the entry, rounded down to the quantity step', () => {
    expect(DEFAULT_AUTO_RULES).toMatchObject({ sizing: 'fixed', amount: 10 });
    const { trader } = desk();
    trader.setStrategy(strategy({ rules: { ...DEFAULT_AUTO_RULES } }), false, T0);
    const r = trader.setup(setup({ entry: '100.00', invalidation: '95.00', target1: '115.00' }), ctx());
    expect(reasons(r)).toEqual(['placed']);
    // 10 ÷ 100 = 0.1, the same for the buy, its stop and its target; the risk does not change it.
    expect(r.orders.map((o) => [o.side, o.type, o.quantity])).toEqual([
      ['buy', 'limit', '0.1'],
      ['sell', 'stop', '0.1'],
      ['sell', 'target', '0.1'],
    ]);
    const { trader: other } = desk();
    other.setStrategy(strategy({ rules: fixed(10) }), false, T0);
    const wide = other.setup(setup({ entry: '100.00', invalidation: '60.00', target1: '200.00' }), ctx());
    expect(wide.orders[0]!.quantity).toBe('0.1');
  });

  it('rounds down, so a buy never spends more than the amount', () => {
    const { trader } = desk();
    trader.setStrategy(strategy({ rules: fixed(10) }), false, T0);
    // 10 ÷ 65432.10 = 0.000152828…, down to the step 0.00001: 0.00015, worth 9.81.
    const r = trader.setup(
      setup({ entry: '65432.10', invalidation: '64000.00', target1: '70000.00' }),
      ctx(),
    );
    expect(r.orders[0]!.quantity).toBe('0.00015');
    expect(dec(r.orders[0]!.quantity).times('65432.10').lte(10)).toBe(true);
  });

  it('is capped at what the free balance buys, and skipped below the pair’s minimum', () => {
    // 8 USDT free: 8 ÷ (100 × 1.001), down to the step: 0.07992, worth 7.99.
    const capped = desk('8');
    capped.trader.setStrategy(strategy({ rules: fixed(10) }), false, T0);
    expect(capped.trader.setup(setup(), ctx()).orders[0]!.quantity).toBe('0.07992');
    // 4 USDT free: what it buys is below the 5 USDT minimum.
    const poor = desk('4');
    poor.trader.setStrategy(strategy({ rules: fixed(10) }), false, T0);
    expect(reasons(poor.trader.setup(setup(), ctx()))).toEqual(['balance']);
    // A pair whose minimum order is 5,000: 10 is too small for it.
    const big = desk();
    big.trader.setStrategy(strategy({ rules: fixed(10) }), false, T0);
    expect(reasons(big.trader.setup(setup({ id: 'set-big', instrumentId: 'big' }), ctx()))).toEqual(['size']);
    // Raise the amount and it trades.
    const bigger = desk();
    bigger.trader.setStrategy(strategy({ rules: fixed(6000) }), false, T0);
    expect(reasons(bigger.trader.setup(setup({ id: 'set-big2', instrumentId: 'big' }), ctx()))).toEqual([
      'placed',
    ]);
  });
});

describe('automatic practice trading: following its trades', () => {
  function placed(available = '10000') {
    const d = desk(available);
    d.trader.setStrategy(strategy(), false, T0);
    d.trader.setup(setup(), ctx());
    return d;
  }

  it('cancels a buy that has not filled when its setup ends, with its stop and target', () => {
    const { trader, engine } = placed();
    expect(trader.wants(setup({ to: 'resolved', resolution: 'invalidated' }))).toBe(true);
    const r = trader.setup(setup({ to: 'resolved', resolution: 'invalidated' }), ctx({ now: T0 + HOUR }));
    expect(r.decisions.map((d) => [d.outcome, d.reason, d.orderId])).toEqual([
      ['cancelled', 'invalidated', ID],
    ]);
    expect(r.outputs.orders.map((o) => [o.id, o.status])).toEqual([
      [ID, 'cancelled'],
      [`${ID}:stop`, 'cancelled'],
      [`${ID}:target`, 'cancelled'],
    ]);
    expect(engine.account('acc').available['USDT']).toBe('10000');
    expect(trader.openTrades('st1')).toEqual([]);
    // Closed without a fill: nothing gained or lost.
    expect(trader.today('acc', T0 + HOUR)).toMatchObject({ orders: 1, result: '0' });
    expect(trader.wants(setup({ to: 'resolved', resolution: 'invalidated' }))).toBe(false);
  });

  it('keeps the stop and target of a partly filled buy when its setup ends', () => {
    const { trader, engine } = placed();
    const fill = engine.trade(trade('99.50', '5'), { health: 'ok', book: null });
    trader.observe(fill, T0 + 2_000);
    const r = trader.setup(
      setup({ to: 'resolved', resolution: 'expired_no_entry' }),
      ctx({ now: T0 + HOUR }),
    );
    expect(r.outputs.orders.map((o) => [o.id, o.status, o.quantity])).toEqual([[ID, 'cancelled', '20']]);
    expect(trader.openTrades('st1')).toHaveLength(1);
    expect(engine.isLive(`${ID}:stop`) && engine.isLive(`${ID}:target`)).toBe(true);
  });

  it('adds up the result of closed trades for the day, and pauses at the daily loss limit until 00:00 UTC', () => {
    const { trader, engine } = desk();
    trader.setStrategy(strategy(), false, T0);
    let at = T0;
    const lose = (n: number) => {
      const id = `loss${n}`;
      at += HOUR;
      trader.setup(setup({ id, processedAt: at }), ctx({ now: at }));
      trader.observe(engine.trade(trade('99.50', '20', at + 1), { health: 'ok', book: null }), at + 1);
      return trader.observe(
        engine.trade(trade('94.90', '1', at + 2), { health: 'ok', book: book() }),
        at + 2,
      );
    };
    // Bought 20 at 100 (fee 2), stopped out at 94.80 (fee 1.896): -107.896. Each next trade risks
    // 1 % of what is left, so it is a little smaller.
    expect(lose(1)).toMatchObject({ pauses: [], days: [{ orders: 1, result: '-107.896' }] });
    expect(lose(2)).toMatchObject({ pauses: [], days: [{ orders: 2, result: '-214.62780216' }] });
    const third = lose(3);
    // -320.21 is past 3 % of the starting 10000.
    expect(third.pauses).toEqual([
      {
        strategyId: 'st1',
        userId: 'u1',
        at: at + 2,
        until: Date.UTC(2026, 10, 17),
        result: '-320.20803031',
        asset: 'USDT',
      },
    ]);
    expect(trader.strategy('st1')?.pausedUntil).toBe(Date.UTC(2026, 10, 17));
    expect(reasons(trader.setup(setup({ id: 'next', processedAt: at + 3 }), ctx({ now: at + 3 })))).toEqual([
      'paused',
    ]);
    // A new day: it trades again.
    const tomorrow = Date.UTC(2026, 10, 17, 0, 1);
    expect(
      reasons(trader.setup(setup({ id: 'day2', processedAt: tomorrow }), ctx({ now: tomorrow }))),
    ).toEqual(['placed']);
    expect(trader.today('acc', tomorrow)).toMatchObject({ orders: 1, result: '0' });
  });

  it('counts a winning trade, and only what was sold', () => {
    const { trader, engine } = placed();
    trader.observe(engine.trade(trade('99.50', '20'), { health: 'ok', book: null }), T0 + 2_000);
    const r = trader.observe(
      engine.trade(trade('115.50', '20', T0 + 3_000), { health: 'ok', book: null }),
      T0 + 3_000,
    );
    // 20 × 115 − 20 × 100 − fees 2 and 2.3.
    expect(r.days).toEqual([{ accountId: 'acc', day: '2026-11-16', orders: 1, result: '295.7' }]);
    expect(trader.openTrades('st1')).toEqual([]);
    expect(
      realized({
        strategyId: 's',
        setupId: 'x',
        runId: 'r',
        pattern: 'eq_near_poi',
        accountId: 'a',
        instrumentId: 'btc',
        buyId: 'b',
        stopId: 's',
        targetId: 't',
        bought: '2',
        cost: '200',
        buyFees: '0.2',
        sold: '1',
        proceeds: '110',
        sellFees: '0.11',
      }).toString(),
    ).toBe('9.79');
  });

  it('stops: switched off, every live automatic order cancelled, and what it bought kept', () => {
    const { trader, engine } = desk();
    trader.setStrategy(strategy(), false, T0);
    trader.setup(setup({ id: 'a' }), ctx());
    trader.setup(setup({ id: 'b', instrumentId: 'eth' }), ctx({ book: book('eth') }));
    trader.observe(engine.trade(trade('99.50', '20'), { health: 'ok', book: null }), T0 + 2_000);
    const r = trader.setStrategy(strategy({ enabled: false, version: 2 }), true, T0 + HOUR);
    expect(r.stopped).toEqual({ strategyId: 'st1', userId: 'u1', cancelled: 5 });
    expect(r.decisions.map((d) => [d.setupId, d.outcome, d.reason, d.strategyVersion])).toEqual([
      ['a', 'cancelled', 'stopped', 2],
      ['b', 'cancelled', 'stopped', 2],
    ]);
    expect(engine.liveOrders()).toEqual([]);
    expect(engine.account('acc').available['BTC']).toBe('20');
    expect(trader.openTrades('st1')).toEqual([]);
    expect(trader.strategy('st1')?.enabled).toBe(false);
    // Nothing sold: nothing counted.
    expect(trader.today('acc', T0 + HOUR).result).toBe('0');
  });

  it('carries on after a restart from its snapshot and the engine state', () => {
    const { trader, engine } = placed();
    trader.setup(setup({ id: 'other', instrumentId: 'eth', score: 1 }), ctx({ book: book('eth') }));
    const engine2 = new PaperEngine(OPTS);
    engine2.load([engine.account('acc')], engine.liveOrders());
    const trader2 = new AutoTrader(engine2, { nameId });
    trader2.load(trader.snapshot());
    expect(trader2.snapshot()).toEqual(trader.snapshot());
    // Decided before the restart: not again.
    expect(trader2.setup(setup({ id: 'other', instrumentId: 'eth' }), ctx()).decisions).toEqual([]);
    const a = trader.observe(engine.trade(trade('99.50', '20'), { health: 'ok', book: null }), T0 + 2_000);
    const b = trader2.observe(
      engine2.trade({ ...trade('99.50', '20'), streamId: `${streamN - 1}-0` }, { health: 'ok', book: null }),
      T0 + 2_000,
    );
    expect(b.outputs).toEqual(a.outputs);
    expect(engine2.account('acc')).toEqual(engine.account('acc'));
    // After a week a setup could be decided again; by then it has long ended.
    trader2.setup(setup({ id: 'late', to: 'forming' }), ctx({ now: T0 + DECIDED_TTL_MS + 2_000 }));
    expect(trader2.snapshot().decided).toEqual([]);
  });

  it('dates the day and the pause in UTC', () => {
    expect(utcDay(Date.UTC(2026, 10, 16, 23, 59, 59))).toBe('2026-11-16');
    expect(nextUtcMidnight(Date.UTC(2026, 10, 30, 12))).toBe(Date.UTC(2026, 11, 1));
    expect(nextUtcMidnight(Date.UTC(2026, 11, 31, 0))).toBe(Date.UTC(2027, 0, 1));
    const { trader } = desk();
    trader.setStrategy(strategy(), false, T0);
    const midnight = Date.UTC(2026, 10, 17, 0, 0, 1);
    trader.setup(setup({ processedAt: midnight }), ctx({ now: midnight }));
    // A later input stamped a moment before midnight (venue time) counts on the day already started.
    expect(trader.today('acc', Date.UTC(2026, 10, 16, 23, 59, 59))).toMatchObject({
      day: '2026-11-17',
      orders: 1,
    });
  });
});

describe('automatic practice trading: journal and replay (criterion 16.6)', () => {
  /** Drives an engine and a trader the way the broker does, journalling each input. */
  function session(): JournalEntry[] {
    const engine = new PaperEngine(OPTS);
    const trader = new AutoTrader(engine, { nameId });
    const entries: JournalEntry[] = [];
    const run = (input: JournalInput) => {
      const out = applyInput(engine, input, trader);
      entries.push({
        input: structuredClone(input),
        fills: out.fills.map(fillDigestLine),
        decisions: out.auto ? autoDigestLines(out.auto) : [],
      });
    };
    run({
      kind: 'load',
      accounts: [
        { id: 'acc', venue: 'binance', epoch: 0, available: { USDT: '10000' }, starting: { USDT: '10000' } },
      ],
      orders: [],
      auto: { strategies: [strategy({ enabled: false })], trades: [], days: [], decided: [] },
    });
    run({ kind: 'strategy', strategy: strategy(), stop: false, at: T0 });
    run({ kind: 'setup', setup: setup(), ctx: ctx() });
    run({ kind: 'setup', setup: setup({ id: 'skip', score: 10 }), ctx: ctx() });
    run({ kind: 'trade', trade: trade('99.50', '20'), ctx: { health: 'ok', book: null } });
    run({ kind: 'trade', trade: trade('94.00', '1', T0 + 3_000), ctx: { health: 'ok', book: book() } });
    run({
      kind: 'setup',
      setup: setup({ id: 'eth1', instrumentId: 'eth' }),
      ctx: ctx({ book: book('eth') }),
    });
    run({ kind: 'cancel', orderId: 'practice-auto:st1:eth1', at: T0 + 4_000 });
    run({
      kind: 'setup',
      setup: setup({ id: 'sol1', instrumentId: 'sol' }),
      ctx: ctx({ book: book('sol') }),
    });
    run({ kind: 'strategy', strategy: strategy({ enabled: false, version: 2 }), stop: true, at: T0 + 5_000 });
    return entries;
  }

  it('replays a session with the same fills, orders and decisions', () => {
    const entries = session();
    const lines = entries.flatMap((e) => e.decisions ?? []);
    expect(lines.filter((l) => l.startsWith('decision'))).toEqual([
      `decision|practice-auto-decision:st1:set1:placed:|placed||${ID}`,
      'decision|practice-auto-decision:st1:skip:skipped:score|skipped|score|',
      'decision|practice-auto-decision:st1:eth1:placed:|placed||practice-auto:st1:eth1',
      'decision|practice-auto-decision:st1:sol1:placed:|placed||practice-auto:st1:sol1',
      'decision|practice-auto-decision:st1:sol1:cancelled:stopped|cancelled|stopped|practice-auto:st1:sol1',
    ]);
    expect(entries.flatMap((e) => e.fills)).toHaveLength(2);
    const replay = replayJournal(JSON.parse(JSON.stringify(entries)) as JournalEntry[], { ...OPTS, nameId });
    expect(replay.mismatchAt).toBeNull();
    expect(replay.checked).toBe(entries.length);
    expect(replay.lines).toEqual(entries.flatMap((e) => [...e.fills, ...(e.decisions ?? [])]));
  });

  it('finds a decision that differs from the one stored', () => {
    const entries = session();
    const i = entries.findIndex((e) => e.input.kind === 'setup');
    const tampered = entries.map((e, j) =>
      j === i ? { ...e, decisions: (e.decisions ?? []).map((l) => l.replace('|placed|', '|skipped|')) } : e,
    );
    expect(replayJournal(tampered, { ...OPTS, nameId }).mismatchAt).toBe(i);
    // Without a trader, decisions are not made: the fills differ.
    const engine = new PaperEngine(OPTS);
    applyInput(engine, entries[0]!.input);
    expect(applyInput(engine, entries[2]!.input).fills).toEqual([]);
    expect(applyInput(engine, entries[1]!.input).auto).toBeNull();
  });
});

describe('automatic practice trading: properties', () => {
  const price = (cents: number) => (cents / 100).toFixed(2);

  it('with a fixed amount, never spends more than it, nor more than the free balance', () => {
    fc.assert(
      fc.property(
        fc.record({
          entry: fc.integer({ min: 1_000, max: 10_000_000 }),
          amount: fc.integer({ min: 1, max: 100_000 }),
          free: fc.integer({ min: 0, max: 5_000_000 }),
        }),
        (g) => {
          const { trader } = desk(price(g.free));
          trader.setStrategy(strategy({ rules: { ...DEFAULT_AUTO_RULES, amount: g.amount } }), false, T0);
          const entry = price(g.entry);
          const s = setup({
            entry,
            invalidation: price(Math.floor(g.entry * 0.95)),
            target1: price(Math.ceil(g.entry * 1.15)),
          });
          const r = trader.setup(s, ctx({ book: { ...book(), asks: [[price(g.entry * 2), '1000000']] } }));
          const d = r.decisions[0]!;
          if (d.outcome !== 'placed') {
            expect(['size', 'balance']).toContain(d.reason);
            return;
          }
          const q = dec(r.orders[0]!.quantity);
          const spent = q.times(entry);
          expect(q.mod(BTC.qtyStep).eq(0) && spent.gte(BTC.minNotional)).toBe(true);
          expect(spent.lte(g.amount)).toBe(true);
          expect(spent.times('1.001').lte(price(g.free))).toBe(true);
          // Less than one quantity step short of the amount, unless the balance capped it.
          if (spent.times('1.001').plus(entry).lte(price(g.free)))
            expect(spent.plus(dec(BTC.qtyStep).times(entry)).gt(g.amount)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('only ever places orders inside the rules and the balance', () => {
    fc.assert(
      fc.property(
        fc.record({
          entry: fc.integer({ min: 1_000, max: 10_000_000 }),
          stopPct: fc.integer({ min: 1, max: 900 }),
          rewardX: fc.integer({ min: 10, max: 600 }),
          score: fc.integer({ min: 0, max: 100 }),
          riskPct: fc.integer({ min: 1, max: 20 }),
          minReward: fc.integer({ min: 5, max: 100 }),
          free: fc.integer({ min: 0, max: 5_000_000 }),
        }),
        (g) => {
          const { trader, engine } = desk(price(g.free));
          const rules = { ...RISK_RULES, riskPct: g.riskPct / 10, minReward: g.minReward / 10 };
          trader.setStrategy(strategy({ rules }), false, T0);
          const stop = Math.max(1, Math.floor((g.entry * (1000 - g.stopPct)) / 1000));
          const target = g.entry + Math.ceil(((g.entry - stop) * g.rewardX) / 100);
          const s = setup({
            entry: price(g.entry),
            invalidation: price(stop),
            target1: price(target),
            score: g.score,
          });
          const r = trader.setup(s, ctx({ book: { ...book(), asks: [[price(g.entry * 2), '1000000']] } }));
          expect(r.decisions).toHaveLength(1);
          const d = r.decisions[0]!;
          if (d.outcome !== 'placed') {
            expect(r.outputs.fills).toEqual([]);
            return;
          }
          const [buy, sl, tp] = r.orders;
          const q = dec(buy!.quantity);
          const e = dec(buy!.limitPrice!);
          expect(dec(sl!.stopPrice!).lt(e) && e.lt(tp!.limitPrice!)).toBe(true);
          expect(q.mod(BTC.qtyStep).eq(0) && q.times(e).gte(BTC.minNotional)).toBe(true);
          // At most the risk per trade of the free balance, and never more than it holds.
          expect(q.times(e.minus(sl!.stopPrice!)).lte(dec(price(g.free)).times(rules.riskPct).div(100))).toBe(
            true,
          );
          expect(q.times(e).times('1.001').lte(price(g.free))).toBe(true);
          expect(dec(tp!.limitPrice!).minus(e).div(e.minus(sl!.stopPrice!)).gte(rules.minReward)).toBe(true);
          expect(g.score).toBeGreaterThanOrEqual(rules.minScore);
          expect(dec(engine.account('acc').available['USDT'] ?? '0').gte(0)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('decides the same way every time, and never exceeds its limits', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            pair: fc.constantFrom('btc', 'eth', 'sol'),
            score: fc.integer({ min: 60, max: 100 }),
            fill: fc.boolean(),
            end: fc.boolean(),
          }),
          { minLength: 1, maxLength: 25 },
        ),
        fc.integer({ min: 1, max: 3 }),
        (steps, maxOpenTrades) => {
          const run = () => {
            const { trader, engine } = desk('100000');
            trader.setStrategy(strategy({ rules: { ...RISK_RULES, maxOpenTrades } }), false, T0);
            const out: string[] = [];
            let n = 100;
            for (const [i, st] of steps.entries()) {
              const at = T0 + i * 60_000;
              const s = setup({ id: `s${i}`, instrumentId: st.pair, score: st.score, processedAt: at });
              out.push(...autoDigestLines(trader.setup(s, ctx({ now: at, book: book(st.pair) }))));
              if (st.fill) {
                n += 1;
                const t = {
                  instrumentId: st.pair,
                  id: `t${n}`,
                  streamId: `${n}-0`,
                  ts: at + 1,
                  price: '99.50',
                  quantity: '5',
                };
                out.push(...engine.trade(t, { health: 'ok', book: null }).fills.map(fillDigestLine));
              }
              if (st.end)
                out.push(
                  ...autoDigestLines(
                    trader.setup({ ...s, to: 'resolved', resolution: 'expired' }, ctx({ now: at + 2 })),
                  ),
                );
              const open = trader.openTrades('st1');
              expect(open.length).toBeLessThanOrEqual(maxOpenTrades);
              expect(new Set(open.map((t) => t.instrumentId)).size).toBe(open.length);
            }
            return out;
          };
          expect(run()).toEqual(run());
        },
      ),
      { numRuns: 100 },
    );
  });
});
