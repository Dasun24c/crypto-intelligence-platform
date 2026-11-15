import { type BookLevel, OrderBook } from './order-book.js';

export interface DepthDelta {
  firstUpdateId: number;
  lastUpdateId: number;
  bids: BookLevel[];
  asks: BookLevel[];
}

export interface DepthSnapshot {
  lastUpdateId: number;
  bids: BookLevel[];
  asks: BookLevel[];
}

export type SyncState = 'awaiting_snapshot' | 'synced';

export type DeltaOutcome =
  | { kind: 'buffered' }
  | { kind: 'applied' }
  | { kind: 'ignored' }
  /** A missing update or a crossed book: discard and fetch a new snapshot (architecture §5.3). */
  | { kind: 'resync'; reason: string; expectedFirstId?: number; gotFirstId?: number };

const MAX_BUFFER = 5_000;

/**
 * Binance's documented procedure for a local book (feasibility §3.1): buffer diff events, take a REST
 * snapshot, drop events already contained in it, require the first applied event to straddle
 * `lastUpdateId + 1`, then require every event to start exactly one after the previous one ended.
 */
export class BinanceBookSync {
  readonly book = new OrderBook();
  private state: SyncState = 'awaiting_snapshot';
  private buffer: DepthDelta[] = [];
  private lastUpdateId = 0;
  /** Deltas collected for a refresh snapshot while the live book keeps updating. */
  private refreshBuffer: DepthDelta[] | null = null;

  /** True between `beginRefresh` and `onRefreshSnapshot`. */
  get refreshing(): boolean {
    return this.refreshBuffer !== null;
  }

  /**
   * Starts a refresh of a synced book (its complete range shrinks as the price moves): deltas are
   * kept for a new snapshot while the live book carries on, and nothing is interrupted.
   */
  beginRefresh(): void {
    if (this.state === 'synced') this.refreshBuffer = [];
  }

  /**
   * Builds a book from the refresh snapshot plus the deltas since, and takes it over only when it
   * reaches exactly the live book's update id. Otherwise the live book stays and the refresh is dropped.
   */
  onRefreshSnapshot(s: DepthSnapshot): DeltaOutcome {
    const buffered = this.refreshBuffer;
    this.refreshBuffer = null;
    if (!buffered || this.state !== 'synced') return { kind: 'ignored' };
    const fresh = new OrderBook();
    fresh.reset(s.bids, s.asks, rangeOf(s));
    let last = s.lastUpdateId;
    for (const d of buffered.filter((x) => x.lastUpdateId > s.lastUpdateId)) {
      if (last === s.lastUpdateId ? d.firstUpdateId > last + 1 : d.firstUpdateId !== last + 1)
        return { kind: 'ignored' };
      fresh.apply(d.bids, d.asks);
      last = d.lastUpdateId;
    }
    if (last !== this.lastUpdateId || fresh.crossed()) return { kind: 'ignored' };
    this.book.replaceWith(fresh);
    return { kind: 'applied' };
  }

  get status(): SyncState {
    return this.state;
  }

  get updateId(): number {
    return this.lastUpdateId;
  }

  onDelta(d: DepthDelta): DeltaOutcome {
    if (this.refreshBuffer && this.refreshBuffer.length < MAX_BUFFER) this.refreshBuffer.push(d);
    if (this.state === 'awaiting_snapshot') {
      this.buffer.push(d);
      if (this.buffer.length > MAX_BUFFER) this.buffer.shift();
      return { kind: 'buffered' };
    }
    if (d.lastUpdateId <= this.lastUpdateId) return { kind: 'ignored' };
    if (d.firstUpdateId !== this.lastUpdateId + 1) {
      return this.desync('update id gap', this.lastUpdateId + 1, d.firstUpdateId);
    }
    this.book.apply(d.bids, d.asks);
    this.lastUpdateId = d.lastUpdateId;
    return this.book.crossed() ? this.desync('crossed book') : { kind: 'applied' };
  }

  /** Applies a snapshot. Returns `resync` if the snapshot is older than the buffered events. */
  onSnapshot(s: DepthSnapshot): DeltaOutcome {
    const first = this.buffer[0];
    if (first && s.lastUpdateId < first.firstUpdateId - 1) {
      return {
        kind: 'resync',
        reason: 'snapshot older than buffered events',
        expectedFirstId: s.lastUpdateId + 1,
        gotFirstId: first.firstUpdateId,
      };
    }
    this.book.reset(s.bids, s.asks, rangeOf(s));
    this.lastUpdateId = s.lastUpdateId;
    this.state = 'synced';
    const pending = this.buffer.filter((d) => d.lastUpdateId > s.lastUpdateId);
    this.buffer = [];
    let firstApplied = true;
    for (const d of pending) {
      if (firstApplied) {
        firstApplied = false;
        if (!(d.firstUpdateId <= s.lastUpdateId + 1 && d.lastUpdateId >= s.lastUpdateId + 1)) {
          return this.desync(
            'first event does not continue the snapshot',
            s.lastUpdateId + 1,
            d.firstUpdateId,
          );
        }
        this.book.apply(d.bids, d.asks);
        this.lastUpdateId = d.lastUpdateId;
        continue;
      }
      const outcome = this.onDelta(d);
      if (outcome.kind === 'resync') return outcome;
    }
    return { kind: 'applied' };
  }

  private desync(reason: string, expectedFirstId?: number, gotFirstId?: number): DeltaOutcome {
    this.state = 'awaiting_snapshot';
    this.buffer = [];
    this.refreshBuffer = null;
    this.book.reset([], []);
    return {
      kind: 'resync',
      reason,
      ...(expectedFirstId !== undefined ? { expectedFirstId } : {}),
      ...(gotFirstId !== undefined ? { gotFirstId } : {}),
    };
  }

  /** After a reconnect: everything known is stale. */
  reset(): void {
    this.state = 'awaiting_snapshot';
    this.buffer = [];
    this.refreshBuffer = null;
    this.book.reset([], []);
    this.lastUpdateId = 0;
  }
}

/** A Binance REST snapshot is the best N levels: complete from its deepest bid to its deepest ask. */
function rangeOf(s: DepthSnapshot): { low: number; high: number } | null {
  const low = s.bids.at(-1);
  const high = s.asks.at(-1);
  return low && high ? { low: Number(low[0]), high: Number(high[0]) } : null;
}

/**
 * Coinbase `level2_batch`: the channel sends a full snapshot on subscribe, then batched changes. It
 * carries no update ids, so integrity comes from the connection (a reconnect brings a new snapshot)
 * and the crossed-book check.
 */
export class CoinbaseBookSync {
  readonly book = new OrderBook();
  private synced = false;

  get status(): SyncState {
    return this.synced ? 'synced' : 'awaiting_snapshot';
  }

  onSnapshot(bids: BookLevel[], asks: BookLevel[]): void {
    this.book.reset(bids, asks);
    this.synced = true;
  }

  onDelta(bids: BookLevel[], asks: BookLevel[]): DeltaOutcome {
    if (!this.synced) return { kind: 'ignored' };
    this.book.apply(bids, asks);
    if (this.book.crossed()) {
      this.reset();
      return { kind: 'resync', reason: 'crossed book' };
    }
    return { kind: 'applied' };
  }

  reset(): void {
    this.synced = false;
    this.book.reset([], []);
  }
}
