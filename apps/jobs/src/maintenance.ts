import { type Job, Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { type Kysely, sql } from 'kysely';
import type { Database } from '@cip/db';
import type { Logger } from '@cip/observability';

export const MAINTENANCE_QUEUE = 'maintenance';
export const PRUNE_REFRESH_TOKENS = 'refresh-tokens.prune';
/** Expired or revoked tokens are kept this long for investigations, then removed. */
export const REFRESH_TOKEN_RETENTION_DAYS = 7;

export type MaintenanceJob = { name: typeof PRUNE_REFRESH_TOKENS; data: Record<string, never> };

/** Deletes refresh tokens that expired, or were revoked, more than the retention period ago. */
export async function pruneRefreshTokens(db: Kysely<Database>): Promise<number> {
  const cutoff = sql<Date>`now() - make_interval(days => ${REFRESH_TOKEN_RETENTION_DAYS})`;
  // Successors point at their predecessors (replaced_by), so delete whole families whose newest token is old.
  const result = await db
    .deleteFrom('app.refresh_tokens')
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('app.refresh_tokens as live')
            .select('live.id')
            .whereRef('live.family_id', '=', 'app.refresh_tokens.family_id')
            .where((w) =>
              w.and([
                w('live.expires_at', '>', cutoff),
                w.or([w('live.revoked_at', 'is', null), w('live.revoked_at', '>', cutoff)]),
              ]),
            ),
        ),
      ),
    )
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

export interface MaintenanceOptions {
  redisUrl: string;
  prefix: string;
  pruneEveryMs: number;
  db: Kysely<Database>;
  log: Logger;
  onCompleted?: (name: string) => void;
  onFailed?: (name: string) => void;
}

/**
 * The maintenance queue: one BullMQ job scheduler and one worker (ADR 003: BullMQ carries units of
 * work). Later phases add their queues (ai-analysis, notifications, backfill, ...) the same way.
 */
export class Maintenance {
  readonly queue: Queue;
  readonly worker: Worker;
  private readonly connections: Redis[] = [];

  constructor(private readonly opts: MaintenanceOptions) {
    // BullMQ needs maxRetriesPerRequest: null for blocking worker connections.
    const connection = () => {
      const c = new Redis(opts.redisUrl, { maxRetriesPerRequest: null, connectionName: 'cip-jobs-bullmq' });
      this.connections.push(c);
      return c;
    };
    this.queue = new Queue(MAINTENANCE_QUEUE, { connection: connection(), prefix: opts.prefix });
    this.worker = new Worker(MAINTENANCE_QUEUE, (job) => this.process(job), {
      connection: connection(),
      prefix: opts.prefix,
      concurrency: 1,
    });
    this.worker.on('completed', (job) => opts.onCompleted?.(job.name));
    this.worker.on('failed', (job, err) => {
      opts.log.error({ err, job: job?.name, attempts: job?.attemptsMade }, 'maintenance job failed');
      opts.onFailed?.(job?.name ?? 'unknown');
    });
  }

  async start(): Promise<void> {
    await this.queue.upsertJobScheduler(
      PRUNE_REFRESH_TOKENS,
      { every: this.opts.pruneEveryMs },
      {
        name: PRUNE_REFRESH_TOKENS,
        data: {},
        opts: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 10_000 },
          removeOnComplete: 100,
          removeOnFail: 500,
        },
      },
    );
    await this.worker.waitUntilReady();
  }

  private async process(job: Job): Promise<{ deleted: number }> {
    if (job.name !== PRUNE_REFRESH_TOKENS) throw new Error(`unknown maintenance job ${job.name}`);
    const deleted = await pruneRefreshTokens(this.opts.db);
    this.opts.log.info({ job: job.name, deleted }, 'pruned refresh tokens');
    return { deleted };
  }

  async counts(): Promise<Record<string, number>> {
    return this.queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
  }

  async close(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
    await Promise.all(this.connections.map((c) => c.quit().catch(() => c.disconnect())));
  }
}
