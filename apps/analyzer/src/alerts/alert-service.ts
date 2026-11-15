import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import {
  type AlertSource,
  type AlertSourceKind,
  AlertEvaluator,
  type CooldownGate,
  decide,
  type InstrumentRef,
  ruleFromRow,
  SOURCE_OF,
} from '@cip/alerts';
import { type AlertRule, PRACTICE_EVENTS_STREAM, type Ticker } from '@cip/contracts';
import { activeAlertRules, alertRulesFingerprint, type Database, insertAlertEvent } from '@cip/db';
import { displayName } from '@cip/domain';
import type { Logger } from '@cip/observability';
import { InstrumentLease } from '../analysis/lease.js';
import {
  fromIndicator,
  fromMarketEvent,
  fromPracticeEvent,
  fromSetup,
  fromSmc,
  type Published,
  type ZoneFacts,
} from './alert-sources.js';

/** The jobs service's delivery queue, as the analyzer adds to it (BullMQ `Queue`). */
export interface DeliveryQueue {
  add(
    name: string,
    data: { eventId: string },
    opts: {
      jobId: string;
      attempts: number;
      backoff: { type: 'exponential'; delay: number };
      removeOnComplete: number;
      removeOnFail: number;
    },
  ): Promise<unknown>;
}

export interface AlertServiceOptions {
  db: Kysely<Database>;
  redis: Redis;
  queue: DeliveryQueue;
  log: Logger;
  instance: string;
  /** Instruments whose lease this instance holds: their prices and analysis are evaluated here. */
  held: () => readonly string[];
  now?: () => number;
  /** Price ticks and stream reads (default 1 s); rules, the lease and the clock every 5 s. */
  tickMs?: number;
}

/** Where the global evaluator has read `md:events` to, so a new lease holder carries on (ADR 020). */
export const MARKET_CURSOR_KEY = 'alerts:md-cursor';
/** The same for `practice:events`, the users' practice orders (ADR 021). */
export const PRACTICE_CURSOR_KEY = 'alerts:practice-cursor';
export const cooldownRedisKey = (key: string) => `alerts:cooldown:${key}`;
const SLOW_MS = 5_000;
const RELOAD_MS = 60_000;
const DAY_MS = 86_400_000;

/** A cooldown shared by every analyzer instance and kept across restarts. */
export class RedisCooldown implements CooldownGate {
  constructor(private readonly redis: Redis) {}

  async tryAcquire(key: string, _at: number, ms: number): Promise<boolean> {
    if (ms <= 0) return true;
    return (await this.redis.set(cooldownRedisKey(key), '1', 'PX', ms, 'NX')) === 'OK';
  }
}

/**
 * Evaluates users' alert rules (ADR 020) and hands fired alerts to the notifications queue.
 *
 * - The instruments this instance holds: their published analysis (from the actors) and their price
 *   (the `ticker:{id}` key, once a second).
 * - With `lease:analyzer:alerts`: `md:events` (feed health, gaps, large trades, walls),
 *   `practice:events` (practice fills, for their owners' rules), the stored PAXG spread, the economic
 *   calendar and the gold-market sessions.
 *
 * Work runs one item at a time, so the evaluator's memory (previous prices, edges) sees sources in order.
 */
export class AlertService {
  private readonly evaluator = new AlertEvaluator();
  private readonly gate: RedisCooldown;
  private readonly lease: InstrumentLease;
  private bySource = new Map<AlertSourceKind, AlertRule[]>();
  private fingerprint: string | null = null;
  private refs = new Map<string, InstrumentRef>();
  private refsAt = 0;
  private readonly zones = new Map<string, ZoneFacts>();
  private readonly tickerTs = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private lastSlow = 0;
  /** Where this lease holder has read each stream to (`md:events`, `practice:events`). */
  private readonly cursors = new Map<string, string>();
  private spreadAfter = 0;
  private calendar: { at: number; events: Extract<AlertSource, { kind: 'economic_event' }>['event'][] } = {
    at: 0,
    events: [],
  };
  private closures: { at: number; list: { startsAt: number; endsAt: number }[] } = { at: 0, list: [] };
  private goldClosed: boolean | null = null;
  private stopped = false;

