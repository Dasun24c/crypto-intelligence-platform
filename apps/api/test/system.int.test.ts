import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HeartbeatPublisher } from '@cip/observability';
import { REDIS } from '../src/tokens.ts';
import { call, createUser, type Harness, startApi, tokenFor } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await startApi();
});
afterAll(async () => {
  await h.close();
});

describe('system health', () => {
  it('answers liveness and readiness probes without authentication', async () => {
    expect((await call(h.base, 'GET', '/healthz')).body).toEqual({ status: 'ok' });
    expect((await call(h.base, 'GET', '/readyz')).status).toBe(200);
  });

  it('reports dependencies and the heartbeats services publish; missing services show as down', async () => {
    const viewer = await createUser(h, 'viewer');
    const token = await tokenFor(h, viewer);
    const hb = new HeartbeatPublisher(
      h.app.get(REDIS),
      { service: 'jobs', instance: 'test-instance', version: '0.0.0-test', startedAt: Date.now() },
      () => ({ status: 'ok', detail: 'test heartbeat' }),
    );
    await hb.beat(h.clock.now);
    try {
      const res = await call(h.base, 'GET', '/api/v1/system/health', { token });
      expect(res.status).toBe(200);
      expect(res.body.dependencies).toEqual([
        expect.objectContaining({ name: 'database', status: 'ok' }),
        expect.objectContaining({ name: 'redis', status: 'ok' }),
      ]);
      const jobs = res.body.services.find((s: { service: string }) => s.service === 'jobs');
      expect(jobs.status).toBe('ok');
      expect(jobs.instances[0]).toMatchObject({ instance: 'test-instance', detail: 'test heartbeat' });
      const analyzer = res.body.services.find((s: { service: string }) => s.service === 'analyzer');
      expect(analyzer).toMatchObject({ status: 'down', instances: [] });
      expect(res.body.status).toBe('degraded');
    } finally {
      await hb.stop();
    }
  });

  it('marks an instance down once its heartbeat is older than 15 s', async () => {
    const token = await tokenFor(h, await createUser(h, 'viewer'));
    const hb = new HeartbeatPublisher(
      h.app.get(REDIS),
      { service: 'ingestor', instance: 'stale-instance', version: '0.0.0-test', startedAt: Date.now() },
      () => ({ status: 'ok', detail: 'test' }),
    );
    await hb.beat(h.clock.now - 16_000);
    try {
      const res = await call(h.base, 'GET', '/api/v1/system/health', { token });
      const ingestor = res.body.services.find((s: { service: string }) => s.service === 'ingestor');
      expect(
        ingestor.instances.find((i: { instance: string }) => i.instance === 'stale-instance').status,
      ).toBe('down');
    } finally {
      await hb.stop();
    }
  });

  it('returns RFC 9457 problems for unknown routes and invalid bodies', async () => {
    const token = await tokenFor(h, await createUser(h, 'viewer'));
    const missing = await call(h.base, 'GET', '/api/v1/nope', { token });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('application/problem+json');
    const invalid = await call(h.base, 'PUT', '/api/v1/me/preferences', {
      token,
      body: { displayTimeZone: 'UTC', extra: 1 },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [expect.objectContaining({ path: '(root)' })],
    });
    expect(invalid.body.correlationId).toBeTypeOf('string');
  });
});
