import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Timeframe } from '@cip/domain';
import { computeIndicators, IndicatorSeries } from './series.js';
import { Vwap, vwap } from './vwap.js';

/** Criterion 3.2: VWAP matches hand-verified fixtures exactly, including the 00:00 UTC anchor reset. */
interface Fixture {
  cases: {
    name: string;
    timeframe: Timeframe;
    candles: [string, string, string, string, string][];
    expected: { vwap: string | null; working: string }[];
  }[];
}

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/vwap/hand-verified.json', import.meta.url), 'utf8'),
) as Fixture;

const barsOf = (candles: Fixture['cases'][number]['candles']) =>
  candles.map(([t, high, low, close, volume]) => ({ openTime: Date.parse(t), high, low, close, volume }));

describe('VWAP against hand-verified fixtures (criterion 3.2)', () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      const bars = barsOf(c.candles);
      // The double nearest each hand-derived value: Number() of a decimal string rounds correctly.
      const want = c.expected.map((e) => (e.vwap === null ? null : Number(e.vwap)));
      expect(vwap(bars)).toStrictEqual(want);
      const streaming = new Vwap();
      expect(bars.map((b) => streaming.next(b))).toStrictEqual(want);
      // The combined series reports the same values on intraday timeframes.
      expect(computeIndicators(bars, c.timeframe).map((v) => v.vwap)).toStrictEqual(want);
      const series = new IndicatorSeries(c.timeframe);
      expect(bars.map((b) => series.next(b).vwap)).toStrictEqual(want);
    });
  }

  it('needs exact decimal sums: the same formula in doubles misses 3', () => {
    const naive = (9 * 0.1 + 9 * 0.2) / (3 * (0.1 + 0.2));
    expect(naive).toBe(2.9999999999999996);
    expect(vwap(barsOf(fixture.cases[2]!.candles))).toStrictEqual([3, 3]);
  });

  it('is not reported on 1d candles, where a day-anchored VWAP is just the typical price', () => {
    const days = [
      { openTime: Date.parse('2026-11-09T00:00:00Z'), high: '110', low: '90', close: '100', volume: '5' },
      { openTime: Date.parse('2026-11-10T00:00:00Z'), high: '120', low: '100', close: '110', volume: '5' },
    ];
    expect(computeIndicators(days, '1d').map((v) => v.vwap)).toStrictEqual([null, null]);
    const series = new IndicatorSeries('1d');
    expect(days.map((d) => series.next(d).vwap)).toStrictEqual([null, null]);
    // The plain function has no timeframe: on its own it gives the typical price.
    expect(vwap(days)).toStrictEqual([100, 110]);
  });
});
