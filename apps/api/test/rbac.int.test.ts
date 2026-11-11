import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { can, ROLES, type Role } from '@cip/contracts';
import type { AccessPolicy } from '../src/common/access.ts';
import { call, createUser, type Harness, startApi, type TestUser, tokenFor } from './harness.ts';

/**
 * Criterion 1.4: every endpoint is called with every role (and anonymously) and the outcome must
 * match the RBAC matrix. The endpoint table below is the expected policy, transcribed from API
 * contracts §2–§3; a separate check proves it lists exactly the routes the app serves, so a new
 * endpoint cannot be added without deciding who may call it.
 */
interface Endpoint {
  method: string;
  path: string;
  policy: AccessPolicy;
  /** A body that passes the guard but is harmless (usually invalid, so nothing changes). */
  body?: unknown;
  /** The route pattern the app registers, when it is not `path` with the id as ":id". */
  route?: string;
}

const NOBODY = randomUUID();
const ENDPOINTS: Endpoint[] = [
  { method: 'POST', path: '/api/v1/auth/login', policy: 'public', body: {} },
  { method: 'POST', path: '/api/v1/auth/mfa', policy: 'public', body: {} },
  { method: 'POST', path: '/api/v1/auth/mfa/enroll', policy: 'public', body: {} },
  // An empty token fails validation (400): proves the guard let the call through without needing a session.
  { method: 'POST', path: '/api/v1/auth/refresh', policy: 'public', body: { refreshToken: '' } },
  { method: 'POST', path: '/api/v1/auth/logout', policy: 'public', body: {} },
  { method: 'GET', path: '/api/v1/me', policy: 'authenticated' },
  {
    method: 'PUT',
    path: '/api/v1/me/preferences',
    policy: 'authenticated',
    body: { displayTimeZone: 'UTC' },
  },
  { method: 'PUT', path: '/api/v1/me/password', policy: 'authenticated', body: {} },
  { method: 'POST', path: '/api/v1/me/mfa/setup', policy: 'authenticated' },
  { method: 'POST', path: '/api/v1/me/mfa/confirm', policy: 'authenticated', body: {} },
  { method: 'GET', path: '/api/v1/admin/users', policy: 'users.manage' },
  { method: 'POST', path: '/api/v1/admin/users', policy: 'users.manage', body: {} },
  { method: 'GET', path: `/api/v1/admin/users/${NOBODY}`, policy: 'users.manage' },
  {
    method: 'PATCH',
    path: `/api/v1/admin/users/${NOBODY}`,
    policy: 'users.manage',
    body: { displayName: 'x' },
  },
  { method: 'POST', path: `/api/v1/admin/users/${NOBODY}/reset-mfa`, policy: 'users.manage' },
  { method: 'GET', path: '/api/v1/admin/audit', policy: 'audit.view' },
  { method: 'GET', path: '/api/v1/admin/audit/verify', policy: 'audit.view' },
  { method: 'GET', path: '/api/v1/system/health', policy: 'dashboards.view' },
  { method: 'GET', path: '/api/v1/system/feeds', policy: 'dashboards.view' },
  // Phase 2: market data (any role) and its administration.
  { method: 'GET', path: '/api/v1/instruments', policy: 'dashboards.view' },
  { method: 'GET', path: '/api/v1/market/gaps', policy: 'dashboards.view' },
  { method: 'GET', path: '/api/v1/market/closures', policy: 'dashboards.view' },
  {
    method: 'GET',
    path: '/api/v1/market/spreads/PAXG',
    policy: 'dashboards.view',
    route: '/api/v1/market/spreads/:baseAsset',
  },
  {
    method: 'GET',
    path: `/api/v1/market/${NOBODY}/candles?tf=1m`,
    policy: 'dashboards.view',
    route: '/api/v1/market/:instrumentId/candles',
  },
  {
    method: 'GET',
    path: `/api/v1/market/${NOBODY}/ticker`,
    policy: 'dashboards.view',
    route: '/api/v1/market/:instrumentId/ticker',
  },
  {
    method: 'GET',
    path: `/api/v1/market/${NOBODY}/book`,
    policy: 'dashboards.view',
    route: '/api/v1/market/:instrumentId/book',
  },
  {
    method: 'GET',
    path: `/api/v1/market/${NOBODY}/book/metrics`,
    policy: 'dashboards.view',
    route: '/api/v1/market/:instrumentId/book/metrics',
  },
  {
    method: 'GET',
    path: `/api/v1/market/${NOBODY}/large-trades`,
    policy: 'dashboards.view',
    route: '/api/v1/market/:instrumentId/large-trades',
  },
  {
    method: 'GET',
    path: `/api/v1/market/${NOBODY}/walls`,
    policy: 'dashboards.view',
    route: '/api/v1/market/:instrumentId/walls',
  },
  {
    method: 'GET',
    path: `/api/v1/indicators/${NOBODY}?tf=1h`,
    policy: 'dashboards.view',
    route: '/api/v1/indicators/:instrumentId',
  },
  {
    method: 'GET',
    path: '/api/v1/system/runs',
    policy: 'dashboards.view',
  },
  {
    method: 'GET',
    path: `/api/v1/smc/${NOBODY}/overlay?tf=1h`,
    policy: 'dashboards.view',
    route: '/api/v1/smc/:instrumentId/overlay',
  },
  {
    method: 'GET',
    path: `/api/v1/smc/${NOBODY}/swings?tf=1h`,
    policy: 'dashboards.view',
    route: '/api/v1/smc/:instrumentId/swings',
  },
  {
    method: 'GET',
    path: `/api/v1/smc/${NOBODY}/structure?tf=1h`,
    policy: 'dashboards.view',
    route: '/api/v1/smc/:instrumentId/structure',
  },
  {
    method: 'GET',
    path: `/api/v1/smc/${NOBODY}/ranges?tf=1h`,
    policy: 'dashboards.view',
    route: '/api/v1/smc/:instrumentId/ranges',
  },
  {
    method: 'GET',
    path: `/api/v1/smc/${NOBODY}/levels?tf=1h`,
    policy: 'dashboards.view',
    route: '/api/v1/smc/:instrumentId/levels',
  },
  {
    method: 'GET',
    path: `/api/v1/smc/${NOBODY}/sweeps?tf=1h`,
    policy: 'dashboards.view',
    route: '/api/v1/smc/:instrumentId/sweeps',
  },
  {
    method: 'GET',
    path: `/api/v1/smc/${NOBODY}/zones?tf=1h`,
    policy: 'dashboards.view',
    route: '/api/v1/smc/:instrumentId/zones',
  },
  // An empty body fails validation (400) after the guard.
  { method: 'POST', path: '/api/v1/replays', policy: 'replays.run', body: {} },
  {
    method: 'GET',
    path: `/api/v1/replays/${NOBODY}`,
    policy: 'dashboards.view',
    route: '/api/v1/replays/:runId',
  },
  { method: 'GET', path: '/api/v1/admin/instruments', policy: 'instruments.manage' },
  { method: 'POST', path: '/api/v1/admin/instruments', policy: 'instruments.manage', body: {} },
  { method: 'PATCH', path: `/api/v1/admin/instruments/${NOBODY}`, policy: 'instruments.manage', body: {} },
  { method: 'POST', path: '/api/v1/admin/closures', policy: 'settings.manage', body: {} },
  {
    method: 'DELETE',
    path: '/api/v1/admin/closures?from=0',
    policy: 'settings.manage',
    route: '/api/v1/admin/closures',
  },
  { method: 'GET', path: '/healthz', policy: 'public' },
  { method: 'GET', path: '/readyz', policy: 'public' },
];

