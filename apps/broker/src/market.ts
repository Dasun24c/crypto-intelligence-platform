import type { Redis } from 'ioredis';
import { channels, tradesStream } from '@cip/contracts';
import { type Book, type Health, type InstrumentRules, practiceHealth } from '@cip/paper-engine';
import type { BrokerStore, InstrumentInfo } from './store.js';

const VENUES = ['binance', 'coinbase', 'replay'] as const;

interface FeedEntry {
  instrumentId: string;
  stream: string;
  state: 'connected' | 'degraded' | 'disconnected';
}

/**
 * What the broker knows about the market (ADR 021): the instruments and their order rules, each
 * instrument's health for practice orders (refreshed every second from `feed:status:{venue}`, the
 * open gaps and the pair status), and the latest book from `book:{id}`.
 */
export class MarketView {
  private instruments = new Map<string, InstrumentInfo>();
  private health = new Map<string, Health>();

  constructor(
    private readonly redis: Redis,
    private readonly store: BrokerStore,
  ) {}

  async refreshInstruments(): Promise<void> {
    this.instruments = new Map((await this.store.instruments()).map((i) => [i.instrumentId, i]));
  }

  async refreshHealth(): Promise<void> {
    const [statuses, gaps] = await Promise.all([
      this.redis.mget(...VENUES.map((v) => `feed:status:${v}`)),
      this.store.openGaps(),
    ]);
    const feeds = new Map<string, FeedEntry[]>();
    for (const raw of statuses) {
      if (!raw) continue;
      try {
        for (const f of (JSON.parse(raw) as { feeds?: FeedEntry[] }).feeds ?? [])
          feeds.set(f.instrumentId, [...(feeds.get(f.instrumentId) ?? []), f]);
      } catch {
        // A malformed status counts as no status: orders wait.
      }
    }
    const next = new Map<string, Health>();
    for (const i of this.instruments.values())
      next.set(
        i.instrumentId,
        practiceHealth({
          enabled: i.enabled,
          venueStatus: i.venueStatus,
          feeds: feeds.get(i.instrumentId) ?? [],
          openGaps: gaps.get(i.instrumentId) ?? [],
        }),
      );
    this.health = next;
  }

  info(instrumentId: string): InstrumentInfo | undefined {
    return this.instruments.get(instrumentId);
  }

  /** Every practice pair's order rules, as the engine uses them (journalled with its inputs). */
  rulesList(): InstrumentRules[] {
    return [...this.instruments.values()]
      .filter((i) => i.role === 'monitored')
      .map((i) => ({
        instrumentId: i.instrumentId,
        venue: i.venue,
        base: i.base,
        quote: i.quote,
        priceTick: i.priceTick,
        qtyStep: i.qtyStep,
        minNotional: i.minNotional,
      }))
      .sort((a, b) => (a.instrumentId < b.instrumentId ? -1 : 1));
  }

  /** Order rules for a pair practice orders may use: monitored, not a reference pair. */
  rules(instrumentId: string): InstrumentRules | undefined {
    const i = this.instruments.get(instrumentId);
    return i?.role === 'monitored' ? i : undefined;
  }

  healthOf(instrumentId: string): Health {
    return this.health.get(instrumentId) ?? 'data_delayed';
  }

  /** The trade streams to read: every enabled monitored pair. */
  tradeInstruments(): string[] {
    return [...this.instruments.values()]
      .filter((i) => i.role === 'monitored' && i.enabled)
      .map((i) => i.instrumentId)
      .sort();
  }

  streamOf(instrumentId: string): string {
    return tradesStream(instrumentId);
  }

  /** The latest book the ingestor keeps, or null when it has none (not live). */
  async book(instrumentId: string): Promise<Book | null> {
    const raw = await this.redis.get(channels.book(instrumentId));
    if (!raw) return null;
    try {
      const b = JSON.parse(raw) as { ts: number; bids: [string, string][]; asks: [string, string][] };
      return { instrumentId, ts: b.ts, bids: b.bids, asks: b.asks };
    } catch {
      return null;
    }
  }
}
