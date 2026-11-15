import {
  aggregateCandles,
  type Candle,
  type CandleQuality,
  type DecimalString,
  flatCandle,
  floorTo,
  mulDecimal,
  TF_MS,
  type Timeframe,
} from '@cip/domain';
import type { RestCandle } from '@cip/exchange-adapters';

/** Whether [start, end) overlaps a closure of the instrument's underlying market (rulebook §3.6). */
export type ClosureCheck = (start: number, end: number) => boolean;

export interface FromRestOptions {
  timeframe: Timeframe;
  /** The periods to build: [from, to), aligned to the timeframe. */
  from: number;
  to: number;
  /** Coinbase omits periods without trades: they become flat candles at the previous close. */
  fillEmpty: boolean;
  /** The close before `from`. Without one, nothing is filled before the first REST candle. */
  previousClose: DecimalString | null;
  quality: CandleQuality;
  closed: ClosureCheck;
  /** Buckets of a flat 1m candle's all-zero profile. */
  profileBuckets: number;
}

/**
 * The venue's REST candles as stored candles of one timeframe, over [from, to). REST candles have no
 * micro profile, so the thin-book rule treats them as unverified (rulebook §3.5). Coinbase omits
 * exactly the periods without trades, so "no volume" is known there: they become flat candles.
 */
export function fromRest(rows: readonly RestCandle[], o: FromRestOptions): Candle[] {
  const step = TF_MS[o.timeframe];
  const byTime = new Map(rows.map((r) => [r.openTime, r]));
  let previousClose = o.previousClose;
  const out: Candle[] = [];
  for (let t = o.from; t < o.to; t += step) {
    const r = byTime.get(t);
    if (r) {
      out.push({
        timeframe: o.timeframe,
        openTime: t,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
        // Coinbase REST candles carry no quote volume: volume × close stands in, on REST candles only.
        quoteVolume: r.quoteVolume ?? mulDecimal(r.volume, r.close),
        tradeCount: r.tradeCount ?? null,
        takerBuyVolume: r.takerBuyVolume ?? null,
        microProfile: null,
        source: 'rest',
        quality: o.quality,
        underlyingClosed: o.closed(t, t + step),
      });
      previousClose = r.close;
    } else if (o.fillEmpty && previousClose !== null) {
      out.push(
        flatCandle(t, previousClose, {
          source: 'rest',
          quality: o.quality,
          underlyingClosed: o.closed(t, t + step),
          profileBuckets: o.profileBuckets,
          timeframe: o.timeframe,
        }),
      );
    }
  }
  return out;
}

/**
 * Candles of `tf` built from shorter REST candles, one for each period that has any: Coinbase's REST
 * API has no 4h granularity, so its 4h candles come from four 1h candles (architecture §5.2). A
 * period with missing children is partial. The data is the venue's REST data, so the source stays
 * `rest`; the closure flag is decided on the whole period, even when children are missing.
 */
export function aggregateRest(tf: Timeframe, children: readonly Candle[], closed: ClosureCheck): Candle[] {
  const childTf = children[0]?.timeframe;
  if (childTf === undefined) return [];
  return [...Map.groupBy(children, (c) => floorTo(c.openTime, tf))].map(([openTime, group]): Candle => ({
    ...aggregateCandles(tf, openTime, group, childTf),
    source: 'rest',
    underlyingClosed: closed(openTime, openTime + TF_MS[tf]),
  }));
}
