import { randomUUID } from 'node:crypto';
import { QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDb } from '@cip/db';
import { createLogger } from '@cip/observability';
import {
  Maintenance,
  MAINTENANCE_QUEUE,
  PRUNE_REFRESH_TOKENS,
  pruneRefreshTokens,
} from '../src/maintenance.ts';

/** BullMQ on Valkey 9.1.3 (decision D4) with the jobs service's own database role. */
const owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 2 });
const jobsDb = createDb({ connectionString: inject('dbRoleUrls').svc_jobs, max: 2 });
const log = createLogger({ service: 'jobs', instance: 'test', level: 'silent' });

async function seedFamily(daysAgoExpired: number, revokedDaysAgo: number | null): Promise<string> {
  const userId = randomUUID();
  await owner
    .insertInto('app.users')
    .values({
      id: userId,
      email: `${userId}@cip.test`,
      display_name: 'x',
      role: 'viewer',
      password_hash: 'x',
    })
    .execute();
  const familyId = randomUUID();
  const day = 24 * 3_600_000;
  await owner
    .insertInto('app.refresh_tokens')
    .values({
      id: randomUUID(),
      user_id: userId,
      family_id: familyId,
      token_hash: Buffer.from(randomUUID()),
      client: 'web',
      expires_at: new Date(Date.now() - daysAgoExpired * day),
      revoked_at: revokedDaysAgo === null ? null : new Date(Date.now() - revokedDaysAgo * day),
    })
    .execute();
  return familyId;
}

const familyExists = async (familyId: string) =>
  (await owner.selectFrom('app.refresh_tokens').select('id').where('family_id', '=', familyId).execute())
    .length > 0;

afterAll(async () => {
  await owner.destroy();
  await jobsDb.destroy();
});

describe('refresh-token pruning', () => {
  it('removes families expired or revoked more than 7 days ago and keeps the rest', async () => {
    const old = await seedFamily(10, null);
    const oldRevoked = await seedFamily(-5, 9);
    const recentlyExpired = await seedFamily(2, null);
    const live = await seedFamily(-14, null);
    await pruneRefreshTokens(jobsDb);
    expect(await familyExists(old)).toBe(false);
    expect(await familyExists(oldRevoked)).toBe(false);
    expect(await familyExists(recentlyExpired)).toBe(true);
    expect(await familyExists(live)).toBe(true);
  });
});

describe('maintenance queue on Valkey', () => {
  let maintenance: Maintenance;
  const completedJobs: string[] = [];
  const failedJobs: string[] = [];
  const prefix = `test-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    maintenance = new Maintenance({
      redisUrl: inject('redisUrl'),
      prefix,
      pruneEveryMs: 60_000,
      db: jobsDb,
      log,
      onCompleted: (name) => completedJobs.push(name),
      onFailed: (name) => failedJobs.push(name),
    });
    await maintenance.start();
  });
  afterAll(async () => {
    await maintenance.close();
  });

  it('registers the prune scheduler', async () => {
    const schedulers = await maintenance.queue.getJobSchedulers();
    expect(schedulers.map((s) => s.key)).toContain(PRUNE_REFRESH_TOKENS);
  });

  it('processes a prune job end to end', async () => {
    const events = new QueueEvents(MAINTENANCE_QUEUE, {
      connection: new Redis(inject('redisUrl'), { maxRetriesPerRequest: null }),
      prefix,
    });
    await events.waitUntilReady();
    try {
      const stale = await seedFamily(30, null);
      const job = await maintenance.queue.add(PRUNE_REFRESH_TOKENS, {});
      const result = (await job.waitUntilFinished(events, 20_000)) as { deleted: number };
      expect(result.deleted).toBeGreaterThanOrEqual(1);
      expect(await familyExists(stale)).toBe(false);
    } finally {
      await events.close();
    }
  });

  it('refuses unknown job names and reports the failure', async () => {
    const events = new QueueEvents(MAINTENANCE_QUEUE, {
      connection: new Redis(inject('redisUrl'), { maxRetriesPerRequest: null }),
      prefix,
    });
    await events.waitUntilReady();
    try {
      const job = await maintenance.queue.add('not-a-real-job', {});
      await expect(job.waitUntilFinished(events, 20_000)).rejects.toThrow(/unknown maintenance job/);
      await new Promise((r) => setTimeout(r, 200));
      expect(failedJobs).toContain('not-a-real-job');
      expect(completedJobs).toContain(PRUNE_REFRESH_TOKENS);
      expect(await maintenance.counts()).toMatchObject({ failed: expect.any(Number) });
      // Health counts recent failures only: this one is recent; none finished in the future.
      expect(await maintenance.failedSince(Date.now() - 60_000)).toBeGreaterThanOrEqual(1);
      expect(await maintenance.failedSince(Date.now() + 60_000)).toBe(0);
    } finally {
      await events.close();
    }
  });

  it('reports the server as Valkey 9.1', async () => {
    const r = new Redis(inject('redisUrl'));
    try {
      const info = await r.info('server');
      expect(info).toMatch(/valkey_version:9\.1\./);
    } finally {
      r.disconnect();
    }
  });
});
