import { CLIENT_HEADER, type Problem, ProblemSchema, type TokenResponse } from '@cip/contracts';
import type { Platform } from '../platform.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Problem | null,
  ) {
    super(problem?.detail ?? problem?.title ?? `Request failed (${status})`);
    this.name = 'ApiError';
  }

  get code(): Problem['code'] | undefined {
    return this.problem?.code;
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * REST client for /api/v1. The access token lives only in memory. On a 401 the client refreshes once
 * and retries; refreshes are serialised across browser tabs with the Web Locks API, because two tabs
 * presenting the same rotated refresh token would look like token theft and end the session.
 */
export class ApiClient {
  private accessToken: string | null = null;
  private refreshing: Promise<boolean> | null = null;

  constructor(
    private readonly platform: Platform,
    private readonly onSessionEnded: () => void,
  ) {}

  private async url(path: string): Promise<string> {
    return `${(await this.platform.getServerUrl()) ?? ''}${path}`;
  }

  private headers(body: boolean): Record<string, string> {
    return {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
      ...(this.platform.kind === 'desktop' ? { [CLIENT_HEADER]: 'desktop' } : {}),
    };
  }

  private async send(method: Method, path: string, body?: unknown): Promise<Response> {
    return fetch(await this.url(path), {
      method,
      headers: this.headers(body !== undefined),
      body: body === undefined ? null : JSON.stringify(body),
      // The refresh cookie is scoped to /api/v1/auth; elsewhere only the bearer token is used.
      credentials: path.startsWith('/api/v1/auth/') ? 'include' : 'same-origin',
    });
  }

  private static async fail(res: Response): Promise<never> {
    let problem: Problem | null = null;
    try {
      const parsed = ProblemSchema.safeParse(await res.json());
      if (parsed.success) problem = parsed.data;
    } catch {
      // not JSON: keep the status only
    }
    throw new ApiError(res.status, problem);
  }

  async request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    let res = await this.send(method, path, body);
    if (res.status === 401 && this.accessToken !== null) {
      if (await this.refresh()) {
        res = await this.send(method, path, body);
      } else {
        this.clear();
        this.onSessionEnded();
      }
    }
    if (!res.ok) return ApiClient.fail(res);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /** Calls an auth endpoint without the retry logic (login, MFA, enrolment). */
  async auth<T>(path: string, body: unknown): Promise<T> {
    const res = await this.send('POST', path, body);
    if (!res.ok) return ApiClient.fail(res);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  async acceptSession(tokens: TokenResponse): Promise<void> {
    this.accessToken = tokens.accessToken;
    if (this.platform.secureStore && tokens.refreshToken) {
      await this.platform.secureStore.set('refresh_token', tokens.refreshToken);
    }
  }

  get signedIn(): boolean {
    return this.accessToken !== null;
  }

  /** The in-memory access token, presented by the live connection at its handshake and renewals. */
  get token(): string | null {
    return this.accessToken;
  }

  /** Gets a new access token from the refresh token. Returns false when the session is over. */
  refresh(): Promise<boolean> {
    this.refreshing ??= this.withLock(() => this.doRefresh()).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async withLock(fn: () => Promise<boolean>): Promise<boolean> {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    return locks ? locks.request('cip-auth-refresh', fn) : fn();
  }

  private async doRefresh(): Promise<boolean> {
    let body: { refreshToken?: string } = {};
    if (this.platform.secureStore) {
      const stored = await this.platform.secureStore.get('refresh_token');
      if (!stored) return false;
      body = { refreshToken: stored };
    }
    const res = await this.send('POST', '/api/v1/auth/refresh', body);
    if (!res.ok) {
      if (this.platform.secureStore) await this.platform.secureStore.delete('refresh_token');
      return false;
    }
    await this.acceptSession((await res.json()) as TokenResponse);
    return true;
  }

  async logout(): Promise<void> {
    try {
      const refreshToken = this.platform.secureStore
        ? await this.platform.secureStore.get('refresh_token')
        : null;
      await this.send('POST', '/api/v1/auth/logout', refreshToken ? { refreshToken } : {});
    } finally {
      if (this.platform.secureStore) await this.platform.secureStore.delete('refresh_token');
      this.clear();
    }
  }

  clear(): void {
    this.accessToken = null;
  }
}
