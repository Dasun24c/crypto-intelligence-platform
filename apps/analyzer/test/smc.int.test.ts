import { Redis } from 'ioredis';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { type AnalysisStatus, analysisStatusKey, type SmcEventMessage } from '@cip/contracts';
import { candleToRow, createDb } from '@cip/db';
import {
  aggregateCandles,
  type Candle,
  floorTo,
  generateClosures,
  GOLD_CLOSURE_RULE,
  HISTORY_CANDLES,
  TF_MS,
  TIMEFRAMES,
  type Timeframe,
} from '@cip/domain';
import { createLogger } from '@cip/observability';
import { publishedKey } from '../src/analysis/actor.ts';
import { Analyzer, candleStream } from '../src/analysis/analyzer.ts';
import { entityId } from '../src/analysis/ids.ts';
import { runReplay } from '../src/analysis/replay.ts';
import { AnalysisRepository } from '../src/analysis/repository.ts';
import { LeaseLost, SmcStore } from '../src/analysis/smc-store.ts';

/**
 * Phase 4 runtime (architecture §7, ADR 004/005/017): SMC detections live, checkpoints, a standby
 * taking over a killed analyzer (criterion 4.4), replays reproducing the live digest (4.3), a data
 * gap that pauses without changing anything published (4.5), fencing, and the publishing outbox.
 */
const BTC = '019a6f00-0000-7000-8000-000000000001';
const PAXG = '019a6f00-0000-7000-8000-000000000004';
const FROM = Date.UTC(2026, 10, 12, 0, 0); // a Thursday: the live run starts here
const MIN = 60_000;

const owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 2 });
const db = createDb({ connectionString: inject('dbRoleUrls').svc_analyzer, max: 4 });
const redis = new Redis(inject('redisUrl'));
const log = createLogger({ service: 'analyzer', instance: 'test', level: 'error' });
const clock = { now: FROM + 30_000 };
const analyzers: Analyzer[] = [];
const store = new SmcStore(db);
const repo = new AnalysisRepository(db);

function analyzer(instance: string): Analyzer {
  const a = new Analyzer({
    db,
    redis,
    redisUrl: inject('redisUrl'),
    log,
    instance,
    tickMs: 3_600_000,
    leaseRenewMs: 200,
    blockMs: 100,
    now: () => clock.now,
  });
  analyzers.push(a);
  return a;
}

