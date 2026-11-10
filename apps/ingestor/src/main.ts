import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type pg from 'pg';
import { createDb } from '@cip/db';
import { ConfigError, INSTANCE_ID, PinoNestLogger, runService } from '@cip/observability';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseRecording } from '@cip/exchange-adapters';
import { checkReplayConfig, loadIngestorConfig } from './config.js';
import { IngestorModule, IngestorStatus, PG_POOL } from './ingestor.module.js';
import { MarketIngestor } from './market/ingestor.js';

async function main(): Promise<void> {
  const config = loadIngestorConfig();
  checkReplayConfig(config);
  const recordings = config.REPLAY_FILES.map((file) => {
    const raw = readFileSync(file);
    return parseRecording((file.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8'));
  });
  await runService('ingestor', config, async ({ log, redis, meter }) => {
    const app = await NestFactory.createApplicationContext(IngestorModule.forRoot(config, redis), {
      logger: new PinoNestLogger(log),
    });
    const status = app.get(IngestorStatus);
    const market = new MarketIngestor({
      db: createDb({ pool: app.get<pg.Pool>(PG_POOL) }),
      redis,
      redisUrl: config.REDIS_URL,
      log,
      meter,
      instance: INSTANCE_ID,
      queuePrefix: config.QUEUE_PREFIX,
      profileBuckets: config.PROFILE_BUCKETS,
      backfillDays: config.BACKFILL_DAYS,
      source: config.MARKET_SOURCE === 'replay' ? { kind: 'replay', recordings } : { kind: 'live' },
    });
    await market.start();
    return {
      probe: () => market.probe(),
      readiness: () => status.readiness(),
      stop: async () => {
        await market.stop();
        await app.close();
      },
    };
  });
}

main().catch((err: unknown) => {
  process.stderr.write(
    err instanceof ConfigError ? `${err.message}\n` : `ingestor failed to start: ${String(err)}\n`,
  );
  process.exit(1);
});
