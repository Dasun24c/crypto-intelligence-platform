import { readFileSync } from 'node:fs';
import { z } from 'zod';

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Builds the raw environment for a schema. For every key `X`, a variable `X_FILE` naming a file
 * (Docker secrets, Kubernetes secrets) takes precedence over `X` itself (architecture §14 "Secrets").
 */
export function resolveEnv(
  keys: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const file = env[`${key}_FILE`];
    if (file) {
      out[key] = readFileSync(file, 'utf8').trim();
    } else if (env[key] !== undefined && env[key] !== '') {
      out[key] = env[key];
    }
  }
  return out;
}

/**
 * Validates the environment against a zod object schema at startup and fails fast with a list of
 * problems. Values are never included in the error, only key names.
 */
export function loadEnv<S extends z.ZodObject>(schema: S, env: NodeJS.ProcessEnv = process.env): z.infer<S> {
  const keys = Object.keys(schema.shape);
  const parsed = schema.safeParse(resolveEnv(keys, env));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n  ${issues.join('\n  ')}`, issues);
  }
  return parsed.data;
}

export const NodeEnvSchema = z.enum(['development', 'test', 'production']).default('development');
export const LogLevelSchema = z
  .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
  .default('info');
export const PortSchema = z.coerce.number().int().min(0).max(65535);
