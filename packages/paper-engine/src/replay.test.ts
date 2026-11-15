import { describe, expect, it } from 'vitest';
import { fillDigestLine } from './digest.js';
import { PaperEngine } from './engine.js';
import { applyInput, type JournalEntry, type JournalInput, replayJournal } from './replay.js';
import type { Book, EngineOptions, InstrumentRules } from './types.js';

const BTC: InstrumentRules = {
  instrumentId: 'btc',
  venue: 'binance',
  base: 'BTC',
  quote: 'USDT',
  priceTick: '0.01',
  qtyStep: '0.00001',
  minNotional: '5',
};
const OPTS: EngineOptions = {
  rules: (id) => (id === 'btc' ? BTC : undefined),
  fees: () => ({ maker: '0.001', taker: '0.001' }),
  fillId: (orderId, n) => `${orderId}#${n}`,
};
const BOOK: Book = { instrumentId: 'btc', ts: 1, bids: [['99.90', '5']], asks: [['100.00', '5']] };

const inputs: JournalInput[] = [
  {
    kind: 'load',
    accounts: [{ id: 'acc', venue: 'binance', epoch: 0, available: { USDT: '10000' } }],
    orders: [],
  },
  {
    kind: 'place',
    order: {
      id: 'b',
      accountId: 'acc',
      instrumentId: 'btc',
      side: 'buy',
      type: 'limit',
      quantity: '1',
      limitPrice: '99.00',
      underlyingClosed: false,
      stop: { id: 'bs', price: '95.00' },
      target: { id: 'bt', price: '105.00' },
      ocoGroup: 'g',
    },
    ctx: { now: 1, health: 'ok', book: BOOK, lastTrade: '1-0' },
  },
  {
    kind: 'trade',
    trade: { instrumentId: 'btc', id: 't1', streamId: '2-0', ts: 2, price: '98.00', quantity: '0.6' },
    ctx: { health: 'ok', book: null },
  },
  {
    kind: 'trade',
    trade: { instrumentId: 'btc', id: 't2', streamId: '3-0', ts: 3, price: '94.00', quantity: '0.1' },
    ctx: { health: 'ok', book: BOOK },
  },
  { kind: 'cancel', orderId: 'b' },
  { kind: 'reset', accountId: 'acc', starting: { USDT: '10000' } },
];

/** What the broker would journal: each input with its fills' digest lines. */
function journal(): JournalEntry[] {
  const engine = new PaperEngine(OPTS);
  return inputs.map((input) => ({ input, fills: applyInput(engine, input).fills.map(fillDigestLine) }));
}

describe('journal replay (criterion 14.3)', () => {
  it('reproduces every fill of a recorded session', () => {
    const entries = journal();
    // The buy fills 0.6, then 0.1 more on the second trade, which also triggers its stop for the 0.7.
    expect(entries.flatMap((e) => e.fills)).toHaveLength(3);
    const result = replayJournal(entries, OPTS);
    expect(result).toMatchObject({ checked: entries.length, mismatchAt: null });
    expect(result.lines).toEqual(entries.flatMap((e) => e.fills));
  });

  it('names the first entry whose fills differ', () => {
    const entries = journal();
    const tampered = entries.map((e, i) =>
      i === 3 ? { ...e, fills: e.fills.map((l) => l.replace('|99.9|', '|99.8|')) } : e,
    );
    expect(replayJournal(tampered, OPTS)).toMatchObject({ checked: 3, mismatchAt: 3 });
  });

  it('loads an account carried by a place entry', () => {
    const engine = new PaperEngine(OPTS);
    const out = applyInput(engine, {
      kind: 'place',
      order: {
        ...(inputs[1] as Extract<JournalInput, { kind: 'place' }>).order,
        type: 'market',
        limitPrice: null,
        stop: null,
        target: null,
        ocoGroup: null,
      },
      ctx: { now: 1, health: 'ok', book: BOOK, lastTrade: '0-0' },
      accounts: [{ id: 'acc', venue: 'binance', epoch: 0, available: { USDT: '500' } }],
    });
    expect(out.fills).toHaveLength(1);
    expect(engine.account('acc').available['BTC']).toBe('1');
  });

  it('uses the configuration the broker journalled, also when it changed mid-session', () => {
    const cheap = { maker: '0.0005', taker: '0.0005' };
    const dear = { maker: '0.002', taker: '0.003' };
    let fees = cheap;
    let minimum = '0';
    const live: EngineOptions = {
      ...OPTS,
      rules: (id) => (id === 'btc' ? { ...BTC, minNotional: minimum } : undefined),
      fees: () => fees,
    };
    const engine = new PaperEngine(live);
    const config = () => ({ rules: [{ ...BTC, minNotional: minimum }], fees: { binance: fees } });
    const entries: JournalEntry[] = [];
    const record = (input: JournalInput) =>
      entries.push({ input, fills: applyInput(engine, input).fills.map(fillDigestLine) });
    const market = (id: string, quantity: string, now: number): JournalInput => ({
      kind: 'place',
      order: {
        id,
        accountId: 'acc',
        instrumentId: 'btc',
        side: 'buy',
        type: 'market',
        quantity,
        limitPrice: null,
        underlyingClosed: false,
        stop: null,
        target: null,
        ocoGroup: null,
      },
      ctx: { now, health: 'ok', book: BOOK, lastTrade: '1-0' },
    });
    record({ ...inputs[0]!, config: config() });
    record(market('m1', '0.01', 1)); // worth 1 USDT: accepted while the minimum is unknown
    // The pair-status job reads the minimum, and an admin raises the fees.
    minimum = '5';
    fees = dear;
    record({ ...market('m2', '0.01', 2), config: config() }); // refused now: below the minimum
    record(market('m3', '1', 3)); // at the dearer taker fee

    expect(entries.map((e) => e.fills.length)).toEqual([0, 1, 0, 1]);
    expect(entries[3]!.fills[0]).toContain('0.3');
    // Today's settings differ from both: the journalled configuration decides.
    const today: EngineOptions = { ...OPTS, fees: () => ({ maker: '0.01', taker: '0.01' }) };
    expect(replayJournal(entries, today)).toMatchObject({ checked: 4, mismatchAt: null });
    // Without it, the replay would differ at the first order.
    const bare = entries.map(({ input: { config: _config, ...input }, fills }) => ({ input: input, fills }));
    expect(replayJournal(bare, today).mismatchAt).toBe(1);
  });
});
