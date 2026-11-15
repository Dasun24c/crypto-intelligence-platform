import type { DecimalString } from '@cip/domain';

export type BookLevel = [price: DecimalString, qty: DecimalString];

export interface BookMetrics {
  mid: number;
  spreadBps: number;
  /**
   * Quote-currency notional within ±0.1%, ±0.5% and ±1% of mid (architecture §5.3); null when the
   * local book is not known to be complete that far from mid (see `coverageBps`), never an undercount.
   */
  bidUsd10bp: number | null;
  askUsd10bp: number | null;
  bidUsd50bp: number | null;
  askUsd50bp: number | null;
  bidUsd100bp: number | null;
  askUsd100bp: number | null;
  imbalance10bp: number | null;
  imbalance50bp: number | null;
  imbalance100bp: number | null;
  /**
   * How far from mid, in bps on the shorter side, the local book reaches reliably. For a venue
   * whose snapshot is the best N levels (Binance): the snapshot's range, since diff updates beyond
   * it only show levels that changed. For a full snapshot (Coinbase): its farthest level, beyond
   * which there is nothing.
   */
  coverageBps: number;
}

interface Entry {
  price: DecimalString;
  qty: DecimalString;
  p: number;
  q: number;
}

/** A book level: exact price and quantity, with their numeric values for metrics. */
export type BookEntry = Readonly<Entry>;

class Side {
  private readonly levels = new Map<string, Entry>();
  private sorted: Entry[] | null = null;

  constructor(private readonly descending: boolean) {}

  set(price: DecimalString, qty: DecimalString): void {
    if (Number(qty) === 0) this.levels.delete(price);
    else this.levels.set(price, { price, qty, p: Number(price), q: Number(qty) });
    this.sorted = null;
  }

  clear(): void {
    this.levels.clear();
    this.sorted = null;
  }

  get(price: DecimalString): Entry | undefined {
    return this.levels.get(price);
  }

  ordered(): Entry[] {
    this.sorted ??= [...this.levels.values()].sort((a, b) => (this.descending ? b.p - a.p : a.p - b.p));
    return this.sorted;
  }

  get size(): number {
    return this.levels.size;
  }
}

/** A local L2 order book: price → quantity per side, best price first. */
export class OrderBook {
  private readonly bids = new Side(true);
  private readonly asks = new Side(false);
  private changes = 0;
  /** Prices between which every level is known; null when the whole book is (a full snapshot). */
  private complete: { low: number; high: number } | null = null;

  /**
   * Replaces the book. `complete` is the price range a partial snapshot covers (its deepest bid and
   * ask); omit it for a full snapshot.
   */
  reset(
    bids: readonly BookLevel[],
    asks: readonly BookLevel[],
    complete: { low: number; high: number } | null = null,
  ): void {
    this.bids.clear();
    this.asks.clear();
    this.complete = complete;
    this.apply(bids, asks);
  }

  /** Takes over another book's levels and coverage (a refreshed snapshot), as one change. */
  replaceWith(other: OrderBook): void {
    const levels = (side: Side) => side.ordered().map((e): BookLevel => [e.price, e.qty]);
    this.reset(levels(other.bids), levels(other.asks), other.complete);
  }

  /** In bps of mid, on the shorter side; null while the book has no mid. */
  coverage(): number | null {
    const mid = this.mid();
    if (mid === null) return null;
    if (this.complete)
      return Math.max(
        0,
        Math.min((mid - this.complete.low) / mid, (this.complete.high - mid) / mid) * 10_000,
      );
    const bids = this.bids.ordered();
    const asks = this.asks.ordered();
    return Math.min(((mid - bids.at(-1)!.p) / mid) * 10_000, ((asks.at(-1)!.p - mid) / mid) * 10_000);
  }

  /** Increments on every change, so a publisher can skip a book that has not moved. */
  get version(): number {
    return this.changes;
  }

  apply(bids: readonly BookLevel[], asks: readonly BookLevel[]): void {
    this.changes++;
    for (const [p, q] of bids) this.bids.set(p, q);
    for (const [p, q] of asks) this.asks.set(p, q);
  }

  get depth(): { bids: number; asks: number } {
    return { bids: this.bids.size, asks: this.asks.size };
  }

