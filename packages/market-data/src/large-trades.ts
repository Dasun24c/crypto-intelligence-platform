import {
  addDecimals,
  type DecimalString,
  divDecimal,
  mulDecimal,
  normalizeDecimal,
  roundDecimal,
} from '@cip/domain';

/**
 * Exchange large trades (architecture §5.6, WH-01). Fills are first grouped into the taker order that
 * produced them, by the best evidence each venue publishes; an order is "large" when its USD notional
 * reaches max(floorUsd, the 99.9th percentile of order notional over the trailing 24 h).
 */

export interface TradeFill {
  /** Venue trade time (epoch ms). */
  ts: number;
  /** Local receive time, for closing an order once no more of its fills can arrive. */
  receivedAt: number;
  price: DecimalString;
  qty: DecimalString;
  takerSide: 'buy' | 'sell';
  /** Coinbase `taker_order_id`. */
  takerOrderRef: string | null;
  /** Binance aggTrade: its underlying trade id range. */
  fills?: { first: number; last: number };
}

export type Grouping = 'single' | 'taker_order' | 'burst';

export interface TakerOrder {
  /** Time of the first fill. */
  ts: number;
  takerSide: 'buy' | 'sell';
  qty: DecimalString;
  /** Σ price × qty in the quote currency. */
  quoteNotional: DecimalString;
  avgPrice: DecimalString;
  /** Venue fills: Coinbase matches, or the trades inside Binance aggTrades. */
  fillCount: number;
  priceLevels: number;
  /** `single`: one message; `taker_order`: merged by order id or Binance sweep; `burst`: same side within 250 ms. */
  grouping: Grouping;
}

/** "Other cases": same-side fills this close together count as one order. */
export const BURST_WINDOW_MS = 250;
/** An order closes when no fill has arrived for this long (local clock). */
export const ORDER_IDLE_MS = 1_000;

interface OpenOrder {
  mode: 'ref' | 'sweep' | 'burst';
  ts: number;
  lastTs: number;
  lastReceivedAt: number;
  side: 'buy' | 'sell';
  ref: string | null;
  lastTradeId: number | null;
  messages: number;
  fillCount: number;
  qty: DecimalString[];
  notional: DecimalString[];
  prices: Set<DecimalString>;
}

/**
 * Groups one instrument's fills into taker orders, in arrival order:
 * - Coinbase: matches with the same `taker_order_id` (they arrive consecutively);
 * - Binance: an aggTrade is one taker order at one price, and consecutive aggTrades with the same
 *   trade time, the same side and contiguous trade ids are one sweep across price levels;
 * - otherwise: same-side fills within 250 ms.
 */
export class TakerOrderGrouper {
  private open: OpenOrder | null = null;

  /** Adds a fill; returns the previous order when this fill cannot belong to it. */
  add(fill: TradeFill): TakerOrder | null {
    const current = this.open;
    if (current && joins(current, fill)) {
      extend(current, fill);
      return null;
    }
    this.open = start(fill);
    return current ? finish(current) : null;
  }

  /** Closes the open order once its last fill is `ORDER_IDLE_MS` old. */
  flush(now: number): TakerOrder | null {
    const current = this.open;
    if (!current || now - current.lastReceivedAt < ORDER_IDLE_MS) return null;
    this.open = null;
    return finish(current);
  }

  /** After a reconnect, later fills cannot be matched to the open order: close it as it stands. */
  reset(): TakerOrder | null {
    const current = this.open;
    this.open = null;
    return current ? finish(current) : null;
  }
}

function modeOf(fill: TradeFill): OpenOrder['mode'] {
  return fill.takerOrderRef !== null ? 'ref' : fill.fills ? 'sweep' : 'burst';
}

function joins(o: OpenOrder, f: TradeFill): boolean {
  if (f.takerSide !== o.side || modeOf(f) !== o.mode) return false;
  switch (o.mode) {
    case 'ref':
      return f.takerOrderRef === o.ref;
    case 'sweep':
      return f.ts === o.lastTs && o.lastTradeId !== null && f.fills!.first === o.lastTradeId + 1;
    case 'burst':
      return f.ts - o.lastTs <= BURST_WINDOW_MS;
  }
}

function start(f: TradeFill): OpenOrder {
  const o: OpenOrder = {
    mode: modeOf(f),
    ts: f.ts,
    lastTs: f.ts,
    lastReceivedAt: f.receivedAt,
    side: f.takerSide,
    ref: f.takerOrderRef,
    lastTradeId: null,
    messages: 0,
    fillCount: 0,
    qty: [],
    notional: [],
    prices: new Set(),
  };
  extend(o, f);
  return o;
}

function extend(o: OpenOrder, f: TradeFill): void {
  o.lastTs = f.ts;
  o.lastReceivedAt = f.receivedAt;
  o.lastTradeId = f.fills ? f.fills.last : null;
  o.messages++;
  o.fillCount += f.fills ? f.fills.last - f.fills.first + 1 : 1;
  o.qty.push(f.qty);
  o.notional.push(mulDecimal(f.price, f.qty));
  o.prices.add(f.price);
}

function finish(o: OpenOrder): TakerOrder {
  const qty = addDecimals(o.qty);
  const quoteNotional = addDecimals(o.notional);
  return {
    ts: o.ts,
    takerSide: o.side,
    qty,
    quoteNotional,
    avgPrice: Number(qty) === 0 ? '0' : divDecimal(quoteNotional, qty, 12),
    fillCount: o.fillCount,
    priceLevels: o.prices.size,
    grouping: o.messages === 1 ? 'single' : o.mode === 'burst' ? 'burst' : 'taker_order',
  };
}

