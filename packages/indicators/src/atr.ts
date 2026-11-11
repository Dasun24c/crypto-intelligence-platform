import { assertPeriod, emptySeries, type Series } from './bar.js';
import { fma } from './fma.js';

/**
 * True range of a candle against the previous close, as TA-Lib's TRANGE: start from H − L, then
 * take |previous C − H| and |previous C − L| if larger, in that order. The first candle of a
 * series has none.
 */
export function trueRange(high: number, low: number, prevClose: number): number {
  let greatest = high - low;
  const toHigh = Math.abs(prevClose - high);
  if (toHigh > greatest) greatest = toHigh;
  const toLow = Math.abs(prevClose - low);
  if (toLow > greatest) greatest = toLow;
  return greatest;
}

/** Wilder's weights as TA-Lib 0.8 derives them: beta = (n − 1) / n first, then alpha = 1 − beta. */
export function wilderWeights(period: number): { alpha: number; beta: number } {
  const beta = (period - 1) / period;
  return { alpha: 1 - beta, beta };
}

/**
 * Average true range with Wilder's smoothing (rulebook: ATR(14), Wilder), TA-Lib 0.8's convention.
 *
 * - **Seed**: TA-Lib skips the first candle, which has no previous close. The first ATR, at index n,
 *   is the simple average of TR_1 to TR_n (added left to right from 0, then divided by n).
 * - **After the seed**: ATR_i = beta × ATR_{i−1} + alpha × TR_i, with beta = (n − 1) / n and
 *   alpha = 1 − beta, computed as fma(beta, ATR_{i−1}, alpha × TR_i) like TA-Lib.
 * - **Warm-up**: the first n candles give no value.
 */
export function atr(
  high: readonly number[],
  low: readonly number[],
  close: readonly number[],
  period: number,
): Series {
  assertPeriod('ATR period', period);
  const n = close.length;
  if (high.length !== n || low.length !== n) throw new RangeError('high, low and close differ in length');
  const out = emptySeries(n);
  if (n <= period) return out;
  const { alpha, beta } = wilderWeights(period);
  const tr = (i: number) => trueRange(high[i]!, low[i]!, close[i - 1]!);
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr(i);
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < n; i++) {
    prev = fma(beta, prev, alpha * tr(i));
    out[i] = prev;
  }
  return out;
}

/** The streaming form of {@link atr}: the same arithmetic in the same order, one candle at a time. */
export class Atr {
  private readonly alpha: number;
  private readonly beta: number;
  private seen = 0;
  private prevClose = 0;
  private sum = 0;
  private value: number | null = null;

  constructor(readonly period: number) {
    assertPeriod('ATR period', period);
    const w = wilderWeights(period);
    this.alpha = w.alpha;
    this.beta = w.beta;
  }

  /** The ATR including this candle, or null during the warm-up. */
  next(high: number, low: number, close: number): number | null {
    const index = this.seen++;
    const prevClose = this.prevClose;
    this.prevClose = close;
    if (index === 0) return null;
    const tr = trueRange(high, low, prevClose);
    if (this.value !== null) {
      this.value = fma(this.beta, this.value, this.alpha * tr);
      return this.value;
    }
    this.sum += tr;
    if (index < this.period) return null;
    this.value = this.sum / this.period;
    return this.value;
  }
}
