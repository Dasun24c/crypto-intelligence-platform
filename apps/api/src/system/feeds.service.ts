import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { FeedStatus } from '@cip/contracts';
import { MarketRepository } from '../market/market.repository.js';
import { REDIS } from '../tokens.js';

type Stream = FeedStatus['stream'];

/** The streams each venue's health is judged on (the ingestor's pipelines watch the same). */
const EXPECTED: Record<'binance' | 'coinbase', Stream[]> = {
  binance: ['kline', 'trades', 'depth', 'ticker'],
  coinbase: ['trades', 'depth', 'ticker'],
};

/**
 * Feed status for System Health (architecture §5.4, §16): what the venue lease holders report in
 * `feed:status:{venue}` (15 s TTL), with open gaps counted from the database. Every enabled
 * instrument appears: one the ingestor does not report is "not streaming", never silently missing.
 */
@Injectable()
export class FeedsService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly market: MarketRepository,
  ) {}

  async feeds(): Promise<FeedStatus[]> {
    const [instruments, gaps, raw] = await Promise.all([
      this.market.instruments({ includeDisabled: false }),
      this.market.openGapCounts(),
      this.redis.mget('feed:status:binance', 'feed:status:coinbase', 'feed:status:replay'),
    ]);
    const live = new Map<string, Omit<FeedStatus, 'openGaps'>>();
    for (const value of raw) {
      if (!value) continue;
      for (const f of (JSON.parse(value) as { feeds: Omit<FeedStatus, 'openGaps'>[] }).feeds)
        live.set(`${f.instrumentId}:${f.stream}`, f);
    }
    const out: FeedStatus[] = [];
    for (const i of instruments) {
      // A replay instrument streams like the venue it was recorded from (Coinbase symbols have a dash).
      const format = i.venue === 'replay' ? (i.venueSymbol.includes('-') ? 'coinbase' : 'binance') : i.venue;
      for (const stream of EXPECTED[format]) {
        const key = `${i.id}:${stream}`;
        // Coinbase candles are built from trades, so its candle-history gaps count against trades.
        const openGaps =
          (gaps.get(key) ?? 0) +
          (format === 'coinbase' && stream === 'trades' ? (gaps.get(`${i.id}:kline`) ?? 0) : 0);
        const f = live.get(key);
        if (i.venueStatus === 'halted' || i.venueStatus === 'delisted')
          out.push(down(i.id, stream, openGaps, i.venueStatus, f?.lastMessageAt ?? null));
        else if (f) out.push({ ...f, openGaps });
        else out.push(down(i.id, stream, openGaps, 'not streaming', null));
      }
    }
    return out;
  }
}

function down(
  instrumentId: string,
  stream: Stream,
  openGaps: number,
  detail: string,
  lastMessageAt: number | null,
): FeedStatus {
  return {
    instrumentId,
    stream,
    state: 'disconnected',
    lastMessageAt,
    lagMsP50: null,
    lagMsP95: null,
    openGaps,
    detail,
  };
}
