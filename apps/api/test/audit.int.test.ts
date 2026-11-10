import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DB } from '../src/tokens.ts';
import { call, createUser, freshIp, type Harness, startApi, type TestUser, tokenFor } from './harness.ts';

/** Criterion 1.5: sign-ins and user changes are audited, the chain verifies, rows cannot be changed. */
let h: Harness;
let admin: TestUser;
let adminToken: string;

beforeAll(async () => {
  h = await startApi();
  admin = await createUser(h, 'admin');
  adminToken = await tokenFor(h, admin);
});
afterAll(async () => {
  await h.close();
});

async function auditFor(targetId: string) {
  const res = await call(h.base, 'GET', `/api/v1/admin/audit?limit=1000`, { token: adminToken });
  expect(res.status).toBe(200);
  return (
    res.body.items as {
      action: string;
      targetId: string | null;
      actorUserId: string | null;
      details: Record<string, unknown>;
    }[]
  )
    .filter((e) => e.targetId === targetId)
    .reverse();
}

describe('audit log', () => {
  it('records successful and failed sign-ins', async () => {
    const u = await createUser(h, 'viewer');
    const ip = freshIp();
    await call(h.base, 'POST', '/api/v1/auth/login', {
      body: { email: u.email, password: 'nope' },
      headers: { 'x-forwarded-for': ip },
    });
    await call(h.base, 'POST', '/api/v1/auth/login', {
      body: { email: u.email, password: u.password },
      headers: { 'x-forwarded-for': ip },
    });
    const entries = await auditFor(u.id);
    expect(entries.map((e) => e.action)).toEqual(['auth.login.failed', 'auth.login.succeeded']);
    expect(entries[0]!.details).toMatchObject({ reason: 'bad_password' });
  });

  it('records user creation, role changes, disabling and MFA resets with the acting admin', async () => {
    const created = await call(h.base, 'POST', '/api/v1/admin/users', {
      token: adminToken,
      body: {
        email: `new-${Date.now()}@cip.test`,
        displayName: 'New Person',
        role: 'viewer',
        password: 'a long initial passphrase',
      },
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect(
      (
        await call(h.base, 'PATCH', `/api/v1/admin/users/${id}`, {
          token: adminToken,
          body: { role: 'analyst' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(h.base, 'PATCH', `/api/v1/admin/users/${id}`, {
          token: adminToken,
          body: { status: 'disabled' },
        })
      ).status,
    ).toBe(200);
    expect(
      (await call(h.base, 'POST', `/api/v1/admin/users/${id}/reset-mfa`, { token: adminToken })).status,
    ).toBe(204);

    const entries = await auditFor(id);
    expect(entries.map((e) => e.action)).toEqual([
      'user.created',
      'user.role.changed',
      'user.disabled',
      'user.mfa.reset',
    ]);
    expect(entries.every((e) => e.actorUserId === admin.id)).toBe(true);
    expect(entries[1]!.details).toEqual({ from: 'viewer', to: 'analyst' });
  });

  it('keeps at least one active admin', async () => {
    const res = await call(h.base, 'GET', '/api/v1/admin/users', { token: adminToken });
    const activeAdmins = (res.body.items as { id: string; role: string; status: string }[]).filter(
      (u) => u.role === 'admin' && u.status !== 'disabled',
    );
    // Disable every other admin first, then the last one must be refused.
    for (const other of activeAdmins.filter((u) => u.id !== admin.id)) {
      await call(h.base, 'PATCH', `/api/v1/admin/users/${other.id}`, {
        token: adminToken,
        body: { status: 'disabled' },
      });
    }
    const last = await call(h.base, 'PATCH', `/api/v1/admin/users/${admin.id}`, {
      token: adminToken,
      body: { role: 'viewer' },
    });
    expect(last.status).toBe(409);
  });

  it('verifies the hash chain through the API', async () => {
    const res = await call(h.base, 'GET', '/api/v1/admin/audit/verify', { token: adminToken });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, firstBrokenSeq: null });
    expect(res.body.checkedRows).toBeGreaterThan(0);
  });

  it("the api's own database role cannot update, delete or truncate audit rows", async () => {
    const db = h.app.get(DB);
    for (const statement of [
      sql`UPDATE app.audit_log SET action = 'tampered'`,
      sql`DELETE FROM app.audit_log`,
      sql`TRUNCATE app.audit_log`,
    ]) {
      await expect(statement.execute(db)).rejects.toMatchObject({ code: '42501' });
    }
  });
});
