import {
  addDecimals,
  type Candle,
  floorTo,
  maxDecimal,
  minDecimal,
  MINUTE_MS,
  TIMEFRAMES,
  type Timeframe,
  worstQuality,
} from '@cip/domain';

type HigherTf = Exclude<Timeframe, '1m'>;
const HIGHER = TIMEFRAMES.filter((tf): tf is HigherTf => tf !== '1m');

/**
 * Candles in progress for live charts (`candle.update`, architecture §10): per timeframe, the closed
 * 1m candles of the current period folded together, plus the minute in progress. O(1) per update.
 * Display only: final candles always come from the database. A period with fewer folded minutes
 * than have passed (a gap, or a start mid-period without history) shows as `partial`.
 */
export class RunningCandles {
  private readonly acc = new Map<HigherTf, { candle: Candle; minutes: number }>();
  private lastMinute = -Infinity;

  /** Folds a closed minute into each timeframe's current period. Minutes arrive in order; an older one is ignored. */
  onMinuteClosed(minute: Candle): void {
    if (minute.openTime <= this.lastMinute) return;
    this.lastMinute = minute.openTime;
    for (const tf of HIGHER) {
      const open = floorTo(minute.openTime, tf);
      const current = this.acc.get(tf);
      if (current && current.candle.openTime === open)
        this.acc.set(tf, { candle: fold(current.candle, minute), minutes: current.minutes + 1 });
      else if (!current || open > current.candle.openTime)
        this.acc.set(tf, { candle: asTimeframe(minute, tf, open), minutes: 1 });
    }
  }

  /** Each timeframe's candle in progress at `now`; 1m is the minute in progress itself. */
  current(inProgress: Candle | null, now: number): Partial<Record<Timeframe, Candle>> {
    const minuteOpen = floorTo(now, '1m');
    const live = inProgress && inProgress.openTime === minuteOpen ? inProgress : null;
    const out: Partial<Record<Timeframe, Candle>> = {};
    if (live) out['1m'] = live;
    for (const tf of HIGHER) {
      const open = floorTo(now, tf);
      const acc = this.acc.get(tf);
      const closed = acc && acc.candle.openTime === open ? acc : null;
      let candle = closed?.candle ?? null;
      if (live) candle = candle ? fold(candle, live) : asTimeframe(live, tf, open);
      if (!candle) continue;
      const expected = (minuteOpen - open) / MINUTE_MS;
      out[tf] = (closed?.minutes ?? 0) < expected ? { ...candle, quality: 'partial' } : candle;
    }
    return out;
  }
}

function asTimeframe(minute: Candle, tf: HigherTf, openTime: number): Candle {
  return { ...minute, timeframe: tf, openTime, source: 'aggregated', microProfile: null };
}

function fold(a: Candle, b: Candle): Candle {
  return {
    ...a,
    high: maxDecimal(a.high, b.high),
    low: minDecimal(a.low, b.low),
    close: b.close,
    volume: addDecimals([a.volume, b.volume]),
    quoteVolume: addDecimals([a.quoteVolume, b.quoteVolume]),
    tradeCount: a.tradeCount !== null && b.tradeCount !== null ? a.tradeCount + b.tradeCount : null,
    takerBuyVolume:
      a.takerBuyVolume !== null && b.takerBuyVolume !== null
        ? addDecimals([a.takerBuyVolume, b.takerBuyVolume])
        : null,
    quality: worstQuality([a.quality, b.quality]),
    underlyingClosed: a.underlyingClosed || b.underlyingClosed,
  };
}
