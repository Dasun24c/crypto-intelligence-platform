import { describe, expect, it } from 'vitest';
import {
  addDecimals,
  aggregateCandles,
  type Candle,
  compareDecimal,
  divDecimal,
  displayName,
  flatCandle,
  floorTo,
  generateClosures,
  GOLD_CLOSURE_RULE,
  isDecimalString,
  isTimeframe,
  maxDecimal,
  minDecimal,
  minuteOpenTimes,
  minutesIn,
  mulDecimal,
  normalizeDecimal,
  overlapsClosure,
  roundDecimal,
  REST_SETTLE_MS,
  restSettledAt,
  timeframesClosingAt,
  timeZoneOffset,
  toNumber,
  worstQuality,
  zonedTimeToUtc,
} from './index.js';

const T0 = Date.UTC(2026, 10, 10, 12, 0); // Tuesday 12:00 UTC

describe('timeframes', () => {
  it('waits for the last minute of a gap to close and settle before REST repair', () => {
    expect(restSettledAt(T0)).toBe(T0 + REST_SETTLE_MS);
    expect(restSettledAt(T0 + 1)).toBe(T0 + 60_000 + REST_SETTLE_MS); // a partial minute counts whole
  });

  it('aligns to UTC periods', () => {
    const t = Date.UTC(2026, 10, 10, 13, 47, 31, 500);
    expect(floorTo(t, '1m')).toBe(Date.UTC(2026, 10, 10, 13, 47));
    expect(floorTo(t, '15m')).toBe(Date.UTC(2026, 10, 10, 13, 45));
    expect(floorTo(t, '4h')).toBe(Date.UTC(2026, 10, 10, 12, 0));
    expect(floorTo(t, '1d')).toBe(Date.UTC(2026, 10, 10));
    expect(minutesIn('4h')).toBe(240);
  });

  it('knows which candles close at a boundary', () => {
    expect(timeframesClosingAt(Date.UTC(2026, 10, 11))).toEqual(['1m', '5m', '15m', '1h', '4h', '1d']);
    expect(timeframesClosingAt(T0)).toEqual(['1m', '5m', '15m', '1h', '4h']);
    expect(timeframesClosingAt(T0 + 5 * 60_000)).toEqual(['1m', '5m']);
    expect(timeframesClosingAt(T0 + 60_000)).toEqual(['1m']);
  });

  it('recognises timeframe names', () => {
    expect(isTimeframe('4h')).toBe(true);
    expect(isTimeframe('2h')).toBe(false);
  });
});

describe('decimals', () => {
  it('normalises venue formats and adds exactly', () => {
    expect(normalizeDecimal('0.00100000')).toBe('0.001');
    expect(normalizeDecimal('65000.10')).toBe('65000.1');
    expect(normalizeDecimal('1e-9')).toBe('0.000000001');
    expect(addDecimals(['0.1', '0.2'])).toBe('0.3');
    expect(addDecimals([])).toBe('0');
    expect(mulDecimal('4106.99', '0.0123')).toBe('50.515977');
    expect(divDecimal('10', '3', 4)).toBe('3.3333');
    expect(divDecimal('205.5', '0.05')).toBe('4110');
    expect(roundDecimal('1234.565', 2)).toBe('1234.57');
  });

  it('compares and picks extremes', () => {
    expect(compareDecimal('10.5', '10.50')).toBe(0);
    expect(compareDecimal('9.99', '10')).toBe(-1);
    expect(maxDecimal('1.2', '1.19')).toBe('1.2');
    expect(minDecimal('1.2', '1.19')).toBe('1.19');
    expect(toNumber('2.5')).toBe(2.5);
  });

  it('validates decimal strings', () => {
    expect(isDecimalString('-12.034')).toBe(true);
    expect(isDecimalString('1e5')).toBe(false);
    expect(isDecimalString('12.')).toBe(false);
  });
});

function minute(
  i: number,
  o: string,
  h: string,
  l: string,
  c: string,
  v: string,
  extra: Partial<Candle> = {},
): Candle {
  return {
    timeframe: '1m',
    openTime: T0 + i * 60_000,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v,
    quoteVolume: mulDecimal(v, c),
    tradeCount: 3,
    takerBuyVolume: '0.5',
    microProfile: [1, 2],
    source: 'trades',
    quality: 'complete',
    underlyingClosed: false,
    ...extra,
  };
}

