import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { inject } from 'vitest';
import type { Role } from '@cip/contracts';
import { createLogger } from '@cip/observability';
import { createApiApp } from '../src/app.ts';
import { PasswordService } from '../src/auth/password.service.ts';
import { TokenService } from '../src/auth/token.service.ts';
import { type ApiConfig, ApiEnvSchema } from '../src/config.ts';
import { UsersRepository } from '../src/users/users.repository.ts';

export const WEB_ORIGIN = 'http://localhost:5173';

export interface Harness {
  app: NestExpressApplication;
  base: string;
  config: ApiConfig;
  /** Test clock (epoch ms); advance it to expire tokens, locks and rate-limit windows. */
  clock: { now: number; advance(ms: number): void };
  close(): Promise<void>;
}

export async function startApi(): Promise<Harness> {
  const { privateKey } = generateKeyPairSync('ed25519');
  const config = ApiEnvSchema.parse({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: inject('dbRoleUrls').svc_api,
    REDIS_URL: inject('redisUrl'),
    AUTH_JWT_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    CORS_ORIGINS: WEB_ORIGIN,
    TRUST_PROXY: 'loopback',
    COOKIE_SECURE: 'false',
  });
  const clock = {
    now: Date.now(),
    advance(ms: number) {
      this.now += ms;
    },
  };
  const app = await createApiApp({
    config,
    logger: createLogger({ service: 'api', instance: 'test', level: 'silent' }),
    clock: () => clock.now,
  });
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  return { app, base, config, clock, close: () => app.close() };
}

export interface CallOptions {
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
  cookie?: string;
}

export interface CallResult<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export async function call<T = any>(
  base: string,
  method: string,
  path: string,
  opts: CallOptions = {},
): Promise<CallResult<T>> {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...opts.headers,
    },
    body: opts.body === undefined ? null : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T, headers: res.headers };
}

/** Each test gets its own client address, so per-IP login limits never couple tests together. */
export function freshIp(): string {
  const b = randomBytes(2);
  return `198.51.${b[0]}.${b[1]}`;
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
  role: Role;
}

export async function createUser(h: Harness, role: Role): Promise<TestUser> {
  const password = `pw-${randomUUID()}`;
  const email = `${role}-${randomUUID().slice(0, 8)}@cip.test`;
  const hash = await h.app.get(PasswordService).hash(password);
  const row = await h.app.get(UsersRepository).insert({
    id: randomUUID(),
    email,
    display_name: `Test ${role}`,
    role,
    password_hash: hash,
    password_changed_at: new Date(h.clock.now),
  });
  return { id: row.id, email, password, role };
}

/** An access token minted directly, for authorisation tests that are not about signing in. */
export async function tokenFor(h: Harness, user: TestUser): Promise<string> {
  return (await h.app.get(TokenService).issueAccessToken({ userId: user.id, role: user.role })).token;
}
