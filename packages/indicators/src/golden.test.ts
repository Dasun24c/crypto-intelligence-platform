import { readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { Timeframe } from '@cip/domain';
import { atr } from './atr.js';
import { ema } from './ema.js';
import { macd } from './macd.js';
import { rsi } from './rsi.js';
import {
  computeIndicators,
  DEFAULT_INDICATOR_PARAMS,
  IndicatorSeries,
  indicatorLookbacks,
} from './series.js';

/**
 * Criterion 3.1 (ADR 012): RSI, MACD, EMA and ATR match TA-Lib within 1e-9 relative error after the
 * documented warm-up, on 3 instruments × 3 timeframes × 10,000 candles. The datasets come from
 * tools/reference-data/generate.py; each records the TA-Lib version that produced it.
 */
const DIR = new URL('../fixtures/talib/', import.meta.url);
const TOLERANCE = 1e-9;

type Reference = (number | null)[];
interface Dataset {
  meta: {
    symbol: string;
    interval: Timeframe;
    count: number;
    gaps: unknown[];
    params: { rsi: number; macd: [number, number, number]; ema: [number, number, number]; atr: number };
    talib: { python: string; c: string };
  };
  candles: [number, string, string, string, string, string][];
  talib: Record<
    'rsi' | 'macd' | 'macdSignal' | 'macdHist' | 'emaFast' | 'emaMid' | 'emaSlow' | 'atr',
    Reference
  >;
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.json.gz'));
const load = (file: string) =>
  JSON.parse(gunzipSync(readFileSync(new URL(file, DIR))).toString('utf8')) as Dataset;

/** Largest relative error after the warm-up; the warm-up itself must be null in both. */
function compare(ours: readonly (number | null)[], reference: Reference, lookback: number): number {
  expect(ours).toHaveLength(reference.length);
  let worst = 0;
  for (let i = 0; i < reference.length; i++) {
    const want = reference[i]!;
    const got = ours[i]!;
    // Plain checks in the loop (an expect per value would dominate the run time); expect on failure.
    const inWarmUp = i < lookback;
    if (inWarmUp !== (want === null) || inWarmUp !== (got === null))
      expect({ index: i, ours: got, talib: want }).toEqual({
        index: i,
        ours: inWarmUp ? null : 'a value',
        talib: inWarmUp ? null : 'a value',
      });
    if (inWarmUp) continue;
    const error = want === 0 ? Math.abs(got) : Math.abs(got - want) / Math.abs(want);
    if (error > worst) worst = error;
  }
  return worst;
}

describe('TA-Lib reference datasets (criterion 3.1)', () => {
  it('covers 3 instruments × 3 timeframes × 10,000 contiguous candles from one pinned TA-Lib version', () => {
    expect(files).toHaveLength(9);
    const sets = files.map(load);
    expect(new Set(sets.map((d) => d.meta.symbol)).size).toBe(3);
    expect(new Set(sets.map((d) => d.meta.interval)).size).toBe(3);
    for (const d of sets) {
      expect(d.meta.count).toBe(10_000);
      expect(d.candles).toHaveLength(10_000);
      expect(d.meta.gaps).toEqual([]);
      expect(d.meta.talib.python).toBe('0.8.3');
      expect(d.meta.talib.c).toMatch(/^0\.8\.3 /);
      // The datasets were made with the platform's default parameters.
      const p = DEFAULT_INDICATOR_PARAMS;
      expect(d.meta.params).toEqual({
        rsi: p.rsi.period,
        macd: [p.macd.fast, p.macd.slow, p.macd.signal],
        ema: [p.ema.fast, p.ema.mid, p.ema.slow],
        atr: p.atr.period,
      });
    }
  });

  const lookbacks = indicatorLookbacks();
  const p = DEFAULT_INDICATOR_PARAMS;

  for (const file of files) {
    it(`${file}: batch, streaming and the combined series match TA-Lib`, () => {
      const d = load(file);
      const high = d.candles.map((c) => Number(c[2]));
      const low = d.candles.map((c) => Number(c[3]));
      const close = d.candles.map((c) => Number(c[4]));
      const m = macd(close, p.macd.fast, p.macd.slow, p.macd.signal);
      const batch = {
        rsi: rsi(close, p.rsi.period),
        macd: m.macd,
        macdSignal: m.signal,
        macdHist: m.hist,
        emaFast: ema(close, p.ema.fast),
        emaMid: ema(close, p.ema.mid),
        emaSlow: ema(close, p.ema.slow),
        atr: atr(high, low, close, p.atr.period),
      };
      const bars = d.candles.map(([openTime, , h, l, c, v]) => ({
        openTime,
        high: h,
        low: l,
        close: c,
        volume: v,
      }));
      const series = new IndicatorSeries(d.meta.interval);
      const streamed = bars.map((b) => series.next(b));
      const combined = computeIndicators(bars, d.meta.interval);
      const warmUp = {
        rsi: lookbacks.rsi,
        macd: lookbacks.macd,
        macdSignal: lookbacks.macd,
        macdHist: lookbacks.macd,
        emaFast: lookbacks.emaFast,
        emaMid: lookbacks.emaMid,
        emaSlow: lookbacks.emaSlow,
        atr: lookbacks.atr,
      };
      const report: Record<string, number> = {};
      for (const key of Object.keys(warmUp) as (keyof typeof warmUp)[]) {
        const worst = Math.max(
          compare(batch[key], d.talib[key], warmUp[key]),
          compare(
            streamed.map((v) => v[key]),
            d.talib[key],
            warmUp[key],
          ),
          compare(
            combined.map((v) => v[key]),
            d.talib[key],
            warmUp[key],
          ),
        );
        // The criterion allows 1e-9; matching TA-Lib 0.8's fma() arithmetic gives the same bits.
        expect(worst, `${key}: worst relative error`).toBeLessThanOrEqual(TOLERANCE);
        expect(worst, `${key}: not bit-identical to TA-Lib`).toBe(0);
        report[key] = worst;
      }
      if (process.env.GOLDEN_REPORT) console.info(file, JSON.stringify(report));
    });
  }
});
