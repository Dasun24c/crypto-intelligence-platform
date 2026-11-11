import { assertPeriod, emptySeries, type Series } from './bar.js';
import { Ema, ema } from './ema.js';

export interface MacdPoint {
  macd: number;
  signal: number;
  hist: number;
}

function checkPeriods(fast: number, slow: number, signal: number): void {
  assertPeriod('MACD fast period', fast);
  assertPeriod('MACD slow period', slow);
  assertPeriod('MACD signal period', signal);
  if (slow <= fast)
    throw new RangeError(`the MACD slow period (${slow}) must be longer than the fast (${fast})`);
}

/** Index of the first MACD value: slow + signal − 2 (33 for 12/26/9), as TA-Lib reports it. */
export function macdLookback(fast: number, slow: number, signal: number): number {
  checkPeriods(fast, slow, signal);
  return slow + signal - 2;
}

/**
 * MACD(fast, slow, signal), TA-Lib's convention. TA-Lib seeds both EMAs at the same input:
 *
 * - **Slow EMA**: seeded with the average of inputs 0 to slow − 1, at index slow − 1.
 * - **Fast EMA**: seeded at the same index, with the average of the `fast` inputs that end there
 *   (inputs 14 to 25 for 12/26), not of inputs 0 to fast − 1.
 * - **MACD line**: fast EMA − slow EMA, from index slow − 1.
 * - **Signal**: the EMA(signal) of the MACD line, seeded with the average of its first `signal` values.
 * - **Histogram**: MACD − signal.
 * - **Warm-up**: TA-Lib reports all three from index slow + signal − 2 (33 for 12/26/9), so the
 *   MACD line is held back until the signal exists.
 */
export function macd(
  values: readonly number[],
  fast: number,
  slow: number,
  signal: number,
): { macd: Series; signal: Series; hist: Series } {
  const first = macdLookback(fast, slow, signal);
  const out = {
    macd: emptySeries(values.length),
    signal: emptySeries(values.length),
    hist: emptySeries(values.length),
  };
  if (values.length <= first) return out;
  const start = slow - 1;
  const slowEma = ema(values, slow);
  const fastEma = ema(values, fast, start);
  const line: number[] = [];
  for (let i = start; i < values.length; i++) line.push(fastEma[i]! - slowEma[i]!);
  const signalEma = ema(line, signal);
  for (let i = first; i < values.length; i++) {
    const m = line[i - start]!;
    const s = signalEma[i - start]!;
    out.macd[i] = m;
    out.signal[i] = s;
    out.hist[i] = m - s;
  }
  return out;
}

/** The streaming form of {@link macd}: the same arithmetic in the same order, one input at a time. */
export class Macd {
  private readonly fastEma: Ema;
  private readonly slowEma: Ema;
  private readonly signalEma: Ema;

  constructor(
    readonly fast: number,
    readonly slow: number,
    readonly signal: number,
  ) {
    checkPeriods(fast, slow, signal);
    this.fastEma = new Ema(fast, slow - 1);
    this.slowEma = new Ema(slow);
    this.signalEma = new Ema(signal);
  }

  /** MACD, signal and histogram including `x`, or null during the warm-up. */
  next(x: number): MacdPoint | null {
    const f = this.fastEma.next(x);
    const s = this.slowEma.next(x);
    if (f === null || s === null) return null;
    const line = f - s;
    const sig = this.signalEma.next(line);
    if (sig === null) return null;
    return { macd: line, signal: sig, hist: line - sig };
  }
}
