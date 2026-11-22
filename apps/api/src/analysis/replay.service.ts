import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { type Job, Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import {
  applyReplaySettings,
  ProfileParamsSchema,
  REPLAY_QUEUE,
  type ReplayBaseSettings,
  type ReplayJob,
  type ReplayRequest,
  type ReplaySettings,
  type ReplayStatus,
  type ReplaySummary,
  type ReplaysQuery,
  replaySettingsOf,
  type RunComparison,
} from '@cip/contracts';
import type { Database } from '@cip/db';
import { validateSmcParams } from '@cip/smc-engine';
import { ProblemError } from '../common/problem.js';
import type { ApiConfig } from '../config.js';
import { type ComparedRun, ComparisonService } from '../history/comparison.service.js';
import { API_CONFIG, DB } from '../tokens.js';

/** API contracts §8: at most two replays running per user. */
export const REPLAYS_PER_USER = 2;

/** Queued, running and recently failed jobs the list looks at (failed ones are kept 500 deep). */
const JOB_STATES = ['waiting', 'active', 'delayed', 'failed'] as const;

/**
 * Throws a validation problem when settings changed for a replay do not make a valid profile:
 * the same checks the analyzer makes before it runs one (ProfileParamsSchema, then the engine's).
 */
export function checkReplaySettings(params: unknown, settings: ReplaySettings): void {
  let changed: unknown;
  try {
    changed = applyReplaySettings(params, settings);
  } catch (err) {
    throw new ProblemError('VALIDATION_FAILED', (err as Error).message);
  }
  const parsed = ProfileParamsSchema.safeParse(changed);
  if (!parsed.success || !parsed.data.smc)
    throw new ProblemError('VALIDATION_FAILED', 'These settings do not make a valid profile.');
  try {
    validateSmcParams(parsed.data.smc);
  } catch (err) {
    throw new ProblemError(
      'VALIDATION_FAILED',
      `These settings do not make a valid profile: ${(err as Error).message}`,
    );
  }
}

/**
 * Replays (API contracts §3 "Setups and replays", ADR 017 and 026): requests go on the `replay`
 * queue, which the analyzer takes; a replay may change some settings for itself. The status reads
 * the replay run and compares it with the live run it started from (criterion 4.3), or with any
 * other run of the instrument (criterion 12.3).
 */
@Injectable()
export class ReplayService implements OnModuleDestroy {
  private readonly queue: Queue<ReplayJob>;
  private readonly connection: Redis;

  constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(API_CONFIG) config: ApiConfig,
    private readonly comparisons: ComparisonService,
  ) {
    this.connection = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: null,
      connectionName: 'cip-api-replays',
      lazyConnect: true,
    });
    this.queue = new Queue<ReplayJob>(REPLAY_QUEUE, {
      connection: this.connection,
      prefix: config.QUEUE_PREFIX,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    this.connection.disconnect();
  }

  async request(req: ReplayRequest, userId: string): Promise<string> {
    if (req.settings) {
      const profile = await this.db
        .selectFrom('market.instruments as i')
        .innerJoin('market.instrument_profiles as p', 'p.id', 'i.profile_id')
        .select('p.params')
        .where('i.id', '=', req.instrumentId)
        .executeTakeFirst();
      if (!profile)
        throw new ProblemError('VALIDATION_FAILED', 'The instrument has no profile to replay with.');
      checkReplaySettings(profile.params, req.settings);
    }
    const pending = await this.queue.getJobs(['waiting', 'active', 'delayed']);
    if (pending.filter((j) => j.data.requestedBy === userId).length >= REPLAYS_PER_USER)
      throw new ProblemError('RATE_LIMITED', `At most ${REPLAYS_PER_USER} replays may run at once.`);
    const runId = uuidv7();
    await this.queue.add(
      'replay',
      {
        runId,
        instrumentId: req.instrumentId,
        from: req.from,
        to: req.to,
        requestedBy: userId,
        settings: req.settings ?? null,
      },
      { jobId: runId, attempts: 1, removeOnComplete: { count: 500 }, removeOnFail: { count: 500 } },
    );
    return runId;
  }

  /** The instrument's profile now, and its values of the settings a replay may change. */
  async baseSettings(instrumentId: string): Promise<ReplayBaseSettings> {
    const profile = await this.db
      .selectFrom('market.instruments as i')
      .innerJoin('market.instrument_profiles as p', 'p.id', 'i.profile_id')
      .select(['p.name', 'p.version', 'p.params'])
      .where('i.id', '=', instrumentId)
      .executeTakeFirst();
    if (!profile) throw new ProblemError('NOT_FOUND', 'The instrument has no profile to replay with.');
    try {
      return {
        instrumentId,
        profile: { name: profile.name, version: profile.version },
        settings: replaySettingsOf(profile.params),
      };
    } catch (err) {
      throw new ProblemError('CONFLICT', (err as Error).message);
    }
  }

  /** Replays newest first: runs the analyzer has started, and jobs still queued or failed before one. */
  async list(q: ReplaysQuery, userId: string): Promise<ReplaySummary[]> {
    let runsQuery = this.db
      .selectFrom('analysis.detection_runs')
      .selectAll()
      .where('mode', '=', 'replay')
      .orderBy('started_at', 'desc')
      .orderBy('id', 'desc')
      .limit(q.limit);
    if (q.instrumentId) runsQuery = runsQuery.where('instrument_id', '=', q.instrumentId);
    const [runs, jobs] = await Promise.all([
      runsQuery.execute(),
      this.queue.getJobs([...JOB_STATES], 0, 499),
    ]);
    const jobById = new Map(jobs.filter((j): j is Job<ReplayJob> => !!j?.id).map((j) => [j.id!, j]));
    const failures = new Map<string, string>();
    for (const j of jobs) if (j?.failedReason) failures.set(j.id!, j.failedReason);
    const fromRuns: ReplaySummary[] = runs.map((r) => ({
      runId: r.id,
      instrumentId: r.instrument_id,
      status: r.status === 'completed' || r.status === 'failed' ? r.status : 'running',
      from: r.from_time.getTime(),
      to: r.to_time!.getTime(),
      settings: (r.settings as ReplaySettings | null) ?? null,
      sourceRunId: r.source_run_id,
      digest: r.result_digest,
      requestedAt: jobById.get(r.id)?.timestamp ?? r.started_at.getTime(),
      finishedAt: r.finished_at?.getTime() ?? null,
      mine: r.requested_by === userId,
      error: r.status === 'failed' ? (failures.get(r.id) ?? 'failed') : null,
    }));
    const started = new Set(runs.map((r) => r.id));
    const known = await this.knownRuns([...jobById.keys()].filter((id) => !started.has(id)));
    const fromJobs: ReplaySummary[] = [...jobById.values()]
      .filter((j) => !started.has(j.id!) && !known.has(j.id!))
      .filter((j) => !q.instrumentId || j.data.instrumentId === q.instrumentId)
      .map((j) => ({
        runId: j.data.runId,
        instrumentId: j.data.instrumentId,
        status: j.failedReason ? 'failed' : 'queued',
        from: j.data.from,
        to: j.data.to,
        settings: j.data.settings ?? null,
        sourceRunId: null,
        digest: null,
        requestedAt: j.timestamp,
        finishedAt: j.finishedOn ?? null,
        mine: j.data.requestedBy === userId,
        error: j.failedReason ?? null,
      }));
    return [...fromJobs, ...fromRuns].sort((a, b) => b.requestedAt - a.requestedAt).slice(0, q.limit);
  }

  /** Runs among `ids` that exist (older than the page of runs listed). */
  private async knownRuns(ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await this.db
      .selectFrom('analysis.detection_runs')
      .select('id')
      .where('id', 'in', ids)
      .execute();
    return new Set(rows.map((r) => r.id));
  }

  async status(runId: string, compareWith?: string): Promise<ReplayStatus> {
    const run = await this.comparisons.run(runId);
    const job = (await this.queue.getJob(runId)) as Job<ReplayJob> | undefined;
    const failure = job && (await job.getState()) === 'failed' ? (job.failedReason ?? 'failed') : null;
    if (!run || run.mode !== 'replay') {
      if (!job || run) throw new ProblemError('NOT_FOUND', 'No such replay.');
      return {
        runId,
        instrumentId: job.data.instrumentId,
        status: failure ? 'failed' : 'queued',
        from: job.data.from,
        to: job.data.to,
        settings: job.data.settings ?? null,
        sourceRunId: null,
        digest: null,
        events: null,
        requestedAt: job.timestamp,
        finishedAt: job.finishedOn ?? null,
        comparison: null,
        error: failure,
      };
    }
    const from = run.from_time.getTime();
    const to = run.to_time!.getTime();
    const base: ReplayStatus = {
      runId,
      instrumentId: run.instrument_id,
      status: run.status === 'completed' || run.status === 'failed' ? run.status : 'running',
      from,
      to,
      settings: (run.settings as ReplaySettings | null) ?? null,
      sourceRunId: run.source_run_id,
      digest: run.result_digest,
      events: null,
      requestedAt: job?.timestamp ?? run.started_at.getTime(),
      finishedAt: run.finished_at?.getTime() ?? null,
      comparison: null,
      error: run.status === 'failed' ? (failure ?? 'failed') : null,
    };
    if (compareWith === runId)
      throw new ProblemError('VALIDATION_FAILED', 'Compare a replay with another run.');
    let other: ComparedRun | null = null;
    if (compareWith) {
      other = await this.comparisons.run(compareWith);
      if (!other) throw new ProblemError('NOT_FOUND', 'No such run to compare with.');
    }
    if (run.status !== 'completed') return base;
    const mine = await this.comparisons.digest(runId, from, to);
    // By default, the live run the replay copied its origins and profile from (ADR 017), if any.
    other ??= run.source_run_id ? await this.comparisons.run(run.source_run_id) : null;
    if (!other) return { ...base, events: mine.events };
    const comparison: RunComparison = await this.comparisons.compare(other, run);
    return { ...base, events: mine.events, comparison };
  }
}
