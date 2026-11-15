import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { TokenResponse } from '@cip/contracts';
import type { Platform, SecureKey } from '../platform.js';
import { ApiClient, ApiError } from './client.js';

function memoryStore() {
  const data = new Map<SecureKey, string>();
  return {
    data,
    get: async (k: SecureKey) => data.get(k) ?? null,
    set: async (k: SecureKey, v: string) => void data.set(k, v),
    delete: async (k: SecureKey) => void data.delete(k),
  };
}

function platform(kind: 'web' | 'desktop', store = memoryStore()): Platform {
  return {
    kind,
    appVersion: 'test',
    getServerUrl: async () => (kind === 'desktop' ? 'https://cip.example.test' : ''),
    secureStore: kind === 'desktop' ? store : null,
    notify: async () => {},
    openExternal: async () => {},
    onSleepWake: () => () => {},
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const token = (n: number): TokenResponse => ({
  accessToken: `access-${n}`,
  expiresAt: 0,
  user: { id: 'u', email: 'e', displayName: 'd', role: 'viewer' },
});

// The client always calls fetch(url: string, init with a plain headers object).
type FetchMock = Mock<
  (url: string, init: RequestInit & { headers: Record<string, string> }) => Promise<Response>
>;
let fetchMock: FetchMock;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ApiClient', () => {
  it('refreshes once on 401 and retries the request with the new token', async () => {
    const client = new ApiClient(platform('web'), () => {});
    await client.acceptSession(token(1));
    fetchMock
      .mockResolvedValueOnce(
        json(401, { type: 'about:blank', title: 'x', status: 401, code: 'AUTH_EXPIRED' }),
      )
      .mockResolvedValueOnce(json(200, token(2)))
      .mockResolvedValueOnce(json(200, { ok: true }));
    await expect(client.request('GET', '/api/v1/me')).resolves.toEqual({ ok: true });
    const [refreshUrl, refreshInit] = fetchMock.mock.calls[1]!;
    expect(refreshUrl).toBe('/api/v1/auth/refresh');
    expect(refreshInit.credentials).toBe('include');
    expect(fetchMock.mock.calls[2]![1].headers.authorization).toBe('Bearer access-2');
  });

  it('shares one refresh between concurrent requests', async () => {
    const client = new ApiClient(platform('web'), () => {});
    await client.acceptSession(token(1));
    fetchMock.mockImplementation((url, init) => {
      if (url.endsWith('/auth/refresh')) return Promise.resolve(json(200, token(2)));
      const auth = init.headers.authorization;
      return Promise.resolve(
        auth === 'Bearer access-2'
          ? json(200, {})
          : json(401, { type: 'x', title: 'x', status: 401, code: 'AUTH_EXPIRED' }),
      );
    });
    await Promise.all([
      client.request('GET', '/a'),
      client.request('GET', '/b'),
      client.request('GET', '/c'),
    ]);
    expect(fetchMock.mock.calls.filter(([u]) => u.endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('ends the session when the refresh is refused', async () => {
    const ended = vi.fn();
    const client = new ApiClient(platform('web'), ended);
    await client.acceptSession(token(1));
    fetchMock
      .mockResolvedValueOnce(json(401, { type: 'x', title: 'x', status: 401, code: 'AUTH_EXPIRED' }))
      .mockResolvedValueOnce(json(401, { type: 'x', title: 'x', status: 401, code: 'AUTH_REQUIRED' }));
    await expect(client.request('GET', '/api/v1/me')).rejects.toBeInstanceOf(ApiError);
    expect(ended).toHaveBeenCalledOnce();
    expect(client.signedIn).toBe(false);
  });

  it('desktop: keeps the refresh token in the secure store and sends it in the body', async () => {
    const store = memoryStore();
    const client = new ApiClient(platform('desktop', store), () => {});
    await client.acceptSession({ ...token(1), refreshToken: 'rt-1' });
    expect(store.data.get('refresh_token')).toBe('rt-1');
    fetchMock.mockResolvedValueOnce(json(200, { ...token(2), refreshToken: 'rt-2' }));
    await expect(client.refresh()).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://cip.example.test/api/v1/auth/refresh');
    expect(JSON.parse(init.body as string)).toEqual({ refreshToken: 'rt-1' });
    expect(init.headers['x-client']).toBe('desktop');
    expect(store.data.get('refresh_token')).toBe('rt-2');
  });

  it('surfaces RFC 9457 problems as ApiError with the code', async () => {
    const client = new ApiClient(platform('web'), () => {});
    fetchMock.mockResolvedValueOnce(
      json(403, { type: 'about:blank', title: 'Forbidden', status: 403, code: 'FORBIDDEN' }),
    );
    const err = await client.request('GET', '/api/v1/admin/users').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('FORBIDDEN');
  });
});
