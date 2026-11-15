import 'reflect-metadata';
import type { Redis } from 'ioredis';
import {
  ConfigError,
  createLogger,
  HeartbeatPublisher,
  INSTANCE_ID,
  initMetrics,
  initTracing,
  PROCESS_STARTED_AT,
  startOpsServer,
} from '@cip/observability';
import { createApiApp } from './app.js';
import { loadApiConfig } from './config.js';
import { HealthService } from './system/health.service.js';
import { REDIS } from './tokens.js';

async function main(): Promise<void> {
  const config = loadApiConfig();
  const log = createLogger({
    service: 'api',
    instance: INSTANCE_ID,
    level: config.LOG_LEVEL,
    pretty: config.LOG_PRETTY,
  });
  const id = { service: 'api', instance: INSTANCE_ID, version: config.APP_VERSION };
  const tracing = initTracing(id, config.OTEL_EXPORTER_OTLP_ENDPOINT);
  const metrics = initMetrics(id);

  const app = await createApiApp({ config, logger: log });
  await app.listen(config.API_PORT, config.API_HOST);

  const health = app.get(HealthService);
  const ops = await startOpsServer({
    port: config.OPS_PORT,
    metrics: metrics.handle,
    readiness: () => health.readiness(),
  });
  const heartbeat = new HeartbeatPublisher(
    app.get<Redis>(REDIS),
    { service: 'api', instance: INSTANCE_ID, version: config.APP_VERSION, startedAt: PROCESS_STARTED_AT },
    () => ({ status: 'ok', detail: 'serving requests' }),
    log,
  );
  heartbeat.start();
  log.info({ port: config.API_PORT, opsPort: config.OPS_PORT, tracing: tracing.enabled }, 'api started');

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'api stopping');
    await heartbeat.stop();
    ops.close();
    await app.close();
    await metrics.shutdown();
    await tracing.shutdown();
    log.flush();
  };
  process.once('SIGTERM', () => void stop('SIGTERM'));
  process.once('SIGINT', () => void stop('SIGINT'));
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    process.stderr.write(`${err.message}\n`);
  } else {
    process.stderr.write(
      `api failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
  }
  process.exit(1);
});
