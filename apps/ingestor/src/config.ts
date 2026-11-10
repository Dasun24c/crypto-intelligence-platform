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
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
});

export type IngestorConfig = z.infer<typeof IngestorEnvSchema>;

export function loadIngestorConfig(env: NodeJS.ProcessEnv = process.env): IngestorConfig {
  return loadEnv(IngestorEnvSchema, env);
}
