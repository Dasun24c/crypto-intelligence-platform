import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { v5 as uuidv5 } from 'uuid';
import {
  ANALYSIS_EVENTS_STREAM,
  type AiJob,
  type AiTrigger,
  type AiTriggerRef,
  IndicatorsClosedEventSchema,
  ProfileParamsSchema,
  SetupTransitionMessageSchema,
  type SmcEventMessage,
  type Tf,
} from '@cip/contracts';
import type { Database } from '@cip/db';
import {
  type AnalysisEventEntry,
  DIGEST_SCORE,
  digestJobId,
  digestSlot,
  eventJobId,
  scoreEvent,
  TRIGGER_COOLDOWN_MS,
  TriggerAggregator,
} from '@cip/ai';
import { FencedLease, LEASE_RENEW_MS, type Logger } from '@cip/observability';
import type { AiStore } from './store.js';

export const TRIGGERS_LEASE = 'lease:ai-triggers';
/** Where the follower is in `an:events` (held before any open window's first event). */
export const TRIGGERS_CURSOR_KEY = 'ai:triggers:cursor';
/** The last 4-hourly digest slot queued. */
export const DIGEST_SLOT_KEY = 'ai:digest:slot';
/** Until when (epoch ms) an instrument cools down after an event analysis. */
export const cooldownKey = (instrumentId: string) => `ai:cooldown:${instrumentId}`;

const TICK_MS = 1_000;
const INSTRUMENTS_EVERY_MS = 5 * 60_000;
/** Names the analyses the follower queues, so one read twice is queued and stored once. */
const ANALYSIS_NAMESPACE = '6f1d4c1e-5b7a-4c39-9a51-3a1c2f0e9d47';

/** The analysis id of a queued trigger: the same job id always gives the same id. */
export const analysisIdOf = (jobId: string) => uuidv5(jobId, ANALYSIS_NAMESPACE);

const ms = (id: string) => Number(id.split('-')[0]);
/** Stream ids in order: milliseconds, then sequence. */
export function compareIds(a: string, b: string): number {
  const [am, as = '0'] = a.split('-');
  const [bm, bs = '0'] = b.split('-');
  return Number(am) - Number(bm) || Number(as) - Number(bs);
}

export interface TriggerFollowerOptions {
  db: Kysely<Database>;
  /** For state and the queue's announcements. */
  redis: Redis;
  /** A second connection for blocking stream reads. */
  reader: Redis;
  queue: Pick<Queue<AiJob>, 'add'>;
  store: AiStore;
  log: Logger;
  instance: string;
  hasKey: () => boolean;
  /** Tells the `ai` channel a job was queued. */
  announce: (job: AiJob) => Promise<void>;
  now?: () => number;
  blockMs?: number;
}

interface Watched {
  contextTfs: Tf[];
  digest: boolean;
}

/**
 * The significance follower (architecture §8, ADR 023): one instance holds `lease:ai-triggers`,
 * reads `an:events`, scores each event, gathers an instrument's events in 60 s windows and queues
 * one `event` analysis for a window scoring 100 or more (then a 15 min cooldown); every 4 hours it
 * queues a digest per monitored instrument. Nothing is queued while analyses are switched off or
 * there is no key. Windows open at the event's stream time, so a window read again after a takeover
 * gets the same job id and is not queued twice.
 */
export class AiTriggerFollower {
  private readonly lease: FencedLease;
  private readonly now: () => number;
  private aggregator = new TriggerAggregator();
  private watched = new Map<string, Watched>();
  /** The stream id just before each open window's first event. */
  private windowFrom = new Map<string, string>();
  private cursor = '0-0';
  private timers: NodeJS.Timeout[] = [];
  private loop: Promise<void> | null = null;
  private active = false;
  private stopping = false;
  private ticking = false;
  private instrumentsAt = -Infinity;
  /** Analyses queued since start, by trigger. */
  readonly queued: Record<'event' | 'digest', number> = { event: 0, digest: 0 };
  lastError: string | null = null;

  constructor(private readonly o: TriggerFollowerOptions) {
    this.lease = new FencedLease(o.redis, TRIGGERS_LEASE, o.instance);
    this.now = o.now ?? Date.now;
  }

  get holding(): boolean {
    return this.active;
  }

