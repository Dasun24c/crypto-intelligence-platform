import { z } from 'zod';
import { LogLevelSchema, loadEnv, NodeEnvSchema, PortSchema } from '@cip/observability';

/** Validated at start-up; every key may also come from a file via `<KEY>_FILE`. */
export const BrokerEnvSchema = z.object({
  NODE_ENV: NodeEnvSchema,
  LOG_LEVEL: LogLevelSchema,
  LOG_PRETTY: z.stringbool().default(false),
  APP_VERSION: z.string().default('0.0.0-dev'),
  OPS_PORT: PortSchema.default(9468),
  /** Connects as the least-privilege role `svc_broker` (data model §9). */
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
});

export type BrokerConfig = z.infer<typeof BrokerEnvSchema>;

export function loadBrokerConfig(env: NodeJS.ProcessEnv = process.env): BrokerConfig {
  return loadEnv(BrokerEnvSchema, env);
}