  top(n: number): { bids: BookLevel[]; asks: BookLevel[] } {
    const pick = (side: Side) =>
      side
        .ordered()
        .slice(0, n)
        .map((e): BookLevel => [e.price, e.qty]);
    return { bids: pick(this.bids), asks: pick(this.asks) };
  }

  /**
   * Levels within ±`bps` of mid, best first, or null while the book is one-sided or crossed. The
   * window never reaches beyond the book's complete coverage, where only changed levels are known.
   */
  near(requestedBps: number): { mid: number; bids: BookEntry[]; asks: BookEntry[] } | null {
    const bids = this.bids.ordered();
    const asks = this.asks.ordered();
    const bestBid = bids[0];
    const bestAsk = asks[0];
    if (!bestBid || !bestAsk || bestBid.p >= bestAsk.p) return null;
    const mid = (bestBid.p + bestAsk.p) / 2;
    const bps = this.complete ? Math.min(requestedBps, this.coverage() ?? requestedBps) : requestedBps;
    const low = mid * (1 - bps / 10_000);
    const high = mid * (1 + bps / 10_000);
    const take = (side: Entry[], inside: (p: number) => boolean) => {
      const out: BookEntry[] = [];
      for (const e of side) {
        if (!inside(e.p)) break;
        out.push(e);
      }
      return out;
    };
    return { mid, bids: take(bids, (p) => p >= low), asks: take(asks, (p) => p <= high) };
  }

  /** (best bid + best ask) / 2, or null while the book is one-sided or crossed. */
  mid(): number | null {
    const bid = this.bids.ordered()[0];
    const ask = this.asks.ordered()[0];
    return bid && ask && bid.p < ask.p ? (bid.p + ask.p) / 2 : null;
  }

  /** The resting quantity at a price (0 when the level is absent). */
  qtyAt(side: 'bid' | 'ask', price: DecimalString): number {
    return (side === 'bid' ? this.bids : this.asks).get(price)?.q ?? 0;
  }

  /** True when the best bid is at or above the best ask: a broken book that must be resynchronised. */
  crossed(): boolean {
    const bid = this.bids.ordered()[0];
    const ask = this.asks.ordered()[0];
    return bid !== undefined && ask !== undefined && bid.p >= ask.p;
  }

  metrics(): BookMetrics | null {
    const bids = this.bids.ordered();
    const asks = this.asks.ordered();
    const bestBid = bids[0];
    const bestAsk = asks[0];
    if (!bestBid || !bestAsk || bestBid.p >= bestAsk.p) return null;
    const mid = (bestBid.p + bestAsk.p) / 2;
    const within = (side: Entry[], bps: number, below: boolean) => {
      const limit = below ? mid * (1 - bps / 10_000) : mid * (1 + bps / 10_000);
      let notional = 0;
      for (const e of side) {
        if (below ? e.p < limit : e.p > limit) break;
        notional += e.p * e.q;
      }
      return notional;
    };
    const coverageBps = this.coverage()!;
    // A band a partial book does not fully cover is unknown, not smaller. A full book is complete
    // everywhere: beyond its last level there is nothing.
    const band = (side: Entry[], bps: number, below: boolean) =>
      this.complete === null || coverageBps >= bps ? within(side, bps, below) : null;
    const imbalance = (b: number | null, a: number | null) =>
      b === null || a === null ? null : b + a === 0 ? 0 : (b - a) / (b + a);
    const b10 = band(bids, 10, true);
    const a10 = band(asks, 10, false);
    const b50 = band(bids, 50, true);
    const a50 = band(asks, 50, false);
    const b100 = band(bids, 100, true);
    const a100 = band(asks, 100, false);
    return {
      mid,
      spreadBps: ((bestAsk.p - bestBid.p) / mid) * 10_000,
      bidUsd10bp: b10,
      askUsd10bp: a10,
      bidUsd50bp: b50,
      askUsd50bp: a50,
      bidUsd100bp: b100,
      askUsd100bp: a100,
      imbalance10bp: imbalance(b10, a10),
      imbalance50bp: imbalance(b50, a50),
      imbalance100bp: imbalance(b100, a100),
      coverageBps,
    };
  }
}
