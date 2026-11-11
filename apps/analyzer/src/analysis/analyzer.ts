import type { Meter } from '@opentelemetry/api';
import { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { type AnalysisStatus, analysisStatusKey } from '@cip/contracts';
import type { Database } from '@cip/db';
import type { Timeframe } from '@cip/domain';
import type { HeartbeatProbe, Logger } from '@cip/observability';
import { InstrumentActor } from './actor.js';
import { InstrumentLease, LEASE_RENEW_MS, LEASE_TTL_MS } from './lease.js';
import { AnalysisRepository } from './repository.js';
import { SmcStore } from './smc-store.js';

/** The ingestor's wake-up stream for one instrument (architecture §6). */
export const candleStream = (instrumentId: string) => `md:candles:${instrumentId}`;

export interface AnalyzerOptions {
  db: Kysely<Database>;
  redis: Redis;
  /** For the connection that blocks on the wake-up streams. */
  redisUrl: string;
  log: Logger;
  meter?: Meter;
  instance: string;
  /** Leases, instrument changes, retries and status (default 5 s). */
  tickMs?: number;
  /** Lease renewal, on its own timer (default 5 s; the TTL is 15 s). */
  leaseRenewMs?: number;
  /** How long one blocking read of the wake-up streams waits (default 2 s). */
  blockMs?: number;
  now?: () => number;
}

interface Held {
  actor: InstrumentActor;
  lease: InstrumentLease;
}

/**
 * The analyzer service's work (architecture §7): one actor per instrument whose lease this
 * instance holds. A candle close announced on `md:candles:{id}` wakes that instrument's actor at
 * once; every few seconds each actor is also woken to retry paused timeframes, leases are renewed,
 * profile changes are picked up and each instrument's state is published for System Health.
 */
export class Analyzer {
  private readonly repo: AnalysisRepository;
  private readonly store: SmcStore;
  private readonly held = new Map<string, Held>();
  private readonly cursors = new Map<string, string>();
  private readonly statuses = new Map<string, AnalysisStatus>();
  private reader: Redis | null = null;
  private timer: NodeJS.Timeout | undefined;
  private leaseTimer: NodeJS.Timeout | undefined;
  private leasing: Promise<void> | null = null;
  private following: Promise<void> = Promise.resolve();
  private ticking: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly onPublished: (kind: 'indicators' | 'smc', tf: Timeframe, lagMs: number) => void;
  private readonly onStep: (ms: number) => void;
  /** The latest engine step times, for the step p95 the probe reports (criterion 4.6). */
  private readonly steps = new RecentValues(4_096);

  constructor(private readonly o: AnalyzerOptions) {
    this.repo = new AnalysisRepository(o.db);
    this.store = new SmcStore(o.db);
    const histogram = o.meter?.createHistogram('cip_analysis_publish_lag_ms', {
      description: 'Candle close to indicators or SMC detections published (criteria 3.5, 4.6)',
      unit: 'ms',
    });
    this.onPublished = (kind, tf, lagMs) => histogram?.record(lagMs, { kind, tf });
    const steps = o.meter?.createHistogram('cip_smc_step_ms', {
      description: 'SMC engine time per boundary (criterion 4.6: p95 at most 2 ms)',
      unit: 'ms',
    });
    this.onStep = (ms) => {
      steps?.record(ms);
      this.steps.add(ms);
    };
  }

  async start(): Promise<void> {
    this.reader = new Redis(this.o.redisUrl, {
      connectionName: 'cip-analyzer-wakeups',
      maxRetriesPerRequest: null,
    });
    // Leases are renewed on their own timer: analysis (a warm-up can take a minute) never delays them.
    this.leaseTimer = setInterval(() => {
      if (this.leasing) return; // a pass is under way
      this.renewLeases().catch((err: unknown) => this.o.log.error({ err }, 'lease renewal failed'));
    }, this.o.leaseRenewMs ?? LEASE_RENEW_MS);
    await this.tick();
    this.timer = setInterval(() => {
      this.ticking = this.tick().catch((err: unknown) => this.o.log.error({ err }, 'analyzer tick failed'));
    }, this.o.tickMs ?? 5_000);
    this.following = this.follow();
  }

  /**
   * Stops the analysis. Gracefully (the default) every actor writes a checkpoint and releases its
   * lease; otherwise nothing is written or released, as when the process is killed (tests of
   * criterion 4.4), and a standby takes over once the leases expire.
   */
  async stop(opts: { graceful?: boolean } = {}): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.leaseTimer);
    this.reader?.disconnect();
    await this.following;
    await this.ticking;
    await this.leasing?.catch(() => undefined);
    if (opts.graceful === false) {
      for (const { actor } of this.held.values()) await actor.idle();
      this.held.clear();
      return;
    }
    for (const { actor, lease } of this.held.values()) {
      await actor.wake().catch(() => undefined);
      // A checkpoint now: the next holder resumes here rather than at the last one.
      await actor.shutdown().catch((err: unknown) => this.o.log.error({ err }, 'shutdown checkpoint failed'));
      await lease.release().catch(() => undefined);
    }
    this.held.clear();
  }

  /** Instruments analysed here, for tests and the probe. */
  get instrumentIds(): string[] {
    return [...this.held.keys()];
  }

  probe(): HeartbeatProbe {
    if (this.held.size === 0) return { status: 'ok', detail: 'standby: no instrument leases held' };
    const all = [...this.statuses.values()];
    const warming = all.filter((s) => s.pauseReason === 'warming_up').length;
    const gaps = all.filter((s) => s.pauseReason === 'data_gap').length;
    return {
      status: gaps > 0 ? 'degraded' : 'ok',
      detail:
        `analysing ${this.held.size} instruments: ${warming} warming up, ${gaps} paused on a data gap` +
        this.steps.describe('SMC step'),
    };
  }

  /** Renews leases and follows instrument changes, then retries each actor and publishes its state. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    await this.renewLeases();
    for (const [id, h] of [...this.held]) {
      await h.actor.wake();
      // Dropped meanwhile (lease lost, instrument disabled): its state is no longer ours to publish.
      if (this.held.get(id) !== h) continue;
      const status = await h.actor.status();
      if (status) {
        this.statuses.set(id, status);
        await this.o.redis.set(analysisStatusKey(id), JSON.stringify(status), 'PX', LEASE_TTL_MS);
      }
    }
  }

  /**
   * Renews held leases, takes free ones (creating their actors) and drops lost ones; follows profile
   * changes and disabled instruments. Never waits for analysis; one pass at a time.
   */
  renewLeases(): Promise<void> {
    // A fresh pass after the one in progress, which may have started before a lease was freed.
    const pass = (this.leasing ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.leasePass())
      .finally(() => {
        if (this.leasing === pass) this.leasing = null;
      });
    this.leasing = pass;
    return pass;
  }

  private async leasePass(): Promise<void> {
    if (this.stopped) return;
    const instruments = await this.repo.instruments();
    const listed = new Set(instruments.map((i) => i.id));
    for (const [id, h] of this.held) {
      if (listed.has(id)) continue;
      // Disabled, or its profile removed: stop analysing; the run stays open for when it returns.
      await h.lease.release();
      this.held.delete(id);
      this.statuses.delete(id);
    }
    for (const instrument of instruments) {
      if (this.stopped) return;
      let h = this.held.get(instrument.id);
      const lease = h?.lease ?? new InstrumentLease(this.o.redis, instrument.id, this.o.instance);
      if (!(await lease.refresh()) || h?.actor.leaseLost) {
        if (h?.actor.leaseLost) await lease.release();
        if (h) {
          this.o.log.warn({ instrument: instrument.symbol }, 'analyzer lease lost to another instance');
          this.held.delete(instrument.id);
          this.statuses.delete(instrument.id);
        }
        continue;
      }
      if (!h) {
        h = {
          lease,
          actor: new InstrumentActor(instrument, {
            repo: this.repo,
            store: this.store,
            redis: this.o.redis,
            log: this.o.log,
            lease,
            now: this.o.now,
            onPublished: this.onPublished,
            onStep: this.onStep,
          }),
        };
        this.held.set(instrument.id, h);
        await this.positionCursor(instrument.id);
        this.o.log.info({ instrument: instrument.symbol, epoch: lease.epoch }, 'analyzer lease taken');
      }
      h.actor.update(instrument);
    }
  }

  /** Starts following an instrument's wake-ups from the entry that is last now. */
  private async positionCursor(instrumentId: string): Promise<void> {
    const key = candleStream(instrumentId);
    const last = await this.o.redis.xrevrange(key, '+', '-', 'COUNT', 1);
    this.cursors.set(key, last[0]?.[0] ?? '0-0');
  }

  private async follow(): Promise<void> {
    while (!this.stopped) {
      const keys = [...this.held.keys()].map(candleStream);
      if (keys.length === 0) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      let res: [string, [string, string[]][]][] | null;
      try {
        res = await this.reader!.xread(
          'BLOCK',
          this.o.blockMs ?? 2_000,
          'STREAMS',
          ...keys,
          ...keys.map((k) => this.cursors.get(k) ?? '$'),
        );
      } catch (err) {
        if (this.stopped) return;
        this.o.log.error({ err }, 'reading candle wake-ups failed');
        await new Promise((r) => setTimeout(r, 1_000));
        continue;
      }
      for (const [key, entries] of res ?? []) {
        const last = entries.at(-1);
        if (!last) continue;
        this.cursors.set(key, last[0]);
        const instrumentId = key.slice('md:candles:'.length);
        // The latest boundary covers every earlier one; a backfill wake-up has none.
        let boundary: number | undefined;
        for (const [, fields] of entries) {
          const f = Object.fromEntries(
            fields.flatMap((v, i) => (i % 2 === 0 ? [[v, fields[i + 1]]] : [])),
          ) as Record<string, string>;
          boundary = f['tfs'] === 'backfill' ? undefined : Math.max(boundary ?? 0, Number(f['boundary']));
          if (boundary === undefined) break;
        }
        void this.held.get(instrumentId)?.actor.wake(boundary);
      }
    }
  }
}

/** The last `size` values, for a percentile over recent work. */
export class RecentValues {
  private readonly values: Float64Array;
  private count = 0;

  constructor(size: number) {
    this.values = new Float64Array(size);
  }

  add(value: number): void {
    this.values[this.count % this.values.length] = value;
    this.count++;
  }

  /** The `q` quantile (nearest rank) of the values held, or null before the first. */
  quantile(q: number): number | null {
    const n = Math.min(this.count, this.values.length);
    if (n === 0) return null;
    const sorted = this.values.slice(0, n).sort();
    return sorted[Math.max(0, Math.ceil(q * n) - 1)]!;
  }

  /** `; <label> p95 0.09 ms over the last N`, or nothing before the first value. */
  describe(label: string): string {
    const p95 = this.quantile(0.95);
    if (p95 === null) return '';
    return `; ${label} p95 ${p95.toFixed(2)} ms over the last ${Math.min(this.count, this.values.length)}`;
  }
}
