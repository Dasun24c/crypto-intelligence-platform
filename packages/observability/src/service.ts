import type { Meter } from '@opentelemetry/api';
import { Redis } from 'ioredis';
import type { ServiceName } from '@cip/contracts';
import { HeartbeatPublisher, type HeartbeatProbe } from './heartbeat.js';
import { INSTANCE_ID, PROCESS_STARTED_AT } from './instance.js';
import { createLogger, type Logger } from './logger.js';
import { initMetrics } from './metrics.js';
import { type Readiness, startOpsServer } from './ops-server.js';
import { initTracing } from './tracing.js';

export interface ServiceRuntimeConfig {
  LOG_LEVEL: string;
  LOG_PRETTY: boolean;
  APP_VERSION: string;
  OPS_PORT: number;
  REDIS_URL: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string | undefined;
}

export interface ServiceContext {
  log: Logger;
  /** Shared connection for heartbeats, streams and caches (not for BullMQ workers). */
  redis: Redis;
  meter: Meter;
  instance: string;
}

export interface RunningService {
  probe(): HeartbeatProbe | Promise<HeartbeatProbe>;
  readiness(): Promise<Readiness>;
  stop(): Promise<void>;
}

/**
 * The common life cycle of the standalone services (ingestor, analyzer, jobs): structured logs,
 * tracing, metrics, a heartbeat for System Health, the internal ops endpoint and an orderly shutdown
 * on SIGTERM/SIGINT. The service itself only supplies `start`.
 */
export interface ServiceHandle {
  /** Stops the service in order: heartbeat, service work, ops endpoint, connections, telemetry. */
  stop(reason: string): Promise<void>;
}

export async function runService(
  service: ServiceName,
  config: ServiceRuntimeConfig,
  start: (ctx: ServiceContext) => Promise<RunningService>,
): Promise<ServiceHandle> {
  const log = createLogger({
    service,
    instance: INSTANCE_ID,
    level: config.LOG_LEVEL,
    pretty: config.LOG_PRETTY,
  });
  const id = { service, instance: INSTANCE_ID, version: config.APP_VERSION };
  const tracing = initTracing(id, config.OTEL_EXPORTER_OTLP_ENDPOINT);
  const metrics = initMetrics(id);
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, connectionName: `cip-${service}` });

  const running = await start({ log, redis, meter: metrics.meter, instance: INSTANCE_ID });
  const ops = await startOpsServer({
    port: config.OPS_PORT,
    metrics: metrics.handle,
    readiness: () => running.readiness(),
  });
  const heartbeat = new HeartbeatPublisher(
    redis,
    { service, instance: INSTANCE_ID, version: config.APP_VERSION, startedAt: PROCESS_STARTED_AT },
    () => running.probe(),
    log,
  );
  heartbeat.start();
  log.info({ opsPort: config.OPS_PORT, tracing: tracing.enabled }, `${service} started`);

  let stopping = false;
  const stop = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    process.off('SIGTERM', onSigterm);
    process.off('SIGINT', onSigint);
    log.info({ reason }, `${service} stopping`);
    try {
      await heartbeat.stop();
      await running.stop();
      ops.close();
      await redis.quit().catch(() => redis.disconnect());
      await metrics.shutdown();
      await tracing.shutdown();
    } catch (err) {
      log.error({ err }, 'error during shutdown');
      process.exitCode = 1;
    }
    log.flush();
  };
  const onSigterm = () => void stop('SIGTERM');
  const onSigint = () => void stop('SIGINT');
  process.once('SIGTERM', onSigterm);
  process.once('SIGINT', onSigint);
  return { stop };
}

/** Common readiness: every listed dependency must answer. */
export async function checkDependencies(checks: Record<string, () => Promise<unknown>>): Promise<Readiness> {
  const failed: string[] = [];
  await Promise.all(
    Object.entries(checks).map(async ([name, check]) => {
      try {
        await check();
      } catch {
        failed.push(name);
      }
    }),
  );
  return failed.length === 0
    ? { status: 'ok', detail: `reachable: ${Object.keys(checks).join(', ')}` }
    : { status: 'down', detail: `unreachable: ${failed.sort().join(', ')}` };
}
