import {
  addDecimals,
  type Candle,
  type CandleSource,
  dec,
  type DecimalString,
  flatCandle,
  floorTo,
  maxDecimal,
  minDecimal,
  MINUTE_MS,
  normalizeDecimal,
} from '@cip/domain';

export interface TradeInput {
  ts: number;
  price: DecimalString;
  qty: DecimalString;
  takerSide: 'buy' | 'sell';
}

export interface KlineInput {
  openTime: number;
  open: DecimalString;
  high: DecimalString;
  low: DecimalString;
  close: DecimalString;
  volume: DecimalString;
  quoteVolume: DecimalString;
  tradeCount: number;
  takerBuyVolume: DecimalString;
}

/** True when [start, end) overlaps a gold-market closure for this instrument (always false otherwise). */
export type ClosureCheck = (start: number, end: number) => boolean;

/**
 * Micro volume profile (rulebook §3.5): [low, high] split into `buckets` equal buckets, each trade's
 * quantity added to its bucket. A one-price minute puts everything in the first bucket.
 */
export function microProfile(
  trades: readonly TradeInput[],
  low: DecimalString,
  high: DecimalString,
  buckets: number,
): number[] {
  const profile = new Array<number>(buckets).fill(0);
  const lo = Number(low);
  const width = Number(high) - lo;
  for (const t of trades) {
    const qty = Number(t.qty);
    let index = width > 0 ? Math.floor(((Number(t.price) - lo) / width) * buckets) : 0;
    index = Math.min(buckets - 1, Math.max(0, index));
    profile[index]! += qty;
  }
  return profile;
}

interface Minute {
  openTime: number;
  trades: TradeInput[];
}

/** Trades grouped by minute, in arrival order; minutes leave once finalised. */
class MinuteBuffer {
  private readonly minutes = new Map<number, Minute>();

  add(t: TradeInput): void {
    const openTime = floorTo(t.ts, '1m');
    let m = this.minutes.get(openTime);
    if (!m) this.minutes.set(openTime, (m = { openTime, trades: [] }));
    m.trades.push(t);
  }

  peek(openTime: number): Minute | undefined {
    return this.minutes.get(openTime);
  }

  take(openTime: number): Minute | undefined {
    const m = this.minutes.get(openTime);
    this.minutes.delete(openTime);
    return m;
  }

  /** Drops minutes older than `before` (already finalised elsewhere, or never claimed). */
  prune(before: number): void {
    for (const key of this.minutes.keys()) if (key < before) this.minutes.delete(key);
  }

  get size(): number {
    return this.minutes.size;
  }
}

export interface TradeCandleBuilderOptions {
  profileBuckets: number;
  /** Time after the minute boundary before the candle is final (architecture §5.2: 2 s for Coinbase). */
  graceMs: number;
  closed: ClosureCheck;
  source?: CandleSource;
}

/**
 * Builds final 1m candles from trades (Coinbase, which has no candle stream). Minutes are finalised
 * strictly in order once their grace period has passed; a minute with no trades becomes a flat candle
 * at the previous close, so every minute exists. Trades for a minute already finalised are counted
 * as late and ignored: published candles never change.
 */
export class TradeCandleBuilder {
  private readonly buffer = new MinuteBuffer();
  private readonly firstOpen: number;
  private nextOpen: number;
  private lastClose: DecimalString | null;
  lateTrades = 0;

  /**
   * `start.nextOpen` is the first minute to build: after a fresh connection, the next full minute,
   * because the minute in progress was only partly seen (backfill covers it). `start.lastClose` is
   * the close of the last stored candle, needed for flat candles; null if unknown.
   */
  constructor(
    private readonly opts: TradeCandleBuilderOptions,
    start: { nextOpen: number; lastClose: DecimalString | null },
  ) {
    if (start.nextOpen % MINUTE_MS !== 0) throw new Error('nextOpen must be a minute boundary');
    this.firstOpen = start.nextOpen;
    this.nextOpen = start.nextOpen;
    this.lastClose = start.lastClose;
  }

  addTrade(t: TradeInput): void {
    const openTime = floorTo(t.ts, '1m');
    if (openTime < this.nextOpen) {
      if (openTime >= this.firstOpen) this.lateTrades++;
      return;
    }
    this.buffer.add(t);
  }

  /** Finalises every minute whose end + grace is at or before `now`. */
  finalize(now: number): Candle[] {
    const out: Candle[] = [];
    while (this.nextOpen + MINUTE_MS + this.opts.graceMs <= now) {
      const openTime = this.nextOpen;
      const minute = this.buffer.take(openTime);
      const closed = this.opts.closed(openTime, openTime + MINUTE_MS);
      if (minute && minute.trades.length > 0) {
        out.push(this.fromTrades(openTime, minute.trades, closed));
      } else if (this.lastClose !== null) {
        out.push(
          flatCandle(openTime, this.lastClose, {
            source: this.opts.source ?? 'trades',
            underlyingClosed: closed,
            profileBuckets: this.opts.profileBuckets,
          }),
        );
      }
      const last = out.at(-1);
      if (last) this.lastClose = last.close;
      this.nextOpen = openTime + MINUTE_MS;
    }
    return out;
  }

