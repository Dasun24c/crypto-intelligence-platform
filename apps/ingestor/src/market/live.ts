import type { Redis } from 'ioredis';
import type { Envelope } from '@cip/contracts';
import type { Logger } from '@cip/observability';

/**
 * Non-durable live channels (ticker, book, candles in progress, spread) leave the ingestor over
 * Redis pub/sub as `live:{channel}` envelopes. Every API instance subscribes to `live:*` and
 * forwards each message to its own sockets in that channel's room (ADR 014). Nothing is kept:
 * a client that missed one simply gets the next, or a snapshot when it subscribes.
 */
export const LIVE_PREFIX = 'live:';

export class LivePublisher {
  published = 0;
  failed = 0;

  constructor(
    private readonly redis: Redis,
    private readonly log: Logger,
  ) {}

  publish<T>(ch: string, type: string, data: T, ts = Date.now()): void {
    const envelope: Envelope<T> = { ch, ts, type, data };
    this.published++;
    this.redis.publish(LIVE_PREFIX + ch, JSON.stringify(envelope)).catch((err: unknown) => {
      if (this.failed++ % 1_000 === 0) this.log.warn({ err, ch }, 'live publish failed');
    });
  }
}
