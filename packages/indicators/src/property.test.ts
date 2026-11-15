import { describe, expect, it } from 'vitest';
import { floorTo, TF_MS, TIMEFRAMES, type Timeframe } from '@cip/domain';
import type { Bar } from './bar.js';
import { computeIndicators, type IndicatorParams, IndicatorSeries } from './series.js';

/**
 * Criterion 3.4: the streaming and batch implementations give identical results on the same data.
 * Random series (seeded, so any failure reproduces) with random parameters, flat stretches, zero
 * volume, gaps up and down, and series that start mid-day.
 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Next = () => number;
const int = (next: Next, lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));

function randomParams(next: Next): IndicatorParams {
  const fast = int(next, 2, 15);
  const emaFast = int(next, 2, 20);
  const emaMid = int(next, emaFast + 1, 60);
  return {
    rsi: { period: int(next, 2, 30) },
    macd: { fast, slow: int(next, fast + 1, 40), signal: int(next, 2, 12) },
    ema: { fast: emaFast, mid: emaMid, slow: int(next, emaMid + 1, 120) },
    atr: { period: int(next, 2, 30) },
    volume: { lookback: int(next, 2, 60), zThreshold: 1 + next() * 4 },
    trend: { slopeBars: int(next, 1, 10), minStrength: 0.01 + next() * 0.5 },
  };
}

function randomBars(next: Next, tf: Timeframe, length: number): Bar[] {
  const start = floorTo(
    Date.parse('2026-01-01T00:00:00Z') + int(next, 0, 400) * 86_400_000 + int(next, 0, 86_399_999),
    tf,
  );
  const decimals = int(next, 0, 8);
  let close = 10 ** int(next, -4, 5) * (1 + next());
  const bars: Bar[] = [];
  let flatFor = 0;
  for (let i = 0; i < length; i++) {
    if (flatFor === 0 && next() < 0.03) flatFor = int(next, 1, 40);
    let open = close;
    let high: number;
    let low: number;
    let volume: number;
    if (flatFor > 0) {
      flatFor--;
      high = low = close;
      volume = 0;
    } else {
      if (next() < 0.02) open = close * (1 + (next() - 0.5) * 0.2); // a gap
      close = Math.max(open * (1 + (next() - 0.5) * 0.04), 10 ** -decimals);
      high = Math.max(open, close) * (1 + next() * 0.01);
      low = Math.min(open, close) * (1 - next() * 0.01);
      volume = next() < 0.1 ? 0 : next() ** 3 * 1000;
    }
    const fmt = (x: number) => Math.max(x, 0).toFixed(decimals);
    bars.push({
      openTime: start + i * TF_MS[tf],
      high: fmt(high),
      low: fmt(Math.min(low, high)),
      close: fmt(close),
      volume: volume.toFixed(int(next, 0, 8)),
    });
  }
  return bars;
}

describe('streaming = batch (criterion 3.4)', () => {
  it('gives identical values, to the bit, on 400 random series', () => {
    const next = rng(31337);
    let points = 0;
    for (let run = 0; run < 400; run++) {
      const tf = TIMEFRAMES[int(next, 0, TIMEFRAMES.length - 1)]!;
      const params = randomParams(next);
      const bars = randomBars(next, tf, int(next, 0, 400));
      const batch = computeIndicators(bars, tf, params);
      const series = new IndicatorSeries(tf, params);
      const streamed = bars.map((b) => series.next(b));
      // toStrictEqual compares numbers with Object.is: -0 and +0 differ, NaN must not appear.
      expect(streamed, `run ${run} (${tf})`).toStrictEqual(batch);
      const nan = batch.flatMap((v) => Object.entries(v).filter(([, x]) => Number.isNaN(x)));
      expect(nan, `run ${run}: NaN values`).toEqual([]);
      points += bars.length;
    }
    expect(points).toBeGreaterThan(70_000);
    // Generous: a few seconds here, but CI machines and loaded hosts can be many times slower.
  }, 240_000);

  it('never repaints: a value depends only on the candles up to it', () => {
    const next = rng(4242);
    for (let run = 0; run < 60; run++) {
      const tf = TIMEFRAMES[int(next, 0, TIMEFRAMES.length - 1)]!;
      const params = randomParams(next);
      const bars = randomBars(next, tf, int(next, 50, 400));
      const full = computeIndicators(bars, tf, params);
      for (let k = 0; k < 5; k++) {
        const cut = int(next, 0, bars.length);
        expect(computeIndicators(bars.slice(0, cut), tf, params)).toStrictEqual(full.slice(0, cut));
      }
    }
  });
});
