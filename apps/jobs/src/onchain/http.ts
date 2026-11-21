/**
 * HTTP for the on-chain providers (ADR 025): JSON-RPC (Alchemy) and Esplora's REST API (mempool.space,
 * blockstream.info). URLs can carry an API key, so no URL is ever logged or put in an error message.
 */

const TIMEOUT_MS = 20_000;

/** A provider answered with a status: `retryAfterMs` when it asked us to slow down (429). */
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}

/** The provider could not be reached at all (DNS, refused or timed-out connection). */
export class ProviderUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnreachable';
  }
}

export type Fetch = typeof globalThis.fetch;

async function request(fetchFn: Fetch, url: string, init: RequestInit, what: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const cause =
      err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.name) : 'error';
    throw new ProviderUnreachable(`${what}: unreachable (${cause})`);
  }
  if (res.status === 429) {
    const after = Number(res.headers.get('retry-after'));
    await res.body?.cancel();
    throw new ProviderHttpError(429, `${what}: rate limited`, after > 0 ? after * 1000 : null);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new ProviderHttpError(res.status, `${what}: HTTP ${res.status}`);
  }
  return res;
}

/** JSON-RPC 2.0 over HTTP; a JSON-RPC error becomes a ProviderHttpError with its code. */
export async function jsonRpc<T>(
  fetchFn: Fetch,
  url: string,
  method: string,
  params: unknown[],
  what: string,
): Promise<T> {
  const res = await request(
    fetchFn,
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    },
    what,
  );
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw new ProviderHttpError(400, `${what}: ${method} failed (${body.error.code})`);
  return body.result as T;
}

/**
 * Esplora's REST API, one request at a time and at most one per `minIntervalMs`: the public
 * instances publish no limits, so it stays gentle.
 */
export class EsploraClient {
  private last = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly baseUrl: () => string,
    private readonly fetchFn: Fetch = globalThis.fetch,
    private readonly minIntervalMs = 250,
    private readonly sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  ) {}

  /** GET `{base}{path}` as JSON (or text). */
  get<T>(path: string, as: 'json' | 'text' = 'json'): Promise<T> {
    const run = this.chain.then(async () => {
      const wait = this.last + this.minIntervalMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.last = Date.now();
      const res = await request(this.fetchFn, `${this.baseUrl()}${path}`, {}, 'Bitcoin API');
      return (as === 'json' ? res.json() : res.text()) as Promise<T>;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}
