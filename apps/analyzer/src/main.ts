import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type pg from 'pg';
import { createDb } from '@cip/db';
import { ConfigError, INSTANCE_ID, PinoNestLogger, runService } from '@cip/observability';
import { Analyzer } from './analysis/analyzer.js';
import { loadAnalyzerConfig } from './config.js';
import { AnalyzerModule, AnalyzerStatus, PG_POOL } from './analyzer.module.js';

async function main(): Promise<void> {
  const config = loadAnalyzerConfig();
  await runService('analyzer', config, async ({ log, redis, meter }) => {
    const app = await NestFactory.createApplicationContext(AnalyzerModule.forRoot(config, redis), {
      logger: new PinoNestLogger(log),
    });
    const status = app.get(AnalyzerStatus);
    const analyzer = new Analyzer({
      db: createDb({ pool: app.get<pg.Pool>(PG_POOL) }),
      redis,
      redisUrl: config.REDIS_URL,
      log,
      meter,
      instance: INSTANCE_ID,
    });
    await analyzer.start();
    return {
      probe: () => analyzer.probe(),
      readiness: () => status.readiness(),
      stop: async () => {
        await analyzer.stop();
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
