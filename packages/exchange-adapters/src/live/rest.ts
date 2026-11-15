/**
 * Public REST access with the venue's limits mirrored locally (architecture §5.1): a token bucket in
 * request weight, `Retry-After` honoured, and a full pause after 429 (rate limited) or 418 (banned).
 */
export class RateLimitedError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number,
  ) {
    super(`rate limited (${status}), retry after ${retryAfterMs} ms`);
    this.name = 'RateLimitedError';
  }
}

export class RestBudget {
  private tokens: number;
  private updatedAt: number;
  private pausedUntil = 0;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.tokens = capacity;
    this.updatedAt = now();
  }

  /** Waits until `weight` is available (or throws while paused by the venue). */
  async take(weight: number): Promise<void> {
    for (;;) {
      const now = this.now();
      if (now < this.pausedUntil) throw new RateLimitedError(429, this.pausedUntil - now);
      this.tokens = Math.min(
        this.capacity,
        this.tokens + ((now - this.updatedAt) / 1000) * this.refillPerSecond,
      );
      this.updatedAt = now;
      if (this.tokens >= weight) {
        this.tokens -= weight;
        return;
      }
      await new Promise((r) =>
        setTimeout(r, Math.ceil(((weight - this.tokens) / this.refillPerSecond) * 1000)),
      );
    }
  }

  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
  }
}

/** The venue answered with an error status (400/404 mean it does not know what was asked for). */
export class RestStatusError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
  ) {
    super(`GET ${path} failed with ${status}`);
    this.name = 'RestStatusError';
  }
}

export interface RestClientOptions {
  baseUrl: string;
  budget: RestBudget;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

export class RestClient {
  constructor(private readonly opts: RestClientOptions) {}

  async get<T>(path: string, weight = 1): Promise<T> {
    await this.opts.budget.take(weight);
    const res = await (this.opts.fetchImpl ?? fetch)(`${this.opts.baseUrl}${path}`, {
      headers: { accept: 'application/json', 'user-agent': this.opts.userAgent ?? 'cip-market-data/1' },
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
    });
    if (res.status === 429 || res.status === 418) {
      const retryAfterMs = Number(res.headers.get('retry-after') ?? '60') * 1000;
      this.opts.budget.pause(retryAfterMs);
      throw new RateLimitedError(res.status, retryAfterMs);
    }
    if (!res.ok) throw new RestStatusError(path, res.status);
    return (await res.json()) as T;
  }
}
