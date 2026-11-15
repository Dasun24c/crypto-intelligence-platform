import { describe, expect, it } from 'vitest';
import type { Candle } from '@cip/domain';
import { KlineCandleAssembler, TradeCandleBuilder } from './candles.js';
import { RunningCandles } from './running.js';

const H = Date.UTC(2026, 10, 10, 9, 0); // 09:00 UTC: a 1h and 4h boundary is not crossed below

function minute(i: number, o: string, h: string, l: string, c: string, v = '1'): Candle {
  return {
    timeframe: '1m',
    openTime: H + i * 60_000,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v,
    quoteVolume: v,
    tradeCount: 2,
    takerBuyVolume: '0.5',
    microProfile: [1],
    source: 'exchange_kline',
    quality: 'complete',
    underlyingClosed: false,
  };
}

describe('RunningCandles', () => {
  it('folds closed minutes and the minute in progress into every timeframe', () => {
    const r = new RunningCandles();
    r.onMinuteClosed(minute(0, '100', '105', '99', '104'));
    r.onMinuteClosed(minute(1, '104', '110', '103', '108'));
    const now = H + 2 * 60_000 + 30_000;
    const live = minute(2, '108', '109', '95', '96', '2');
    const c = r.current(live, now);
    expect(c['1m']).toBe(live);
    expect(c['5m']).toMatchObject({
      timeframe: '5m',
      openTime: H,
      open: '100',
      high: '110',
      low: '95',
      close: '96',
      volume: '4',
      tradeCount: 6,
      takerBuyVolume: '1.5',
      source: 'aggregated',
      quality: 'complete',
      microProfile: null,
    });
    // 09:00 is a 1h boundary but 1d started at 00:00 with nine hours unseen: partial, not complete.
    expect(c['1h']!.quality).toBe('complete');
    expect(c['1d']!.quality).toBe('partial');
  });

  it('starts a new period at its boundary and ignores minutes from earlier periods', () => {
    const r = new RunningCandles();
    r.onMinuteClosed(minute(4, '1', '2', '1', '2'));
    r.onMinuteClosed(minute(5, '7', '8', '6', '7')); // 09:05 starts a new 5m period
    r.onMinuteClosed(minute(3, '50', '50', '50', '50')); // out of order: ignored everywhere
    const c = r.current(null, H + 6 * 60_000 + 1);
    expect(c['5m']).toMatchObject({ openTime: H + 5 * 60_000, open: '7', close: '7', quality: 'complete' });
    expect(c['1m']).toBeUndefined();
    expect(c['15m']).toMatchObject({ open: '1', high: '8', close: '7', quality: 'partial' }); // 09:00–09:03 missing
  });

  it('shows nothing for a timeframe with no data in its current period', () => {
    expect(new RunningCandles().current(null, H)).toEqual({});
  });
});

describe('candles in progress', () => {
  it('builds the current minute from the trades so far, or a flat candle before the first trade', () => {
    const b = new TradeCandleBuilder(
      { profileBuckets: 4, graceMs: 2_000, closed: () => false },
      { nextOpen: H, lastClose: '100' },
    );
    expect(b.inProgress(H + 1_000)).toMatchObject({ open: '100', close: '100', volume: '0' });
    b.addTrade({ ts: H + 2_000, price: '101', qty: '1', takerSide: 'buy' });
    b.addTrade({ ts: H + 3_000, price: '99', qty: '2', takerSide: 'sell' });
    expect(b.inProgress(H + 5_000)).toMatchObject({
      open: '101',
      high: '101',
      low: '99',
      close: '99',
      volume: '3',
    });
    expect(b.inProgress(H - 60_000)).toBeNull(); // before the first minute it builds
  });

  it('turns a Binance kline in progress into a display candle without a profile', () => {
    const a = new KlineCandleAssembler({ profileBuckets: 4, closed: () => true });
    expect(
      a.inProgress({
        openTime: H,
        open: '1',
        high: '2',
        low: '0.5',
        close: '1.5',
        volume: '10',
        quoteVolume: '15',
        tradeCount: 3,
        takerBuyVolume: '4',
      }),
    ).toMatchObject({ close: '1.5', microProfile: null, underlyingClosed: true, source: 'exchange_kline' });
  });
});
