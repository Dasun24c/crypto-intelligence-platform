import { Redis } from 'ioredis';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { HEARTBEAT_STALE_MS } from '@cip/contracts';
import { HeartbeatPublisher, type Logger, readHeartbeats, runService } from '../src/index.ts';

const redis = new Redis(inject('redisUrl'));
afterAll(() => {
  redis.disconnect();
});

describe('heartbeats in Redis', () => {
  it('publishes, lists newest first, and removes on stop', async () => {
    const make = (instance: string) =>
      new HeartbeatPublisher(
        redis,
        { service: 'analyzer', instance, version: '0.0.0-test', startedAt: 1 },
        () => ({ status: 'ok', detail: `detail ${instance}` }),
      );
    const a = make('hb-a');
    const b = make('hb-b');
    const now = Date.now();
    await a.beat(now - 1_000);
    await b.beat(now);
    const listed = (await readHeartbeats(redis, now)).filter((h) => h.instance.startsWith('hb-'));
    expect(listed.map((h) => h.instance)).toEqual(['hb-b', 'hb-a']);
    expect(listed[0]).toMatchObject({ service: 'analyzer', status: 'ok', detail: 'detail hb-b' });
    await a.stop();
    await b.stop();
    expect((await readHeartbeats(redis)).some((h) => h.instance.startsWith('hb-'))).toBe(false);
  });

  it('keeps entries whose key expired out of the list', async () => {
    const p = new HeartbeatPublisher(
      redis,
      { service: 'jobs', instance: 'hb-expired', version: '0', startedAt: 1 },
      () => ({ status: 'ok', detail: 'x' }),
    );
    await p.beat();
    await redis.del('hb:jobs:hb-expired');
    expect((await readHeartbeats(redis)).some((h) => h.instance === 'hb-expired')).toBe(false);
    await p.stop();
  });

  it('logs and survives a failing probe', async () => {
    const warnings: unknown[] = [];
    const log = { warn: (o: unknown) => warnings.push(o) } as unknown as Logger;
    const p = new HeartbeatPublisher(
      redis,
      { service: 'jobs', instance: 'hb-failing', version: '0', startedAt: 1 },
      () => {
        throw new Error('probe broke');
      },
      log,
    );
    await p.beat();
    expect(warnings).toHaveLength(1);
    await p.stop();
  });
});

describe('runService', () => {
  it('starts the ops endpoint and heartbeat, then shuts down in order', async () => {
    let stopped = false;
    const handle = await runService(
      'ingestor',
      {
        LOG_LEVEL: 'silent',
        LOG_PRETTY: false,
        APP_VERSION: '0.0.0-test',
        OPS_PORT: 0,
        REDIS_URL: inject('redisUrl'),
      },
      () =>
        Promise.resolve({
          probe: () => ({ status: 'ok' as const, detail: 'runService test' }),
          readiness: () => Promise.resolve({ status: 'ok' as const, detail: 'ready' }),
          stop: () => {
            stopped = true;
            return Promise.resolve();
          },
        }),
    );
    await new Promise((r) => setTimeout(r, 200));
    const beats = await readHeartbeats(redis);
    const mine = beats.find((h) => h.detail === 'runService test');
    expect(mine).toBeDefined();
    expect(Date.now() - mine!.sentAt).toBeLessThan(HEARTBEAT_STALE_MS);

    await handle.stop('test');
    expect(stopped).toBe(true);
    expect((await readHeartbeats(redis)).some((h) => h.detail === 'runService test')).toBe(false);
  });
});