function allowed(policy: AccessPolicy, role: Role | null): boolean {
  if (policy === 'public') return true;
  if (role === null) return false;
  return policy === 'authenticated' || can(role, policy);
}

let h: Harness;
const users = {} as Record<Role, TestUser>;
const tokens = {} as Record<Role, string>;

beforeAll(async () => {
  h = await startApi();
  for (const role of ROLES) {
    users[role] = await createUser(h, role);
    tokens[role] = await tokenFor(h, users[role]);
  }
});
afterAll(async () => {
  await h.close();
});

describe('RBAC matrix', () => {
  it('the endpoint table covers exactly the routes the application serves', () => {
    const router = (
      h.app.getHttpAdapter().getInstance() as {
        router: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] };
      }
    ).router;
    const served = router.stack
      // Nest also adds a catch-all layer for paths excluded from the global prefix; it answers 404.
      .filter((layer) => layer.route && Object.keys(layer.route.methods).length < 5)
      .flatMap((layer) =>
        Object.keys(layer.route!.methods).map((m) => `${m.toUpperCase()} ${layer.route!.path}`),
      )
      .filter((r) => !r.startsWith('OPTIONS '))
      .sort();
    const expected = ENDPOINTS.map((e) => `${e.method} ${e.route ?? e.path.replace(NOBODY, ':id')}`).sort();
    expect(served).toEqual(expected);
  });

  for (const endpoint of ENDPOINTS) {
    for (const role of [null, ...ROLES] as (Role | null)[]) {
      const ok = allowed(endpoint.policy, role);
      it(`${endpoint.method} ${endpoint.path.replace(NOBODY, ':id')} as ${role ?? 'anonymous'} → ${ok ? 'allowed' : 'refused'}`, async () => {
        const res = await call(h.base, endpoint.method, endpoint.path, {
          ...(role ? { token: tokens[role] } : {}),
          ...(endpoint.body !== undefined ? { body: endpoint.body } : {}),
        });
        if (ok) {
          expect([401, 403], `status ${res.status}: ${JSON.stringify(res.body)}`).not.toContain(res.status);
        } else {
          expect(res.status).toBe(role === null ? 401 : 403);
          expect(res.body.code).toBe(role === null ? 'AUTH_REQUIRED' : 'FORBIDDEN');
        }
      });
    }
  }

  it('answers 404 for other methods on the probe paths', async () => {
    for (const path of ['/healthz', '/readyz']) {
      expect((await call(h.base, 'POST', path, { body: {} })).status).toBe(404);
      expect((await call(h.base, 'DELETE', path)).status).toBe(404);
    }
  });
});
