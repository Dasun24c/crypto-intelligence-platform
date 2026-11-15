import { z } from 'zod';
import { LogLevelSchema, loadEnv, NodeEnvSchema, PortSchema } from '@cip/observability';

/** Validated at start-up; every key may also come from a file via `<KEY>_FILE`. */
export const AnalyzerEnvSchema = z.object({
  NODE_ENV: NodeEnvSchema,
  LOG_LEVEL: LogLevelSchema,
  LOG_PRETTY: z.stringbool().default(false),
  APP_VERSION: z.string().default('0.0.0-dev'),
  OPS_PORT: PortSchema.default(9466),
  /** Connects as the least-privilege role `svc_analyzer` (data model §9). */
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  /** Key prefix for every BullMQ queue (the analyzer takes replays from `replay`). */
  QUEUE_PREFIX: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .default('cip'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
});

export type AnalyzerConfig = z.infer<typeof AnalyzerEnvSchema>;

export function loadAnalyzerConfig(env: NodeJS.ProcessEnv = process.env): AnalyzerConfig {
  return loadEnv(AnalyzerEnvSchema, env);
}
