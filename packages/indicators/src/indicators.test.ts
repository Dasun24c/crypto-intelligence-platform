import { describe, expect, it } from 'vitest';
import { TF_MS } from '@cip/domain';
import { assertPeriod } from './bar.js';
import { Atr, atr, trueRange, wilderWeights } from './atr.js';
import { Ema, ema, emaWeights } from './ema.js';
import { Macd, macd, macdLookback } from './macd.js';
import { Rsi, rsi } from './rsi.js';
import {
  computeIndicators,
  DEFAULT_INDICATOR_PARAMS,
  type IndicatorParams,
  IndicatorSeries,
  indicatorLookbacks,
  validateIndicatorParams,
} from './series.js';
import { classifyTrend } from './trend.js';
import { isVolumeAnomaly, robustZ, VolumeZ, volumeZ } from './volume.js';

const stream = <T>(values: readonly number[], next: (x: number) => T) => values.map(next);

describe('EMA', () => {
  it('derives k and beta so that they add up to exactly 1', () => {
    for (let n = 2; n <= 5000; n++) {
      const { beta, k } = emaWeights(n);
      expect(beta + k).toBe(1);
      expect(Math.abs(k - 2 / (n + 1))).toBeLessThan(1e-15);
    }
    // n = 2: 1 − 1/3 is inexact, so beta is re-derived from k, which keeps the sum exact.
    const two = emaWeights(2);
    expect(two.k).toBe(1 - 1 / 3);
    expect(two.beta).toBe(1 - two.k);
    expect(two.beta).not.toBe(1 / 3);
  });

  it('seeds with the simple average, then smooths (worked example, n = 3)', () => {
    // beta = 0.5 and k = 0.5: seed (1 + 2 + 3) / 3 = 2, then 0.5 × 2 + 0.5 × 4 = 3, then 0.5 × 3 + 0.5 × 5 = 4.
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    const e = new Ema(3);
    expect(stream([1, 2, 3, 4, 5], (x) => e.next(x))).toEqual([null, null, 2, 3, 4]);
  });

  it('keeps a flat input exactly flat once seeded on it', () => {
    // 67 123.5 and its multiples are exact, so the seed is exactly the level; fma keeps it there.
    const flat = new Array<number>(500).fill(67_123.5);
    expect(
      ema(flat, 200)
        .slice(199)
        .every((v) => v === 67_123.5),
    ).toBe(true);
  });

  it('can seed later, on the n inputs ending at seedAt', () => {
    expect(ema([10, 1, 2, 3, 4], 3, 3)).toEqual([null, null, null, 2, 3]);
    const e = new Ema(3, 3);
    expect(stream([10, 1, 2, 3, 4], (x) => e.next(x))).toEqual([null, null, null, 2, 3]);
  });

  it('returns only nulls for a series shorter than its warm-up', () => {
    expect(ema([1, 2], 3)).toEqual([null, null]);
  });

  it('rejects periods and seeds it cannot use', () => {
    expect(() => ema([1], 1)).toThrow(/EMA period/);
    expect(() => ema([1], 2.5)).toThrow(/whole number/);
    expect(() => new Ema(200_000)).toThrow(/100000/);
    expect(() => ema([1, 2, 3], 3, 1)).toThrow(/needs 3 inputs/);
    expect(() => new Ema(3, 1)).toThrow(/needs 3 inputs/);
    expect(() => assertPeriod('x', 0, 1)).toThrow(/from 1/);
  });
});

describe('RSI', () => {
  it('follows Wilder smoothing (worked example, n = 2)', () => {
    // Changes +1, −1, +1, −1. Seed: gain 1 × ½ = 0.5, loss 1 × ½ = 0.5, RSI 50.
    // Then gain (0.5 + 1) × ½ = 0.75, loss 0.5 × ½ = 0.25: RSI 75.
    // Then gain 0.75 × ½ = 0.375, loss (0.25 + 1) × ½ = 0.625: RSI 37.5.
    expect(rsi([1, 2, 1, 2, 1], 2)).toEqual([null, null, 50, 75, 37.5]);
    const r = new Rsi(2);
    expect(stream([1, 2, 1, 2, 1], (x) => r.next(x))).toEqual([null, null, 50, 75, 37.5]);
  });

  it('reads 100 for a market that only rises, 0 for one that only falls and 50 for a flat one', () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(rsi(up, 14).at(-1)).toBe(100);
    expect(rsi(up.toReversed(), 14).at(-1)).toBe(0);
    expect(rsi(new Array<number>(30).fill(5), 14).at(-1)).toBe(50);
  });

  it('needs n + 1 inputs', () => {
    expect(rsi([1, 2, 3], 3)).toEqual([null, null, null]);
    expect(() => new Rsi(1)).toThrow(/RSI period/);
  });
});

