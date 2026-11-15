import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REFRESH_COOKIE } from '@cip/contracts';
import { DB } from '../src/tokens.ts';
import { totp } from '../src/auth/totp.ts';
import { call, createUser, freshIp, type Harness, startApi, WEB_ORIGIN } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await startApi();
});
afterAll(async () => {
  await h.close();
});

const auditActions = async (userId: string) => {
  const rows = await h.app
    .get(DB)
    .selectFrom('app.audit_log')
    .select(['action', 'details'])
    .where('target_id', '=', userId)
    .orderBy('chain_seq')
    .execute();
  return rows as { action: string; details: Record<string, unknown> }[];
};

function login(email: string, password: string, headers: Record<string, string> = {}) {
  return call(h.base, 'POST', '/api/v1/auth/login', {
    body: { email, password },
    headers: { 'x-forwarded-for': freshIp(), ...headers },
  });
}

describe('password sign-in (non-admin, no MFA)', () => {
  it('issues an access token and, for web, an httpOnly SameSite=Strict refresh cookie', async () => {
    const u = await createUser(h, 'viewer');
    const res = await login(u.email, u.password);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTypeOf('string');
    expect(res.body.refreshToken).toBeUndefined();
    expect(res.body.user).toMatchObject({ id: u.id, role: 'viewer' });
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${REFRESH_COOKIE}=`))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    const me = await call(h.base, 'GET', '/api/v1/me', { token: res.body.accessToken });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      role: 'viewer',
      mfaEnabled: false,
      preferences: { displayTimeZone: 'UTC' },
    });
  });

  it('returns the refresh token in the body for the desktop client', async () => {
    const u = await createUser(h, 'analyst');
    const res = await login(u.email, u.password, { 'x-client': 'desktop' });
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).toBeTypeOf('string');
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${REFRESH_COOKIE}=`))).toBe(false);
  });

  it('refuses wrong passwords and unknown accounts with the same answer, and audits both', async () => {
    const u = await createUser(h, 'viewer');
    const wrong = await login(u.email, 'not the password');
    const unknown = await login(`nobody-${u.id}@cip.test`, 'whatever');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.detail).toBe(unknown.body.detail);
    expect(wrong.headers.get('content-type')).toContain('application/problem+json');
    const actions = await auditActions(u.id);
    expect(actions).toContainEqual(
      expect.objectContaining({
        action: 'auth.login.failed',
        details: expect.objectContaining({ reason: 'bad_password' }),
      }),
    );
  });

  it('locks an account progressively after 5 failures, then lets it in after the lock', async () => {
    const u = await createUser(h, 'viewer');
    for (let i = 0; i < 5; i++) expect((await login(u.email, `wrong-${i}`)).status).toBe(401);
    h.clock.advance(30_000); // refills the per-account limiter, still inside the 60 s lock
    expect((await login(u.email, u.password)).status).toBe(401);
    h.clock.advance(31_000);
    expect((await login(u.email, u.password)).status).toBe(200);
    const actions = (await auditActions(u.id)).map((a) => a.action);
    expect(actions).toContain('auth.lockout');
    expect(actions.at(-1)).toBe('auth.login.succeeded');
  });

  it('rate-limits sign-in attempts per account (API contracts §8)', async () => {
    const u = await createUser(h, 'viewer');
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await login(u.email, 'wrong password')).status);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
  });
});

describe('MFA', () => {
  it('admins cannot sign in without a second factor: first sign-in requires TOTP enrolment', async () => {
    const admin = await createUser(h, 'admin');
    const first = await login(admin.email, admin.password);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ mfaRequired: true, mfaToken: expect.any(String), enrollmentRequired: true });
    expect(first.body.accessToken).toBeUndefined();
    // The MFA token is not an access token.
    expect((await call(h.base, 'GET', '/api/v1/me', { token: first.body.mfaToken })).status).toBe(401);
    // Skipping enrolment and guessing a code does not work.
    const guess = await call(h.base, 'POST', '/api/v1/auth/mfa', {
      body: { mfaToken: first.body.mfaToken, code: '123456' },
    });
    expect(guess.status).toBe(401);

    const enrol = await call(h.base, 'POST', '/api/v1/auth/mfa/enroll', {
      body: { mfaToken: first.body.mfaToken },
    });
    expect(enrol.status).toBe(200);
    expect(enrol.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    const done = await call(h.base, 'POST', '/api/v1/auth/mfa', {
      body: { mfaToken: first.body.mfaToken, code: totp(enrol.body.secret, h.clock.now) },
    });
    expect(done.status).toBe(200);
    expect(done.body.user.role).toBe('admin');
    const me = await call(h.base, 'GET', '/api/v1/me', { token: done.body.accessToken });
    expect(me.body.mfaEnabled).toBe(true);

    // Next sign-in: a code is required, a wrong one is refused, a replayed one is refused.
    h.clock.advance(30_000);
    const second = await login(admin.email, admin.password);
    expect(second.body).toMatchObject({ mfaRequired: true, enrollmentRequired: false });
    const bad = await call(h.base, 'POST', '/api/v1/auth/mfa', {
      body: { mfaToken: second.body.mfaToken, code: '000000' },
    });
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('MFA_REQUIRED');
    const code = totp(enrol.body.secret, h.clock.now);
    const ok = await call(h.base, 'POST', '/api/v1/auth/mfa', {
      body: { mfaToken: second.body.mfaToken, code },
    });
    expect(ok.status).toBe(200);
    const third = await login(admin.email, admin.password);
    const replay = await call(h.base, 'POST', '/api/v1/auth/mfa', {
      body: { mfaToken: third.body.mfaToken, code },
    });
    expect(replay.status).toBe(401);

    const actions = (await auditActions(admin.id)).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(['user.mfa.enabled', 'auth.login.succeeded', 'auth.login.failed']),
    );
  });

  it('lets other roles opt in to TOTP from their profile', async () => {
    const u = await createUser(h, 'analyst');
    const session = await login(u.email, u.password);
    const setup = await call(h.base, 'POST', '/api/v1/me/mfa/setup', { token: session.body.accessToken });
    expect(setup.status).toBe(200);
    const confirm = await call(h.base, 'POST', '/api/v1/me/mfa/confirm', {
      token: session.body.accessToken,
      body: { code: totp(setup.body.secret, h.clock.now) },
    });
    expect(confirm.status).toBe(204);
    expect((await login(u.email, u.password)).body).toMatchObject({
      mfaRequired: true,
      enrollmentRequired: false,
    });
  });
});