  /** The last `an:events` id read. */
  get position(): string {
    return this.cursor;
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.leaseTick();
    this.timers.push(
      setInterval(() => void this.leaseTick(), LEASE_RENEW_MS),
      setInterval(() => void this.tick(), TICK_MS),
    );
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.active = false;
    await this.loop;
    await this.lease.release().catch(() => undefined);
  }

  /** Closes due windows and queues their analyses, and the digests when a new slot began. */
  async tick(): Promise<void> {
    if (!this.active || this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      if (now - this.instrumentsAt >= INSTRUMENTS_EVERY_MS) await this.loadInstruments(now);
      for (const due of this.aggregator.due(now)) {
        this.windowFrom.delete(due.instrumentId);
        await this.o.redis.set(
          cooldownKey(due.instrumentId),
          String(now + TRIGGER_COOLDOWN_MS),
          'PX',
          TRIGGER_COOLDOWN_MS,
        );
        await this.enqueue('event', eventJobId(due.instrumentId, due.windowStart), {
          instrumentId: due.instrumentId,
          score: due.score,
          refs: due.refs,
        });
      }
      for (const id of [...this.windowFrom.keys()])
        if (!this.aggregator.isOpen(id)) this.windowFrom.delete(id);
      await this.digests(now);
      this.lastError = null;
    } catch (err) {
      this.lastError = 'queueing AI analyses failed';
      this.o.log.warn({ err }, 'AI trigger tick failed');
    } finally {
      this.ticking = false;
    }
  }

  // ----- the lease -----

  private async leaseTick(): Promise<void> {
    if (this.stopping) return;
    try {
      const held = await this.lease.refresh();
      if (held && !this.active) await this.takeOver();
      else if (!held && this.active) {
        this.active = false;
        this.o.log.warn('AI trigger lease lost');
      }
    } catch (err) {
      this.active = false;
      this.lastError = 'AI trigger lease check failed';
      this.o.log.warn({ err }, 'AI trigger lease check failed');
    }
  }

  private async takeOver(): Promise<void> {
    const now = this.now();
    await this.loadInstruments(now);
    this.aggregator = new TriggerAggregator();
    this.windowFrom.clear();
    for (const id of this.watched.keys()) {
      const until = Number((await this.o.redis.get(cooldownKey(id))) ?? 0);
      if (until > now) this.aggregator.coolDown(id, until);
    }
    // The first time it starts at the end: earlier events are history, not news.
    const saved = await this.o.redis.get(TRIGGERS_CURSOR_KEY);
    this.cursor = saved ?? (await this.streamEnd());
    if (!saved) await this.o.redis.set(TRIGGERS_CURSOR_KEY, this.cursor);
    this.active = true;
    this.o.log.info({ cursor: this.cursor, instruments: this.watched.size }, 'AI trigger follower active');
    this.loop = this.run();
  }

  private async streamEnd(): Promise<string> {
    const last = await this.o.redis.xrevrange(ANALYSIS_EVENTS_STREAM, '+', '-', 'COUNT', 1);
    return last[0]?.[0] ?? '0-0';
  }

  // ----- reading `an:events` -----

