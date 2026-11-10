import type { DecimalString } from '@cip/domain';
import type { BookEntry, OrderBook } from './order-book.js';

/**
 * Order-book walls (architecture §5.6, WH-01): a price level whose notional is at least `multiple`
 * times the median level notional within ±`windowBps` of mid, and above a floor. A wall is reported
 * once it has lasted `minLifetimeMs` (shorter ones are flicker), and when it ends its removal is
 * classified from the trades seen at or through its price.
 */
export interface WallParams {
  /** × the median level notional near mid (architecture: 10). */
  multiple: number;
  floorUsd: number;
  /** The neighbourhood of mid the median is taken over (architecture: ±1% = 100 bps). */
  windowBps: number;
  minLifetimeMs: number;
  /** A wall stays a wall while it holds this share of the threshold, so it does not flap. */
  holdRatio: number;
}

export type WallSide = 'bid' | 'ask';
export type WallEndReason = 'filled' | 'pulled' | 'unknown';

export interface Wall {
  side: WallSide;
  price: DecimalString;
  firstSeen: number;
  lastSeen: number;
  qty: number;
  notionalUsd: number;
  maxNotionalUsd: number;
}

export type WallEvent =
  { kind: 'appeared'; wall: Wall } | { kind: 'ended'; wall: Wall; reason: WallEndReason };

interface Tracked extends Wall {
  p: number;
  announced: boolean;
}

/** Taker volume against one resting side since the last scan, by price. */
type Taken = Map<number, number>;

export class WallDetector {
  private readonly walls = new Map<string, Tracked>();
  private taken: Record<WallSide, Taken> = { bid: new Map(), ask: new Map() };

  constructor(private readonly params: WallParams) {}

  /** A sell taker trades against resting bids; a buy taker against resting asks. */
  onTrade(t: { price: DecimalString; qty: DecimalString; takerSide: 'buy' | 'sell' }): void {
    const side: WallSide = t.takerSide === 'sell' ? 'bid' : 'ask';
    const p = Number(t.price);
    this.taken[side].set(p, (this.taken[side].get(p) ?? 0) + Number(t.qty));
  }

  /** Called at 1 Hz with the current book; returns walls that appeared or ended since the last scan. */
  scan(book: OrderBook, now: number, usdPerQuote: number): WallEvent[] {
    const near = book.near(this.params.windowBps);
    if (!near) {
      this.clearTaken();
      return this.endAll(now, 'unknown');
    }
    const levels: { side: WallSide; e: BookEntry; usd: number }[] = [
      ...near.bids.map((e) => ({ side: 'bid' as const, e, usd: e.p * e.q * usdPerQuote })),
      ...near.asks.map((e) => ({ side: 'ask' as const, e, usd: e.p * e.q * usdPerQuote })),
    ];
    const threshold = Math.max(this.params.floorUsd, this.params.multiple * median(levels.map((l) => l.usd)));

    const events: WallEvent[] = [];
    const present = new Set<string>();
    for (const { side, e, usd } of levels) {
      const key = `${side}:${e.price}`;
      const existing = this.walls.get(key);
      if (usd < (existing ? threshold * this.params.holdRatio : threshold)) continue;
      present.add(key);
      if (existing) {
        existing.lastSeen = now;
        existing.qty = e.q;
        existing.notionalUsd = usd;
        existing.maxNotionalUsd = Math.max(existing.maxNotionalUsd, usd);
      } else {
        this.walls.set(key, {
          side,
          price: e.price,
          p: e.p,
          firstSeen: now,
          lastSeen: now,
          qty: e.q,
          notionalUsd: usd,
          maxNotionalUsd: usd,
          announced: false,
        });
      }
    }

    for (const [key, w] of this.walls) {
      if (present.has(key)) {
        if (!w.announced && now - w.firstSeen >= this.params.minLifetimeMs) {
          w.announced = true;
          events.push({ kind: 'appeared', wall: publicWall(w) });
        }
        continue;
      }
      this.walls.delete(key);
      if (!w.announced) continue;
      const remaining = book.qtyAt(w.side, w.price);
      events.push({ kind: 'ended', wall: publicWall(w), reason: this.classify(w, remaining, near.mid) });
    }
    this.clearTaken();
    return events;
  }

  /** The book was reset or the feed lost: how the walls ended cannot be known. */
  endAll(now: number, reason: WallEndReason): WallEvent[] {
    const events: WallEvent[] = [];
    for (const w of this.walls.values())
      if (w.announced) events.push({ kind: 'ended', wall: { ...publicWall(w), lastSeen: now }, reason });
    this.walls.clear();
    return events;
  }

  get active(): Wall[] {
    return [...this.walls.values()].filter((w) => w.announced).map(publicWall);
  }

  private classify(w: Tracked, remaining: number, mid: number): WallEndReason {
    const edge = this.params.windowBps / 10_000;
    const outside = w.side === 'bid' ? w.p < mid * (1 - edge) : w.p > mid * (1 + edge);
    // The market moved away and the level left the watched neighbourhood: nothing says how it ended.
    if (outside && remaining > 0) return 'unknown';
    const removed = Math.max(0, w.qty - remaining);
    // Takers at the wall's price, or beyond it (the market traded through the level).
    let traded = 0;
    for (const [p, q] of this.taken[w.side]) if (w.side === 'bid' ? p <= w.p : p >= w.p) traded += q;
    return traded >= removed / 2 && traded > 0 ? 'filled' : 'pulled';
  }

  private clearTaken(): void {
    this.taken = { bid: new Map(), ask: new Map() };
  }
}

function publicWall(w: Tracked): Wall {
  return {
    side: w.side,
    price: w.price,
    firstSeen: w.firstSeen,
    lastSeen: w.lastSeen,
    qty: w.qty,
    notionalUsd: w.notionalUsd,
    maxNotionalUsd: w.maxNotionalUsd,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
