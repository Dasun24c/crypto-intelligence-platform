/** The six timeframes (requirements §1). 1m is the base; the others are aggregated from it, UTC-aligned. */
export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const MINUTE_MS = 60_000;

export const TF_MS: Readonly<Record<Timeframe, number>> = {
  '1m': MINUTE_MS,
  '5m': 5 * MINUTE_MS,
  '15m': 15 * MINUTE_MS,
  '1h': 60 * MINUTE_MS,
  '4h': 240 * MINUTE_MS,
  '1d': 1440 * MINUTE_MS,
};

export function isTimeframe(value: string): value is Timeframe {
  return (TIMEFRAMES as readonly string[]).includes(value);
}

/** Start of the `tf` period containing `ts` (epoch ms, UTC). 1d starts at 00:00 UTC, 4h at 00, 04, 08 ... UTC. */
export function floorTo(ts: number, tf: Timeframe): number {
  const size = TF_MS[tf];
  return Math.floor(ts / size) * size;
}

/** Number of 1m candles in one `tf` candle. */
export function minutesIn(tf: Timeframe): number {
  return TF_MS[tf] / MINUTE_MS;
}

/**
 * Timeframes whose candle closes at `boundary`: the end (exclusive) of a 1m candle, i.e. its open time
 * plus one minute. At 12:00 UTC the 1m, 5m, 15m, 1h and 4h candles close; at 00:00 UTC all six do.
 */
export function timeframesClosingAt(boundary: number): Timeframe[] {
  return TIMEFRAMES.filter((tf) => boundary % TF_MS[tf] === 0);
}

/**
 * Venues publish a minute's REST candle a little after the minute closes. A gap is fetched only
 * once its last minute has closed and this long has passed, or the repair would miss that minute.
 */
export const REST_SETTLE_MS = 30_000;

/** The instant a gap ending at `to` (exclusive) can be repaired from REST. */
export function restSettledAt(to: number): number {
  return Math.ceil(to / MINUTE_MS) * MINUTE_MS + REST_SETTLE_MS;
}

/**
 * Candles of history each timeframe needs before analysis starts (architecture §7, warm-up: at least
 * 500 of the highest timeframe). The analyzer warms each run up on this many candles per timeframe;
 * the ingestor and the backfill job keep at least this much history available.
 */
export const HISTORY_CANDLES = 1_000;