  constructor(private readonly o: AlertServiceOptions) {
    this.gate = new RedisCooldown(o.redis);
    this.lease = new InstrumentLease(o.redis, 'alerts', o.instance);
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  async start(): Promise<void> {
    await this.refreshRules();
    await this.refreshRefs();
    this.timer = setInterval(() => void this.tick(), this.o.tickMs ?? 1_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.chain;
    await this.lease.release().catch(() => undefined);
  }

  /** Whether this instance evaluates the global sources (for tests and the probe). */
  get global(): boolean {
    return this.lease.held;
  }

  /** Resolves once everything queued so far has been evaluated (tests). */
  idle(): Promise<void> {
    return this.chain;
  }

  /** What an actor just published (never warm-up or replays). */
  published(instrumentId: string, items: readonly Published[], processedAt: number): void {
    if (!items.length) return;
    this.enqueue(async () => {
      const ref = await this.ref(instrumentId);
      if (!ref) return;
      const sources: AlertSource[] = [];
      for (const p of items) {
        if (p.kind === 'indicators') sources.push(fromIndicator(ref, p.tf, p.point, processedAt));
        else if (p.kind === 'setup') sources.push(fromSetup(ref, p.message));
        else {
          if (p.message.type === 'zone.status') await this.loadZone((p.message.data as { id: string }).id);
          const s = fromSmc(ref, p.message, processedAt, (id) => this.zones.get(id) ?? null);
          if (s) sources.push(s);
        }
      }
      await this.evaluate(sources);
    });
  }

  /** One second's work; the slower parts every 5 s. */
  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      const now = this.now();
      const slow = now - this.lastSlow >= SLOW_MS;
      if (slow) {
        this.lastSlow = now;
        await this.refreshRules();
        if (now - this.refsAt >= RELOAD_MS) await this.refreshRefs();
        const was = this.lease.held;
        await this.lease.refresh();
        if (was && !this.lease.held) this.o.log.warn('alerts lease lost to another instance');
        if (!this.lease.held) {
          this.cursors.clear();
          this.goldClosed = null;
        }
      }
      this.enqueue(() => this.prices());
      if (this.lease.held) {
        this.enqueue(() => this.marketEvents());
        this.enqueue(() => this.practiceEvents());
        if (slow) this.enqueue(() => this.globalClock(now));
      }
      await this.chain;
    } catch (err) {
      this.o.log.error({ err }, 'alert evaluation failed');
    } finally {
      this.ticking = false;
    }
  }

