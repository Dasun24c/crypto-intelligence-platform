import type { Redis } from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import {
  ANALYSIS_EVENTS_STREAM,
  type AnalysisStatus,
  type IndicatorPoint,
  type PauseReason,
  ProfileParamsSchema,
} from '@cip/contracts';
import type { DetectionRunRow, NewIndicatorValue } from '@cip/db';
import { type Closure, floorTo, HISTORY_CANDLES, TF_MS, TIMEFRAMES, type Timeframe } from '@cip/domain';
import type { IndicatorParams, IndicatorValues } from '@cip/indicators';
import type { Logger } from '@cip/observability';
import {
  RULESET_VERSION as SMC_RULESET,
  type SmcEvent,
  type SmcParams,
  validateSmcParams,
} from '@cip/smc-engine';
import { decodeState, encodeState } from './checkpoint.js';
import type { InstrumentLease } from './lease.js';
import { type Output, type ProcessorConfig, RunProcessor } from './processor.js';
import type { AnalysedInstrument, AnalysisRepository } from './repository.js';
import { isWarmup, type RunInfo, toMessage } from './smc-rows.js';
import { LeaseLost, type SmcStore } from './smc-store.js';

/**
 * The analysis rules version stored on every run: the indicators' and the SMC rulebook's. Bump it
 * when either changes: the next start supersedes each open run with one computed under the new rules.
 */
export const RULESET_VERSION = `indicators-1+smc-${SMC_RULESET}`;

/** A checkpoint every 60 boundaries (architecture §7), and on shutdown. */
export const CHECKPOINT_EVERY = 60;
/** About seven days of an:events entries at 9 instruments (architecture §6). */
const EVENTS_MAXLEN = '200000';
/**
 * How long a new run waits before accepting that a timeframe's history is shorter than
 * HISTORY_CANDLES: the ingestor records its history gaps when it starts, and may start after us.
 * The replay venue has no history to fetch (ADR 015), so its instruments do not wait.
 */
export const HISTORY_GRACE_MS = 120_000;
const CLOSURES_REFRESH_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The last SMC event published for a run (the outbox cursor). */
export const publishedKey = (runId: string) => `an:published:${runId}`;

export interface ActorDeps {
  repo: AnalysisRepository;
  store: SmcStore;
  redis: Redis;
  log: Logger;
  /** The instrument's lease: its epoch fences this actor's writes. */
  lease: Pick<InstrumentLease, 'epoch' | 'bump'>;
  now?: () => number;
  /** Candle close → published, for the latency histogram (criteria 3.5 and 4.6). */
  onPublished?: (kind: 'indicators' | 'smc', tf: Timeframe, lagMs: number) => void;
  /** SMC engine step time (criterion 4.6). */
  onStep?: (ms: number) => void;
}

export function toRow(
  instrumentId: string,
  tf: Timeframe,
  runId: string,
  v: IndicatorValues,
): NewIndicatorValue {
  return {
    instrument_id: instrumentId,
    timeframe: tf,
    open_time: new Date(v.openTime),
    run_id: runId,
    rsi: v.rsi,
    macd: v.macd,
    macd_signal: v.macdSignal,
    macd_hist: v.macdHist,
    ema_fast: v.emaFast,
    ema_mid: v.emaMid,
    ema_slow: v.emaSlow,
    vwap: v.vwap,
    atr: v.atr,
    volume_z: v.volumeZ,
    volume_anomaly: v.volumeAnomaly,
    trend: v.trend,
    trend_strength: v.trendStrength,
  };
}

export function toPoint(v: IndicatorValues, warmup: boolean): IndicatorPoint {
  return {
    t: v.openTime,
    rsi: v.rsi,
    macd: v.macd,
    macdSignal: v.macdSignal,
    macdHist: v.macdHist,
    emaFast: v.emaFast,
    emaMid: v.emaMid,
    emaSlow: v.emaSlow,
    vwap: v.vwap,
    atr: v.atr,
    volumeZ: v.volumeZ,
    volumeAnomaly: v.volumeAnomaly,
    trend: v.trend,
    trendStrength: v.trendStrength,
    warmup,
  };
}

