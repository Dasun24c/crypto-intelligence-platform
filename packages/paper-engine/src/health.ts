import type { Health } from './types.js';

/** What the platform knows about an instrument's market data (ADR 021, TRD-07). */
export interface HealthInput {
  enabled: boolean;
  venueStatus: 'trading' | 'halted' | 'delisted' | 'unknown';
  /** The instrument's entries in `feed:status:{venue}`; none when the ingestor is not reporting. */
  feeds: readonly { stream: string; state: 'connected' | 'degraded' | 'disconnected' }[];
  /** Streams with an open gap (`market.data_gaps` status `open` or `backfilling`). */
  openGaps: readonly string[];
}

/** The streams practice fills come from: trades for resting orders, the book for the rest. */
const FILL_STREAMS = ['trades', 'depth'] as const;

/**
 * Whether practice orders may be taken up and filled on an instrument, and if not why: a disabled,
 * halted or delisted pair; a gap in its trades or book; or trades or book not streaming, silent or
 * delayed (`degraded`, as the ingestor reports a median lag above 2 s). The api checks it before
 * accepting an order and the broker before every fill.
 */
export function practiceHealth(input: HealthInput): Health {
  if (!input.enabled || input.venueStatus === 'halted' || input.venueStatus === 'delisted')
    return 'pair_halted';
  if (FILL_STREAMS.some((s) => input.openGaps.includes(s))) return 'data_gap';
  for (const stream of FILL_STREAMS) {
    const feed = input.feeds.find((f) => f.stream === stream);
    if (!feed || feed.state !== 'connected') return 'data_delayed';
  }
  return 'ok';
}