  /** Reads until the lease is lost or the service stops; never rejects (a failed pass waits, then retries). */
  private async run(): Promise<void> {
    while (this.active && !this.stopping) {
      try {
        await this.readOnce();
      } catch (err) {
        this.lastError = 'reading an:events failed';
        this.o.log.warn({ err }, 'reading an:events failed');
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
  }

  private async readOnce(): Promise<void> {
    const res: [string, [string, string[]][]][] | null = await this.o.reader.xread(
      'COUNT',
      500,
      'BLOCK',
      this.o.blockMs ?? 1_000,
      'STREAMS',
      ANALYSIS_EVENTS_STREAM,
      this.cursor,
    );
    if (!res || !this.active) return;
    for (const [id, fields] of res[0]?.[1] ?? []) {
      const before = this.cursor;
      this.cursor = id;
      const entry = parseEntry(fields);
      if (!entry) continue;
      const scored = scoreEvent(entry, (instrumentId) => this.watched.get(instrumentId)?.contextTfs ?? []);
      if (!scored || !this.watched.has(scored.instrumentId)) continue;
      if (this.aggregator.add(scored, ms(id)) === 'opened') this.windowFrom.set(scored.instrumentId, before);
    }
    // Kept before the earliest open window, so a takeover reads that window's events again.
    const held = [...this.windowFrom.values()].reduce((a, b) => (compareIds(a, b) <= 0 ? a : b), this.cursor);
    await this.o.redis.set(TRIGGERS_CURSOR_KEY, held);
  }

  // ----- queueing -----

  private async digests(now: number): Promise<void> {
    const slot = digestSlot(now);
    const last = await this.o.redis.get(DIGEST_SLOT_KEY);
    // The first digest comes at the next slot: starting up is not a reason to spend.
    if (last === null) {
      await this.o.redis.set(DIGEST_SLOT_KEY, String(slot));
      return;
    }
    if (Number(last) >= slot) return;
    await this.o.redis.set(DIGEST_SLOT_KEY, String(slot));
    for (const [instrumentId, w] of this.watched)
      if (w.digest)
        await this.enqueue('digest', digestJobId(instrumentId, slot), {
          instrumentId,
          score: DIGEST_SCORE,
          refs: [{ kind: 'digest', id: String(slot), score: DIGEST_SCORE, at: slot }],
        });
  }

  private async enqueue(
    trigger: Extract<AiTrigger, 'event' | 'digest'>,
    jobId: string,
    t: { instrumentId: string; score: number; refs: AiTriggerRef[] },
  ): Promise<void> {
    const settings = await this.o.store.settings();
    if (!settings.enabled || !this.o.hasKey()) {
      this.o.log.debug(
        { jobId, enabled: settings.enabled },
        'AI analysis not queued: switched off or no key',
      );
      return;
    }
    const job: AiJob = {
      analysisId: analysisIdOf(jobId),
      trigger,
      instrumentId: t.instrumentId,
      score: t.score,
      triggerRefs: t.refs,
      requestedBy: null,
      reason: null,
      setupId: null,
      queuedAt: this.now(),
    };
    await this.o.queue.add(trigger, job, {
      jobId,
      attempts: 1,
      removeOnComplete: { age: 24 * 3_600, count: 1_000 },
      removeOnFail: { age: 7 * 24 * 3_600 },
    });
    this.queued[trigger]++;
    await this.o.announce(job);
  }

  /**
   * The enabled instruments with an analysis profile: their context timeframes (an MSS there
   * scores), and whether they get a digest (monitored, on their primary venue).
   */
  private async loadInstruments(now: number): Promise<void> {
    const rows = await this.o.db
      .selectFrom('market.instruments as i')
      .innerJoin('market.instrument_profiles as p', 'p.id', 'i.profile_id')
      .select(['i.id', 'i.role', 'i.is_primary_venue', 'p.params'])
      .where('i.enabled', '=', true)
      .execute();
    const watched = new Map<string, Watched>();
    for (const r of rows) {
      const parsed = ProfileParamsSchema.safeParse(r.params);
      const pairs = parsed.success ? (parsed.data.smc?.timeframePairs ?? []) : [];
      watched.set(r.id, {
        contextTfs: [...new Set(pairs.map((p) => p.context))],
        digest: r.role === 'monitored' && r.is_primary_venue,
      });
    }
    this.watched = watched;
    this.instrumentsAt = now;
  }
}

/** An `an:events` entry the scoring understands, or null. */
export function parseEntry(fields: string[]): AnalysisEventEntry | null {
  const f: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) f[fields[i]!] = fields[i + 1]!;
  let data: unknown;
  try {
    data = JSON.parse(f['data'] ?? '');
  } catch {
    return null;
  }
  switch (f['type']) {
    case 'setup': {
      const p = SetupTransitionMessageSchema.safeParse(data);
      return p.success ? { type: 'setup', data: p.data } : null;
    }
    case 'smc': {
      const m = data as Partial<SmcEventMessage> | null;
      if (
        !m ||
        typeof m.instrumentId !== 'string' ||
        typeof m.type !== 'string' ||
        typeof m.time !== 'number'
      )
        return null;
      if (!m.data || typeof m.data !== 'object') return null;
      return { type: 'smc', data: m as SmcEventMessage };
    }
    case 'indicators.closed': {
      const p = IndicatorsClosedEventSchema.safeParse(data);
      return p.success ? { type: 'indicators.closed', data: p.data } : null;
    }
    default:
      return null;
  }
}
