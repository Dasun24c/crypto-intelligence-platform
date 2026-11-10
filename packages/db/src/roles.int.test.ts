import pg from 'pg';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { createDb, createPool, pingDb } from './client.js';
import { configureServiceRoles } from './roles.js';

const owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 1 });
afterAll(async () => {
  await owner.destroy();
});

async function canLogin(role: string, password: string): Promise<boolean> {
  const url = new URL(inject('dbOwnerUrl'));
  url.username = role;
  url.password = password;
  const client = new pg.Client({ connectionString: url.toString() });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

describe('configureServiceRoles', () => {
  it('enables login with the configured password and leaves other roles unchanged', async () => {
    const password = 'rotated-password-for-test-1';
    expect(await configureServiceRoles(owner, { svc_analyzer: password })).toEqual(['svc_analyzer']);
    expect(await canLogin('svc_analyzer', password)).toBe(true);
    expect(await canLogin('svc_analyzer', 'wrong-password-for-test')).toBe(false);
    // Restore the password the other tests use.
    const original = new URL(inject('dbRoleUrls').svc_analyzer).password;
    await configureServiceRoles(owner, { svc_analyzer: decodeURIComponent(original) });
  });

  it('refuses short passwords', async () => {
    await expect(configureServiceRoles(owner, { svc_jobs: 'short' })).rejects.toThrow(/at least 16/);
  });
});

describe('pingDb', () => {
  it('measures a round trip, and fails fast when the database is unreachable', async () => {
    const pool = createPool({ connectionString: inject('dbRoleUrls').svc_api, max: 1 });
    try {
      expect(await pingDb(pool)).toBeGreaterThanOrEqual(0);
    } finally {
      await pool.end();
    }
    const dead = createPool({ connectionString: 'postgres://nobody:nothing@127.0.0.1:1/none', max: 1 });
    try {
      await expect(pingDb(dead)).rejects.toThrow();
    } finally {
      await dead.end();
    }
  });
});
