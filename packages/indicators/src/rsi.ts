import { assertPeriod, emptySeries, type Series } from './bar.js';

/** RSI from the smoothed averages: 50 (neutral) when there was neither gain nor loss, as TA-Lib 0.8. */
function rsiOf(gain: number, loss: number): number {
  const total = gain + loss;
  return total > 0 ? 100 * (gain / total) : 50;
}

/**
 * Relative strength index with Wilder's smoothing, TA-Lib 0.8's convention.
 *
 * - **Changes**: each input against the one before. The gain is the change when positive, else 0;
 *   the loss is gain − change (the size of a fall, else 0).
 * - **Seed**: the gains and losses of the first n changes (inputs 1 to n), added left to right from
 *   0, then multiplied by 1/n. The first RSI is at index n.
 * - **After the seed**: average = (average × (n − 1) + today's gain or loss) × (1/n), done as three
 *   steps (multiply, add, multiply by the rounded reciprocal) like TA-Lib, so the rounding matches.
 * - **Value**: 100 × gain / (gain + loss), which equals 100 − 100 / (1 + RS). When gain + loss is
 *   exactly 0 (no movement at all) the RSI is the neutral 50.
 * - **Warm-up**: the first n inputs give no value.
 */
export function rsi(values: readonly number[], period: number): Series {
  assertPeriod('RSI period', period);
  const out = emptySeries(values.length);
  if (values.length <= period) return out;
  const inverse = 1 / period;
  let gain = 0;
  let loss = 0;
  let prevValue = values[0]!;
  for (let i = 1; i <= period; i++) {
    const change = values[i]! - prevValue;
    prevValue = values[i]!;
    const up = change > 0 ? change : 0;
    gain += up;
    loss += up - change;
  }
  loss *= inverse;
  gain *= inverse;
  out[period] = rsiOf(gain, loss);
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i]! - prevValue;
    prevValue = values[i]!;
    loss *= period - 1;
    gain *= period - 1;
    const up = change > 0 ? change : 0;
    gain += up;
    loss += up - change;
    loss *= inverse;
    gain *= inverse;
    out[i] = rsiOf(gain, loss);
  }
  return out;
}

/** The streaming form of {@link rsi}: the same arithmetic in the same order, one input at a time. */
/** An {@link Rsi}'s state, for checkpoints. */
export interface RsiState {
  seen: number;
  prevValue: number;
  gain: number;
  loss: number;
}

export class Rsi {
  private readonly inverse: number;
  private seen = 0;
  private prevValue = 0;
  private gain = 0;
  private loss = 0;

  constructor(readonly period: number) {
    assertPeriod('RSI period', period);
    this.inverse = 1 / period;
  }

  /** The RSI including `x`, or null during the warm-up. */
  next(x: number): number | null {
    const index = this.seen++;
    if (index === 0) {
      this.prevValue = x;
      return null;
    }
    const change = x - this.prevValue;
    this.prevValue = x;
    if (index > this.period) {
      this.loss *= this.period - 1;
      this.gain *= this.period - 1;
    }
    const up = change > 0 ? change : 0;
    this.gain += up;
    this.loss += up - change;
    if (index < this.period) return null;
    this.loss *= this.inverse;
    this.gain *= this.inverse;
    return rsiOf(this.gain, this.loss);
  }

  snapshot(): RsiState {
    return { seen: this.seen, prevValue: this.prevValue, gain: this.gain, loss: this.loss };
  }

  restore(state: RsiState): this {
    this.seen = state.seen;
    this.prevValue = state.prevValue;
    this.gain = state.gain;
    this.loss = state.loss;
    return this;
  }
}
