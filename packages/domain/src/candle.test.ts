import { describe, expect, it } from 'vitest';
import { aggregateCandles, type Candle, flatCandle, mulDecimal } from './index.js';

const T0 = Date.UTC(2026, 10, 10, 8, 0); // Tuesday 08:00 UTC, a 4h boundary
const HOUR = 3_600_000;

function hour(
  i: number,
  o: string,
  h: string,
  l: string,
  c: string,
  v: string,
  extra: Partial<Candle> = {},
): Candle {
  return {
    timeframe: '1h',
    openTime: T0 + i * HOUR,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v,
    quoteVolume: mulDecimal(v, c),
    tradeCount: null,
    takerBuyVolume: null,
    microProfile: null,
    source: 'rest',
    quality: 'complete',
    underlyingClosed: false,
    ...extra,
  };
}

describe('aggregating a timeframe other than 1m', () => {
  const hours = [
    hour(0, '100', '104', '99', '103', '2'),
    hour(1, '103', '103', '103', '103', '0', { tradeCount: 0 }), // flat: nothing traded
    hour(2, '103', '106', '102', '105', '1.5'),
    hour(3, '105', '105.5', '101', '102', '3'),
  ];

  it('builds a 4h candle from four 1h candles', () => {
    expect(aggregateCandles('4h', T0, [...hours].reverse(), '1h')).toEqual({
      timeframe: '4h',
      openTime: T0,
      open: '100',
      high: '106',
      low: '99',
      close: '102',
      volume: '6.5',
      quoteVolume: '669.5', // 206 + 0 + 157.5 + 306
      tradeCount: null, // the venue gave no trade counts
      takerBuyVolume: null,
      microProfile: null,
      source: 'aggregated',
      quality: 'complete',
      underlyingClosed: false,
    });
  });

  it('marks a 4h candle with fewer than four hours partial', () => {
    expect(aggregateCandles('4h', T0, hours.slice(1), '1h')).toMatchObject({
      open: '103',
      close: '102',
      quality: 'partial',
    });
  });

  it('takes only children of the given timeframe and period', () => {
    const minute: Candle = { ...hours[0]!, timeframe: '1m', high: '999' };
    const nextPeriod = hour(4, '1', '1', '1', '1', '1');
    const c = aggregateCandles('4h', T0, [minute, ...hours, nextPeriod], '1h');
    expect(c.high).toBe('106');
    expect(c.volume).toBe('6.5');
    expect(() => aggregateCandles('4h', T0, [minute], '1h')).toThrow(/no 1h candles/);
  });

  it('refuses a child timeframe that is not shorter, and duplicate children', () => {
    expect(() => aggregateCandles('1h', T0, hours, '1h')).toThrow(/above 1h/);
    expect(() => aggregateCandles('1h', T0, hours, '4h')).toThrow(/above 4h/);
    expect(() => aggregateCandles('4h', T0, [hours[0]!, hours[0]!], '1h')).toThrow(/duplicate 1h/);
  });

  it('still aggregates 1m candles by default', () => {
    const minutes = [0, 1, 2, 3, 4].map((i) => ({
      ...hour(0, '10', '11', '9', '10', '1'),
      timeframe: '1m' as const,
      openTime: T0 + i * 60_000,
    }));
    expect(aggregateCandles('5m', T0, minutes)).toMatchObject({ volume: '5', quality: 'complete' });
  });
});

describe('flat candles for other timeframes', () => {
  it('has no profile above 1m', () => {
    const c = flatCandle(T0, '103', {
      source: 'rest',
      quality: 'repaired',
      underlyingClosed: false,
      profileBuckets: 24,
      timeframe: '1h',
    });
    expect(c).toEqual({
      timeframe: '1h',
      openTime: T0,
      open: '103',
      high: '103',
      low: '103',
      close: '103',
      volume: '0',
      quoteVolume: '0',
      tradeCount: 0,
      takerBuyVolume: '0',
      microProfile: null,
      source: 'rest',
      quality: 'repaired',
      underlyingClosed: false,
    });
    expect(flatCandle(T0, '1', { source: 'rest', underlyingClosed: false, profileBuckets: 3 })).toMatchObject(
      {
        timeframe: '1m',
        microProfile: [0, 0, 0],
      },
    );
  });
});
