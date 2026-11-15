import { readFileSync } from 'node:fs';
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
  /**
   * FRED API key for the economic calendar's release dates (feasibility §6.1). Optional: without it
   * the FRED part of the sync is skipped and checklist item 8 fails safe (`calendar_unavailable`).
   * With `FRED_API_KEY_FILE`, the file is read again at every sync, so a key added later needs no
   * restart. An empty value counts as no key.
   */
  FRED_API_KEY: z.string().optional(),
  /** How often the calendar syncs (it also syncs at start-up). */
  CALENDAR_SYNC_EVERY_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(6 * 60 * 60 * 1000),
  /**
   * The xAI (Grok) API key for the AI analyses (ADR 023). Only this service has it: in the local
   * stack it is `.secrets-jobs/grok-api-key`, a folder no other container mounts. Optional: without
   * it nothing is queued and requested analyses fail as `no_key`. With `GROK_API_KEY_FILE`, the
   * file is read again at every call, so a key added later needs no restart.
   */
  GROK_API_KEY: z.string().optional(),
  /** xAI's OpenAI-compatible API; tests point it at a fake server. */
  AI_BASE_URL: z.url().default('https://api.x.ai/v1'),
});

export type JobsConfig = z.infer<typeof JobsEnvSchema>;

export function loadJobsConfig(env: NodeJS.ProcessEnv = process.env): JobsConfig {
  return loadEnv(JobsEnvSchema, env);
}

/**
 * A key read at every use, so one added later needs no restart: from the file when one is named,
 * else the value given at start-up. An empty value or a missing file counts as no key.
 */
export function keyReader(value: string | undefined, file: string | undefined): () => string | undefined {
  return () => {
    let key = value;
    if (file)
      try {
        key = readFileSync(file, 'utf8').trim();
      } catch {
        key = undefined;
      }
    return key ? key : undefined;
  };
}
