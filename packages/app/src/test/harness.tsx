import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { act, render } from '@testing-library/react';
import { vi } from 'vitest';
import type { Envelope, Role, SubscribeRequest, UserSummary } from '@cip/contracts';
import type { Platform } from '../platform.js';
import { createAppRouter } from '../router.js';
import { Session, SessionContext } from '../session.js';
import { ackAll, type FakeSocket, fakeSockets } from './fake-socket.js';

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });

const TITLES: Record<number, string> = {
  400: 'Validation failed',
  404: 'Not found',
  409: 'Conflict',
  500: 'Internal error',
  503: 'Service unavailable',
};
const CODES: Record<number, string> = {
  400: 'VALIDATION_FAILED',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  500: 'INTERNAL',
  503: 'UNAVAILABLE',
};

/** An RFC 9457 problem response, as the API sends it. */
export const problem = (status: number, detail?: string, extra: Record<string, unknown> = {}) =>
  json(status, {
    type: 'about:blank',
    title: TITLES[status] ?? 'Error',
    status,
    code: CODES[status] ?? 'INTERNAL',
    ...(detail ? { detail } : {}),
    ...extra,
  });

export interface ApiRequest {
  method: string;
  url: URL;
  body: unknown;
}

/** A route answers with a JSON body, or a Response for statuses other than 200. */
export type ApiRoutes = Record<string, unknown>;

/** Stubs fetch: `routes['GET /api/v1/instruments']` is a body, a Response, or a function of the request. */
export function mockApi(routes: ApiRoutes) {
  const requests: ApiRequest[] = [];
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://localhost');
    const method = init.method ?? 'GET';
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const request = { method, url, body };
    requests.push(request);
    const route = routes[`${method} ${url.pathname}`];
    if (route === undefined) return problem(404, `No test route for ${method} ${url.pathname}`);
    const result: unknown =
      typeof route === 'function' ? await (route as (r: ApiRequest) => unknown)(request) : route;
    return result instanceof Response ? result.clone() : json(200, result);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    requests,
    find: (method: string, pathname: string) =>
      requests.filter((r) => r.method === method && r.url.pathname === pathname),
  };
}

/** The gateway's side of the fake live connection. */
export class FakeLiveServer {
  /** Non-durable channel → the snapshot a subscribe returns. */
  readonly snapshots: Record<string, unknown> = {};
  readonly sockets = fakeSockets();
  private seq = 2_000;

  readonly create = (...args: Parameters<ReturnType<typeof fakeSockets>['create']>): FakeSocket => {
    const socket = this.sockets.create(...args);
    socket.autoOpen = true;
    socket.respond = (event, payload) => {
      if (event === 'subscribe') return ackAll((payload as SubscribeRequest).channels, this.snapshots);
      if (event === 'auth:renew') return { ok: true };
      return undefined;
    };
    return socket;
  };

  /** Every channel subscribed so far on the current connection. */
  subscribed(): string[] {
    const socket = this.sockets.made.at(-1);
    return socket ? socket.subscribeRequests().flatMap((r) => r.channels) : [];
  }

  /** Delivers a message as the gateway would; durable channels get the next seq. */
  push(ch: string, type: string, data: unknown, ts = Date.now()): void {
    const durable = ch.startsWith('trades:') || ch.startsWith('market:');
    const message: Envelope =
      durable && type !== 'spread' ? { ch, seq: `${this.seq++}-0`, ts, type, data } : { ch, ts, type, data };
    act(() => {
      for (const socket of this.sockets.made) if (socket.connected) socket.send(message);
    });
  }
}

const platform: Platform = {
  kind: 'web',
  appVersion: 'test',
  getServerUrl: () => Promise.resolve(''),
  secureStore: null,
  notify: () => Promise.resolve(),
  openExternal: () => Promise.resolve(),
  onSleepWake: () => () => undefined,
};

/** A signed-in session whose live connection talks to a FakeLiveServer. */
export async function signedIn(role: Role = 'viewer') {
  const server = new FakeLiveServer();
  const session = new Session(platform, { createSocket: server.create });
  const user: UserSummary = { id: 'user-1', email: `${role}@cip.test`, displayName: 'Test User', role };
  await session.client.acceptSession({ accessToken: 'access-1', expiresAt: Date.now() + 900_000, user });
  session.store.setState({
    state: {
      status: 'signed-in',
      user,
      me: {
        user,
        role,
        mfaEnabled: false,
        preferences: { displayTimeZone: 'UTC', watchlist: [], layouts: {} },
      },
    },
  });
  return { session, server, user };
}

/** Renders the whole signed-in app (shell and routes) at `path`. */
export function renderApp(path: string, session: Session, user: UserSummary) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }) });
  const view = render(
    <SessionContext.Provider value={session}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} context={{ user }} />
      </QueryClientProvider>
    </SessionContext.Provider>,
  );
  return { ...view, router, queryClient };
}
