import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type pg from 'pg';
import { NOTIFICATIONS_QUEUE } from '@cip/contracts';
import { createDb } from '@cip/db';
import { ConfigError, INSTANCE_ID, PinoNestLogger, runService } from '@cip/observability';
import { Analyzer } from './analysis/analyzer.js';
import { AnalysisRepository } from './analysis/repository.js';
import { ReplayWorker } from './analysis/replay.js';
import { SmcStore } from './analysis/smc-store.js';
import { loadAnalyzerConfig } from './config.js';
import { AnalyzerModule, AnalyzerStatus, PG_POOL } from './analyzer.module.js';

async function main(): Promise<void> {
  const config = loadAnalyzerConfig();
  await runService('analyzer', config, async ({ log, redis, meter }) => {
    const app = await NestFactory.createApplicationContext(AnalyzerModule.forRoot(config, redis), {
      logger: new PinoNestLogger(log),
    });
    const status = app.get(AnalyzerStatus);
    const db = createDb({ pool: app.get<pg.Pool>(PG_POOL) });
    // Fired alerts are delivered by the jobs service (ADR 020).
    const notifications = new Queue(NOTIFICATIONS_QUEUE, {
      connection: new Redis(config.REDIS_URL, {
        maxRetriesPerRequest: null,
        connectionName: 'cip-analyzer-alerts',
      }),
      prefix: config.QUEUE_PREFIX,
    });
    const analyzer = new Analyzer({
      db,
      redis,
      redisUrl: config.REDIS_URL,
      log,
      meter,
      instance: INSTANCE_ID,
      alerts: { queue: notifications },
    });
    await analyzer.start();
    // Replays (ADR 017): the same engine on stored history, one at a time.
    const replays = new ReplayWorker({
      repo: new AnalysisRepository(db),
      store: new SmcStore(db),
      log,
      redisUrl: config.REDIS_URL,
      prefix: config.QUEUE_PREFIX,
    });
    replays.start();
    return {
      probe: () => analyzer.probe(),
      activity: () => analyzer.activity(),
      readiness: () => status.readiness(),
      stop: async () => {
        await replays.stop();
        await analyzer.stop();
        await notifications.close();
        await app.close();
      },
    };
  });
}

main().catch((err: unknown) => {
  process.stderr.write(
    err instanceof ConfigError ? `${err.message}\n` : `analyzer failed to start: ${String(err)}\n`,
  );
  process.exit(1);
});
