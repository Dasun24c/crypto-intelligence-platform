import type { Redis } from 'ioredis';

const RENEW = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

/** Leases last 15 s and are renewed every 5 s (architecture §6, leases). */
export const LEASE_TTL_MS = 15_000;

/**
 * One analyzer per instrument (`lease:analyzer:{instrumentId}`): whoever holds the lease runs the
 * instrument's actor, so a standby instance takes over within the TTL when the holder dies.
 * Writes are idempotent and a run's values are deterministic, so a brief overlap between an old and
 * a new holder can only write the same values twice. Fencing epochs arrive with the Phase 4
 * checkpoints, which are not idempotent.
 */
export class InstrumentLease {
  held = false;
  private readonly key: string;

  constructor(
    private readonly redis: Redis,
    instrumentId: string,
    private readonly owner: string,
  ) {
    this.key = `lease:analyzer:${instrumentId}`;
  }

  /** Renews a held lease or takes a free one; returns whether it is held now. */
  async refresh(): Promise<boolean> {
    if (this.held)
      this.held = (await this.redis.eval(RENEW, 1, this.key, this.owner, String(LEASE_TTL_MS))) === 1;
    if (!this.held)
      this.held = (await this.redis.set(this.key, this.owner, 'PX', LEASE_TTL_MS, 'NX')) === 'OK';
    return this.held;
  }

  async release(): Promise<void> {
    if (this.held) await this.redis.eval(RELEASE, 1, this.key, this.owner);
    this.held = false;
  }
}
