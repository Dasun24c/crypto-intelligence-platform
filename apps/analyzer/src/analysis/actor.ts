import { v7 as uuidv7 } from 'uuid';
import type { Redis } from 'ioredis';
import {
  ANALYSIS_EVENTS_STREAM,
  type AnalysisStatus,
  type IndicatorPoint,
  type PauseReason,
  ProfileParamsSchema,
} from '@cip/contracts';
import type { DetectionRunRow, NewIndicatorValue } from '@cip/db';
import { floorTo, HISTORY_CANDLES, TF_MS, TIMEFRAMES, type Timeframe } from '@cip/domain';
import { type IndicatorParams, IndicatorSeries, type IndicatorValues } from '@cip/indicators';
import type { Logger } from '@cip/observability';
import type { AnalysedInstrument, AnalysisRepository } from './repository.js';

/**
 * The analysis rules version stored on every run. Bump it when indicator semantics change: the
 * next start supersedes each open run with one computed under the new rules.
 */
export const RULESET_VERSION = 'indicators-1';

/** About seven days of an:events entries at 9 instruments (architecture §6). */
const EVENTS_MAXLEN = '200000';
const PAGE = 1_000;
/**
 * How long a new run waits before accepting that a timeframe's history is shorter than
 * HISTORY_CANDLES: the ingestor records its history gaps when it starts, and may start after us.
 * The replay venue has no history to fetch (ADR 015), so its instruments do not wait.
 */
export const HISTORY_GRACE_MS = 120_000;

export interface ActorDeps {
  repo: AnalysisRepository;
  redis: Redis;
  log: Logger;
  now?: () => number;
  /** Candle close → published, for the latency histogram (criterion 3.5). */
  onPublished?: (tf: Timeframe, lagMs: number) => void;
}

interface TfState {
  series: IndicatorSeries | null;
  /** Open time of the next candle to take. */
  next: number;
  /** Open time of the last candle taken, or null before the first. */
  last: number | null;
  /** Caught up with the stored candles at least once. */
  live: boolean;
  pause: { reason: PauseReason; detail: string } | null;
}

const iso = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');

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

/**
 * Analysis of one instrument (architecture §7, one actor per instrument). It keeps one open live
 * run and, per timeframe, an indicator series fed with closed candles strictly in order:
 *
 * - **Warm-up**: each timeframe starts HISTORY_CANDLES candles before the run's start, so values
 *   are primed when the run goes live; those points are stored with `warmup` (open time before the
 *   run's `from`) and are not published.
 * - **Gaps**: a missing candle, or a partial one while its gap is still open, holds the timeframe
 *   back ("paused: data gap") until the backfill repairs it; nothing is skipped.
 * - **Determinism**: a run always starts from the same candles, so a restart recomputes the same
 *   values (written idempotently, and published only when first written) and carries on.
 *   Checkpoints, which make restarts cheap, arrive in Phase 4.
 */
export class InstrumentActor {
  private run: DetectionRunRow | null = null;
  private params: IndicatorParams | null = null;
  private problem: string | null = null;
  private readonly tfs = new Map<Timeframe, TfState>();
  private readonly now: () => number;
  private busy: Promise<void> = Promise.resolve();
  private pending = false;

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

  /** Steps the actor once now, or once more after the step in progress (wake-ups coalesce). */
  wake(boundary?: number): Promise<void> {
    if (this.pending) return this.busy;
    this.pending = true;
    this.busy = this.busy.then(async () => {
      this.pending = false;
      try {
        await this.step(boundary);
      } catch (err) {
        this.deps.log.error({ err, instrument: this.instrument.symbol }, 'analysis step failed');
      }
    });
    return this.busy;
  }

  /** Takes a changed profile: the open run is superseded by a new one at the next step. */
  update(instrument: AnalysedInstrument): void {
    this.instrument = instrument;
  }

