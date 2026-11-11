import { z } from 'zod';
import { LogLevelSchema, loadEnv, NodeEnvSchema, PortSchema } from '@cip/observability';

const csv = (value: string) =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Origins of the desktop app's WebView (Tauri 2 on macOS/Linux and on Windows). */
export const TAURI_ORIGINS = ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'];

/**
 * Every setting the api reads, validated at startup (architecture §14 "Secrets"). Any key can also be
 * supplied as a file through `<KEY>_FILE`. scripts/server-env-names.json must list every key, so the
 * artefact scan can prove none of them reaches a client bundle (criterion 1.6).
 */
export const ApiEnvSchema = z.object({
  NODE_ENV: NodeEnvSchema,
  LOG_LEVEL: LogLevelSchema,
  LOG_PRETTY: z.stringbool().default(false),
  APP_VERSION: z.string().default('0.0.0-dev'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: PortSchema.default(3000),
  OPS_PORT: PortSchema.default(9464),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  /** Key prefix for every BullMQ queue (`POST /replays` adds to `replay`). */
  QUEUE_PREFIX: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .default('cip'),
  AUTH_ISSUER: z.string().min(1).default('cip'),
  /** Ed25519 private key, PKCS#8 PEM. */
  AUTH_JWT_PRIVATE_KEY: z.string().includes('PRIVATE KEY'),
  /** Public keys (SPKI PEM, concatenated) of retired signing keys, accepted until their tokens expire. */
  AUTH_JWT_PREVIOUS_PUBLIC_KEYS: z.string().optional(),
  /** 32 random bytes, base64: encrypts TOTP secrets at rest. */
  MFA_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, { error: 'must be 32 bytes, base64-encoded' }),
  /** Comma-separated web origins allowed by CORS. The Tauri origins are always added. */
  CORS_ORIGINS: z.string().default('http://localhost:5173').transform(csv),
  /** Express `trust proxy` setting: Caddy runs on the internal network. */
  TRUST_PROXY: z.string().default('loopback, linklocal, uniquelocal'),
  /** Secure flag on the refresh cookie. Only ever false for plain-HTTP local testing. */
  COOKIE_SECURE: z.stringbool().default(true),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
});

export type ApiConfig = z.infer<typeof ApiEnvSchema>;

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return loadEnv(ApiEnvSchema, env);
}
