import { addDecimals, type DecimalString, maxDecimal, minDecimal } from './decimal.js';
import { MINUTE_MS, TF_MS, type Timeframe } from './timeframe.js';

export type CandleSource = 'exchange_kline' | 'trades' | 'rest' | 'aggregated' | 'replay';
export type CandleQuality = 'complete' | 'repaired' | 'partial';

/** One OHLCV candle (data model §4.1). Prices and volumes are exact decimal strings. */
export interface Candle {
  timeframe: Timeframe;
  /** Epoch ms, UTC; candles are keyed by their open time. */
  openTime: number;
  open: DecimalString;
  high: DecimalString;
  low: DecimalString;
  close: DecimalString;
  /** Base-asset volume. */
  volume: DecimalString;
  quoteVolume: DecimalString;
  tradeCount: number | null;
  takerBuyVolume: DecimalString | null;
  /** 1m only: base volume per bucket between low and high (rulebook §3.5); null when unknown. */
  microProfile: number[] | null;
  source: CandleSource;
  quality: CandleQuality;
  underlyingClosed: boolean;
}

const QUALITY_RANK: Record<CandleQuality, number> = { complete: 0, repaired: 1, partial: 2 };

export function worstQuality(qualities: readonly CandleQuality[]): CandleQuality {
  return qualities.reduce<CandleQuality>(
    (worst, q) => (QUALITY_RANK[q] > QUALITY_RANK[worst] ? q : worst),
    'complete',
  );
}

/**
 * A period without trades (architecture §5.2): O = H = L = C = the previous close, volume 0. A 1m
 * candle (the default) also gets an all-zero profile, because "no trades" is known, not missing;
 * other timeframes have no profile.
 */
export function flatCandle(
  openTime: number,
  previousClose: DecimalString,
  opts: {
    source: CandleSource;
    quality?: CandleQuality;
    underlyingClosed: boolean;
    /** Buckets of the 1m profile; unused for other timeframes. */
    profileBuckets: number;
    timeframe?: Timeframe;
  },
): Candle {
  const timeframe = opts.timeframe ?? '1m';
  return {
    timeframe,
    openTime,
    open: previousClose,
    high: previousClose,
    low: previousClose,
    close: previousClose,
    volume: '0',
    quoteVolume: '0',
    tradeCount: 0,
    takerBuyVolume: '0',
    microProfile: timeframe === '1m' ? new Array<number>(opts.profileBuckets).fill(0) : null,
    source: opts.source,
    quality: opts.quality ?? 'complete',
    underlyingClosed: opts.underlyingClosed,
  };
}

/**
 * Aggregates consecutive `childTf` candles (1m unless given) into one `tf` candle opening at
 * `openTime`. Missing children make the result `partial`; any child inside a gold-market closure flags
 * the result, because the rulebook (§3.6) flags every candle whose interval overlaps a closure.
 * Coinbase's 4h candles are built from its 1h candles this way, since its REST API has no 4h.
 */
export function aggregateCandles(
  tf: Timeframe,
  openTime: number,
  candles: readonly Candle[],
  childTf: Timeframe = '1m',
): Candle {
  // Every timeframe is a whole multiple of each shorter one, so only the order needs checking.
  if (TF_MS[tf] <= TF_MS[childTf]) throw new Error(`aggregateCandles builds timeframes above ${childTf}`);
  if (openTime % TF_MS[tf] !== 0) throw new Error(`open time ${openTime} is not aligned to ${tf}`);
  const end = openTime + TF_MS[tf];
  const children = candles
    .filter((c) => c.timeframe === childTf && c.openTime >= openTime && c.openTime < end)
    .sort((a, b) => a.openTime - b.openTime);
  const first = children[0];
  const last = children.at(-1);
  if (!first || !last) throw new Error(`no ${childTf} candles for ${tf} at ${openTime}`);
  for (let i = 1; i < children.length; i++) {
    if (children[i]!.openTime === children[i - 1]!.openTime) throw new Error(`duplicate ${childTf} candle`);
  }

  let high = first.high;
  let low = first.low;
  for (const c of children) {
    high = maxDecimal(high, c.high);
    low = minDecimal(low, c.low);
  }
  const counts = children.map((c) => c.tradeCount);
  const takerBuys = children.map((c) => c.takerBuyVolume);
  const complete = children.length === TF_MS[tf] / TF_MS[childTf];
  return {
    timeframe: tf,
    openTime,
    open: first.open,
    high,
    low,
    close: last.close,
    volume: addDecimals(children.map((c) => c.volume)),
    quoteVolume: addDecimals(children.map((c) => c.quoteVolume)),
    tradeCount: counts.every((n) => n !== null) ? counts.reduce<number>((a, n) => a + (n ?? 0), 0) : null,
    takerBuyVolume: takerBuys.every((v) => v !== null) ? addDecimals(takerBuys) : null,
    microProfile: null,
    source: 'aggregated',
    quality: complete ? worstQuality(children.map((c) => c.quality)) : 'partial',
    underlyingClosed: children.some((c) => c.underlyingClosed),
  };
}

/** Open times of every 1m candle in [from, to): used to find missing minutes. */
export function minuteOpenTimes(from: number, to: number): number[] {
  const out: number[] = [];
  for (let t = from; t < to; t += MINUTE_MS) out.push(t);
  return out;
}
