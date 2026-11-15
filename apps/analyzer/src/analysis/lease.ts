import type { Redis } from 'ioredis';
import { FencedLease } from '@cip/observability';

export { LEASE_RENEW_MS, LEASE_TTL_MS } from '@cip/observability';

/**
 * One analyzer per instrument (`lease:analyzer:{instrumentId}`): whoever holds the lease runs the
 * instrument's actor, so a standby instance takes over within the TTL when the holder dies. A run's
 * checkpoint records the epoch that wrote it, and the analyzer writes only while no newer epoch
 * holds the run (architecture §6). The lease itself is `FencedLease` (`@cip/observability`).
 */
export class InstrumentLease extends FencedLease {
  constructor(redis: Redis, instrumentId: string, owner: string) {
    super(redis, `lease:analyzer:${instrumentId}`, owner);
  }
}