/** A profile's settings, checked: the indicators' and the SMC engine's. */
export function analysisParams(params: unknown): { indicators: IndicatorParams; smc: SmcParams } {
  const parsed = ProfileParamsSchema.safeParse(params);
  if (!parsed.success)
    throw new Error(`invalid settings: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  if (!parsed.data.smc) throw new Error('the profile has no SMC settings (version 2 or later is needed)');
  const smc = parsed.data.smc;
  validateSmcParams(smc);
  return { indicators: parsed.data.indicators, smc };
}

/**
 * Analysis of one instrument (architecture §7, one actor per instrument). It keeps one open live run
 * and steps it boundary by boundary: indicators and the SMC engine take every closed candle in order.
 *
 * - **Warm-up**: each timeframe starts HISTORY_CANDLES candles before the run's start (its origin,
 *   stored on the run). A timeframe without any candles yet joins later, at its first candle.
 * - **Gaps**: a missing candle, or a partial one that can still be repaired, holds the whole run at
 *   that boundary ("paused: data gap", ADR 005); a gap declared unrepairable becomes a gap marker.
 * - **Writes**: each batch of boundaries is one transaction (values, events, projections), with a
 *   checkpoint every 60 boundaries. Every write is fenced with the lease epoch, so a former holder
 *   that stalled cannot write after a takeover.
 * - **Restarts**: the next holder restores the checkpoint and recomputes the boundaries after it;
 *   determinism makes them identical, so nothing is written or published twice. Events committed by
 *   a holder that died before publishing them are published from the event log (the outbox).
 */
export class InstrumentActor {
  private run: DetectionRunRow | null = null;
  private params: { indicators: IndicatorParams; smc: SmcParams } | null = null;
  private problem: string | null = null;
  private proc: RunProcessor | null = null;
  private pause: { reason: PauseReason; detail: string } | null = null;
  private sinceCheckpoint = 0;
  private published = 0;
  private lost = false;
  private context: { closures: readonly Closure[] } = { closures: [] };
  private contextLoaded = 0;
  private readonly now: () => number;
  private busy: Promise<void> = Promise.resolve();
  private pending = false;
  /** The lease epoch the step in progress writes under (taken when it starts). */
  private writeEpoch: number | null = null;

  constructor(
    private instrument: AnalysedInstrument,
    private readonly deps: ActorDeps,
  ) {
    this.now = deps.now ?? Date.now;
  }

  get instrumentId(): string {
    return this.instrument.id;
  }

  get runId(): string | null {
    return this.run?.id ?? null;
  }

  /** A newer lease holder owns the run: drop this actor. */
  get leaseLost(): boolean {
    return this.lost;
  }

  /** The last boundary processed, for tests. */
  get boundary(): number | null {
    return this.proc?.boundary ?? null;
  }

  /** Steps the actor once now, or once more after the step in progress (wake-ups coalesce). */
  wake(_boundary?: number): Promise<void> {
    if (this.pending) return this.busy;
    this.pending = true;
    this.busy = this.busy.then(async () => {
      this.pending = false;
      try {
        await this.step();
      } catch (err) {
        if (err instanceof LeaseLost) {
          this.lost = true;
          this.deps.log.warn(
            { instrument: this.instrument.symbol },
            'analysis lease lost: a newer holder owns the run',
          );
          return;
        }
        // The in-memory state may be half-way through a boundary: drop it, and resume from the last
        // checkpoint (determinism recomputes the same results).
        this.proc = null;
        this.sinceCheckpoint = 0;
        this.deps.log.error({ err, instrument: this.instrument.symbol }, 'analysis step failed');
      }
    });
    return this.busy;
  }

  /** Resolves when the step in progress (if any) has finished. */
  idle(): Promise<void> {
    return this.busy;
  }

  /** Takes a changed profile: the open run is superseded by a new one at the next step. */
  update(instrument: AnalysedInstrument): void {
    this.instrument = instrument;
  }

  private async ensureRun(): Promise<boolean> {
    const { repo, log } = this.deps;
    const i = this.instrument;
    try {
      this.params = analysisParams(i.params);
      this.problem = null;
    } catch (err) {
      this.problem = `profile ${i.profileName} v${i.profileVersion}: ${(err as Error).message}`;
      log.error({ instrument: i.symbol }, this.problem);
      return false;
    }
    let run = this.run ?? (await repo.openRun(i.id));
    if (
      run &&
      (run.profile_id !== i.profileId ||
        run.params_hash !== i.paramsHash ||
        run.ruleset_version !== RULESET_VERSION)
    ) {
      await repo.setStatus(run.id, 'superseded', new Date(this.now()));
      log.info({ instrument: i.symbol, runId: run.id }, 'run superseded by a profile or rules change');
      run = null;
    }
    if (!run) {
      run =
        (await repo.createRun({
          id: uuidv7(),
          instrumentId: i.id,
          profileId: i.profileId,
          rulesetVersion: RULESET_VERSION,
          paramsHash: i.paramsHash,
          from: floorTo(this.now(), '1m'),
          startedAt: this.now(),
        })) ?? (await repo.openRun(i.id));
      if (!run) return false;
      log.info({ instrument: i.symbol, runId: run.id, from: run.from_time }, 'live run opened');
    }
    if (run.id !== this.run?.id) {
      this.run = run;
      this.proc = null;
      this.pause = null;
      this.sinceCheckpoint = 0;
    }
    return true;
  }

  private processorConfig(): ProcessorConfig {
    return {
      instrumentId: this.instrument.id,
      tick: this.instrument.tick,
      indicators: this.params!.indicators,
      smc: this.params!.smc,
      context: () => this.context,
      onStep: this.deps.onStep,
    };
  }

  /** The closure calendar for the engine: loaded for gold instruments, refreshed hourly. */
  private async refreshContext(): Promise<void> {
    const calendar = this.instrument.calendarId;
    if (!calendar || this.now() - this.contextLoaded < CLOSURES_REFRESH_MS) return;
    const origins = Object.values(this.run!.series_origins);
    const from = (origins.length ? Math.min(...origins) : this.run!.from_time.getTime()) - 7 * DAY_MS;
    this.context = { closures: await this.deps.repo.closures(calendar, from, this.now() + 30 * DAY_MS) };
    this.contextLoaded = this.now();
  }

  /** One pass: start or restore the run, then take every boundary that is due. */
  async step(): Promise<void> {
    // Every write of this step is fenced with the epoch it started under, even if the lease is
    // renewed, lost or taken again meanwhile: a newer holder's epoch then refuses them.
    this.writeEpoch = this.deps.lease.epoch;
    if (this.lost || this.writeEpoch === null) return;
    if (!(await this.ensureRun())) return;
    if (!this.proc && !(await this.start())) return;
    await this.refreshContext();
    await this.joinLate();
    const proc = this.proc!;
    for (;;) {
      const stop = await proc.advance({ max: CHECKPOINT_EVERY - this.sinceCheckpoint });
      const out = proc.drain();
      if (out.boundaries > 0) await this.flush(out);
      if (stop.kind === 'limit') continue;
      this.pause = stop.kind === 'paused' ? { reason: 'data_gap', detail: stop.detail } : null;
      const run = this.run!;
      if (stop.kind === 'caught_up' && run.status === 'warming_up') {
        await this.deps.repo.setStatus(run.id, 'running');
        run.status = 'running';
        this.deps.log.info(
          { instrument: this.instrument.symbol, runId: run.id },
          'warm-up complete; run is live',
        );
      }
      return;
    }
  }

  /** Restores the run's checkpoint, or starts its timeframes at their origins. */
  private async start(): Promise<boolean> {
    const { store, lease, repo, log } = this.deps;
    const run = this.run!;
    const cp = await store.loadCheckpoint(run.id);
    if (cp) {
      if (cp.epoch >= this.writeEpoch!) {
        // Only while the lease is still the one this step started under (bump is safe only then).
        if (lease.epoch !== this.writeEpoch) return false;
        this.writeEpoch = await lease.bump(cp.epoch);
      }
      if (!(await store.claim(run.id, this.writeEpoch!))) {
        this.lost = true;
        return false;
      }
      try {
        this.proc = RunProcessor.restore(repo, this.processorConfig(), decodeState(cp.state));
      } catch (err) {
        // A checkpoint this code cannot continue (rules changed without a new version): start over.
        log.error(
          { err, instrument: this.instrument.symbol, runId: run.id },
          'checkpoint unusable; run superseded',
        );
        await repo.setStatus(run.id, 'superseded', new Date(this.now()));
        this.run = null;
        return false;
      }
      log.info(
        { instrument: this.instrument.symbol, runId: run.id, boundary: new Date(cp.boundary) },
        'run restored from its checkpoint',
      );
      this.contextLoaded = 0;
      await this.catchUpPublishing();
      return true;
    }
    const origins = await this.resolveOrigins(run);
    if (!origins) return false;
    if (origins.size === 0) {
      this.pause = { reason: 'warming_up', detail: 'waiting for the first candles' };
      return false;
    }
    const proc = new RunProcessor(repo, this.processorConfig());
    for (const [tf, origin] of origins) proc.join(tf, origin);
    this.proc = proc;
    this.contextLoaded = 0; // the calendar must now reach back to the earliest origin
    await this.catchUpPublishing();
    return true;
  }

  /**
   * Where each timeframe starts: HISTORY_CANDLES before the run's start, or at the earliest stored
   * candle when the venue has less. Null while history is still arriving.
   */
  private async resolveOrigins(run: DetectionRunRow): Promise<Map<Timeframe, number> | null> {
    const origins = new Map<Timeframe, number>();
    const waiting: string[] = [];
    for (const tf of TIMEFRAMES) {
      const fixed = run.series_origins[tf];
      if (fixed !== undefined) {
        origins.set(tf, fixed);
        continue;
      }
      const origin = await this.originFor(tf, run, -Infinity);
      if (origin === 'wait') waiting.push(`${tf}: waiting for history`);
      else if (origin !== null) origins.set(tf, origin);
    }
    if (waiting.length) {
      this.pause = { reason: 'warming_up', detail: waiting.join('; ') };
      return null;
    }
    return origins;
  }

  /** A timeframe's origin, stored on the run the first time; null when it has no candles yet. */
  private async originFor(
    tf: Timeframe,
    run: DetectionRunRow,
    floor: number,
  ): Promise<number | 'wait' | null> {
    const { repo } = this.deps;
    const id = this.instrument.id;
    const target = floorTo(run.from_time.getTime(), tf) - HISTORY_CANDLES * TF_MS[tf];
    const earliest = await repo.earliestOpenTime(id, tf);
    const young =
      this.instrument.venue !== 'replay' && this.now() - run.started_at.getTime() < HISTORY_GRACE_MS;
    if (earliest === null) return young ? 'wait' : null;
    let origin = target;
    if (earliest > target) {
      if (young || (await repo.openGapOverlaps(id, tf, target, earliest))) return 'wait';
      origin = earliest;
    }
    origin = Math.max(origin, floor);
    origin = await repo.fixOrigin(run.id, tf, origin);
    run.series_origins = { ...run.series_origins, [tf]: origin };
    return origin;
  }

  /** Timeframes that had no candles when the run started join at their first candle still to close. */
  private async joinLate(): Promise<void> {
    const proc = this.proc!;
    const run = this.run!;
    for (const tf of TIMEFRAMES) {
      if (proc.timeframes.includes(tf)) continue;
      const fixed = run.series_origins[tf];
      const origin = fixed ?? (await this.originFor(tf, run, proc.joinFloor(tf)));
      if (typeof origin === 'number' && origin >= proc.joinFloor(tf)) proc.join(tf, origin);
    }
  }

  private async flush(out: Output): Promise<void> {
    const run = this.run!;
    const proc = this.proc!;
    const now = this.now();
    const info: RunInfo = {
      runId: run.id,
      instrumentId: this.instrument.id,
      from: run.from_time.getTime(),
      live: true,
    };
    const checkpoint = this.sinceCheckpoint + out.boundaries >= CHECKPOINT_EVERY;
    const written = await this.deps.store.write({
      info,
      values: out.values.map((v) => toRow(info.instrumentId, v.tf, run.id, v.values)),
      events: out.events,
      epoch: this.writeEpoch!,
      checkpoint: checkpoint ? { boundary: proc.boundary!, state: encodeState(proc.snapshot()) } : undefined,
      now,
    });
    this.sinceCheckpoint = checkpoint ? 0 : this.sinceCheckpoint + out.boundaries;
    // Indicators: points stored just now and not warm-up (after a restart, recomputed ones are not).
    for (const { tf, values } of out.values)
      if (values.openTime >= info.from && written.values.has(`${tf}|${values.openTime}`))
        await this.publishPoint(tf, run.id, toPoint(values, false));
    await this.publishEvents(info, written.events, out.events.at(-1)?.seq ?? this.published);
  }

  /** Persists the state now (shutdown): the next holder resumes here instead of the last checkpoint. */
  async shutdown(): Promise<void> {
    await this.busy;
    const run = this.run;
    const proc = this.proc;
    const epoch = this.deps.lease.epoch;
    if (!run || !proc || this.lost || epoch === null || this.sinceCheckpoint === 0 || proc.boundary === null)
      return;
    await this.deps.store.write({
      info: { runId: run.id, instrumentId: this.instrument.id, from: run.from_time.getTime(), live: true },
      values: [],
      events: [],
      epoch,
      checkpoint: { boundary: proc.boundary, state: encodeState(proc.snapshot()) },
      now: this.now(),
    });
    this.sinceCheckpoint = 0;
  }

  private async publishPoint(tf: Timeframe, runId: string, point: IndicatorPoint): Promise<void> {
    const data = JSON.stringify({ instrumentId: this.instrument.id, tf, runId, point });
    await this.deps.redis.xadd(
      ANALYSIS_EVENTS_STREAM,
      'MAXLEN',
      '~',
      EVENTS_MAXLEN,
      '*',
      'type',
      'indicators.closed',
      'data',
      data,
    );
    this.deps.onPublished?.('indicators', tf, this.now() - (point.t + TF_MS[tf]));
  }

  /** Publishes events not published yet (never warm-up ones) and moves the outbox cursor to `upTo`. */
  private async publishEvents(info: RunInfo, events: readonly SmcEvent[], upTo: number): Promise<void> {
    const now = this.now();
    for (const e of events) {
      if (e.seq <= this.published || isWarmup(info, e)) continue;
      const message = toMessage(info, e, now);
      if (!message) continue;
      await this.deps.redis.xadd(
        ANALYSIS_EVENTS_STREAM,
        'MAXLEN',
        '~',
        EVENTS_MAXLEN,
        '*',
        'type',
        'smc',
        'data',
        JSON.stringify(message),
      );
      this.deps.onPublished?.('smc', e.tf, now - e.time);
    }
    if (upTo > this.published) {
      this.published = upTo;
      await this.deps.redis.set(publishedKey(info.runId), String(upTo));
    }
  }

  /**
   * The outbox: events a former holder committed but did not publish are published now. Without a
   * cursor (a new run, or Redis lost it) nothing older than now is published.
   */
  private async catchUpPublishing(): Promise<void> {
    const run = this.run!;
    const stored = await this.deps.redis.get(publishedKey(run.id));
    if (stored === null) {
      this.published = await this.deps.store.lastSeq(run.id);
      await this.deps.redis.set(publishedKey(run.id), String(this.published));
      return;
    }
    this.published = Number(stored);
    const info: RunInfo = {
      runId: run.id,
      instrumentId: this.instrument.id,
      from: run.from_time.getTime(),
      live: true,
    };
    for (;;) {
      const events = await this.deps.store.eventsAfter(run.id, this.published);
      if (!events.length) return;
      await this.publishEvents(info, events, events.at(-1)!.seq);
    }
  }

  /** This instrument's state for System Health (`SystemHealth.analysis`). */
  async status(): Promise<AnalysisStatus | null> {
    if (!this.run) return null;
    const held: string[] = [];
    let reason: PauseReason | undefined;
    if (this.problem) held.push(this.problem);
    if (this.pause) {
      held.push(this.pause.detail);
      reason = this.pause.reason;
    } else if (!this.proc) {
      held.push('starting');
      reason = 'warming_up';
    }
    let lagMs: number | null = null;
    const boundary = this.proc?.boundary ?? null;
    const latest = await this.deps.repo.latestOpenTime(this.instrument.id, '1m');
    if (latest !== null && boundary !== null) lagMs = Math.max(0, latest + TF_MS['1m'] - boundary);
    return {
      instrumentId: this.instrument.id,
      runId: this.run.id,
      status: this.run.status,
      lagSec: lagMs === null ? null : lagMs / 1000,
      paused: held.length > 0,
      ...(reason ? { pauseReason: reason } : {}),
      detail: held.join('; '),
      updatedAt: this.now(),
    };
  }
}