  /** Runs `work` after everything queued before it. */
  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain
      .then(work)
      .catch((err: unknown) => this.o.log.error({ err }, 'alert evaluation failed'));
  }

  private async evaluate(sources: readonly AlertSource[]): Promise<void> {
    for (const source of sources) {
      const rules = this.bySource.get(source.kind) ?? [];
      for (const { rule, match } of this.evaluator.evaluate(rules, source)) {
        if ((await decide(rule, match, this.evaluator.memory, this.gate)) !== 'fire') continue;
        const id = await insertAlertEvent(this.o.db, {
          id: uuidv7(),
          ruleId: rule.id,
          firedAt: match.at,
          dedupeKey: match.dedupeKey,
          severity: rule.severity,
          title: match.title,
          body: match.body,
          sourceRefs: match.sourceRefs,
          late: match.late,
        });
        if (!id) continue; // fired before (a restart re-read its source)
        await this.o.queue.add(
          'deliver',
          { eventId: id },
          {
            jobId: `alert-${id}`,
            attempts: 5,
            backoff: { type: 'exponential', delay: 1_000 },
            removeOnComplete: 1_000,
            removeOnFail: 5_000,
          },
        );
        this.o.log.info({ rule: rule.id, key: match.dedupeKey, late: match.late }, 'alert fired');
      }
    }
  }

  // ── rules and references ───────────────────────────────────────────────────────────────────────

  private async refreshRules(): Promise<void> {
    const fingerprint = await alertRulesFingerprint(this.o.db);
    if (fingerprint === this.fingerprint) return;
    const by = new Map<AlertSourceKind, AlertRule[]>();
    for (const row of await activeAlertRules(this.o.db)) {
      const rule = ruleFromRow(row);
      if (!rule) {
        this.o.log.warn({ rule: row.id }, 'alert rule no longer valid: not evaluated');
        continue;
      }
      const kind = SOURCE_OF[rule.condition.kind];
      by.set(kind, [...(by.get(kind) ?? []), rule]);
    }
    this.bySource = by;
    this.fingerprint = fingerprint;
  }

  private async refreshRefs(): Promise<void> {
    const rows = await this.o.db
      .selectFrom('market.instruments')
      .select(['id', 'venue_id', 'base_asset', 'quote_asset', 'asset_class'])
      .execute();
    this.refs = new Map(
      rows.map((r) => [
        r.id,
        {
          id: r.id,
          venue: r.venue_id,
          name: displayName({
            venue: r.venue_id,
            base: r.base_asset,
            quote: r.quote_asset,
            assetClass: r.asset_class,
          }),
        },
      ]),
    );
    this.refsAt = this.now();
  }

  private async ref(instrumentId: string): Promise<InstrumentRef | null> {
    if (!this.refs.has(instrumentId)) await this.refreshRefs();
    return this.refs.get(instrumentId) ?? null;
  }

  private async loadZone(id: string): Promise<void> {
    if (this.zones.has(id)) return;
    const z = await this.o.db
      .selectFrom('analysis.poi_zones')
      .select(['type', 'direction', 'top', 'bottom'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (z) this.zones.set(id, z);
    if (this.zones.size > 10_000) this.zones.delete(this.zones.keys().next().value!);
  }

  // ── sources ────────────────────────────────────────────────────────────────────────────────────

  /** The latest ticker of every instrument held here, once a second (the prices' memory always grows). */
  private async prices(): Promise<void> {
    const ids = [...this.o.held()];
    if (!ids.length) return;
    const raw = await this.o.redis.mget(ids.map((id) => `ticker:${id}`));
    const sources: AlertSource[] = [];
    for (const [i, id] of ids.entries()) {
      const value = raw[i];
      const ref = this.refs.get(id);
      if (!value || !ref) continue;
      const t = JSON.parse(value) as Ticker;
      if (this.tickerTs.get(id) === t.ts) continue;
      this.tickerTs.set(id, t.ts);
      sources.push({ kind: 'price', instrument: ref, at: t.ts, price: t.last });
    }
    await this.evaluate(sources);
  }

  /** New `md:events` entries since the shared cursor (catch-up after a restart is labelled late). */
  private async marketEvents(): Promise<void> {
    await this.follow('md:events', MARKET_CURSOR_KEY, (entryId, f, data, processedAt) =>
      fromMarketEvent(entryId, f['type'] ?? '', data, (id) => this.refs.get(id) ?? null, processedAt),
    );
  }

  /** New `practice:events` entries: the owners' practice fills (criterion 14.9). */
  private async practiceEvents(): Promise<void> {
    await this.follow(PRACTICE_EVENTS_STREAM, PRACTICE_CURSOR_KEY, (_entryId, f, data, processedAt) =>
      fromPracticeEvent(
        f['type'] ?? '',
        f['user'] ?? '',
        data,
        (id) => this.refs.get(id) ?? null,
        processedAt,
      ),
    );
  }

  /**
   * Evaluates a stream's entries after the shared cursor, oldest first, a batch at a time; the
   * cursor moves on after each batch, so a new lease holder carries on from there. A first holder
   * starts at the stream's end.
   */
  private async follow(
    stream: string,
    cursorKey: string,
    toSource: (
      entryId: string,
      fields: Record<string, string>,
      data: unknown,
      processedAt: number,
    ) => AlertSource | null,
  ): Promise<void> {
    let cursor = this.cursors.get(stream);
    if (cursor === undefined) {
      const stored = await this.o.redis.get(cursorKey);
      const latest = stored ? null : await this.o.redis.xrevrange(stream, '+', '-', 'COUNT', 1);
      cursor = stored ?? latest?.[0]?.[0] ?? '0-0';
      this.cursors.set(stream, cursor);
    }
    for (let batch = 0; batch < 10; batch++) {
      // Entries after the cursor (`(` excludes it), oldest first. (Typed through `unknown`: the
      // linter's type checker resolves this ioredis overload to `any`.)
      const raw: unknown = await this.o.redis.xrange(stream, `(${cursor}`, '+', 'COUNT', 500);
      const entries = raw as [id: string, fields: string[]][];
      if (!entries.length) return;
      const processedAt = this.now();
      const sources: AlertSource[] = [];
      for (const [entryId, fields] of entries) {
        const f: Record<string, string> = {};
        for (let i = 0; i + 1 < fields.length; i += 2) f[fields[i]!] = fields[i + 1]!;
        let data: unknown;
        try {
          data = JSON.parse(f['data'] ?? 'null');
        } catch {
          continue;
        }
        const s = toSource(entryId, f, data, processedAt);
        if (s) sources.push(s);
      }
      await this.evaluate(sources);
      cursor = entries.at(-1)![0];
      this.cursors.set(stream, cursor);
      await this.o.redis.set(cursorKey, cursor);
      if (entries.length < 500) return;
    }
  }

  /** The stored PAXG spread, the economic calendar and the gold-market sessions (every 5 s). */
  private async globalClock(now: number): Promise<void> {
    const sources: AlertSource[] = [];

    if (this.spreadAfter === 0) this.spreadAfter = now - 30_000;
    const spreads = await this.o.db
      .selectFrom('market.cross_venue_spreads')
      .select(['ts', 'spread_bps'])
      .where('base_asset', '=', 'PAXG')
      .where('ts', '>', new Date(this.spreadAfter))
      .orderBy('ts')
      .limit(500)
      .execute();
    for (const s of spreads)
      sources.push({ kind: 'spread', baseAsset: 'PAXG', at: s.ts.getTime(), bps: s.spread_bps });
    if (spreads.length) this.spreadAfter = spreads.at(-1)!.ts.getTime();

    if (now - this.calendar.at >= RELOAD_MS) {
      const events = await this.o.db
        .selectFrom('market.economic_events')
        .select(['id', 'title', 'scheduled_at', 'impact', 'currency'])
        .where('status', '=', 'scheduled')
        .where('scheduled_at', '>', new Date(now))
        .where('scheduled_at', '<=', new Date(now + DAY_MS + RELOAD_MS))
        .execute();
      this.calendar = {
        at: now,
        events: events.map((e) => ({
          id: e.id,
          title: e.title,
          scheduledAt: e.scheduled_at.getTime(),
          impact: e.impact,
          currency: e.currency,
        })),
      };
    }
    for (const event of this.calendar.events)
      if (event.scheduledAt > now) sources.push({ kind: 'economic_event', at: now, event });

    if (now - this.closures.at >= RELOAD_MS) {
      const rows = await this.o.db
        .selectFrom('market.underlying_market_closures')
        .select(['starts_at', 'ends_at'])
        .where('calendar_id', '=', 'gold')
        .where('ends_at', '>', new Date(now - 8 * DAY_MS))
        .where('starts_at', '<', new Date(now + 8 * DAY_MS))
        .orderBy('starts_at')
        .execute();
      this.closures = {
        at: now,
        list: rows.map((r) => ({ startsAt: r.starts_at.getTime(), endsAt: r.ends_at.getTime() })),
      };
    }
    const current = this.closures.list.find((c) => c.startsAt <= now && now < c.endsAt);
    const closed = current !== undefined;
    if (this.goldClosed !== null && closed !== this.goldClosed) {
      const ended = this.closures.list.filter((c) => c.endsAt <= now).at(-1);
      const boundaryAt = closed ? current.startsAt : (ended?.endsAt ?? now);
      sources.push({ kind: 'gold_session', at: now, change: closed ? 'close' : 'open', boundaryAt });
    }
    this.goldClosed = closed;

    await this.evaluate(sources);
  }

  /** Re-reads the calendar and closures at the next clock tick (tests, and `config:` changes). */
  reloadCalendars(): void {
    this.calendar.at = 0;
    this.closures.at = 0;
  }
}
