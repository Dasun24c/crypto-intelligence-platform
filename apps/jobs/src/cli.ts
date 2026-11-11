#!/usr/bin/env node
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createDb } from '@cip/db';
import { BinanceVenue, CoinbaseVenue } from '@cip/exchange-adapters';
import { createLogger, INSTANCE_ID } from '@cip/observability';
import type { BackfillJob } from './backfill.js';
import { checkConsistency, previousDay } from './consistency.js';
import { loadJobsConfig } from './config.js';
import { gapRepairer } from './gap-repairs.js';

/**
 * `cip-jobs consistency [YYYY-MM-DD]`  compare a UTC day's stored candles with the venues' REST
 * candles (default: yesterday) and print the report; exit 2 when anything differs. Missing minutes
 * are recorded as gaps and queued for the running jobs service to repair, as the nightly check does.
 */
async function main(command: string | undefined, arg: string | undefined): Promise<number> {
  const config = loadJobsConfig();
  const log = createLogger({ service: 'jobs', instance: INSTANCE_ID, level: config.LOG_LEVEL });
  if (command !== 'consistency') {
    log.error({ command }, 'usage: cip-jobs consistency [YYYY-MM-DD]');
    return 64;
  }
  const range = arg
    ? { from: Date.parse(`${arg}T00:00:00Z`), to: Date.parse(`${arg}T00:00:00Z`) + 86_400_000 }
    : previousDay(Date.now());
  if (Number.isNaN(range.from)) {
    log.error({ arg }, 'the day must be YYYY-MM-DD');
    return 64;
  }
  const db = createDb({ connectionString: config.DATABASE_URL, max: 2, applicationName: 'cip-jobs-cli' });
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, connectionName: 'cip-jobs-cli' });
  const queue = new Queue<BackfillJob>('backfill', { connection: redis, prefix: config.QUEUE_PREFIX });
  const hooks = { onEvent: () => undefined, onUnparsed: () => undefined, onStatus: () => undefined };
  try {
    const report = await checkConsistency(
      {
        db,
        redis,
        log,
        venues: { binance: new BinanceVenue(hooks), coinbase: new CoinbaseVenue(hooks) },
        repair: gapRepairer(db, redis, queue),
      },
      range,
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 2;
  } finally {
    await queue.close();
    await redis.quit().catch(() => redis.disconnect());
    await db.destroy();
  }
}

process.exitCode = await main(process.argv[2], process.argv[3]);
