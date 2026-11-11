import { createHash } from 'node:crypto';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { type Job, Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { REPLAY_QUEUE, type ReplayJob, type ReplayRequest, type ReplayStatus } from '@cip/contracts';
import type { Database } from '@cip/db';
import { digestLine } from '@cip/smc-engine';
import { ProblemError } from '../common/problem.js';
import type { ApiConfig } from '../config.js';
import { API_CONFIG, DB } from '../tokens.js';

/** API contracts §8: at most two replays running per user. */
export const REPLAYS_PER_USER = 2;

/**
 * Replays (API contracts §3 "Setups and replays", ADR 017): requests go on the `replay` queue,
 * which the analyzer takes; the status reads the replay run and compares its digest with the live
 * run's over the same period (criterion 4.3).
 */
@Injectable()
export class ReplayService implements OnModuleDestroy {
  private readonly queue: Queue<ReplayJob>;
  private readonly connection: Redis;

  constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(API_CONFIG) config: ApiConfig,
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
    const pending = await this.queue.getJobs(['waiting', 'active', 'delayed']);
    if (pending.filter((j) => j.data.requestedBy === userId).length >= REPLAYS_PER_USER)
      throw new ProblemError('RATE_LIMITED', `At most ${REPLAYS_PER_USER} replays may run at once.`);
    const runId = uuidv7();
    await this.queue.add(
      'replay',
      { runId, instrumentId: req.instrumentId, from: req.from, to: req.to, requestedBy: userId },
      { jobId: runId, attempts: 1, removeOnComplete: { count: 500 }, removeOnFail: { count: 500 } },
    );
    return runId;
  }

  async status(runId: string): Promise<ReplayStatus> {
    const run = await this.db
      .selectFrom('analysis.detection_runs')
      .selectAll()
      .where('id', '=', runId)
      .where('mode', '=', 'replay')
      .executeTakeFirst();
    const job = (await this.queue.getJob(runId)) as Job<ReplayJob> | undefined;
    const failure = job && (await job.getState()) === 'failed' ? (job.failedReason ?? 'failed') : null;
    if (!run) {
      if (!job) throw new ProblemError('NOT_FOUND', 'No such replay.');
      return {
        runId,
        instrumentId: job.data.instrumentId,
        status: failure ? 'failed' : 'queued',
        from: job.data.from,
        to: job.data.to,
        digest: null,
        events: null,
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
      digest: run.result_digest,
      events: null,
      comparison: null,
      error: run.status === 'failed' ? (failure ?? 'failed') : null,
    };
    if (run.status !== 'completed') return base;
    const mine = await this.digest(runId, from, to);
    // The live run the replay copied its origins and profile from (ADR 017), if one covered the period.
    const live = run.source_run_id;
    if (!live) return { ...base, events: mine.events };
    const theirs = await this.digest(live, from, to);
    return {
      ...base,
      events: mine.events,
      comparison: {
        liveRunId: live,
        from,
        to,
        liveEvents: theirs.events,
        replayEvents: mine.events,
        liveDigest: theirs.digest,
        replayDigest: mine.digest,
        equal: theirs.digest === mine.digest,
      },
    };
  }

  /** sha256 over a run's events decided in (from, to], in seq order (the analyzer's digest). */
  private async digest(runId: string, from: number, to: number): Promise<{ digest: string; events: number }> {
    const hash = createHash('sha256');
    const rows = await this.db
      .selectFrom('analysis.detection_events')
      .select(['seq', 'type', 'timeframe', 'candle_time', 'payload'])
      .where('run_id', '=', runId)
      .where('candle_time', '>', new Date(from))
      .where('candle_time', '<=', new Date(to))
      .orderBy('seq')
      .execute();
    for (const r of rows) {
      const p = r.payload as { key: string; data: unknown };
      hash.update(
        digestLine({
          seq: Number(r.seq),
          type: r.type,
          tf: r.timeframe,
          time: r.candle_time.getTime(),
          key: p.key,
          data: p.data,
        }),
      );
    }
    return { digest: hash.digest('hex'), events: rows.length };
  }
}
