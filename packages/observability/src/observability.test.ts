import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HEARTBEAT_STALE_MS, type ServiceHeartbeat } from '@cip/contracts';
import { ConfigError, REDACT_PATHS, effectiveStatus, loadEnv, startOpsServer } from './index.js';

describe('loadEnv', () => {
  const schema = z.object({
    PORT: z.coerce.number().int(),
    SECRET: z.string().min(8),
    OPTIONAL: z.string().optional(),
  });

  it('parses and coerces values', () => {
    expect(loadEnv(schema, { PORT: '8080', SECRET: 'abcdefgh' })).toEqual({ PORT: 8080, SECRET: 'abcdefgh' });
  });

  it('prefers X_FILE over X, as with Docker secrets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cip-env-'));
    const file = join(dir, 'secret');
    writeFileSync(file, 'from-the-file\n');
    expect(loadEnv(schema, { PORT: '1', SECRET: 'from-env-var', SECRET_FILE: file }).SECRET).toBe(
      'from-the-file',
    );
  });

  it('lists every problem by key without echoing values', () => {
    try {
      loadEnv(schema, { PORT: 'nope', SECRET: 'short-value-that-is-secret'.slice(0, 5) });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const e = err as ConfigError;
      expect(e.issues.map((i) => i.split(':')[0])).toEqual(['PORT', 'SECRET']);
      expect(e.message).not.toContain('short');
    }
  });
});

describe('logger redaction', () => {
  it('removes credentials from log lines', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const log = pino({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, sink);
    log.info({
      body: { password: 'hunter2hunter2', email: 'a@b.test' },
      req: { headers: { authorization: 'Bearer x' } },
    });
    const line = lines.join('');
    expect(line).not.toContain('hunter2');
    expect(line).not.toContain('Bearer x');
    expect(line).toContain('a@b.test');
  });
});

describe('heartbeat status', () => {
  const hb: ServiceHeartbeat = {
    service: 'jobs',
    instance: 'i1',
    version: '0.0.0',
    startedAt: 0,
    sentAt: 1_000_000,
    status: 'ok',
    detail: 'running',
  };
  it('keeps the reported status while fresh and marks stale instances down', () => {
    expect(effectiveStatus(hb, hb.sentAt + HEARTBEAT_STALE_MS)).toBe('ok');
    expect(effectiveStatus(hb, hb.sentAt + HEARTBEAT_STALE_MS + 1)).toBe('down');
  });
});

describe('ops server', () => {
  it('answers liveness, readiness and 404', async () => {
    let ready: 'ok' | 'down' = 'ok';
    const server = await startOpsServer({
      port: 0,
      host: '127.0.0.1',
      readiness: async () => ({ status: ready, detail: 'x' }),
    });
    const { port } = server.address() as { port: number };
    const base = `http://127.0.0.1:${port}`;
    try {
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      expect((await fetch(`${base}/readyz`)).status).toBe(200);
      ready = 'down';
      expect((await fetch(`${base}/readyz`)).status).toBe(503);
      expect((await fetch(`${base}/nope`)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
