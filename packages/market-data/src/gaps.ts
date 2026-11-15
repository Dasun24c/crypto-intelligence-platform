/**
 * Gap and delay detection (architecture §5.4): sequence gaps, missed trades behind a heartbeat,
 * silent streams and exchange-time lag.
 */
export type SequenceOutcome =
  | { kind: 'first' }
  | { kind: 'ok' }
  | { kind: 'duplicate' }
  | { kind: 'gap'; missingFrom: number; missingTo: number };

/** Ids that must increase by exactly one (Binance aggTrade id, Coinbase trade_id per product). */
export class SequenceTracker {
  private last: number | null = null;

  observe(seq: number): SequenceOutcome {
    const last = this.last;
    if (last === null) {
      this.last = seq;
      return { kind: 'first' };
    }
    if (seq <= last) return { kind: 'duplicate' };
    this.last = seq;
    return seq === last + 1 ? { kind: 'ok' } : { kind: 'gap', missingFrom: last + 1, missingTo: seq - 1 };
  }

  get lastSeen(): number | null {
    return this.last;
  }

  reset(): void {
    this.last = null;
  }
}

/**
 * Coinbase heartbeats carry the product's last trade id. Trades and heartbeats are separate channels,
 * so a heartbeat can overtake the trades it mentions; a gap is declared only if the trades named by
 * one heartbeat have still not arrived when the next heartbeat comes.
 */
export class HeartbeatTradeCheck {
  private pending: number | null = null;

  onHeartbeat(
    lastTradeId: number,
    lastSeenTradeId: number | null,
  ): { kind: 'ok' } | { kind: 'gap'; missingFrom: number; missingTo: number } {
    const due = this.pending;
    this.pending = lastTradeId;
    if (due === null || lastSeenTradeId === null || lastSeenTradeId >= due) return { kind: 'ok' };
    return { kind: 'gap', missingFrom: lastSeenTradeId + 1, missingTo: due };
  }

  reset(): void {
    this.pending = null;
  }
}

/** A stream is silent after max(30 s, 3 × its expected interval) without a message (NFR-04). */
export class SilenceMonitor {
  private readonly lastMessage = new Map<string, number>();

  constructor(private readonly expectedIntervalMs: (stream: string) => number) {}

  touch(stream: string, now: number): void {
    this.lastMessage.set(stream, now);
  }

  forget(stream: string): void {
    this.lastMessage.delete(stream);
  }

  silent(now: number): { stream: string; since: number }[] {
    const out: { stream: string; since: number }[] = [];
    for (const [stream, last] of this.lastMessage) {
      if (now - last > Math.max(30_000, 3 * this.expectedIntervalMs(stream)))
        out.push({ stream, since: last });
    }
    return out;
  }

  lastAt(stream: string): number | undefined {
    return this.lastMessage.get(stream);
  }
}

/** Exchange-time lag over a trailing window; "delayed" when the median exceeds 2 s over 60 s. */
export class DelayTracker {
  private samples: { at: number; lag: number }[] = [];

  constructor(
    private readonly windowMs = 60_000,
    private readonly delayedAboveMs = 2_000,
  ) {}

  add(venueTs: number, receivedAt: number): void {
    this.samples.push({ at: receivedAt, lag: receivedAt - venueTs });
    if (this.samples.length > 10_000) this.samples.splice(0, this.samples.length - 10_000);
  }

  private window(now: number): number[] {
    this.samples = this.samples.filter((s) => s.at > now - this.windowMs);
    return this.samples.map((s) => s.lag).sort((a, b) => a - b);
  }

  percentile(p: number, now: number): number | null {
    const lags = this.window(now);
    if (lags.length === 0) return null;
    return lags[Math.min(lags.length - 1, Math.floor((p / 100) * lags.length))]!;
  }

  delayed(now: number): boolean {
    const p50 = this.percentile(50, now);
    return p50 !== null && p50 > this.delayedAboveMs;
  }
}
