import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { addDecimals } from '@cip/domain';
import { parseRecording, replayEvents, type TradeEvent } from '@cip/exchange-adapters';
import { KlineCandleAssembler, microProfile, TradeCandleBuilder, type TradeInput } from './candles.js';

const M = 60_000;
const T0 = Date.UTC(2026, 10, 10, 12, 0);
const never = () => false;
const trade = (
  offsetMs: number,
  price: string,
  qty: string,
  takerSide: 'buy' | 'sell' = 'buy',
): TradeInput => ({
  ts: T0 + offsetMs,
  price,
  qty,
  takerSide,
});

describe('micro volume profile (rulebook §3.5)', () => {
  it('adds each trade to its bucket between low and high', () => {
    const profile = microProfile(
      [trade(0, '100', '1'), trade(1, '104', '2'), trade(2, '101.9', '0.5')],
      '100',
      '104',
      4,
    );
    expect(profile).toEqual([1, 0.5, 0, 2]);
  });

  it('puts a one-price minute in the first bucket and clamps out-of-range prices', () => {
    expect(microProfile([trade(0, '7', '3')], '7', '7', 3)).toEqual([3, 0, 0]);
    expect(microProfile([trade(0, '99', '1'), trade(0, '106', '1')], '100', '104', 2)).toEqual([1, 1]);
  });
});

describe('TradeCandleBuilder (Coinbase)', () => {
  const builder = () =>
    new TradeCandleBuilder(
      { profileBuckets: 4, graceMs: 2_000, closed: never },
      { nextOpen: T0, lastClose: '99' },
    );

  it('finalises a minute only after its grace period, with exact OHLCV', () => {
    const b = builder();
    b.addTrade(trade(30_000, '100.1', '0.2', 'sell'));
    b.addTrade(trade(5_000, '100.0', '0.1'));
    b.addTrade(trade(59_999, '100.05', '0.3'));
    b.addTrade(trade(40_000, '100.4', '0.1'));
    expect(b.finalize(T0 + M + 1_999)).toEqual([]);
    const [c] = b.finalize(T0 + M + 2_000);
    expect(c).toMatchObject({
      openTime: T0,
      open: '100.0',
      high: '100.4',
      low: '100.0',
      close: '100.05',
      volume: '0.7',
      quoteVolume: '70.075',
      tradeCount: 4,
      takerBuyVolume: '0.5',
      source: 'trades',
      quality: 'complete',
    });
    expect(c!.microProfile!.reduce((a, v) => a + v, 0)).toBeCloseTo(0.7);
  });

  it('writes flat candles for minutes without trades, so every minute exists', () => {
    const b = builder();
    b.addTrade(trade(2 * M + 10, '101', '1'));
    const candles = b.finalize(T0 + 3 * M + 2_000);
    expect(candles.map((c) => [c.openTime - T0, c.open, c.close, c.volume])).toEqual([
      [0, '99', '99', '0'],
      [M, '99', '99', '0'],
      [2 * M, '101', '101', '1'],
    ]);
    expect(b.finalize(T0 + 4 * M + 2_000)[0]).toMatchObject({ open: '101', volume: '0', tradeCount: 0 });
  });

  it('never changes a published minute: late trades are counted and ignored', () => {
    const b = builder();
    b.addTrade(trade(10, '100', '1'));
    b.finalize(T0 + M + 2_000);
    b.addTrade(trade(50, '200', '1'));
    expect(b.lateTrades).toBe(1);
    expect(b.pendingFrom).toBe(T0 + M);
  });

  it('skips the partly seen minute before its start and needs a known close for flat candles', () => {
    const b = new TradeCandleBuilder(
      { profileBuckets: 2, graceMs: 0, closed: never },
      { nextOpen: T0 + M, lastClose: null },
    );
    b.addTrade(trade(30_000, '100', '1')); // before the start: not late, just not ours
    expect(b.lateTrades).toBe(0);
    expect(b.finalize(T0 + 2 * M)).toEqual([]); // no trades and no previous close: nothing to write
    expect(
      () =>
        new TradeCandleBuilder(
          { profileBuckets: 2, graceMs: 0, closed: never },
          { nextOpen: T0 + 1, lastClose: null },
        ),
    ).toThrow();
  });

  it('flags minutes inside a gold-market closure', () => {
    const b = new TradeCandleBuilder(
      { profileBuckets: 2, graceMs: 0, closed: (start) => start >= T0 + M },
      { nextOpen: T0, lastClose: '1' },
    );
    expect(b.finalize(T0 + 2 * M).map((c) => c.underlyingClosed)).toEqual([false, true]);
  });

  it('builds candles from recorded Coinbase trades without losing volume', () => {
    const lines = parseRecording(
      readFileSync(new URL('../../exchange-adapters/fixtures/coinbase-ws.jsonl', import.meta.url), 'utf8'),
    );
    const trades = replayEvents(lines).events.filter(
      (e): e is TradeEvent => e.type === 'trade' && e.symbol === 'BTC-USD',
    );
    const first = Math.floor(trades[0]!.ts / M) * M;
    const b = new TradeCandleBuilder(
      { profileBuckets: 24, graceMs: 2_000, closed: never },
      { nextOpen: first, lastClose: trades[0]!.price },
    );
    for (const t of trades) b.addTrade(t);
    const candles = b.finalize(trades.at(-1)!.ts + 2 * M);
    expect(addDecimals(candles.map((c) => c.volume))).toBe(addDecimals(trades.map((t) => t.qty)));
    for (const c of candles) expect(Number(c.high)).toBeGreaterThanOrEqual(Number(c.low));
  });
});

describe('KlineCandleAssembler (Binance)', () => {
  const kline = (tradeCount: number) => ({
    openTime: T0,
    open: '100',
    high: '102',
    low: '99',
    close: '101',
    volume: '3',
    quoteVolume: '301',
    tradeCount,
    takerBuyVolume: '2',
  });

  it('takes OHLCV from the venue and the profile from our trades', () => {
    const a = new KlineCandleAssembler({ profileBuckets: 3, closed: never });
    a.addTrade(trade(1_000, '99', '1'));
    a.addTrade(trade(2_000, '102', '2'));
    const c = a.onFinalKline(kline(2));
    expect(c).toMatchObject({
      source: 'exchange_kline',
      open: '100',
      close: '101',
      tradeCount: 2,
      microProfile: [1, 0, 2],
    });
    expect(a.bufferedMinutes).toBe(0);
  });

  it('leaves the profile unknown when we saw fewer fills than the venue counted', () => {
    const a = new KlineCandleAssembler({ profileBuckets: 3, closed: never });
    a.addTrade(trade(1_000, '100', '1'));
    expect(a.onFinalKline(kline(5)).microProfile).toBeNull();
    expect(
      new KlineCandleAssembler({ profileBuckets: 3, closed: never }).onFinalKline(kline(0)).microProfile,
    ).toEqual([0, 0, 0]);
  });

  it('drops trades for minutes older than the closed kline', () => {
    const a = new KlineCandleAssembler({ profileBuckets: 2, closed: () => true });
    a.addTrade(trade(-M, '1', '1'));
    expect(a.onFinalKline(kline(0)).underlyingClosed).toBe(true);
    expect(a.bufferedMinutes).toBe(0);
  });
});
