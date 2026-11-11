import { describe, expect, it } from 'vitest';
import type { RestCandle } from '@cip/exchange-adapters';
import { aggregateRest, type FromRestOptions, fromRest } from './rest-candles.ts';

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 6, 8); // Tuesday 08:00 UTC, a 4h boundary

/** A Coinbase REST candle: no quote volume, trade count or taker volume. */
const cb = (i: number, o: string, h: string, l: string, c: string, v: string): RestCandle => ({
  openTime: T0 + i * H,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: v,
});

const hourly = (o: Partial<FromRestOptions> = {}): FromRestOptions => ({
  timeframe: '1h',
  from: T0,
  to: T0 + 4 * H,
  fillEmpty: true,
  previousClose: null,
  quality: 'complete',
  closed: () => false,
  profileBuckets: 24,
  ...o,
});

describe('REST candles at a higher timeframe', () => {
  it('fills a period Coinbase omitted with a flat candle at the previous close', () => {
    const rows = [cb(0, '100', '102', '99', '101', '2'), cb(2, '101', '104', '100', '103', '1')];
    const candles = fromRest(rows, hourly({ to: T0 + 3 * H }));
    expect(candles.map((c) => [c.openTime, c.open, c.close, c.volume, c.tradeCount])).toEqual([
      [T0, '100', '101', '2', null],
      [T0 + H, '101', '101', '0', 0], // nothing traded: flat, and known to be empty
      [T0 + 2 * H, '101', '103', '1', null],
    ]);
    expect(candles[0]).toMatchObject({
      timeframe: '1h',
      quoteVolume: '202', // volume × close stands in for Coinbase
      microProfile: null,
      source: 'rest',
      quality: 'complete',
    });
    expect(candles[1]).toMatchObject({ timeframe: '1h', microProfile: null, source: 'rest' });
  });

  it('invents nothing before the first REST candle unless a close before the range is known', () => {
    const rows = [cb(2, '101', '104', '100', '103', '1')];
    expect(fromRest(rows, hourly()).map((c) => c.openTime)).toEqual([T0 + 2 * H, T0 + 3 * H]);
    const known = fromRest(rows, hourly({ previousClose: '99.5' }));
    expect(known.map((c) => [c.openTime, c.close])).toEqual([
      [T0, '99.5'],
      [T0 + H, '99.5'],
      [T0 + 2 * H, '103'],
      [T0 + 3 * H, '103'],
    ]);
  });

  it('keeps Binance fields and leaves a missing kline missing', () => {
    const kline: RestCandle = {
      ...cb(0, '10', '11', '9', '10.5', '3'),
      quoteVolume: '31',
      tradeCount: 5,
      takerBuyVolume: '1',
    };
    const candles = fromRest([kline, { ...kline, openTime: T0 + 2 * H }], hourly({ fillEmpty: false }));
    expect(candles.map((c) => c.openTime)).toEqual([T0, T0 + 2 * H]);
    expect(candles[0]).toMatchObject({ quoteVolume: '31', tradeCount: 5, takerBuyVolume: '1' });
  });

  it('flags a period that overlaps a closure, judged on the whole period', () => {
    const seen: [number, number][] = [];
    const closed = (start: number, end: number) => {
      seen.push([start, end]);
      return start === T0 + H;
    };
    const candles = fromRest(
      [cb(0, '1', '1', '1', '1', '1')],
      hourly({ closed, quality: 'repaired', to: T0 + 2 * H }),
    );
    expect(candles.map((c) => [c.underlyingClosed, c.quality])).toEqual([
      [false, 'repaired'],
      [true, 'repaired'],
    ]);
    expect(seen).toEqual([
      [T0, T0 + H],
      [T0 + H, T0 + 2 * H],
    ]);
  });
});

describe('Coinbase 4h candles from 1h', () => {
  const hours = fromRest(
    [
      cb(0, '100', '102', '99', '101', '2'),
      // 09:00 omitted: nothing traded
      cb(2, '101', '106', '100', '105', '1'),
      cb(3, '105', '105', '98', '99', '4'),
      cb(4, '99', '100', '97', '98', '1'),
      cb(5, '98', '99', '98', '99', '1'),
    ],
    hourly({ to: T0 + 6 * H }),
  );

  it('aggregates four UTC-aligned hours into one candle, the flat hour included', () => {
    const [first] = aggregateRest('4h', hours, () => false);
    expect(first).toEqual({
      timeframe: '4h',
      openTime: T0,
      open: '100',
      high: '106',
      low: '98',
      close: '99',
      volume: '7',
      quoteVolume: '703', // 202 + 0 + 105 + 396
      tradeCount: null,
      takerBuyVolume: null,
      microProfile: null,
      source: 'rest',
      quality: 'complete',
      underlyingClosed: false,
    });
  });

  it('marks a period with missing hours partial and flags a closure in a missing hour', () => {
    const closed = (start: number, end: number) => start <= T0 + 7 * H && end > T0 + 7 * H;
    const candles = aggregateRest('4h', hours, closed);
    expect(candles.map((c) => [c.openTime, c.quality, c.underlyingClosed, c.close])).toEqual([
      [T0, 'complete', false, '99'],
      [T0 + 4 * H, 'partial', true, '99'], // 12:00 and 13:00 only; the closure is at 15:00
    ]);
    expect(aggregateRest('4h', [], closed)).toEqual([]);
  });
});