/** A deterministic random walk of consistent candles. */
function walk(tf: Timeframe, start: number, count: number, seed: number, from = 100): Candle[] {
  let s = seed;
  const rand = () => (s = (s * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
  let close = from;
  return Array.from({ length: count }, (_, i) => {
    const open = close;
    close = Math.max(1, open * (1 + (rand() - 0.5) * 0.01));
    const high = Math.max(open, close) * (1 + rand() * 0.003);
    const low = Math.min(open, close) * (1 - rand() * 0.003);
    return candle(tf, start + i * TF_MS[tf], open, high, low, close, rand() * 50);
  });
}

function candle(
  tf: Timeframe,
  openTime: number,
  o: number,
  h: number,
  l: number,
  c: number,
  v: number,
): Candle {
  return {
    timeframe: tf,
    openTime,
    open: o.toFixed(2),
    high: h.toFixed(2),
    low: l.toFixed(2),
    close: c.toFixed(2),
    volume: v.toFixed(3),
    quoteVolume: (v * c).toFixed(2),
    tradeCount: 1,
    takerBuyVolume: null,
    microProfile: null,
    source: 'rest',
    quality: 'complete',
    underlyingClosed: false,
  };
}

async function save(candles: Candle[], instrumentId: string): Promise<void> {
  for (let i = 0; i < candles.length; i += 500)
    await owner
      .insertInto('market.candles')
      .values(candles.slice(i, i + 500).map((c) => candleToRow(instrumentId, c, new Date())))
      .onConflict((oc) =>
        oc.columns(['instrument_id', 'timeframe', 'open_time']).doUpdateSet((eb) => ({
          open: eb.ref('excluded.open'),
          high: eb.ref('excluded.high'),
          low: eb.ref('excluded.low'),
          close: eb.ref('excluded.close'),
          volume: eb.ref('excluded.volume'),
          quality: eb.ref('excluded.quality'),
        })),
      )
      .execute();
}

/** Live 1m candles from FROM, and every longer candle they complete, as the ingestor builds them. */
const LIVE = walk('1m', FROM, 400, 4242, 100);
async function arrive(fromMin: number, toMin: number, skip: number[] = []): Promise<void> {
  const ones = LIVE.slice(fromMin, toMin).filter((c) => !skip.includes((c.openTime - FROM) / MIN));
  const all: Candle[] = [...ones];
  for (const tf of ['5m', '15m', '1h', '4h'] as Timeframe[]) {
    for (let t = floorTo(FROM + fromMin * MIN, tf); t + TF_MS[tf] <= FROM + toMin * MIN; t += TF_MS[tf]) {
      if (t < FROM) continue;
      const children = LIVE.filter(
        (c) => c.openTime >= t && c.openTime < t + TF_MS[tf] && !skip.includes((c.openTime - FROM) / MIN),
      );
      if (children.length) all.push(aggregateCandles(tf, t, children));
    }
  }
  await save(all, BTC);
}

async function wake(instrumentId: string, boundary: number): Promise<void> {
  await redis.xadd(candleStream(instrumentId), '*', 'boundary', String(boundary), 'tfs', '1m');
}

const openRun = (instrumentId: string) =>
  owner
    .selectFrom('analysis.detection_runs')
    .selectAll()
    .where('instrument_id', '=', instrumentId)
    .where('mode', '=', 'live')
    .where('status', 'in', ['warming_up', 'running'])
    .executeTakeFirstOrThrow();

const eventLog = (runId: string) =>
  owner
    .selectFrom('analysis.detection_events')
    .selectAll()
    .where('run_id', '=', runId)
    .orderBy('seq')
    .execute();

async function published(): Promise<SmcEventMessage[]> {
  const entries = await redis.xrange('an:events', '-', '+');
  return entries
    .filter(([, f]) => f[1] === 'smc')
    .map(([, f]) => JSON.parse(f[3]!) as SmcEventMessage)
    .filter((m) => m.instrumentId === BTC);
}

async function status(instrumentId: string): Promise<AnalysisStatus> {
  return JSON.parse((await redis.get(analysisStatusKey(instrumentId)))!) as AnalysisStatus;
}

/** Waits until the analyzer has caught up with every stored candle of BTC. */
async function caughtUp(a: Analyzer): Promise<void> {
  await vi.waitFor(
    async () => {
      await a.tick();
      expect(await status(BTC)).toMatchObject({ paused: false, lagSec: 0 });
    },
    { timeout: 30_000, interval: 100 },
  );
}

beforeAll(async () => {
  await owner.updateTable('market.instruments').set({ enabled: false }).where('id', '!=', BTC).execute();
  await owner.updateTable('market.instruments').set({ enabled: true }).where('id', '=', BTC).execute();
  for (const [n, tf] of TIMEFRAMES.entries()) {
    const size = TF_MS[tf];
    await save(walk(tf, floorTo(FROM, tf) - HISTORY_CANDLES * size, HISTORY_CANDLES, 31 + n), BTC);
  }
});

afterAll(async () => {
  for (const a of analyzers) await a.stop().catch(() => undefined);
  await owner.destroy();
  await db.destroy();
  redis.disconnect();
});

describe('SMC analysis runtime (Phase 4)', () => {
  let runId = '';

  it('warms up with SMC detections: event log, projections and checkpoints, nothing published', async () => {
    const a = analyzer('a');
    await a.start();
    const run = await openRun(BTC);
    runId = run.id;
    expect(run.status).toBe('running');
    const events = await eventLog(run.id);
    expect(events.length).toBeGreaterThan(200);
    // seq counts from 1 without holes; every event is warm-up (decided at or before FROM).
    expect(events.map((e) => Number(e.seq))).toEqual(events.map((_, i) => i + 1));
    expect(events.every((e) => e.candle_time.getTime() <= FROM)).toBe(true);
    const types = new Set(events.map((e) => e.type));
    for (const t of ['swing_confirmed', 'structure', 'level_created', 'sweep'] as const)
      expect(types).toContain(t);
    // Projections mirror the log, with ids derived from the run and the natural key.
    const swings = await owner
      .selectFrom('analysis.swing_points')
      .selectAll()
      .where('run_id', '=', run.id)
      .execute();
    const swingEvents = events.filter((e) => e.type === 'swing_confirmed');
    expect(swings).toHaveLength(swingEvents.length);
    const first = swingEvents[0]!;
    const key = (first.payload as { key: string }).key;
    expect(first.entity_id).toBe(entityId(run.id, key));
    expect(swings.find((s) => s.id === first.entity_id)?.flags).toContain('warmup');
    const levels = await owner
      .selectFrom('analysis.liquidity_levels')
      .selectAll()
      .where('run_id', '=', run.id)
      .execute();
    expect(levels.length).toBe(events.filter((e) => e.type === 'level_created').length);
    const sweeps = await owner
      .selectFrom('analysis.sweeps')
      .selectAll()
      .where('run_id', '=', run.id)
      .execute();
    expect(sweeps.length).toBe(events.filter((e) => e.type === 'sweep').length);
    // Zones (Phase 5): one row per zone, holding the state of its last status event.
    for (const t of ['zone_created', 'zone_status'] as const) expect(types).toContain(t);
    const zones = await owner
      .selectFrom('analysis.poi_zones')
      .selectAll()
      .where('run_id', '=', run.id)
      .execute();
    expect(zones.length).toBe(events.filter((e) => e.type === 'zone_created').length);
    const last = new Map<string, { status: string; fillPct: number; firstTouchAt: number | null }>();
    for (const e of events)
      if (e.type === 'zone_status')
        last.set(
          e.entity_id!,
          (e.payload as { data: { status: string; fillPct: number; firstTouchAt: number | null } }).data,
        );
    expect(last.size).toBeGreaterThan(0);
    for (const z of zones) {
      const s = last.get(z.id);
      expect({
        status: z.status,
        fill: Number(z.fill_pct),
        touch: z.first_touch_at?.getTime() ?? null,
      }).toEqual(
        s
          ? { status: s.status, fill: s.fillPct, touch: s.firstTouchAt }
          : { status: 'untouched', fill: 0, touch: null },
      );
    }
    // An order block points at its break; a linked zone is linked back.
    const ob = zones.find((z) => z.type === 'order_block');
    expect(ob?.structure_event_id).toBeTruthy();
    for (const z of zones.filter((x) => x.linked_zone_id !== null)) {
      const other = zones.find((x) => x.id === z.linked_zone_id)!;
      expect(other.linked_zone_id).not.toBeNull();
    }
    // Setups (Phase 6): one row per setup with the state of its latest transition, every transition
    // stored once, the checklist of each state it reached, and the outcome of each confirmed one.
    expect(types).toContain('setup_transition');
    type T = {
      to: string;
      score: number;
      resolution: string | null;
      entryZone: string | null;
      outcome: { result: string } | null;
    };
    const latest = new Map<string, T>();
    const states = new Map<string, Set<string>>();
    let transitions = 0;
    for (const e of events)
      if (e.type === 'setup_transition') {
        const d = (e.payload as { data: T }).data;
        latest.set(e.entity_id!, d);
        states.set(e.entity_id!, (states.get(e.entity_id!) ?? new Set()).add(d.to));
        transitions++;
      }
    const setups = await owner
      .selectFrom('analysis.setups')
      .selectAll()
      .where('run_id', '=', run.id)
      .execute();
    expect(setups.length).toBe(latest.size);
    for (const s of setups) {
      const d = latest.get(s.id)!;
      expect({ state: s.state, score: Number(s.confluence_score), resolution: s.resolution }).toEqual({
        state: d.to,
        score: d.score,
        resolution: d.resolution,
      });
      expect(s.flags).toContain('warmup');
      if (d.entryZone) expect(s.entry_zone_id).toBe(entityId(run.id, d.entryZone));
    }
    const ids = setups.map((s) => s.id);
    const stored = await owner
      .selectFrom('analysis.setup_transitions')
      .selectAll()
      .where('setup_id', 'in', ids)
      .execute();
    expect(stored.length).toBe(transitions);
    const checklist = await owner
      .selectFrom('analysis.setup_checklist_results')
      .select(['setup_id', 'state'])
      .where('setup_id', 'in', ids)
      .execute();
    expect(checklist.length).toBe([...states.values()].reduce((n, s) => n + 8 * s.size, 0));
    const outcomes = await owner
      .selectFrom('analysis.setup_outcomes')
      .selectAll()
      .where('setup_id', 'in', ids)
      .execute();
    expect(outcomes.map((o) => [o.setup_id, o.result]).sort()).toEqual(
      [...latest]
        .filter(([, d]) => d.outcome)
        .map(([id, d]) => [id, d.outcome!.result])
        .sort(),
    );
    // Checkpoints every 60 boundaries during the warm-up.
    const cp = await store.loadCheckpoint(run.id);
    expect(cp).not.toBeNull();
    expect(cp!.epoch).toBeGreaterThan(0);
    expect(await published()).toEqual([]);
  });

  it('publishes live detections with run ids and flags, after the candle closes', async () => {
    const a = analyzers[0]!;
    await arrive(0, 60);
    clock.now = FROM + 60 * MIN + 2_000;
    await wake(BTC, FROM + 60 * MIN);
    await caughtUp(a);
    const events = (await eventLog(runId)).filter((e) => e.candle_time.getTime() > FROM);
    expect(events.length).toBeGreaterThan(0);
    const messages = await published();
    // Setup transitions go to the setups channels (their own stream entries), gap markers nowhere.
    const visible = events.filter((e) => e.type !== 'gap_marker' && e.type !== 'setup_transition');
    expect(messages.map((m) => m.seq)).toEqual(visible.map((e) => Number(e.seq)));
    const setupEntries = (await redis.xrange('an:events', '-', '+')).filter(([, f]) => f[1] === 'setup');
    expect(setupEntries.length).toBe(events.filter((e) => e.type === 'setup_transition').length);
    for (const m of messages) {
      expect(m).toMatchObject({ instrumentId: BTC, runId });
      expect(JSON.stringify(m.data)).not.toContain('warmup');
    }
  });

  it('survives a killed analyzer: the standby resumes from the checkpoint and the run equals a replay', async () => {
    const a = analyzers[0]!;
    await arrive(60, 120);
    clock.now = FROM + 120 * MIN + 2_000;
    await wake(BTC, FROM + 120 * MIN);
    await caughtUp(a);
    const before = await eventLog(runId);
    const cp = await store.loadCheckpoint(runId);
    // Killed: no shutdown checkpoint, the lease is left to expire.
    await a.stop({ graceful: false });
    await redis.del(`lease:analyzer:${BTC}`);
    await arrive(120, 180);
    clock.now = FROM + 180 * MIN + 2_000;
    const b = analyzer('b');
    await b.start();
    await caughtUp(b);
    const after = await eventLog(runId);
    // What the killed holder wrote after its last checkpoint was recomputed identically, not duplicated.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.map((e) => Number(e.seq))).toEqual(after.map((_, i) => i + 1));
    expect((await store.loadCheckpoint(runId))!.epoch).toBeGreaterThan(cp!.epoch);
    // Criterion 4.3: replaying the stored period reproduces the live run's digest exactly, also over
    // a period the live run computed while warming up on stored history (before its start).
    for (const [from, to] of [
      [FROM, FROM + 180 * MIN],
      [FROM + 60 * MIN, FROM + 180 * MIN],
      [FROM - 300 * MIN, FROM + 60 * MIN],
    ] as const) {
      const replay = await runReplay(
        { repo, store, log },
        { runId: uuidv7(), instrumentId: BTC, from, to, requestedBy: null },
      );
      const live = await store.digest(runId, from, to);
      expect(replay.liveRunId).toBe(runId);
      expect(replay.events).toBeGreaterThan(0);
      expect(replay).toMatchObject({ digest: live.digest, events: live.events });
    }
  });

  it('fences a former holder: a write with an older epoch is refused', async () => {
    const { epoch } = (await store.loadCheckpoint(runId))!;
    const info = { runId, instrumentId: BTC, from: FROM, live: true };
    await expect(
      store.write({ info, values: [], events: [], epoch: epoch - 1, now: clock.now }),
    ).rejects.toBeInstanceOf(LeaseLost);
    await expect(
      store.write({
        info,
        values: [],
        events: [],
        checkpoint: { boundary: FROM, state: Buffer.from('x') },
        now: clock.now,
      }),
    ).rejects.toBeInstanceOf(LeaseLost);
  });

  it('pauses at a data gap, changes nothing already published, and resumes after the repair', async () => {
    const b = analyzers[1]!;
    const gapId = '019a6f00-0000-7000-8000-00000000b001';
    await arrive(180, 240, [200]);
    await owner
      .insertInto('market.data_gaps')
      .values({
        id: gapId,
        instrument_id: BTC,
        stream: 'kline',
        gap_start: new Date(FROM + 200 * MIN),
        gap_end: new Date(FROM + 201 * MIN),
        detected_at: new Date(),
        detected_by: 'sequence',
        status: 'open',
      })
      .execute();
    clock.now = FROM + 240 * MIN + 2_000;
    await wake(BTC, FROM + 240 * MIN);
    await vi.waitFor(
      async () => {
        await b.tick();
        expect(await status(BTC)).toMatchObject({ paused: true, pauseReason: 'data_gap' });
      },
      { timeout: 30_000, interval: 100 },
    );
    expect((await status(BTC)).detail).toBe('1m: missing 2026-11-12 03:20 (backfill running)');
    const logBefore = await eventLog(runId);
    const sentBefore = await published();
    expect(logBefore.at(-1)!.candle_time.getTime()).toBeLessThanOrEqual(FROM + 200 * MIN);

    // The backfill repairs the minute and rebuilds the aggregates over it.
    await arrive(200, 240);
    await owner.updateTable('market.data_gaps').set({ status: 'repaired' }).where('id', '=', gapId).execute();
    await wake(BTC, FROM + 240 * MIN);
    await vi.waitFor(
      async () => {
        await b.tick();
        expect(await status(BTC)).toMatchObject({ paused: false, lagSec: 0 });
      },
      { timeout: 30_000, interval: 100 },
    );
    const logAfter = await eventLog(runId);
    const sentAfter = await published();
    // Nothing decided or published before the pause changed (ADR 005).
    expect(logAfter.slice(0, logBefore.length)).toEqual(logBefore);
    expect(sentAfter.slice(0, sentBefore.length)).toEqual(sentBefore);
    expect(new Set(sentAfter.map((m) => m.seq)).size).toBe(sentAfter.length);
    // And the paused run is still exactly what a replay of the period gives.
    const replay = await runReplay(
      { repo, store, log },
      { runId: uuidv7(), instrumentId: BTC, from: FROM, to: FROM + 240 * MIN, requestedBy: null },
    );
    expect(replay.digest).toBe((await store.digest(runId, FROM, FROM + 240 * MIN)).digest);
  });

  it('publishes, after a restart, events a former holder stored but never published (the outbox)', async () => {
    const b = analyzers[1]!;
    const log = await eventLog(runId);
    const live = log.filter((e) => e.candle_time.getTime() > FROM && e.type !== 'gap_marker');
    const rewind = Number(live.at(-5)!.seq) - 1;
    await b.stop();
    // As if the holder had stored its last events and died before publishing them.
    await redis.set(publishedKey(runId), String(rewind));
    const sent = (await published()).length;
    const c = analyzer('c');
    await c.start();
    const resent = (await published()).slice(sent);
    expect(resent.map((m) => m.seq)).toEqual(
      live.filter((e) => Number(e.seq) > rewind).map((e) => Number(e.seq)),
    );
    expect(await redis.get(publishedKey(runId))).toBe(String(Number(log.at(-1)!.seq)));
  });

  it('gives a gold instrument its closure calendar: weekend levels from the hours inside a closure', async () => {
    const c = analyzers[2]!;
    const start = floorTo(FROM, '1h') - HISTORY_CANDLES * TF_MS['1h'];
    const closures = generateClosures(GOLD_CLOSURE_RULE, start - 7 * 86_400_000, FROM + 7 * 86_400_000);
    for (const x of closures)
      await owner
        .insertInto('market.underlying_market_closures')
        .values({
          calendar_id: 'gold',
          starts_at: new Date(x.startsAt),
          ends_at: new Date(x.endsAt),
          reason: x.reason,
          source: 'generated',
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
    const flagged = (cs: Candle[]) =>
      cs.map((x) => ({
        ...x,
        underlyingClosed: closures.some(
          (k) => k.startsAt < x.openTime + TF_MS[x.timeframe] && k.endsAt > x.openTime,
        ),
      }));
    for (const [n, tf] of TIMEFRAMES.entries())
      await save(
        flagged(walk(tf, floorTo(FROM, tf) - HISTORY_CANDLES * TF_MS[tf], HISTORY_CANDLES, 77 + n, 2650)),
        PAXG,
      );
    await owner.updateTable('market.instruments').set({ enabled: true }).where('id', '=', PAXG).execute();
    await c.tick();
    const run = await openRun(PAXG);
    const weekend = await owner
      .selectFrom('analysis.liquidity_levels')
      .select(['type', 'origin_timeframe', 'known_at'])
      .where('run_id', '=', run.id)
      .where('type', 'in', ['weekend_high', 'weekend_low'])
      .execute();
    const reopenings = closures.filter(
      (k) => k.reason === 'weekend' && k.startsAt >= start && k.endsAt <= FROM,
    );
    expect(weekend).toHaveLength(2 * reopenings.length);
    expect(weekend.every((w) => w.origin_timeframe === '1d')).toBe(true);
    expect(new Set(weekend.map((w) => w.known_at.getTime()))).toEqual(
      new Set(reopenings.map((k) => k.endsAt)),
    );
  });

  it('keeps renewing its leases while an instrument is busy, so a standby never takes it mid-step', async () => {
    const holder = analyzers.find((a) => a.instrumentIds.includes(BTC))!;
    const key = `lease:analyzer:${BTC}`;
    const epoch = await redis.get(`${key}:epoch`);
    await arrive(240, 270);
    clock.now = FROM + 270 * MIN + 2_000;
    // The checkpoint table locked: the actor's next write waits, as behind a long warm-up.
    let unlock!: () => void;
    const gate = new Promise<void>((resolve) => (unlock = resolve));
    const locked = owner.transaction().execute(async (trx) => {
      await sql`LOCK TABLE analysis.engine_checkpoints IN ACCESS EXCLUSIVE MODE`.execute(trx);
      await gate;
    });
    await new Promise((r) => setTimeout(r, 100));
    const ticking = holder.tick();
    await new Promise((r) => setTimeout(r, 1_500));
    // Renewed within the last renewal interval (TTL 15 s), by the same holding: same epoch.
    expect(await redis.pttl(key)).toBeGreaterThan(14_000);
    expect(await redis.get(`${key}:epoch`)).toBe(epoch);
    unlock();
    await locked;
    await ticking;
    await caughtUp(holder);
    const log = await eventLog(runId);
    expect(log.map((e) => Number(e.seq))).toEqual(log.map((_, i) => i + 1));
  });
});
