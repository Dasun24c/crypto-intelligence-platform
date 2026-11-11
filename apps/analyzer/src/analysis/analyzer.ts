import type { Meter } from '@opentelemetry/api';
import { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { type AnalysisStatus, analysisStatusKey } from '@cip/contracts';
import type { Database } from '@cip/db';
import type { Timeframe } from '@cip/domain';
import type { HeartbeatProbe, Logger } from '@cip/observability';
import { InstrumentActor } from './actor.js';
import { InstrumentLease, LEASE_TTL_MS } from './lease.js';
import { AnalysisRepository } from './repository.js';

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
  private readonly held = new Map<string, Held>();
  private readonly cursors = new Map<string, string>();
  private readonly statuses = new Map<string, AnalysisStatus>();
  private reader: Redis | null = null;
  private timer: NodeJS.Timeout | undefined;
  private following: Promise<void> = Promise.resolve();
  private ticking: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly onPublished: (tf: Timeframe, lagMs: number) => void;

  constructor(private readonly o: AnalyzerOptions) {
    this.repo = new AnalysisRepository(o.db);
    const histogram = o.meter?.createHistogram('cip_analysis_publish_lag_ms', {
      description: 'Candle close to indicators published (criterion 3.5)',
      unit: 'ms',
    });
    this.onPublished = (tf, lagMs) => histogram?.record(lagMs, { tf });
  }

  async start(): Promise<void> {
    this.reader = new Redis(this.o.redisUrl, {
      connectionName: 'cip-analyzer-wakeups',
      maxRetriesPerRequest: null,
    });
    await this.tick();
    this.timer = setInterval(() => {
      this.ticking = this.tick().catch((err: unknown) => this.o.log.error({ err }, 'analyzer tick failed'));
    }, this.o.tickMs ?? 5_000);
    this.following = this.follow();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.reader?.disconnect();
    await this.following;
    await this.ticking;
    for (const { actor, lease } of this.held.values()) {
      await actor.wake().catch(() => undefined);
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
      detail: `analysing ${this.held.size} instruments: ${warming} warming up, ${gaps} paused on a data gap`,
    };
  }

  /** Renews leases, follows profile changes, retries each actor and publishes its state. */
  async tick(): Promise<void> {
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
      let h = this.held.get(instrument.id);
      const lease = h?.lease ?? new InstrumentLease(this.o.redis, instrument.id, this.o.instance);
      if (!(await lease.refresh())) {
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
            redis: this.o.redis,
            log: this.o.log,
            now: this.o.now,
            onPublished: this.onPublished,
          }),
        };
        this.held.set(instrument.id, h);
        await this.positionCursor(instrument.id);
        this.o.log.info({ instrument: instrument.symbol }, 'analyzer lease taken');
      }
      h.actor.update(instrument);
      await h.actor.wake();
      const status = await h.actor.status();
      if (status) {
        this.statuses.set(instrument.id, status);
        await this.o.redis.set(analysisStatusKey(instrument.id), JSON.stringify(status), 'PX', LEASE_TTL_MS);
      }
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