describe('candles', () => {
  const minutes = [
    minute(0, '100', '101', '99.5', '100.5', '2'),
    minute(1, '100.5', '102', '100', '101.5', '1.5'),
    minute(2, '101.5', '101.5', '98', '99', '3'),
    minute(3, '99', '100', '98.5', '99.75', '0.25'),
    minute(4, '99.75', '100.25', '99.5', '100', '1'),
  ];

  it('aggregates five 1m candles into a 5m candle', () => {
    const c = aggregateCandles('5m', T0, [...minutes].reverse());
    expect(c).toMatchObject({
      timeframe: '5m',
      openTime: T0,
      open: '100',
      high: '102',
      low: '98',
      close: '100',
      volume: '7.75',
      tradeCount: 15,
      takerBuyVolume: '2.5',
      microProfile: null,
      source: 'aggregated',
      quality: 'complete',
      underlyingClosed: false,
    });
  });

  it('marks missing minutes partial, carries the worst quality and any closure', () => {
    expect(aggregateCandles('5m', T0, minutes.slice(0, 4)).quality).toBe('partial');
    const repaired = minutes.map((m, i) =>
      i === 2 ? { ...m, quality: 'repaired' as const, underlyingClosed: true } : m,
    );
    const c = aggregateCandles('5m', T0, repaired);
    expect(c.quality).toBe('repaired');
    expect(c.underlyingClosed).toBe(true);
    expect(worstQuality(['complete', 'partial', 'repaired'])).toBe('partial');
  });

  it('loses trade counts and taker volume when any minute lacks them', () => {
    const c = aggregateCandles(
      '5m',
      T0,
      minutes.map((m, i) => (i === 1 ? { ...m, tradeCount: null, takerBuyVolume: null } : m)),
    );
    expect(c.tradeCount).toBeNull();
    expect(c.takerBuyVolume).toBeNull();
  });

  it('refuses misaligned, empty, duplicate or 1m aggregation', () => {
    expect(() => aggregateCandles('5m', T0 + 60_000, minutes)).toThrow(/aligned/);
    expect(() => aggregateCandles('15m', T0 + 15 * 60_000, minutes)).toThrow(/no 1m/);
    expect(() => aggregateCandles('5m', T0, [minutes[0]!, minutes[0]!])).toThrow(/duplicate/);
    expect(() => aggregateCandles('1m', T0, minutes)).toThrow();
  });

  it('builds flat candles for minutes without trades', () => {
    const c = flatCandle(T0, '100.5', { source: 'trades', underlyingClosed: true, profileBuckets: 24 });
    expect(c).toMatchObject({
      open: '100.5',
      high: '100.5',
      low: '100.5',
      close: '100.5',
      volume: '0',
      tradeCount: 0,
    });
    expect(c.microProfile).toHaveLength(24);
    expect(c.underlyingClosed).toBe(true);
    expect(minuteOpenTimes(T0, T0 + 3 * 60_000)).toEqual([T0, T0 + 60_000, T0 + 120_000]);
  });
});

describe('instruments', () => {
  it('always labels PAXG as the gold-backed token, never as gold or XAUUSD', () => {
    const paxg = displayName({ venue: 'binance', base: 'PAXG', quote: 'USDT', assetClass: 'tokenised_gold' });
    expect(paxg).toBe('PAXG (gold-backed token) · Binance PAXG/USDT');
    expect(paxg).not.toMatch(/XAU/);
    expect(displayName({ venue: 'coinbase', base: 'BTC', quote: 'USD', assetClass: 'crypto' })).toBe(
      'BTC · Coinbase BTC/USD',
    );
  });
});

describe('gold-market closure calendar', () => {
  const tz = 'America/New_York';

  it('converts New York wall time across daylight saving', () => {
    expect(zonedTimeToUtc(2026, 11, 9, '17:00', tz)).toBe(Date.UTC(2026, 10, 9, 22, 0)); // EST, UTC−5
    expect(zonedTimeToUtc(2026, 7, 6, '17:00', tz)).toBe(Date.UTC(2026, 6, 6, 21, 0)); // EDT, UTC−4
    expect(timeZoneOffset(Date.UTC(2026, 6, 6, 12), tz)).toBe(-4 * 3_600_000);
  });

  it('generates the weekend and daily-break closures for a winter week', () => {
    const closures = generateClosures(GOLD_CLOSURE_RULE, Date.UTC(2026, 10, 9), Date.UTC(2026, 10, 16));
    const h = (d: number, hh: number) => Date.UTC(2026, 10, d, hh);
    expect(closures).toEqual([
      { startsAt: h(9, 22), endsAt: h(9, 23), reason: 'daily_break' },
      { startsAt: h(10, 22), endsAt: h(10, 23), reason: 'daily_break' },
      { startsAt: h(11, 22), endsAt: h(11, 23), reason: 'daily_break' },
      { startsAt: h(12, 22), endsAt: h(12, 23), reason: 'daily_break' },
      { startsAt: h(13, 22), endsAt: h(15, 23), reason: 'weekend' },
    ]);
  });

  it('follows the clock change inside a weekend closure (8 March 2026)', () => {
    const closures = generateClosures(GOLD_CLOSURE_RULE, Date.UTC(2026, 2, 6), Date.UTC(2026, 2, 9));
    const weekend = closures.find((c) => c.reason === 'weekend');
    expect(weekend).toEqual({
      startsAt: Date.UTC(2026, 2, 6, 22),
      endsAt: Date.UTC(2026, 2, 8, 22),
      reason: 'weekend',
    });
  });

  it('includes a weekend already in progress and tests overlap', () => {
    const saturday = Date.UTC(2026, 10, 14, 12);
    const closures = generateClosures(GOLD_CLOSURE_RULE, saturday, saturday + 3_600_000);
    expect(closures).toHaveLength(1);
    expect(overlapsClosure(saturday, saturday + 60_000, closures)).toBe(true);
    expect(overlapsClosure(Date.UTC(2026, 10, 16, 0), Date.UTC(2026, 10, 16, 1), closures)).toBe(false);
  });
});
