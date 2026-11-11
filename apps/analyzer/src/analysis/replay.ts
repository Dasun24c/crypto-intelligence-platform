import { type Job, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { REPLAY_QUEUE, type ReplayJob } from '@cip/contracts';
import { type Closure, floorTo, HISTORY_CANDLES, TF_MS, TIMEFRAMES } from '@cip/domain';
import type { Logger } from '@cip/observability';
import { analysisParams, RULESET_VERSION, toRow } from './actor.js';
import { RunProcessor } from './processor.js';
import type { AnalysisRepository } from './repository.js';
import type { RunInfo } from './smc-rows.js';
import type { SmcStore } from './smc-store.js';

export interface ReplayDeps {
  repo: AnalysisRepository;
  store: SmcStore;
  log: Logger;
  now?: () => number;
}

export interface ReplayResult {
  runId: string;
  /** sha256 over the replay's events decided in (from, to]. */
  digest: string;
  events: number;
  boundaries: number;
  /** The live run whose origins and profile the replay copied (its source run), if any. */
  liveRunId: string | null;
}

/** Boundaries per transaction. */
const BATCH = 2_000;
const DAY_MS = 86_400_000;

/**
 * Replays stored history as a new run (`mode = replay`, ADR 004): the same processor and engine as
 * live, over the boundaries up to `to`.
 *
 * When a live run of the instrument under the same rules had started its series by `from`, the replay
 * starts each timeframe where that run did (its series origins) with that run's profile, and records
 * it as its source: its state at `from` is then the live run's, and the digests over (from, to] must
 * be equal (criterion 4.3), whether the live run computed the period live or while warming up on
 * stored history. Otherwise every timeframe warms up on HISTORY_CANDLES of stored history before
 * `from`.
 *
 * A replay reads final history only: a candle that is not stored, or still awaiting repair, fails it.
 */
export async function runReplay(deps: ReplayDeps, job: ReplayJob): Promise<ReplayResult> {
  const { repo, store, log } = deps;
  const now = deps.now ?? Date.now;
  const instrument = await repo.instrument(job.instrumentId);
  if (!instrument) throw new Error(`unknown instrument ${job.instrumentId}`);
  const live = await repo.liveRunCovering(job.instrumentId, job.from, RULESET_VERSION);
  let profileId = instrument.profileId;
  let params = instrument.params;
  let paramsHash = instrument.paramsHash;
  let origins: Record<string, number> = {};
  if (live) {
    const profile = await repo.profileParams(live.profile_id);
    if (!profile) throw new Error(`profile ${live.profile_id} is missing`);
    profileId = live.profile_id;
    params = profile.params;
    paramsHash = profile.paramsHash;
    origins = { ...live.series_origins };
  } else {
    for (const tf of TIMEFRAMES) {
      const earliest = await repo.earliestOpenTime(instrument.id, tf);
      if (earliest === null || earliest > job.to) continue;
      origins[tf] = Math.max(floorTo(job.from, tf) - HISTORY_CANDLES * TF_MS[tf], earliest);
    }
  }
  const settings = analysisParams(params);
  const run = await repo.createReplayRun({
    id: job.runId,
    instrumentId: instrument.id,
    profileId,
    rulesetVersion: RULESET_VERSION,
    paramsHash,
    from: job.from,
    to: job.to,
    origins,
    requestedBy: job.requestedBy,
    sourceRunId: live?.id ?? null,
  });
  const starts = Object.values(run.series_origins);
  if (starts.length === 0) throw new Error('no stored candles to replay');
  const closures: Closure[] = instrument.calendarId
    ? await repo.closures(instrument.calendarId, Math.min(...starts) - 7 * DAY_MS, job.to + 7 * DAY_MS)
    : [];
  const context = { closures };
  const proc = new RunProcessor(repo, {
    instrumentId: instrument.id,
    tick: instrument.tick,
    indicators: settings.indicators,
    smc: settings.smc,
    context: () => context,
  });
  for (const tf of TIMEFRAMES) {
    const origin = run.series_origins[tf];
    if (origin !== undefined) proc.join(tf, origin);
  }
  const info: RunInfo = { runId: run.id, instrumentId: instrument.id, from: job.from, live: false };
  let boundaries = 0;
  for (;;) {
    const stop = await proc.advance({ until: job.to, max: BATCH, strict: true });
    const out = proc.drain();
    boundaries += out.boundaries;
    if (out.boundaries > 0)
      await store.write({
        info,
        values: out.values.map((v) => toRow(instrument.id, v.tf, run.id, v.values)),
        events: out.events,
        now: now(),
      });
    if (stop.kind !== 'limit') break;
  }
  const { digest, events } = await store.digest(run.id, job.from, job.to);
  await repo.finishReplay(run.id, 'completed', digest, new Date(now()));
  log.info({ runId: run.id, instrument: instrument.symbol, boundaries, events, digest }, 'replay completed');
  return { runId: run.id, digest, events, boundaries, liveRunId: run.source_run_id };
}

/** Takes replays from the `replay` queue (enqueued by `POST /replays`), one at a time. */
export class ReplayWorker {
  private worker: Worker<ReplayJob, ReplayResult> | null = null;

  constructor(private readonly deps: ReplayDeps & { redisUrl: string; prefix: string }) {}

  start(): void {
    this.worker = new Worker<ReplayJob, ReplayResult>(
      REPLAY_QUEUE,
      async (job: Job<ReplayJob>) => {
        try {
          return await runReplay(this.deps, job.data);
        } catch (err) {
          await this.deps.repo.finishReplay(job.data.runId, 'failed', null).catch(() => undefined);
          this.deps.log.warn({ err, runId: job.data.runId }, 'replay failed');
          throw err;
        }
      },
      {
        connection: new Redis(this.deps.redisUrl, {
          maxRetriesPerRequest: null,
          connectionName: 'cip-analyzer-replays',
        }),
        prefix: this.deps.prefix,
        concurrency: 1,
      },
    );
  }

  async stop(): Promise<void> {
    await this.worker?.close();
  }
}
