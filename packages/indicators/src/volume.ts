import { assertPeriod, emptySeries, type Series } from './bar.js';

/** MAD × 1.4826 estimates the standard deviation of normally distributed data. */
export const MAD_SCALE = 1.4826;
/** Mean absolute deviation × 1.253314 (√(π/2)) does the same, for windows whose MAD is 0. */
export const MEAN_AD_SCALE = 1.253314;

const ascending = (a: number, b: number) => a - b;

function medianOfSorted(sorted: readonly number[]): number {
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Robust z-score of `x` against `window` (the modified z-score of Iglewicz and Hoaglin):
 * (x − median) / (1.4826 × MAD), where MAD is the median absolute deviation from the median.
 *
 * Volume is often 0 or the same for many candles, which makes the MAD 0. The mean absolute
 * deviation then stands in: (x − median) / (1.253314 × mean absolute deviation). When every value
 * in the window is the same, there is nothing to compare with and the result is null.
 * The result depends only on the values in the window, not on their order.
 */
export function robustZ(x: number, window: readonly number[]): number | null {
  if (window.length === 0) return null;
  const sorted = [...window].sort(ascending);
  const median = medianOfSorted(sorted);
  const deviations = sorted.map((v) => Math.abs(v - median)).sort(ascending);
  const mad = medianOfSorted(deviations);
  if (mad > 0) return (x - median) / (MAD_SCALE * mad);
  let total = 0;
  for (const d of deviations) total += d;
  const meanDeviation = total / deviations.length;
  return meanDeviation > 0 ? (x - median) / (MEAN_AD_SCALE * meanDeviation) : null;
}

/**
 * Volume z-score of each candle against the `lookback` candles before it (not including itself).
 * **Warm-up**: the first `lookback` candles give no value.
 */
export function volumeZ(volumes: readonly number[], lookback: number): Series {
  assertPeriod('volume lookback', lookback);
  const out = emptySeries(volumes.length);
  for (let i = lookback; i < volumes.length; i++)
    out[i] = robustZ(volumes[i]!, volumes.slice(i - lookback, i));
  return out;
}

/**
 * A volume anomaly (TA-02) is a spike: z at or above the threshold (3.5 by default, Iglewicz and
 * Hoaglin's cut-off). Unusually low volume is visible in the z-score itself but is not flagged.
 * Null when there is no z-score.
 */
export function isVolumeAnomaly(z: number | null, threshold: number): boolean | null {
  return z === null ? null : z >= threshold;
}

/** A {@link VolumeZ}'s state, for checkpoints. */
export interface VolumeZState {
  history: number[];
}

/** The streaming form of {@link volumeZ}. */
export class VolumeZ {
  private readonly history: number[] = [];

  constructor(readonly lookback: number) {
    assertPeriod('volume lookback', lookback);
  }

  /** The z-score of `volume` against the previous `lookback` volumes, or null during the warm-up. */
  next(volume: number): number | null {
    const z = this.history.length === this.lookback ? robustZ(volume, this.history) : null;
    this.history.push(volume);
    if (this.history.length > this.lookback) this.history.shift();
    return z;
  }

  snapshot(): VolumeZState {
    return { history: [...this.history] };
  }

  restore(state: VolumeZState): this {
    this.history.length = 0;
    this.history.push(...state.history);
    return this;
  }
}
