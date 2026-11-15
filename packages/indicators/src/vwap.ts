import { type Decimal, dec } from '@cip/domain';
import type { Bar, Series } from './bar.js';

/** VWAP's anchor: it resets at 00:00 UTC every day. */
export const DAY_MS = 86_400_000;

function vwapOf(priceVolume: Decimal, volume: Decimal): number {
  // Σ((H + L + C) × V) / (3 × ΣV): the only rounding is this division (30 decimal places), then the double.
  return Number(priceVolume.div(volume.times(3)).toString());
}

/** One UTC day's running sums. `anchored` is false when the series began after 00:00 that day. */
interface Day {
  index: number;
  anchored: boolean;
  priceVolume: Decimal;
  volume: Decimal;
}

function step(day: Day | null, bar: Bar): { day: Day; value: number | null } {
  const index = Math.floor(bar.openTime / DAY_MS);
  const current =
    day && day.index === index
      ? day
      : { index, anchored: bar.openTime === index * DAY_MS, priceVolume: dec(0), volume: dec(0) };
  const v = dec(bar.volume);
  current.priceVolume = current.priceVolume.plus(dec(bar.high).plus(bar.low).plus(bar.close).times(v));
  current.volume = current.volume.plus(v);
  const value = current.anchored && current.volume.gt(0) ? vwapOf(current.priceVolume, current.volume) : null;
  return { day: current, value };
}

/**
 * Volume-weighted average price anchored at 00:00 UTC (data model: "anchored daily (UTC)").
 *
 * - **Value**: Σ(TP × V) / ΣV over the candles of the current UTC day up to and including this one,
 *   with the typical price TP = (H + L + C) / 3.
 * - **Exact**: prices and volumes are decimal strings and the sums are kept as exact decimals. The
 *   one division is rounded to 30 decimal places, then converted to a double, so the result is the
 *   double nearest the true VWAP.
 * - **Reset**: the first candle opening at or after 00:00 UTC starts a new day.
 * - **Warm-up**: none, but the value is null until the day has traded some volume, and for the
 *   whole of a day whose 00:00 candle is not in the series (it started mid-day), because that
 *   day's VWAP cannot be known.
 */
export function vwap(bars: readonly Bar[]): Series {
  const out: Series = [];
  let day: Day | null = null;
  for (const bar of bars) {
    const r = step(day, bar);
    day = r.day;
    out.push(r.value);
  }
  return out;
}

/** A {@link Vwap}'s state, for checkpoints: the day's exact sums as decimal strings. */
export interface VwapState {
  day: { index: number; anchored: boolean; priceVolume: string; volume: string } | null;
}

/** The streaming form of {@link vwap}. */
export class Vwap {
  private day: Day | null = null;

  /** The day's VWAP including this candle, or null (see {@link vwap}). */
  next(bar: Bar): number | null {
    const r = step(this.day, bar);
    this.day = r.day;
    return r.value;
  }

  snapshot(): VwapState {
    const d = this.day;
    return {
      day: d
        ? {
            index: d.index,
            anchored: d.anchored,
            priceVolume: d.priceVolume.toString(),
            volume: d.volume.toString(),
          }
        : null,
    };
  }

  restore(state: VwapState): this {
    const d = state.day;
    this.day = d
      ? { index: d.index, anchored: d.anchored, priceVolume: dec(d.priceVolume), volume: dec(d.volume) }
      : null;
    return this;
  }
}