describe('refresh tokens', () => {
  it('rotate on use; reusing a rotated token revokes the whole family (integration test for 1.3)', async () => {
    const u = await createUser(h, 'viewer');
    const session = await login(u.email, u.password, { 'x-client': 'desktop' });
    const a = session.body.refreshToken as string;

    const first = await call(h.base, 'POST', '/api/v1/auth/refresh', {
      body: { refreshToken: a },
      headers: { 'x-client': 'desktop' },
    });
    expect(first.status).toBe(200);
    const b = first.body.refreshToken as string;
    expect(b).not.toBe(a);

    // Token A was stolen and is replayed: refused, and B dies with it.
    const replay = await call(h.base, 'POST', '/api/v1/auth/refresh', { body: { refreshToken: a } });
    expect(replay.status).toBe(401);
    const afterReplay = await call(h.base, 'POST', '/api/v1/auth/refresh', { body: { refreshToken: b } });
    expect(afterReplay.status).toBe(401);

    const live = await h.app
      .get(DB)
      .selectFrom('app.refresh_tokens')
      .select('id')
      .where('user_id', '=', u.id)
      .where('revoked_at', 'is', null)
      .execute();
    expect(live).toHaveLength(0);
    expect((await auditActions(u.id)).map((x) => x.action)).toContain('auth.refresh.reuse_detected');
  });

  it('web clients refresh with the cookie from an allowed origin only, and logout ends the session', async () => {
    const u = await createUser(h, 'viewer');
    const session = await login(u.email, u.password);
    const cookie = session.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${REFRESH_COOKIE}=`))!
      .split(';')[0]!;

    const foreign = await call(h.base, 'POST', '/api/v1/auth/refresh', {
      cookie,
      body: {},
      headers: { origin: 'https://evil.example' },
    });
    expect(foreign.status).toBe(403);
    const ok = await call(h.base, 'POST', '/api/v1/auth/refresh', {
      cookie,
      body: {},
      headers: { origin: WEB_ORIGIN },
    });
    expect(ok.status).toBe(200);
    const rotated = ok.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${REFRESH_COOKIE}=`))!
      .split(';')[0]!;
    expect(rotated).not.toBe(cookie);

    expect(
      (
        await call(h.base, 'POST', '/api/v1/auth/logout', {
          cookie: rotated,
          body: {},
          headers: { origin: WEB_ORIGIN },
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await call(h.base, 'POST', '/api/v1/auth/refresh', {
          cookie: rotated,
          body: {},
          headers: { origin: WEB_ORIGIN },
        })
      ).status,
    ).toBe(401);
    expect((await auditActions(u.id)).map((x) => x.action)).toContain('auth.logout');
  });
});

describe('access tokens', () => {
  it('expire after 15 minutes', async () => {
    const u = await createUser(h, 'viewer');
    const { body } = await login(u.email, u.password);
    h.clock.advance(15 * 60_000 + 1_000);
    const res = await call(h.base, 'GET', '/api/v1/me', { token: body.accessToken });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_EXPIRED');
  });

  it('stop working at once when the account is disabled or the password changes', async () => {
    const admin = await createUser(h, 'admin');
    const { tokenFor } = await import('./harness.ts');
    const adminToken = await tokenFor(h, admin);
    const u = await createUser(h, 'analyst');
    const session = await login(u.email, u.password);
    const token = session.body.accessToken as string;

    h.clock.advance(1_000);
    const changed = await call(h.base, 'PUT', '/api/v1/me/password', {
      token,
      body: { currentPassword: u.password, newPassword: 'a brand new passphrase' },
    });
    expect(changed.status).toBe(204);
    h.clock.advance(1_000);
    expect((await call(h.base, 'GET', '/api/v1/me', { token })).status).toBe(401);

    const again = await login(u.email, 'a brand new passphrase');
    expect(again.status).toBe(200);
    const disable = await call(h.base, 'PATCH', `/api/v1/admin/users/${u.id}`, {
      token: adminToken,
      body: { status: 'disabled' },
    });
    expect(disable.status).toBe(200);
    expect((await call(h.base, 'GET', '/api/v1/me', { token: again.body.accessToken })).status).toBe(401);
    expect((await login(u.email, 'a brand new passphrase')).status).toBe(401);
  });
});