  private async ensureRun(): Promise<boolean> {
    const { repo, log } = this.deps;
    const i = this.instrument;
    const parsed = ProfileParamsSchema.safeParse(i.params);
    if (!parsed.success) {
      this.problem = `profile ${i.profileName} v${i.profileVersion} has invalid indicator settings`;
      log.error({ instrument: i.symbol, issues: parsed.error.issues }, this.problem);
      return false;
    }
    this.problem = null;
    this.params = parsed.data.indicators;
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
      this.tfs.clear();
    }
    return true;
  }

  /** One pass over every timeframe: take every closed candle that is due, in order. */
  async step(boundary?: number): Promise<void> {
    if (!(await this.ensureRun())) return;
    const run = this.run!;
    for (const tf of TIMEFRAMES) {
      const state = this.tfs.get(tf) ?? (await this.start(tf, run));
      if (!state.series) continue;
      // A wake-up for a boundary before this timeframe's next close has nothing for it.
      if (boundary !== undefined && state.pause === null && state.next + TF_MS[tf] > boundary) continue;
      await this.advance(tf, state, run);
    }
    if (run.status === 'warming_up' && TIMEFRAMES.every((tf) => this.tfs.get(tf)?.live)) {
      await this.deps.repo.setStatus(run.id, 'running');
      run.status = 'running';
      this.deps.log.info(
        { instrument: this.instrument.symbol, runId: run.id },
        'warm-up complete; run is live',
      );
    }
  }

  /**
   * Decides where a timeframe's series starts; it stays unstarted while its history is incomplete.
   * The start is stored on the run the first time, and a restart takes it from there.
   */
  private async start(tf: Timeframe, run: DetectionRunRow): Promise<TfState> {
    const { repo } = this.deps;
    const state: TfState = { series: null, next: 0, last: null, live: false, pause: null };
    const fixed = run.series_origins[tf];
    if (fixed !== undefined) return this.begin(tf, state, fixed);
    const target = floorTo(run.from_time.getTime(), tf) - HISTORY_CANDLES * TF_MS[tf];
    const earliest = await repo.earliestOpenTime(this.instrument.id, tf);
    let origin = target;
    if (earliest === null || earliest > target) {
      const waiting =
        earliest === null ||
        (this.instrument.venue !== 'replay' && this.now() - run.started_at.getTime() < HISTORY_GRACE_MS) ||
        (await repo.openGapOverlaps(this.instrument.id, tf, target, earliest));
      if (waiting) {
        state.pause = { reason: 'warming_up', detail: `${tf}: waiting for history` };
        return state; // not stored: asked again at the next step
      }
      // The venue has less history than HISTORY_CANDLES: start where it starts.
      origin = earliest;
    }
    origin = await repo.fixOrigin(run.id, tf, origin);
    run.series_origins = { ...run.series_origins, [tf]: origin };
    return this.begin(tf, state, origin);
  }

  private begin(tf: Timeframe, state: TfState, origin: number): TfState {
    state.series = new IndicatorSeries(tf, this.params!);
    state.next = origin;
    this.tfs.set(tf, state);
    return state;
  }

  private async advance(tf: Timeframe, state: TfState, run: DetectionRunRow): Promise<void> {
    const { repo } = this.deps;
    const id = this.instrument.id;
    const size = TF_MS[tf];
    const from = run.from_time.getTime();
    state.pause = null;
    for (;;) {
      const candles = await repo.candlesFrom(id, tf, state.next, PAGE);
      const rows: NewIndicatorValue[] = [];
      const live: IndicatorPoint[] = [];
      let held = false;
      for (const c of candles) {
        if (c.openTime > state.next) {
          const repairing = await repo.openGapOverlaps(id, tf, state.next, c.openTime);
          state.pause = {
            reason: 'data_gap',
            detail: `${tf}: missing ${iso(state.next)}${repairing ? ' (backfill running)' : ''}`,
          };
          held = true;
          break;
        }
        if (c.quality === 'partial') {
          // A partial aggregate is final only once its missing minutes can no longer be repaired:
          // taking it earlier would leave values that stop matching the candle when it is rebuilt.
          const repairing = await repo.openGapOverlaps(id, tf, c.openTime, c.openTime + size);
          if (repairing || (await repo.awaitsRepair(id, c.openTime, c.openTime + size))) {
            state.pause = {
              reason: 'data_gap',
              detail: `${tf}: ${iso(c.openTime)} is missing minutes (${repairing ? 'backfill running' : 'waiting for repair'})`,
            };
            held = true;
            break;
          }
        }
        const values = state.series!.next(c);
        rows.push(toRow(id, tf, run.id, values));
        if (c.openTime >= from) live.push(toPoint(values, false));
        state.last = c.openTime;
        state.next = c.openTime + size;
      }
      // Only values stored just now are published: after a restart the recomputed ones are not.
      const written = await repo.insertValues(rows);
      await this.publish(
        tf,
        run.id,
        live.filter((p) => written.has(p.t)),
      );
      if (held) return;
      if (candles.length < PAGE) break;
    }
    state.live = true;
  }

  private async publish(tf: Timeframe, runId: string, points: IndicatorPoint[]): Promise<void> {
    for (const point of points) {
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
      this.deps.onPublished?.(tf, this.now() - (point.t + TF_MS[tf]));
    }
  }

  /** This instrument's state for System Health (`SystemHealth.analysis`). */
  async status(): Promise<AnalysisStatus | null> {
    if (!this.run) return null;
    const held: string[] = [];
    let reason: PauseReason | undefined;
    let lagMs: number | null = null;
    for (const tf of TIMEFRAMES) {
      const state = this.tfs.get(tf);
      if (!state) {
        held.push(`${tf}: waiting for history`);
        reason ??= 'warming_up';
        continue;
      }
      if (state.pause) {
        held.push(state.pause.detail);
        if (state.pause.reason === 'data_gap' || reason === undefined) reason = state.pause.reason;
      }
      const latest = await this.deps.repo.latestOpenTime(this.instrument.id, tf);
      if (latest !== null && state.last !== null) lagMs = Math.max(lagMs ?? 0, latest - state.last);
    }
    if (this.problem) held.unshift(this.problem);
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
