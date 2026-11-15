import { z } from 'zod';
import { LogLevelSchema, loadEnv, NodeEnvSchema, PortSchema } from '@cip/observability';

/** Validated at start-up; every key may also come from a file via `<KEY>_FILE`. */
export const JobsEnvSchema = z.object({
  NODE_ENV: NodeEnvSchema,
  LOG_LEVEL: LogLevelSchema,
  LOG_PRETTY: z.stringbool().default(false),
  APP_VERSION: z.string().default('0.0.0-dev'),
  OPS_PORT: PortSchema.default(9467),
  /** Connects as the least-privilege role `svc_jobs` (data model §9). */
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  /** Key prefix for every BullMQ queue. */
  QUEUE_PREFIX: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .default('cip'),
  /** How often expired refresh tokens are removed. */
  PRUNE_REFRESH_TOKENS_EVERY_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(60 * 60 * 1000),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
});

export type JobsConfig = z.infer<typeof JobsEnvSchema>;

export function loadJobsConfig(env: NodeJS.ProcessEnv = process.env): JobsConfig {
  return loadEnv(JobsEnvSchema, env);
}
