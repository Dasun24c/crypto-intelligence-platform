import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TF_MS } from '@cip/domain';
import type { Bar } from './bar.js';
import {
  computeIndicators,
  DEFAULT_INDICATOR_PARAMS,
  IndicatorSeries,
  indicatorLookbacks,
} from './series.js';
import type { Trend } from './trend.js';

/** Criterion 3.3: volume-anomaly and trend detection pass labelled positive and negative fixtures. */

const T0 = Date.parse('2026-11-01T00:00:00Z');
const H1 = TF_MS['1h'];
const price = (x: number) => x.toFixed(8);

describe('volume anomalies: labelled fixtures', () => {
  interface Case {
    name: string;
    label: 'anomaly' | 'normal' | 'no basis';
    history: { repeat: string[]; times: number } | { range: [number, number] };
    volume: string;
  }
  const { cases } = JSON.parse(
    readFileSync(new URL('../fixtures/labelled/volume.json', import.meta.url), 'utf8'),
  ) as { cases: Case[] };

  const historyOf = (h: Case['history']) =>
    'range' in h
      ? Array.from({ length: h.range[1] - h.range[0] + 1 }, (_, i) => String(h.range[0] + i))
      : Array.from({ length: h.times }, () => h.repeat).flat();

  it('has positive and negative cases', () => {
    expect(cases.filter((c) => c.label === 'anomaly').length).toBeGreaterThanOrEqual(3);
    expect(cases.filter((c) => c.label === 'normal').length).toBeGreaterThanOrEqual(3);
  });

  for (const c of cases) {
    it(`${c.label}: ${c.name}`, () => {
      const volumes = [...historyOf(c.history), c.volume];
      expect(volumes).toHaveLength(DEFAULT_INDICATOR_PARAMS.volume.lookback + 1);
      const bars: Bar[] = volumes.map((volume, i) => ({
        openTime: T0 + i * H1,
        high: '101',
        low: '99',
        close: '100',
        volume,
      }));
      const last = computeIndicators(bars, '1h').at(-1)!;
      const want = c.label === 'no basis' ? null : c.label === 'anomaly';
      expect(last.volumeAnomaly).toBe(want);
      expect(last.volumeZ === null).toBe(c.label === 'no basis');
      // Every earlier candle is still inside the 50-candle warm-up.
      expect(computeIndicators(bars.slice(0, -1), '1h').every((v) => v.volumeZ === null)).toBe(true);
    });
  }
});

describe('trend: labelled fixtures', () => {
  /** A deterministic series: each close from `closeAt(i)`, with a high and low around it. */
  function series(n: number, closeAt: (i: number) => number, halfRange = (c: number) => c * 0.001): Bar[] {
    return Array.from({ length: n }, (_, i) => {
      const c = closeAt(i);
      return {
        openTime: T0 + i * H1,
        high: price(c + halfRange(c)),
        low: price(c - halfRange(c)),
        close: price(c),
        volume: '10',
      };
    });
  }
  const wave = (i: number) => Math.sin(i * 1.7); // deterministic noise in [−1, 1]

  const cases: { name: string; label: Trend; bars: Bar[]; last: number }[] = [
    {
      name: 'a steady rise of 0.2 % per candle',
      label: 'bullish',
      bars: series(300, (i) => 100 * 1.002 ** i),
      last: 60,
    },
    {
      name: 'a rise of 0.2 % per candle with ±0.3 % noise',
      label: 'bullish',
      bars: series(300, (i) => 100 * 1.002 ** i * (1 + 0.003 * wave(i))),
      last: 60,
    },
    {
      name: 'a steady fall of 0.2 % per candle',
      label: 'bearish',
      bars: series(300, (i) => 100 * 0.998 ** i),
      last: 60,
    },
    {
      name: 'a fall of 0.2 % per candle with ±0.3 % noise',
      label: 'bearish',
      bars: series(300, (i) => 100 * 0.998 ** i * (1 + 0.003 * wave(i))),
      last: 60,
    },
    { name: 'a flat market with a range', label: 'neutral', bars: series(300, () => 100), last: 90 },
    {
      name: 'noise that alternates every candle around a flat level',
      label: 'neutral',
      bars: series(
        300,
        (i) => (i % 2 === 0 ? 100 : 101),
        () => 0.2,
      ),
      last: 90,
    },
    {
      name: 'a sharp pullback inside an uptrend (the close falls below the fast EMA)',
      label: 'neutral',
      bars: series(285, (i) => (i < 280 ? 100 * 1.002 ** i : 100 * 1.002 ** 279 * 0.985 ** (i - 279))),
      last: 3,
    },
    {
      name: 'no range at all (an ATR of 0)',
      label: 'neutral',
      bars: series(
        300,
        () => 100,
        () => 0,
      ),
      last: 90,
    },
  ];

  it('has positive and negative cases', () => {
    expect(cases.filter((c) => c.label !== 'neutral').length).toBeGreaterThanOrEqual(4);
    expect(cases.filter((c) => c.label === 'neutral').length).toBeGreaterThanOrEqual(4);
  });

  const warmUp = indicatorLookbacks().trend;
  for (const c of cases) {
    it(`${c.label}: ${c.name}`, () => {
      const values = computeIndicators(c.bars, '1h');
      // Null throughout the warm-up, then a label on every candle.
      expect(values.slice(0, warmUp).every((v) => v.trend === null)).toBe(true);
      expect(values.slice(warmUp).every((v) => v.trend !== null)).toBe(true);
      const tail = values.slice(-c.last);
      expect(tail.map((v) => v.trend)).toEqual(tail.map(() => c.label));
      const series = new IndicatorSeries('1h');
      expect(c.bars.map((b) => series.next(b).trend)).toEqual(values.map((v) => v.trend));
    });
  }

  it('reports the strength behind each label', () => {
    const up = computeIndicators(cases[0]!.bars, '1h').at(-1)!;
    expect(up.trendStrength).toBeGreaterThan(1);
    const noise = computeIndicators(cases[5]!.bars, '1h').at(-1)!;
    expect(Math.abs(noise.trendStrength!)).toBeLessThan(DEFAULT_INDICATOR_PARAMS.trend.minStrength);
    expect(computeIndicators(cases[7]!.bars, '1h').at(-1)!.trendStrength).toBeNull();
  });
});
