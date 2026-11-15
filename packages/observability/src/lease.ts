import type { Redis } from 'ioredis';

const RENEW = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
/** The next epoch, at least `ARGV[1]` + 1 (a store that lost the counter must not reuse an epoch). */
const BUMP = `local v = redis.call('INCR', KEYS[1])
if v <= tonumber(ARGV[1]) then v = tonumber(ARGV[1]) + 1; redis.call('SET', KEYS[1], v) end
return v`;

/** Leases last 15 s and are renewed every 5 s (architecture §6, leases). */
export const LEASE_TTL_MS = 15_000;
export const LEASE_RENEW_MS = 5_000;

/**
 * A single-holder lease in Valkey (`key`): whoever holds it does the work, and a standby instance
 * takes over within the TTL when the holder dies. Used by the analyzer (per instrument, and for the
 * global alert sources) and by the broker (practice trading, ADR 021).
 *
 * Each acquisition gets a fencing epoch, larger than every earlier one (`{key}:epoch`, a counter
 * that never expires). Writers record the epoch with what they write and refuse to write once a
 * newer epoch holds it, so a holder that stalled past its TTL cannot overwrite the work of the one
 * that took over (architecture §6).
 */
export class FencedLease {
  held = false;
  /** The fencing epoch of the current holding; null when not held. */
  epoch: number | null = null;

  constructor(
    private readonly redis: Redis,
    readonly key: string,
    private readonly owner: string,
  ) {}

  /** Renews a held lease or takes a free one; returns whether it is held now. */
  async refresh(): Promise<boolean> {
    if (this.held)
      this.held = (await this.redis.eval(RENEW, 1, this.key, this.owner, String(LEASE_TTL_MS))) === 1;
    if (!this.held) {
      this.epoch = null;
      this.held = (await this.redis.set(this.key, this.owner, 'PX', LEASE_TTL_MS, 'NX')) === 'OK';
      if (this.held) this.epoch = await this.bump(0);
    }
    return this.held;
  }

  /**
   * Moves to an epoch above `atLeast` (one found stored with the work). Safe while the lease is
   * held: nobody else can be taking an epoch.
   */
  async bump(atLeast: number): Promise<number> {
    this.epoch = Number(await this.redis.eval(BUMP, 1, `${this.key}:epoch`, String(atLeast)));
    return this.epoch;
  }

  async release(): Promise<void> {
    if (this.held) await this.redis.eval(RELEASE, 1, this.key, this.owner);
    this.held = false;
    this.epoch = null;
  }
}
