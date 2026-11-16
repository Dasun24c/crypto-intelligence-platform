import type { TokenUsage } from './budget.js';
import type { ChatMessage } from './prompt.js';

/**
 * The model behind the AI analyses (ADR 023). Its own entry point (`@cip/ai/provider`): only the
 * jobs service, which alone holds the key, may import it (a dependency rule).
 */
export interface LlmRequest {
  model: string;
  messages: ChatMessage[];
  /** The answer's JSON Schema, for structured output. */
  schema: Record<string, unknown>;
  schemaName: string;
  maxCompletionTokens: number;
  /** Sent to reasoning models when set. */
  reasoningEffort: string | null;
}

export interface LlmResult {
  /** The answer as the model wrote it (JSON text). */
  content: string;
  /** The model the API says answered. */
  model: string;
  usage: TokenUsage;
  latencyMs: number;
}

/** Why a call gave no answer: stored as the analysis's `error`. */
export type LlmFailure =
  | 'no_key'
  | 'timeout'
  | 'network'
  | 'rate_limited'
  | 'http_400'
  | 'http_401'
  | 'http_403'
  | 'http_404'
  | 'http_4xx'
  | 'http_5xx'
  | 'bad_response';

export class LlmError extends Error {
  constructor(
    readonly failure: LlmFailure,
    detail: string,
    /** An answer that came back unusable was still billed: what it used, when the API said. */
    readonly usage: TokenUsage | null = null,
    readonly model: string | null = null,
  ) {
    super(detail);
  }
}

export interface LlmProvider {
  complete(req: LlmRequest): Promise<LlmResult>;
  /** The model ids the account can use (the startup check). */
  models(): Promise<string[]>;
}

export interface GrokOptions {
  /** `https://api.x.ai/v1`. */
  baseUrl: string;
  /** Read at every call, so a key added later needs no restart; undefined: no key. */
  apiKey: () => string | undefined;
  fetch?: typeof fetch;
  /** Default 60 s: reasoning takes time. */
  timeoutMs?: number;
  /** Attempts after the first, on 429, 5xx and network errors (never on a timeout: it may be billed). */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface ChatCompletion {
  model?: string;
  choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    reasoning_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    input_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
}

/**
 * Tokens from a usage object, whichever naming the API uses. Reasoning tokens are kept apart from
 * the visible answer's: when the total shows that the completion count includes them, they are
 * taken out of it.
 */
export function readUsage(u: ChatCompletion['usage']): TokenUsage {
  const input = u?.prompt_tokens ?? u?.input_tokens ?? 0;
  const completion = u?.completion_tokens ?? u?.output_tokens ?? 0;
  const reasoning =
    u?.completion_tokens_details?.reasoning_tokens ??
    u?.output_tokens_details?.reasoning_tokens ??
    u?.reasoning_tokens ??
    0;
  const cached = u?.prompt_tokens_details?.cached_tokens ?? u?.input_tokens_details?.cached_tokens ?? 0;
  const total = u?.total_tokens;
  const included =
    total !== undefined ? total === input + completion && reasoning > 0 : reasoning <= completion;
  return {
    inputTokens: input,
    cachedInputTokens: Math.min(cached, input),
    outputTokens: included ? Math.max(0, completion - reasoning) : completion,
    reasoningTokens: reasoning,
  };
}

const sleepFor = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * xAI's OpenAI-compatible Chat Completions API with structured output (feasibility §5): plain
 * `fetch`, a 60 s timeout, and up to 3 retries with exponential backoff on 429, 5xx and network
 * errors, honouring `Retry-After`. A timeout is not retried: the request may have been answered,
 * and billed, after all. A 400 that names the reasoning effort is sent again without it.
 */
export class GrokProvider implements LlmProvider {
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly o: GrokOptions) {
    this.fetch = o.fetch ?? globalThis.fetch;
    this.timeoutMs = o.timeoutMs ?? 60_000;
    this.retries = o.retries ?? 3;
    this.sleep = o.sleep ?? sleepFor;
    this.now = o.now ?? Date.now;
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      response_format: {
        type: 'json_schema',
        json_schema: { name: req.schemaName, schema: req.schema, strict: true },
      },
      max_completion_tokens: req.maxCompletionTokens,
      ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
    };
    const started = this.now();
    let res: Response;
    try {
      res = await this.post('/chat/completions', body);
    } catch (err) {
      if (
        err instanceof LlmError &&
        err.failure === 'http_400' &&
        req.reasoningEffort &&
        /reasoning/i.test(err.message)
      ) {
        delete body['reasoning_effort'];
        res = await this.post('/chat/completions', body);
      } else throw err;
    }
    let json: ChatCompletion;
    try {
      json = (await res.json()) as ChatCompletion;
    } catch {
      throw new LlmError('bad_response', 'the answer was not JSON');
    }
    const choice = json.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== 'string' || content.length === 0)
      throw new LlmError(
        'bad_response',
        choice?.message?.refusal
          ? `refused: ${choice.message.refusal}`
          : `no content (${choice?.finish_reason ?? 'none'})`,
        json.usage ? readUsage(json.usage) : null,
        json.model ?? null,
      );
    return {
      content,
      model: json.model ?? req.model,
      usage: readUsage(json.usage),
      latencyMs: this.now() - started,
    };
  }

  async models(): Promise<string[]> {
    const res = await this.request('GET', '/models');
    const json = (await res.json()) as { data?: { id?: string }[] };
    return (json.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
  }

  private post(path: string, body: unknown): Promise<Response> {
    return this.request('POST', path, body);
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    const key = this.o.apiKey();
    if (!key) throw new LlmError('no_key', 'no Grok API key is configured');
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetch(`${this.o.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${key}`,
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        if (!timeout && attempt < this.retries) {
          await this.sleep(backoff(attempt, null));
          continue;
        }
        throw new LlmError(timeout ? 'timeout' : 'network', err instanceof Error ? err.message : String(err));
      }
      if (res.ok) return res;
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < this.retries) {
        await this.sleep(backoff(attempt, res.headers.get('retry-after')));
        continue;
      }
      const text = (await res.text().catch(() => '')).slice(0, 500);
      throw new LlmError(failureOf(res.status), `HTTP ${res.status}: ${text}`);
    }
  }
}

function failureOf(status: number): LlmFailure {
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'http_5xx';
  if (status === 400 || status === 401 || status === 403 || status === 404) return `http_${status}`;
  return 'http_4xx';
}

/** 1 s, 2 s, 4 s, or what `Retry-After` asks (at most 30 s). */
export function backoff(attempt: number, retryAfter: string | null): number {
  const asked = retryAfter === null ? NaN : Number(retryAfter);
  if (Number.isFinite(asked) && asked >= 0) return Math.min(asked * 1000, 30_000);
  return 1000 * 2 ** attempt;
}