// ---------------------------------------------------------------------------------------------
// Trailing-24 h percentile of order notional
// ---------------------------------------------------------------------------------------------

export const HOUR_MS = 3_600_000;
/** Log-spaced bins: each is 2% wider than the last, so a percentile is known to within 2%. */
export const NOTIONAL_BIN_RATIO = 1.02;
const LOG_RATIO = Math.log(NOTIONAL_BIN_RATIO);
/** Bins from $1 to $1 trillion. */
export const NOTIONAL_BINS = Math.ceil(Math.log(1e12) / LOG_RATIO) + 1;

/** The bin of a USD notional: floor(ln(usd) / ln(1.02)), clamped. Stored trades are binned the same way. */
export function notionalBin(usd: number): number {
  if (!(usd > 1)) return 0;
  return Math.min(NOTIONAL_BINS - 1, Math.floor(Math.log(usd) / LOG_RATIO));
}

/** The lower edge of a bin, in USD. */
export function binFloorUsd(bin: number): number {
  return NOTIONAL_BIN_RATIO ** bin;
}

/**
 * Counts of order notional per hour and log bin. Memory is bounded (24 hours × ~1,400 bins), and
 * the trailing window is the current hour plus the 23 before it.
 */
export class NotionalHistogram {
  private readonly hours = new Map<number, Uint32Array>();

  constructor(private readonly windowHours = 24) {}

  add(usd: number, ts: number, count = 1): void {
    this.addToBin(notionalBin(usd), ts, count);
  }

  addToBin(bin: number, ts: number, count: number): void {
    const hour = Math.floor(ts / HOUR_MS);
    let counts = this.hours.get(hour);
    if (!counts) {
      counts = new Uint32Array(NOTIONAL_BINS);
      this.hours.set(hour, counts);
      this.prune(ts);
    }
    counts[Math.max(0, Math.min(NOTIONAL_BINS - 1, bin))]! += count;
  }

  count(now: number): number {
    let total = 0;
    for (const counts of this.window(now)) for (const n of counts) total += n;
    return total;
  }

  /** The lower edge of the bin holding the q-quantile, or null while the window is empty. */
  quantile(q: number, now: number): number | null {
    const windows = this.window(now);
    const merged = new Float64Array(NOTIONAL_BINS);
    let total = 0;
    for (const counts of windows)
      for (let b = 0; b < NOTIONAL_BINS; b++) {
        merged[b]! += counts[b]!;
        total += counts[b]!;
      }
    if (total === 0) return null;
    const rank = Math.ceil(q * total);
    let seen = 0;
    for (let b = 0; b < NOTIONAL_BINS; b++) {
      seen += merged[b]!;
      if (seen >= rank) return binFloorUsd(b);
    }
    return binFloorUsd(NOTIONAL_BINS - 1);
  }

  private window(now: number): Uint32Array[] {
    const first = Math.floor(now / HOUR_MS) - this.windowHours + 1;
    const out: Uint32Array[] = [];
    for (const [hour, counts] of this.hours) if (hour >= first) out.push(counts);
    return out;
  }

  private prune(now: number): void {
    const first = Math.floor(now / HOUR_MS) - this.windowHours + 1;
    for (const hour of this.hours.keys()) if (hour < first) this.hours.delete(hour);
  }
}

export interface LargeTrade extends TakerOrder {
  /** Quote notional × the quote currency's USD rate, to the cent. */
  notionalUsd: DecimalString;
  /** The threshold in force when the order completed, to the cent. */
  thresholdUsd: DecimalString;
}

export interface LargeTradeOptions {
  floorUsd: number;
  /** Default 0.999. */
  quantile?: number;
  /** Below this many orders in the window the percentile is not trusted and the floor alone applies. */
  minSamples?: number;
  /** The percentile moves slowly; it is recomputed at most this often. */
  recomputeMs?: number;
}

/**
 * Thresholds completed taker orders. Detection starts only once `start()` is called, after the
 * window has been seeded from stored trades, so a restart does not report every order above the floor.
 */
export class LargeTradeDetector {
  private readonly histogram = new NotionalHistogram();
  private started = false;
  private cached: { at: number; value: number } | null = null;

  constructor(private readonly opts: LargeTradeOptions) {}

  /** Adds hourly log-binned order counts (for example aggregated from stored trades). */
  seed(rows: readonly { hour: number; bin: number; count: number }[]): void {
    for (const r of rows) this.histogram.addToBin(r.bin, r.hour * HOUR_MS, r.count);
    this.cached = null;
  }

  start(): void {
    this.started = true;
  }

  get isStarted(): boolean {
    return this.started;
  }

  thresholdUsd(now: number): number {
    const recompute = this.opts.recomputeMs ?? 10_000;
    if (!this.cached || now - this.cached.at >= recompute || now < this.cached.at) {
      const enough = this.histogram.count(now) >= (this.opts.minSamples ?? 1_000);
      const percentile = enough ? (this.histogram.quantile(this.opts.quantile ?? 0.999, now) ?? 0) : 0;
      this.cached = { at: now, value: Math.max(this.opts.floorUsd, percentile) };
    }
    return this.cached.value;
  }

  /** Records the order in the window; returns it as a large trade when it reaches the threshold. */
  observe(order: TakerOrder, usdPerQuote: DecimalString): LargeTrade | null {
    const notionalUsd = roundDecimal(mulDecimal(order.quoteNotional, usdPerQuote), 2);
    const usd = Number(notionalUsd);
    const threshold = this.thresholdUsd(order.ts);
    this.histogram.add(usd, order.ts);
    if (!this.started || usd < threshold) return null;
    return { ...order, notionalUsd, thresholdUsd: normalizeDecimal(threshold.toFixed(2)) };
  }
}