describe('MACD', () => {
  it('reports from index slow + signal − 2, with the histogram as MACD − signal', () => {
    expect(macdLookback(12, 26, 9)).toBe(33);
    const values = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 3) * 5 + i * 0.1);
    const m = macd(values, 12, 26, 9);
    expect(m.macd.slice(0, 33).every((v) => v === null)).toBe(true);
    expect(m.macd[33]).not.toBeNull();
    for (let i = 33; i < 80; i++) expect(m.hist[i]).toBe(m.macd[i]! - m.signal[i]!);
    const s = new Macd(12, 26, 9);
    const streamed = values.map((x) => s.next(x));
    expect(streamed.slice(0, 33).every((v) => v === null)).toBe(true);
    expect(streamed.slice(33)).toEqual(
      values
        .slice(33)
        .map((_, j) => ({ macd: m.macd[33 + j], signal: m.signal[33 + j], hist: m.hist[33 + j] })),
    );
  });

  it('seeds the fast EMA on the inputs that end where the slow one is seeded (TA-Lib)', () => {
    const values = Array.from({ length: 40 }, (_, i) => (i < 14 ? 1000 : 100));
    // The fast EMA is seeded on inputs 14..25, so the early 1000s reach only the slow EMA.
    // So the fast EMA is exactly 100 throughout, and MACD is 100 minus the slow EMA.
    const m = macd(values, 12, 26, 9);
    const slow = ema(values, 26);
    expect(m.macd[33]).toBe(100 - slow[33]!);
    expect(m.macd[33]).toBeLessThan(-200);
  });

  it('is empty for short series and rejects a slow period that is not longer', () => {
    expect(macd([1, 2, 3], 12, 26, 9).macd).toEqual([null, null, null]);
    expect(() => macd([1], 26, 12, 9)).toThrow(/longer than the fast/);
    expect(() => new Macd(12, 12, 9)).toThrow(/longer than the fast/);
  });
});

describe('ATR', () => {
  it('takes the largest of the three distances', () => {
    expect(trueRange(12, 10, 11)).toBe(2); // inside the previous close: H − L
    expect(trueRange(12, 11, 8)).toBe(4); // gap up: |8 − 12|
    expect(trueRange(9, 8, 12)).toBe(4); // gap down: |12 − 8|
  });

  it('averages, then smooths with fma(beta, previous, alpha × TR) (worked example, n = 2)', () => {
    // TR1 = 2, TR2 = 2, so the seed at index 2 is 2; TR3 = 3 (|11 − 8|): 0.5 × 2 + 0.5 × 3 = 2.5.
    const high = [10, 11, 12, 10];
    const low = [8, 9, 10, 8];
    const close = [9, 10, 11, 9];
    expect(atr(high, low, close, 2)).toEqual([null, null, 2, 2.5]);
    const a = new Atr(2);
    expect(high.map((h, i) => a.next(h, low[i]!, close[i]!))).toEqual([null, null, 2, 2.5]);
    expect(wilderWeights(14)).toEqual({ beta: 13 / 14, alpha: 1 - 13 / 14 });
  });

  it('is empty for short series and rejects mismatched inputs', () => {
    expect(atr([1, 2], [1, 2], [1, 2], 2)).toEqual([null, null]);
    expect(() => atr([1], [1, 2], [1], 2)).toThrow(/differ in length/);
    expect(() => new Atr(1)).toThrow(/ATR period/);
  });
});

describe('volume z-score', () => {
  it('is robust: one huge outlier in the window barely moves it', () => {
    const window = [...new Array<number>(49).fill(10), 1_000_000];
    // Median 10, MAD 0, mean absolute deviation (999 990 / 50): an outlier only raises the bar.
    expect(robustZ(10, window)).toBe(0);
    expect(robustZ(10, [])).toBeNull();
    expect(robustZ(10, [7, 10, 13])).toBeCloseTo(0, 12);
    expect(robustZ(16, [7, 10, 13])).toBeCloseTo(6 / (1.4826 * 3), 12);
  });

  it('compares each candle with the ones before it, not itself', () => {
    const volumes = [8, 9, 10, 11, 12, 30];
    const z = volumeZ(volumes, 5);
    expect(z.slice(0, 5)).toEqual([null, null, null, null, null]);
    expect(z[5]).toBeCloseTo(20 / 1.4826, 12);
    const s = new VolumeZ(5);
    expect(volumes.map((v) => s.next(v))).toEqual(z);
    expect(isVolumeAnomaly(null, 3.5)).toBeNull();
    expect(isVolumeAnomaly(3.5, 3.5)).toBe(true);
    expect(isVolumeAnomaly(-10, 3.5)).toBe(false);
  });
});

