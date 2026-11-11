import 'reflect-metadata';
import { DelayedError, Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createDb, createPool, pingDb } from '@cip/db';
import { BinanceVenue, CoinbaseVenue } from '@cip/exchange-adapters';
import { checkDependencies, ConfigError, runService } from '@cip/observability';
import { Backfiller, type BackfillJob, GapNotRepairable, GapNotSettled } from './backfill.js';
import { loadJobsConfig } from './config.js';
import { CONSISTENCY_CHECK, CONSISTENCY_PATTERN, checkConsistency, previousDay } from './consistency.js';
import { gapRepairer, HOLE_SWEEP, HOLE_SWEEP_EVERY_MS, sweepHoles } from './gap-repairs.js';
import { Maintenance } from './maintenance.js';
import {
  GENERATE_CLOSURES,
  GENERATE_CLOSURES_EVERY_MS,
  generateGoldClosures,
  PAIR_STATUS,
  PAIR_STATUS_EVERY_MS,
  refreshPairStatus,
} from './market-jobs.js';

async function main(): Promise<void> {
  const config = loadJobsConfig();
  await runService('jobs', config, async ({ log, redis, meter }) => {
    const pool = createPool({ connectionString: config.DATABASE_URL, max: 6, applicationName: 'cip-jobs' });
    const db = createDb({ pool });
    const completed = meter.createCounter('cip_jobs_completed_total', {
      description: 'Jobs completed, by queue and name',
    });
    const failed = meter.createCounter('cip_jobs_failed_total', {
      description: 'Jobs failed, by queue and name',
    });
    // Public REST clients (no credentials) for pair status and gap repair; budgets live in each client.
    const noHooks = { onEvent: () => undefined, onUnparsed: () => undefined, onStatus: () => undefined };
    const venues = { binance: new BinanceVenue(noHooks), coinbase: new CoinbaseVenue(noHooks) };
    const queueRedis = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: null,
      connectionName: 'cip-jobs-backfill',
    });
    const backfillQueue = new Queue<BackfillJob>('backfill', {
      connection: queueRedis,
      prefix: config.QUEUE_PREFIX,
    });
    const maintenance = new Maintenance({
      redisUrl: config.REDIS_URL,
      prefix: config.QUEUE_PREFIX,
      pruneEveryMs: config.PRUNE_REFRESH_TOKENS_EVERY_MS,
      tasks: [
        {
          name: PAIR_STATUS,
          everyMs: PAIR_STATUS_EVERY_MS,
          run: async () => {
            const r = await refreshPairStatus({ db, redis, log, venues });
            return { checked: r.checked, changed: r.changed.length };
          },
        },
        {
          name: CONSISTENCY_CHECK,
          pattern: CONSISTENCY_PATTERN,
          run: async () => {
            const report = await checkConsistency(
              { db, redis, log, venues, repair: gapRepairer(db, redis, backfillQueue) },
              previousDay(Date.now()),
            );
            return {
              ok: report.ok,
              failing: report.results.filter((r) => r.differences > 0).length,
              holes: report.holes.length,
            };
          },
        },
        {
          name: HOLE_SWEEP,
          everyMs: HOLE_SWEEP_EVERY_MS,
          run: async () => ({
            recorded: await sweepHoles(db, gapRepairer(db, redis, backfillQueue), Date.now()),
          }),
        },
        {
          name: GENERATE_CLOSURES,
          everyMs: GENERATE_CLOSURES_EVERY_MS,
          run: async () => ({ inserted: await generateGoldClosures(db) }),
        },
      ],
      db,
      log,
      onCompleted: (name) => completed.add(1, { queue: 'maintenance', name }),
      onFailed: (name) => failed.add(1, { queue: 'maintenance', name }),
    });
    await maintenance.start();

    // The closure table must cover today before anything reads it; the daily job keeps it 8 weeks ahead.
    await generateGoldClosures(db).catch((err: unknown) => log.warn({ err }, 'closure generation failed'));

    // Gap repair from the venues' public REST APIs (architecture §5.4).
    const backfiller = new Backfiller(db, redis, log, venues);
    const backfill = new Worker<BackfillJob>(
      'backfill',
      async (job, token) => {
        try {
          return await backfiller.run(job.data);
        } catch (err) {
          if (!(err instanceof GapNotSettled)) throw err;
          // Not a failure and no attempt used: run again once the venue has published the last minute.
          await job.moveToDelayed(Date.now() + err.waitMs, token);
          throw new DelayedError();
        }
      },
      { connection: queueRedis.duplicate(), prefix: config.QUEUE_PREFIX, concurrency: 2 },
    );
    backfill.on('completed', () => completed.add(1, { queue: 'backfill', name: 'gap' }));
    backfill.on('failed', (job, err) => {
      failed.add(1, { queue: 'backfill', name: 'gap' });
      if (!job) return;
      const final = err instanceof GapNotRepairable || job.attemptsMade >= (job.opts.attempts ?? 1);
      log.warn({ err, gapId: job.data.id, attempts: job.attemptsMade, final }, 'backfill failed');
      if (final)
        void backfiller
          .markUnrepairable(job.data.id, err.message)
          .catch((e: unknown) => log.error({ err: e }, 'could not mark gap'));
    });

    return {
      async probe() {
        const [m, b] = await Promise.all([
          maintenance.counts(),
          backfillQueue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
        ]);
        const running = maintenance.worker.isRunning() && backfill.isRunning();
        return {
          status: running && (m.failed ?? 0) < 10 ? 'ok' : 'degraded',
          detail: `${running ? 'workers running' : 'a worker stopped'}; backfill: ${b.waiting ?? 0} waiting, ${b.active ?? 0} active, ${b.failed ?? 0} failed; maintenance: ${m.delayed ?? 0} scheduled`,
        };
      },
      readiness: () => checkDependencies({ database: () => pingDb(pool), redis: () => redis.ping() }),
      async stop() {
        await backfill.close();
        await backfillQueue.close();
        await maintenance.close();
        await queueRedis.quit().catch(() => queueRedis.disconnect());
        await db.destroy();
      },
    };
  });
}

main().catch((err: unknown) => {
  process.stderr.write(
    err instanceof ConfigError ? `${err.message}\n` : `jobs failed to start: ${String(err)}\n`,
  );
  process.exit(1);
});
