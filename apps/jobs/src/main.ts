import 'reflect-metadata';
import { createDb, createPool, pingDb } from '@cip/db';
import { checkDependencies, ConfigError, runService } from '@cip/observability';
import { loadJobsConfig } from './config.js';
import { Maintenance } from './maintenance.js';

async function main(): Promise<void> {
  const config = loadJobsConfig();
  await runService('jobs', config, async ({ log, redis, meter }) => {
    const pool = createPool({ connectionString: config.DATABASE_URL, max: 4, applicationName: 'cip-jobs' });
    const db = createDb({ pool });
    const completed = meter.createCounter('cip_jobs_completed_total', {
      description: 'Jobs completed, by queue and name',
    });
    const failed = meter.createCounter('cip_jobs_failed_total', {
      description: 'Jobs failed, by queue and name',
    });
    const maintenance = new Maintenance({
      redisUrl: config.REDIS_URL,
      prefix: config.QUEUE_PREFIX,
      pruneEveryMs: config.PRUNE_REFRESH_TOKENS_EVERY_MS,
      db,
      log,
      onCompleted: (name) => completed.add(1, { queue: 'maintenance', name }),
      onFailed: (name) => failed.add(1, { queue: 'maintenance', name }),
    });
    await maintenance.start();
    return {
      async probe() {
        const c = await maintenance.counts();
        const state = maintenance.worker.isRunning() ? 'worker running' : 'worker stopped';
        return {
          status: maintenance.worker.isRunning() && (c.failed ?? 0) < 10 ? 'ok' : 'degraded',
          detail: `${state}; maintenance queue: ${c.waiting ?? 0} waiting, ${c.delayed ?? 0} scheduled, ${c.failed ?? 0} failed`,
        };
      },
      readiness: () => checkDependencies({ database: () => pingDb(pool), redis: () => redis.ping() }),
      async stop() {
        await maintenance.close();
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
