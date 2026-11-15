import { assertPeriod, emptySeries, type Series } from './bar.js';
import { fma } from './fma.js';

export interface EmaWeights {
  /** Weight of the previous EMA: (n − 1) / (n + 1). */
  beta: number;
  /** Weight of the new input, k = 1 − beta (= 2 / (n + 1)). */
  k: number;
}

/**
 * The EMA weights exactly as TA-Lib 0.8 derives them: beta = (n − 1) / (n + 1) first, then
 * k = 1 − beta, so that k + beta is exactly 1 and a flat input stays exactly flat. (For n = 2 the
 * subtraction is exact only the other way round, so beta is re-derived from k.)
 */
export function emaWeights(period: number): EmaWeights {
  let beta = (period - 1) / (period + 1);
  const k = 1 - beta;
  if (beta < 0.5) beta = 1 - k;
  return { beta, k };
}

/** One EMA step, TA-Lib's fma(beta, previous, k × x): one rounding for the multiply-add. */
export function emaStep(w: EmaWeights, previous: number, x: number): number {
  return fma(w.beta, previous, w.k * x);
}

function checkSeed(period: number, seedAt: number): void {
  assertPeriod('EMA period', period);
  if (!Number.isInteger(seedAt) || seedAt < period - 1)
    throw new RangeError(`the EMA seed needs ${period} inputs, so it cannot be at index ${seedAt}`);
}

/**
 * Exponential moving average, TA-Lib 0.8's convention (ADR 012).
 *
 * - **Seed**: the simple average of the first n inputs (added left to right from 0, then divided
 *   by n), placed at index n − 1.
 * - **After the seed**: EMA_i = beta × EMA_{i−1} + k × x_i, with beta = (n − 1) / (n + 1) and
 *   k = 1 − beta, computed as fma(beta, EMA_{i−1}, k × x_i): the product k × x_i is rounded, the
 *   multiply-add is not (see {@link emaWeights} and fma.ts).
 * - **Warm-up**: the first n − 1 inputs give no value.
 *
 * `seedAt` moves the seed later, to the average of the n inputs ending at `seedAt`. Only TA-Lib's
 * MACD uses it, for its fast EMA.
 */
export function ema(values: readonly number[], period: number, seedAt = period - 1): Series {
  checkSeed(period, seedAt);
  const out = emptySeries(values.length);
  if (values.length <= seedAt) return out;
  const w = emaWeights(period);
  let sum = 0;
  for (let i = seedAt - period + 1; i <= seedAt; i++) sum += values[i]!;
  let prev = sum / period;
  out[seedAt] = prev;
  for (let i = seedAt + 1; i < values.length; i++) {
    prev = emaStep(w, prev, values[i]!);
    out[i] = prev;
  }
  return out;
}

/** The streaming form of {@link ema}: the same arithmetic in the same order, one input at a time. */
/** An {@link Ema}'s state, for checkpoints: plain JSON. */
export interface EmaState {
  seen: number;
  value: number | null;
  window: number[];
}

export class Ema {
  private readonly weights: EmaWeights;
  /** The latest n inputs, kept only until the seed. */
  private readonly window: number[] = [];
  private seen = 0;
  private value: number | null = null;

  constructor(
    readonly period: number,
    private readonly seedAt = period - 1,
  ) {
    checkSeed(period, seedAt);
    this.weights = emaWeights(period);
  }

  /** The EMA including `x`, or null during the warm-up. */
  next(x: number): number | null {
    const index = this.seen++;
    if (this.value !== null) {
      this.value = emaStep(this.weights, this.value, x);
      return this.value;
    }
    this.window.push(x);
    if (this.window.length > this.period) this.window.shift();
    if (index < this.seedAt) return null;
    let sum = 0;
    for (const v of this.window) sum += v;
    this.value = sum / this.period;
    this.window.length = 0;
    return this.value;
  }

  snapshot(): EmaState {
    return { seen: this.seen, value: this.value, window: [...this.window] };
  }

  /** Continues from a {@link snapshot} taken with the same period and seed. */
  restore(state: EmaState): this {
    this.seen = state.seen;
    this.value = state.value;
    this.window.length = 0;
    this.window.push(...state.window);
    return this;
  }
}