describe('trend classification', () => {
  const base = { close: 110, emaFast: 105, emaMid: 100, emaSlow: 90, emaMidBefore: 99, atr: 2 };

  it('needs the order and a slope of at least the minimum strength', () => {
    expect(classifyTrend(base, 0.1)).toEqual({ trend: 'bullish', strength: 0.5 });
    expect(classifyTrend(base, 0.6)).toEqual({ trend: 'neutral', strength: 0.5 });
    expect(classifyTrend({ ...base, close: 104 }, 0.1).trend).toBe('neutral');
    const down = { close: 80, emaFast: 85, emaMid: 90, emaSlow: 100, emaMidBefore: 91, atr: 2 };
    expect(classifyTrend(down, 0.1)).toEqual({ trend: 'bearish', strength: -0.5 });
    expect(classifyTrend({ ...down, emaSlow: 89 }, 0.1).trend).toBe('neutral');
  });

  it('is null during the warm-up and neutral without any range', () => {
    expect(classifyTrend({ ...base, emaSlow: null }, 0.1)).toEqual({ trend: null, strength: null });
    expect(classifyTrend({ ...base, emaMidBefore: null }, 0.1).trend).toBeNull();
    expect(classifyTrend({ ...base, atr: null }, 0.1).trend).toBeNull();
    expect(classifyTrend({ ...base, atr: 0 }, 0.1)).toEqual({ trend: 'neutral', strength: null });
  });
});

describe('indicator series', () => {
  const T0 = Date.parse('2026-11-10T00:00:00Z');
  const bar = (i: number, close = 100 + i) => ({
    openTime: T0 + i * TF_MS['5m'],
    high: String(close + 1),
    low: String(close - 1),
    close: String(close),
    volume: String(10 + (i % 7)),
  });

  it('documents each warm-up', () => {
    expect(indicatorLookbacks()).toEqual({
      rsi: 14,
      macd: 33,
      emaFast: 19,
      emaMid: 49,
      emaSlow: 199,
      atr: 14,
      volume: 50,
      trend: 199,
    });
  });

  it('gives each indicator its first value exactly at its warm-up', () => {
    const bars = Array.from({ length: 260 }, (_, i) => bar(i));
    const values = computeIndicators(bars, '5m');
    const firstIndex = (key: keyof (typeof values)[number]) => values.findIndex((v) => v[key] !== null);
    const l = indicatorLookbacks();
    expect(firstIndex('rsi')).toBe(l.rsi);
    expect(firstIndex('macd')).toBe(l.macd);
    expect(firstIndex('emaFast')).toBe(l.emaFast);
    expect(firstIndex('emaMid')).toBe(l.emaMid);
    expect(firstIndex('emaSlow')).toBe(l.emaSlow);
    expect(firstIndex('atr')).toBe(l.atr);
    expect(firstIndex('volumeZ')).toBe(l.volume);
    expect(firstIndex('trend')).toBe(l.trend);
    expect(firstIndex('vwap')).toBe(0);
  });

  it('takes consecutive, aligned candles only', () => {
    const s = new IndicatorSeries('5m');
    expect(s.lastOpenTime).toBeNull();
    s.next(bar(0));
    expect(s.lastOpenTime).toBe(T0);
    expect(() => s.next(bar(2))).toThrow(/consecutive: expected 2026-11-10T00:05:00.000Z/);
    expect(() => s.next({ ...bar(1), openTime: T0 + 1 })).toThrow(/not aligned to 5m/);
    expect(() => computeIndicators([bar(0), bar(0)], '5m')).toThrow(/consecutive/);
    expect(computeIndicators([], '5m')).toEqual([]);
  });

  it('validates every parameter', () => {
    const p = DEFAULT_INDICATOR_PARAMS;
    const bad: [Partial<IndicatorParams>, RegExp][] = [
      [{ rsi: { period: 1 } }, /RSI period/],
      [{ macd: { fast: 26, slow: 12, signal: 9 } }, /slow period/],
      [{ ema: { fast: 50, mid: 20, slow: 200 } }, /must increase/],
      [{ ema: { fast: 1, mid: 20, slow: 200 } }, /fast EMA period/],
      [{ atr: { period: 0 } }, /ATR period/],
      [{ volume: { lookback: 50, zThreshold: 0 } }, /z threshold/],
      [{ volume: { lookback: 1, zThreshold: 3.5 } }, /volume lookback/],
      [{ trend: { slopeBars: 0, minStrength: 0.1 } }, /trend slope/],
      [{ trend: { slopeBars: 5, minStrength: Number.NaN } }, /minimum trend strength/],
    ];
    for (const [change, message] of bad) {
      expect(() => validateIndicatorParams({ ...p, ...change })).toThrow(message);
      expect(() => new IndicatorSeries('1h', { ...p, ...change })).toThrow(message);
    }
    expect(() => validateIndicatorParams(p)).not.toThrow();
    expect(Object.isFrozen(p)).toBe(true);
  });
});
