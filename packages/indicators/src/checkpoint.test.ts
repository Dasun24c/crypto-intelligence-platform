import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { TF_MS, type Timeframe } from '@cip/domain';
import type { Bar } from './bar.js';
import { DEFAULT_INDICATOR_PARAMS, IndicatorSeries, type IndicatorValues } from './series.js';

/**
 * Checkpoints (architecture §7): a series restored from a snapshot that went through JSON, as the
 * analyzer stores it, continues with exactly the values an uninterrupted series gives.
 */
const DIR = new URL('../fixtures/talib/', import.meta.url);

function bars(file: string): { tf: Timeframe; bars: Bar[] } {
  const data = JSON.parse(gunzipSync(readFileSync(new URL(file, DIR))).toString('utf8')) as {
    meta: { interval: Timeframe };
    candles: [number, string, string, string, string, string][];
  };
  return {
    tf: data.meta.interval,
    bars: data.candles.slice(0, 1500).map(([openTime, , high, low, close, volume]) => ({
      openTime,
      high,
      low,
      close,
      volume,
    })),
  };
}

const run = (series: IndicatorSeries, input: readonly Bar[]): IndicatorValues[] =>
  input.map((b) => series.next(b));

describe('IndicatorSeries checkpoints', () => {
  for (const file of ['BTCUSDT-5m.json.gz', 'PAXGUSDT-1h.json.gz']) {
    it(`restores mid-series bit for bit (${file})`, () => {
      const { tf, bars: input } = bars(file);
      const whole = run(new IndicatorSeries(tf), input);
      for (const cut of [1, 13, 14, 15, 34, 200, 201, 777, input.length - 1]) {
        const first = new IndicatorSeries(tf);
        run(first, input.slice(0, cut));
        const state = JSON.parse(JSON.stringify(first.snapshot())) as ReturnType<IndicatorSeries['snapshot']>;
        const restored = IndicatorSeries.restore(state, DEFAULT_INDICATOR_PARAMS);
        expect(restored.lastOpenTime).toBe(input[cut - 1]!.openTime);
        const rest = run(restored, input.slice(cut));
        // toEqual treats every double exactly, so this is bit-for-bit (no -0 occurs in these series).
        expect(rest).toEqual(whole.slice(cut));
      }
    });
  }

  it('refuses a state whose VWAP does not match the timeframe', () => {
    const state = new IndicatorSeries('1h').snapshot();
    expect(() => IndicatorSeries.restore({ ...state, timeframe: '1d' })).toThrow(/VWAP/);
  });

  it('resumes after an unrepairable gap as if the candles were consecutive', () => {
    const { tf, bars: input } = bars('BTCUSDT-5m.json.gz');
    const size = TF_MS[tf];
    const withGap = new IndicatorSeries(tf);
    run(withGap, input.slice(0, 100));
    // Candles 100–109 are missing for good: the series steps over them.
    withGap.resumeAfterGap(input[110]!.openTime);
    const after = run(withGap, input.slice(110, 300));
    // The same values as a series that never saw those candles at all, with times shifted to match.
    const shifted = [...input.slice(0, 100), ...input.slice(110, 300)].map((b, i) => ({
      ...b,
      openTime: input[0]!.openTime + i * size,
    }));
    const reference = run(new IndicatorSeries(tf), shifted).slice(100);
    // VWAP is anchored to the UTC day, so the shift changes it; every other value is the same.
    const strip = (v: IndicatorValues) => ({ ...v, openTime: 0, vwap: null });
    expect(after.map(strip)).toEqual(reference.map(strip));
    expect(() => withGap.resumeAfterGap(input[200]!.openTime)).toThrow(/already taken/);
    expect(() => withGap.resumeAfterGap(input[400]!.openTime + 1)).toThrow(/not aligned/);
  });

  it('resuming before the first candle changes nothing', () => {
    const { tf, bars: input } = bars('BTCUSDT-5m.json.gz');
    const s = new IndicatorSeries(tf);
    s.resumeAfterGap(input[5]!.openTime);
    expect(s.lastOpenTime).toBeNull();
    expect(run(s, input.slice(5, 50))).toEqual(run(new IndicatorSeries(tf), input.slice(5, 50)));
  });
});
