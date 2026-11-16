import { describe, expect, it } from 'vitest';
import { backoff, GrokProvider, LlmError, type LlmRequest, readUsage } from './provider.js';

const REQ: LlmRequest = {
  model: 'grok-4.3',
  messages: [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'context' },
  ],
  schema: { type: 'object' },
  schemaName: 'cip_ai_analysis',
  maxCompletionTokens: 2_000,
  reasoningEffort: 'low',
};

interface Call {
  url: string;
  init: RequestInit;
}

function fake(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { f, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const answer = (content: string | null, usage: Record<string, unknown> = {}) =>
  json(200, {
    model: 'grok-4.3-0101',
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 6_000, completion_tokens: 800, total_tokens: 8_000, ...usage },
  });

function provider(responses: (Response | Error)[], key: string | null = 'xai-test') {
  const { f, calls } = fake(responses);
  const slept: number[] = [];
  let t = 0;
  const p = new GrokProvider({
    baseUrl: 'https://api.x.ai/v1',
    apiKey: () => key ?? undefined,
    fetch: f,
    sleep: async (ms) => {
      slept.push(ms);
    },
    now: () => (t += 250),
  });
  return { p, calls, slept };
}

describe('the Grok provider (ADR 023)', () => {
  it('asks for structured output and reads the answer, the model and the usage', async () => {
    const { p, calls } = provider([
      answer('{"stance":"neutral"}', {
        prompt_tokens_details: { cached_tokens: 3_000 },
        completion_tokens_details: { reasoning_tokens: 1_200 },
      }),
    ]);
    const r = await p.complete(REQ);
    expect(r).toEqual({
      content: '{"stance":"neutral"}',
      model: 'grok-4.3-0101',
      usage: { inputTokens: 6_000, cachedInputTokens: 3_000, outputTokens: 800, reasoningTokens: 1_200 },
      latencyMs: 250,
    });
    expect(calls[0]!.url).toBe('https://api.x.ai/v1/chat/completions');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer xai-test');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      model: 'grok-4.3',
      messages: REQ.messages,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'cip_ai_analysis', schema: { type: 'object' }, strict: true },
      },
      max_completion_tokens: 2_000,
      reasoning_effort: 'low',
    });
  });

  it('keeps reasoning apart from the visible answer, whichever way the usage counts it', () => {
    // Separate: total = input + completion + reasoning.
    expect(
      readUsage({
        prompt_tokens: 100,
        completion_tokens: 10,
        total_tokens: 160,
        completion_tokens_details: { reasoning_tokens: 50 },
      }),
    ).toEqual({ inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, reasoningTokens: 50 });
    // Included: total = input + completion.
    expect(
      readUsage({
        prompt_tokens: 100,
        completion_tokens: 60,
        total_tokens: 160,
        completion_tokens_details: { reasoning_tokens: 50 },
      }),
    ).toEqual({ inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, reasoningTokens: 50 });
    // The Responses API's names, and no total.
    expect(
      readUsage({
        input_tokens: 32,
        output_tokens: 9,
        input_tokens_details: { cached_tokens: 40 },
        output_tokens_details: { reasoning_tokens: 110 },
      }),
    ).toEqual({ inputTokens: 32, cachedInputTokens: 32, outputTokens: 9, reasoningTokens: 110 });
    expect(readUsage(undefined)).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    });
  });

  it('retries 429 and 5xx with backoff, honouring Retry-After, then fails', async () => {
    const { p, calls, slept } = provider([
      json(429, { error: 'slow down' }, { 'retry-after': '2' }),
      json(503, { error: 'busy' }),
      answer('{}'),
    ]);
    await expect(p.complete(REQ)).resolves.toMatchObject({ content: '{}' });
    expect(calls).toHaveLength(3);
    expect(slept).toEqual([2_000, 2_000]);
    const failing = provider([json(500, {}), json(500, {}), json(500, {}), json(500, {})]);
    await expect(failing.p.complete(REQ)).rejects.toMatchObject({ failure: 'http_5xx' });
    expect(failing.calls).toHaveLength(4);
    expect(failing.slept).toEqual([1_000, 2_000, 4_000]);
    const limited = provider([429, 429, 429, 429].map((s) => json(s, {})));
    await expect(limited.p.complete(REQ)).rejects.toMatchObject({ failure: 'rate_limited' });
  });

  it('retries network errors, never a timeout (it may have been billed), and says which', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    const { p, calls } = provider([timeout, answer('{}')]);
    await expect(p.complete(REQ)).rejects.toMatchObject({ failure: 'timeout' });
    expect(calls).toHaveLength(1);
    const net = provider([new Error('ECONNRESET'), answer('{}')]);
    await expect(net.p.complete(REQ)).resolves.toMatchObject({ content: '{}' });
    const down = provider([
      new Error('ENOTFOUND'),
      new Error('ENOTFOUND'),
      new Error('ENOTFOUND'),
      new Error('ENOTFOUND'),
    ]);
    await expect(down.p.complete(REQ)).rejects.toMatchObject({ failure: 'network' });
  });

  it('fails at once without a key, on 401, and on an answer without content', async () => {
    const none = provider([], null);
    await expect(none.p.complete(REQ)).rejects.toMatchObject({ failure: 'no_key' });
    expect(none.calls).toHaveLength(0);
    const empty = provider([], '');
    await expect(empty.p.complete(REQ)).rejects.toBeInstanceOf(LlmError);
    await expect(provider([json(401, { error: 'bad key' })]).p.complete(REQ)).rejects.toMatchObject({
      failure: 'http_401',
    });
    await expect(provider([json(403, {})]).p.complete(REQ)).rejects.toMatchObject({ failure: 'http_403' });
    await expect(provider([json(422, {})]).p.complete(REQ)).rejects.toMatchObject({ failure: 'http_4xx' });
    // An answer cut off before any content was still billed: its usage comes with the failure.
    await expect(provider([answer(null)]).p.complete(REQ)).rejects.toMatchObject({
      failure: 'bad_response',
      model: 'grok-4.3-0101',
      usage: { inputTokens: 6_000, outputTokens: 800 },
    });
    const refused = json(200, { choices: [{ message: { content: null, refusal: 'no' } }] });
    await expect(provider([refused]).p.complete(REQ)).rejects.toThrow('refused: no');
    await expect(provider([new Response('not json', { status: 200 })]).p.complete(REQ)).rejects.toMatchObject(
      {
        failure: 'bad_response',
      },
    );
  });

  it('sends a call again without the reasoning effort when the model refuses it', async () => {
    const { p, calls } = provider([json(400, { error: 'reasoning_effort is not supported' }), answer('{}')]);
    await expect(p.complete(REQ)).resolves.toMatchObject({ content: '{}' });
    expect(JSON.parse(calls[1]!.init.body as string)).not.toHaveProperty('reasoning_effort');
    // Other 400s are failures.
    await expect(provider([json(400, { error: 'bad schema' })]).p.complete(REQ)).rejects.toMatchObject({
      failure: 'http_400',
    });
  });

  it('lists the models for the startup check', async () => {
    const { p, calls } = provider([json(200, { data: [{ id: 'grok-4.3' }, { id: 'grok-4.7' }, {}] })]);
    expect(await p.models()).toEqual(['grok-4.3', 'grok-4.7']);
    expect(calls[0]!.url).toBe('https://api.x.ai/v1/models');
    expect(calls[0]!.init.method).toBe('GET');
  });

  it('backs off 1, 2 and 4 s, or as asked, at most 30 s', () => {
    expect([0, 1, 2].map((a) => backoff(a, null))).toEqual([1_000, 2_000, 4_000]);
    expect(backoff(0, '120')).toBe(30_000);
    expect(backoff(0, 'soon')).toBe(1_000);
  });
});
