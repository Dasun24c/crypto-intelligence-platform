import { z } from 'zod';
import { LogLevelSchema, loadEnv, NodeEnvSchema, PortSchema } from '@cip/observability';

/** Validated at start-up; every key may also come from a file via `<KEY>_FILE`. */
export const IngestorEnvSchema = z.object({
  NODE_ENV: NodeEnvSchema,
  LOG_LEVEL: LogLevelSchema,
  LOG_PRETTY: z.stringbool().default(false),
  APP_VERSION: z.string().default('0.0.0-dev'),
  OPS_PORT: PortSchema.default(9465),
  /** Connects as the least-privilege role `svc_ingestor` (data model §9). */
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  /** Key prefix for BullMQ queues (the ingestor enqueues backfills). */
  QUEUE_PREFIX: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .default('cip'),
  /** Buckets in each 1m candle's micro volume profile (rulebook §3.5, §10). */
  PROFILE_BUCKETS: z.coerce.number().int().min(4).max(200).default(24),
  /** History requested on first start for an instrument without candles (MD-03). */
  BACKFILL_DAYS: z.coerce.number().int().min(1).max(3_650).default(7),
  /**
   * `live` streams Binance and Coinbase; `replay` plays recordings for tests, CI and demos
   * (architecture principle 1), streaming only the instruments whose venue is "replay".
   */
  MARKET_SOURCE: z.enum(['live', 'replay']).default('live'),
  /** Recordings for `replay` (tools/recorder JSON Lines, optionally gzipped), comma-separated paths. */
  REPLAY_FILES: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean),
    ),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
});

export type IngestorConfig = z.infer<typeof IngestorEnvSchema>;

/** Replay mode needs at least one recording. */
export function checkReplayConfig(config: IngestorConfig): void {
  if (config.MARKET_SOURCE === 'replay' && config.REPLAY_FILES.length === 0)
    throw new Error('MARKET_SOURCE=replay needs REPLAY_FILES (comma-separated recordings).');
}

export function loadIngestorConfig(env: NodeJS.ProcessEnv = process.env): IngestorConfig {
  return loadEnv(IngestorEnvSchema, env);
}
