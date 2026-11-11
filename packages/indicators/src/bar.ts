import type { DecimalString } from '@cip/domain';

/** The candle fields the indicators read. `Candle` from `@cip/domain` has all of them. */
export interface Bar {
  /** Open time, epoch ms (UTC). */
  openTime: number;
  high: DecimalString;
  low: DecimalString;
  close: DecimalString;
  volume: DecimalString;
}

/** One output value per input: null while the indicator has no value yet (its warm-up). */
export type Series = (number | null)[];

/** Periods are whole numbers of candles, from `min` to 100,000 (TA-Lib's range). */
export function assertPeriod(name: string, period: number, min = 2): void {
  if (!Number.isInteger(period) || period < min || period > 100_000)
    throw new RangeError(`${name} must be a whole number from ${min} to 100000, got ${period}`);
}

export function emptySeries(length: number): Series {
  return new Array<number | null>(length).fill(null);
}