  private fromTrades(openTime: number, trades: TradeInput[], closed: boolean): Candle {
    const sorted = [...trades].sort((a, b) => a.ts - b.ts);
    let high = sorted[0]!.price;
    let low = sorted[0]!.price;
    let quote = dec(0);
    for (const t of sorted) {
      high = maxDecimal(high, t.price);
      low = minDecimal(low, t.price);
      quote = quote.plus(dec(t.price).times(t.qty));
    }
    return {
      timeframe: '1m',
      openTime,
      open: sorted[0]!.price,
      high,
      low,
      close: sorted.at(-1)!.price,
      volume: addDecimals(sorted.map((t) => t.qty)),
      quoteVolume: normalizeDecimal(quote),
      tradeCount: sorted.length,
      takerBuyVolume: addDecimals(sorted.filter((t) => t.takerSide === 'buy').map((t) => t.qty)),
      microProfile: microProfile(sorted, low, high, this.opts.profileBuckets),
      source: this.opts.source ?? 'trades',
      quality: 'complete',
      underlyingClosed: closed,
    };
  }

  /** The minute in progress at `now`, from the trades so far: for live display only, never stored. */
  inProgress(now: number): Candle | null {
    const openTime = floorTo(now, '1m');
    if (openTime < this.nextOpen) return null;
    const closed = this.opts.closed(openTime, openTime + MINUTE_MS);
    const trades = this.buffer.peek(openTime)?.trades;
    if (trades && trades.length > 0) return this.fromTrades(openTime, trades, closed);
    return this.lastClose === null
      ? null
      : flatCandle(openTime, this.lastClose, {
          source: this.opts.source ?? 'trades',
          underlyingClosed: closed,
          profileBuckets: this.opts.profileBuckets,
        });
  }

  /** Minute the builder will finalise next. */
  get pendingFrom(): number {
    return this.nextOpen;
  }

  /** Supplies the last known price (for example from the ticker) when no stored candle gave one. */
  primeClose(close: DecimalString): void {
    this.lastClose ??= close;
  }
}

/**
 * Binance: the venue's 1m kline is authoritative for OHLCV (architecture §5.2); our own trades only
 * add the micro profile. If we missed trades in that minute (fewer than the kline counts), the
 * profile is unknown (null) rather than wrong, which the thin-book rule treats as unverified.
 */
export class KlineCandleAssembler {
  private readonly buffer = new MinuteBuffer();

  constructor(private readonly opts: { profileBuckets: number; closed: ClosureCheck }) {}

  addTrade(t: TradeInput): void {
    this.buffer.add(t);
  }

  /** Call with the venue's final kline; returns the candle to store. */
  onFinalKline(
    k: KlineInput,
    fillCount: (trades: TradeInput[]) => number = (trades) => trades.length,
  ): Candle {
    const minute = this.buffer.take(k.openTime);
    this.buffer.prune(k.openTime);
    const trades = minute?.trades ?? [];
    let profile: number[] | null;
    if (k.tradeCount === 0) profile = new Array<number>(this.opts.profileBuckets).fill(0);
    else if (trades.length > 0 && fillCount(trades) >= k.tradeCount)
      profile = microProfile(trades, k.low, k.high, this.opts.profileBuckets);
    else profile = null;
    return {
      timeframe: '1m',
      openTime: k.openTime,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
      volume: k.volume,
      quoteVolume: k.quoteVolume,
      tradeCount: k.tradeCount,
      takerBuyVolume: k.takerBuyVolume,
      microProfile: profile,
      source: 'exchange_kline',
      quality: 'complete',
      underlyingClosed: this.opts.closed(k.openTime, k.openTime + MINUTE_MS),
    };
  }

  /** The venue's kline in progress as a candle, for live display only (no profile until final). */
  inProgress(k: KlineInput): Candle {
    return {
      timeframe: '1m',
      openTime: k.openTime,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
      volume: k.volume,
      quoteVolume: k.quoteVolume,
      tradeCount: k.tradeCount,
      takerBuyVolume: k.takerBuyVolume,
      microProfile: null,
      source: 'exchange_kline',
      quality: 'complete',
      underlyingClosed: this.opts.closed(k.openTime, k.openTime + MINUTE_MS),
    };
  }

  get bufferedMinutes(): number {
    return this.buffer.size;
  }
}
