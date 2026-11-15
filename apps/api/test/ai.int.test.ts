import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  AI_EVENTS_STREAM,
  AI_QUEUE,
  AI_STATUS_KEY,
  type AiAnalysisSummary,
  AiAnalysisDetailSchema,
  AiAnalysesPageSchema,
  type AiContext,
  type AiJob,
  type AiResponse,
  type AiStatusReport,
  AiUsageSchema,
  DEFAULT_AI_SETTINGS,
  type Envelope,
  type SubscribeAck,
  WS_NAMESPACE,
  WS_PATH,
} from '@cip/contracts';
import { createDb } from '@cip/db';
import { call, createUser, type Harness, startApi, type TestUser, tokenFor } from './harness.ts';

/** Phase 9 (ADR 023): the api's side of the AI analyses. No jobs service runs here. */
const BTC = '019a6f00-0000-7000-8000-000000000001';
const ETH = '019a6f00-0000-7000-8000-000000000002';
const H = 3_600_000;

let h: Harness;
const redis = new Redis(inject('redisUrl'));
const owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 2 });
const queueConnection = new Redis(inject('redisUrl'), { maxRetriesPerRequest: null });
const queue = new Queue<AiJob>(AI_QUEUE, { connection: queueConnection, prefix: 'cip' });
const sockets: Socket[] = [];
let viewer: TestUser;
let analyst: TestUser;
let admin: TestUser;
let viewerToken: string;
let analystToken: string;
let adminToken: string;

function api(method: string, path: string, token: string, body?: unknown) {
  h.clock.advance(100);
  return call(h.base, method, `/api/v1${path}`, { token, ...(body !== undefined ? { body } : {}) });
}

function context(): AiContext {
  return {
    contextVersion: '1',
    asOf: h.clock.now,
    instrument: {
      id: 'instr',
      displayName: 'BTC · Binance BTC/USDT',
      assetClass: 'crypto',
      venue: 'binance',
    },
    market: { id: 'mkt', last: '65432.10', change24hPct: -1.84, volume24hUsd: 1834500000, spreadBps: 0.03 },
    indicators: [],
    structure: [],
    levels: [],
    zones: [],
    setups: [],
    recentEvents: [],
    calendar: [],
    dataQuality: [],
  };
}

const answer: AiResponse = {
  stance: 'neutral',
  confidence: 'low',
  headline: 'A calm market with nothing decisive yet',
  summary: 'The platform sees the market but nothing that settles its direction.',
  observations: [{ text: 'The platform reports the live market.', refs: ['mkt'] }],
  supportingIndicators: [],
  risks: [{ text: 'Conditions can change quickly.', refs: ['mkt'] }],
  invalidation: { text: 'A new structure shift would change this view.', refs: ['instr'] },
  competingScenario: { text: 'A quiet market can break out either way.', refs: ['mkt'] },
  dataQualityNotes: [],
};

/** An analysis as the jobs service stores it. */
async function analysis(o: {
  instrumentId?: string;
  status: 'accepted' | 'rejected' | 'failed' | 'skipped_budget' | 'cache_hit';
  at: number;
  cost?: string | null;
  source?: string;
}): Promise<string> {
  const id = randomUUID();
  const shown = o.status === 'accepted' || o.status === 'cache_hit';
  await owner
    .insertInto('ai.analyses')
    .values({
      id,
      instrument_id: o.instrumentId ?? BTC,
      trigger: 'event',
      trigger_refs: JSON.stringify([{ kind: 'sweep', id: 'w1', score: 50, at: o.at }]),
      request_reason: null,
      setup_id: null,
      requested_by: null,
      context_hash: 'a'.repeat(64),
      context: JSON.stringify(context()),
      prompt_version: 'ai-1',
      model_requested: 'grok-4.3',
      model_reported: o.status === 'failed' ? null : 'grok-4.3-1120',
      status: o.status,
      cache_source_id: o.source ?? null,
      stance: shown ? 'neutral' : null,
      confidence: shown ? 'low' : null,
      response: o.status === 'failed' || o.status === 'skipped_budget' ? null : JSON.stringify(answer),
      validation: JSON.stringify(
        o.status === 'rejected'
          ? {
              errors: [{ rule: 'V3', path: 'summary', message: '12345.67 is not in the context' }],
              warnings: [],
            }
          : { errors: [], warnings: [] },
      ),
      repair_attempted: o.status === 'rejected',
      error: o.status === 'failed' ? 'timeout' : o.status === 'skipped_budget' ? 'daily_cap' : null,
      input_tokens: o.status === 'accepted' || o.status === 'rejected' ? 6_000 : null,
      cached_input_tokens: o.status === 'accepted' || o.status === 'rejected' ? 0 : null,
      output_tokens: o.status === 'accepted' || o.status === 'rejected' ? 800 : null,
      reasoning_tokens: o.status === 'accepted' || o.status === 'rejected' ? 0 : null,
      cost_usd:
        o.cost === undefined ? (o.status === 'accepted' || o.status === 'rejected' ? '0.0095' : '0') : o.cost,
      latency_ms: 1_200,
      created_at: new Date(o.at),
    })
    .execute();
  return id;
}

async function status(report: Partial<AiStatusReport> | null): Promise<void> {
  if (report === null) {
    await redis.del(AI_STATUS_KEY);
    return;
  }
  const full: AiStatusReport = {
    status: 'ok',
    detail: 'grok-4.3',
    keyConfigured: true,
    model: 'grok-4.3',
    budget: {
      state: 'ok',
      daily: { spentUsd: '0', capUsd: '5', usedPct: 0 },
      monthly: { spentUsd: '0', capUsd: '100', usedPct: 0 },
      enabled: true,
    },
    checkedAt: h.clock.now,
    ...report,
  };
  await redis.set(AI_STATUS_KEY, JSON.stringify(full), 'PX', 120_000);
}

async function settings(over: Record<string, unknown> | null): Promise<void> {
  if (over === null) {
    await owner.deleteFrom('app.settings').where('key', '=', 'ai').execute();
    return;
  }
  const value = JSON.stringify({ ...DEFAULT_AI_SETTINGS, ...over });
  await owner
    .insertInto('app.settings')
    .values({ key: 'ai', value, updated_by: null })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value }))
    .execute();
}

/** Fresh access tokens, after the test clock jumped past their lifetime. */
async function signIn(): Promise<void> {
  [viewerToken, analystToken, adminToken] = await Promise.all([
    tokenFor(h, viewer),
    tokenFor(h, analyst),
    tokenFor(h, admin),
  ]);
}

beforeAll(async () => {
  h = await startApi();
  viewer = await createUser(h, 'viewer');
  analyst = await createUser(h, 'analyst');
  admin = await createUser(h, 'admin');
  await signIn();
  await status({});
});
afterEach(async () => {
  await settings(null);
  await status({});
});
afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await queue.close();
  queueConnection.disconnect();
  redis.disconnect();
  await owner.destroy();
  await h.close();
});

describe('the AI history (API contracts §3, criterion 9.6)', () => {
  it('lists, filters and pages analyses, newest first; a rejected one has no headline', async () => {
    const t = h.clock.now - 10 * H;
    const accepted = await analysis({ status: 'accepted', at: t });
    const rejected = await analysis({ status: 'rejected', at: t + 1_000 });
    const cached = await analysis({ status: 'cache_hit', at: t + 2_000, source: accepted });
    const eth = await analysis({ status: 'failed', at: t + 3_000, instrumentId: ETH });

    const all = await api('GET', `/ai/analyses?from=${t}&to=${t + 4_000}`, viewerToken);
    expect(all.status).toBe(200);
    const page = AiAnalysesPageSchema.parse(all.body);
    expect(page.items.map((a) => a.id)).toEqual([eth, cached, rejected, accepted]);
    const byId = new Map<string, AiAnalysisSummary>(page.items.map((a) => [a.id, a]));
    expect(byId.get(accepted)).toMatchObject({
      status: 'accepted',
      stance: 'neutral',
      headline: answer.headline,
      costUsd: '0.0095',
      trigger: 'event',
    });
    expect(byId.get(rejected)).toMatchObject({ status: 'rejected', headline: null, stance: null });
    expect(byId.get(cached)).toMatchObject({
      cacheSourceId: accepted,
      headline: answer.headline,
      costUsd: '0',
    });
    expect(byId.get(eth)).toMatchObject({ status: 'failed', error: 'timeout', instrumentId: ETH });

    const btcAccepted = await api(
      'GET',
      `/ai/analyses?from=${t}&to=${t + 4_000}&instrumentId=${BTC}&status=accepted,rejected`,
      viewerToken,
    );
    expect(btcAccepted.body.items.map((a: AiAnalysisSummary) => a.id)).toEqual([rejected, accepted]);

    const first = await api('GET', `/ai/analyses?from=${t}&to=${t + 4_000}&limit=3`, viewerToken);
    expect(first.body.items).toHaveLength(3);
    const rest = await api(
      'GET',
      `/ai/analyses?from=${t}&to=${t + 4_000}&limit=3&cursor=${first.body.nextCursor}`,
      viewerToken,
    );
    expect(rest.body).toEqual({ items: [expect.objectContaining({ id: accepted })], nextCursor: null });
    expect((await api('GET', '/ai/analyses?cursor=nope', viewerToken)).status).toBe(400);
  });

  it('shows one analysis with the context sent, the answer, the validation and the usage', async () => {
    const id = await analysis({ status: 'rejected', at: h.clock.now - 9 * H });
    const res = await api('GET', `/ai/analyses/${id}`, viewerToken);
    expect(res.status).toBe(200);
    const detail = AiAnalysisDetailSchema.parse(res.body);
    expect(detail).toMatchObject({
      id,
      promptVersion: 'ai-1',
      modelRequested: 'grok-4.3',
      repairAttempted: true,
      response: answer,
      usage: { inputTokens: 6_000, outputTokens: 800, costUsd: '0.0095', latencyMs: 1_200 },
    });
    expect(detail.context?.market.last).toBe('65432.10');
    expect(detail.validation.errors[0]).toMatchObject({ rule: 'V3' });
    expect((await api('GET', `/ai/analyses/${randomUUID()}`, viewerToken)).status).toBe(404);
  });

  it('adds up the usage per UTC day, with the budget now', async () => {
    const day = Date.UTC(2026, 9, 3, 12);
    await analysis({ status: 'accepted', at: day });
    await analysis({ status: 'rejected', at: day + H });
    await analysis({ status: 'skipped_budget', at: day + 2 * H });
    await analysis({ status: 'accepted', at: day + 24 * H, instrumentId: ETH });
    const res = await api('GET', `/ai/usage?from=${day - H}&to=${day + 30 * H}`, viewerToken);
    expect(res.status).toBe(200);
    const usage = AiUsageSchema.parse(res.body);
    expect(usage.days).toEqual([
      {
        day: '2026-10-03',
        calls: 2,
        accepted: 1,
        rejected: 1,
        failed: 0,
        cacheHits: 0,
        skipped: 1,
        inputTokens: 12_000,
        outputTokens: 1_600,
        costUsd: '0.019',
      },
      expect.objectContaining({ day: '2026-10-04', calls: 1, costUsd: '0.0095' }),
    ]);
    expect(usage.budget).toMatchObject({ state: 'ok', enabled: true, daily: { capUsd: '5' } });
    expect((await api('GET', `/ai/usage?from=${day}&to=${day - 1}`, viewerToken)).status).toBe(400);
  });
});

describe('requesting an analysis (criterion 9.3)', () => {
  it('queues it for the jobs service, announces it on the ai channel and audits it', async () => {
    const res = await api('POST', '/ai/analyses', analystToken, {
      instrumentId: BTC,
      reason: 'market_summary',
    });
    expect(res.status).toBe(202);
    const { analysisId } = res.body as { analysisId: string };
    const job = await queue.getJob(analysisId);
    expect(job?.name).toBe('on_demand');
    expect(job?.data).toMatchObject({
      analysisId,
      trigger: 'on_demand',
      instrumentId: BTC,
      score: 100,
      requestedBy: analyst.id,
      reason: 'market_summary',
      setupId: null,
    });
    const [latest] = await redis.xrevrange(AI_EVENTS_STREAM, '+', '-', 'COUNT', 1);
    const fields = latest![1];
    expect(fields[1]).toBe('ai.queued');
    expect(JSON.parse(fields[3]!)).toMatchObject({ analysisId, instrumentId: BTC, trigger: 'on_demand' });
    const audit = await owner
      .selectFrom('app.audit_log')
      .selectAll()
      .where('action', '=', 'ai.requested')
      .where('target_id', '=', analysisId)
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({
      actor_user_id: analyst.id,
      details: { instrumentId: BTC, reason: 'market_summary' },
    });
  });

  it('checks the request: the instrument, the setup on it, and a setup review naming its setup', async () => {
    expect(
      (await api('POST', '/ai/analyses', analystToken, { instrumentId: randomUUID(), reason: 'refresh' }))
        .status,
    ).toBe(404);
    expect(
      (await api('POST', '/ai/analyses', analystToken, { instrumentId: BTC, reason: 'setup_review' })).status,
    ).toBe(400);
    const wrong = await api('POST', '/ai/analyses', analystToken, {
      instrumentId: BTC,
      reason: 'setup_review',
      setupId: randomUUID(),
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.errors[0].path).toBe('setupId');
    // Viewers read the history but do not ask.
    expect(
      (await api('POST', '/ai/analyses', viewerToken, { instrumentId: BTC, reason: 'refresh' })).status,
    ).toBe(403);
  });

  it('refuses while switched off, without a key, and once the budget is reached', async () => {
    const ask = () => api('POST', '/ai/analyses', adminToken, { instrumentId: ETH, reason: 'refresh' });
    await settings({ enabled: false });
    expect((await ask()).status).toBe(409);
    await settings(null);

    await status({
      status: 'down',
      detail: 'no Grok API key is configured',
      keyConfigured: false,
      model: null,
    });
    const noKey = await ask();
    expect(noKey.status).toBe(503);
    expect(noKey.body.detail).toBe('No Grok API key is configured.');
    await status({});

    // Today's spend leaves no room for a typical call under a $0.05 cap.
    await settings({ dailyCapUsd: 0.05 });
    await analysis({ status: 'accepted', at: h.clock.now - 60_000, cost: '0.03' });
    const spent = await ask();
    expect(spent.status).toBe(409);
    expect(spent.body).toMatchObject({
      code: 'BUDGET_EXHAUSTED',
      detail: expect.stringContaining('AI budget reached'),
    });
    const usage = AiUsageSchema.parse((await api('GET', '/ai/usage', viewerToken)).body);
    expect(usage.budget.state).toBe('exhausted');
  });

  it('allows 10 requests an hour per user', async () => {
    const someone = await createUser(h, 'analyst');
    const token = await tokenFor(h, someone);
    for (let i = 0; i < 10; i++)
      expect(
        (await api('POST', '/ai/analyses', token, { instrumentId: BTC, reason: 'refresh' })).status,
      ).toBe(202);
    const limited = await api('POST', '/ai/analyses', token, { instrumentId: BTC, reason: 'refresh' });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(300);
    // Another user is not affected; an hour later this one may ask again.
    expect(
      (await api('POST', '/ai/analyses', analystToken, { instrumentId: BTC, reason: 'refresh' })).status,
    ).toBe(202);
    h.clock.advance(H);
    const later = await tokenFor(h, someone);
    expect((await api('POST', '/ai/analyses', later, { instrumentId: BTC, reason: 'refresh' })).status).toBe(
      202,
    );
    await signIn();
  });
});

describe('the AI settings (admins)', () => {
  it('reads the defaults, saves a change, audits it, and refuses a model without prices', async () => {
    const before = await api('GET', '/admin/settings/ai', adminToken);
    expect(before.body).toEqual(DEFAULT_AI_SETTINGS);
    const next = { ...DEFAULT_AI_SETTINGS, dailyCapUsd: 3, reasoningEffort: 'medium' };
    const put = await api('PUT', '/admin/settings/ai', adminToken, next);
    expect(put.status).toBe(200);
    expect((await api('GET', '/admin/settings/ai', adminToken)).body).toEqual(next);
    const audit = await owner
      .selectFrom('app.audit_log')
      .selectAll()
      .where('action', '=', 'settings.updated')
      .where('target_id', '=', 'ai')
      .orderBy('chain_seq', 'desc')
      .executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({ before: { dailyCapUsd: 5 }, after: { dailyCapUsd: 3 } });
    const bad = await api('PUT', '/admin/settings/ai', adminToken, {
      ...DEFAULT_AI_SETTINGS,
      model: 'grok-9',
    });
    expect(bad.status).toBe(400);
  });
});

describe('the ai channel and the system health', () => {
  function connect(token: string): Promise<Socket> {
    const socket = io(h.base + WS_NAMESPACE, {
      path: WS_PATH,
      transports: ['websocket'],
      auth: { token },
      reconnection: false,
    });
    sockets.push(socket);
    return new Promise((resolve, reject) => {
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
    });
  }
  const received = (socket: Socket) => {
    const got: Envelope[] = [];
    socket.on('message', (e: Envelope) => {
      if (e.ch === 'ai') got.push(e);
    });
    return got;
  };
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 50));
  };
  const publish = (type: string, data: unknown) =>
    redis.xadd(AI_EVENTS_STREAM, '*', 'type', type, 'data', JSON.stringify(data)) as Promise<string>;

  it('delivers the analyses’ lifecycle live to every role, replays it, or sends a snapshot', async () => {
    const socket = await connect(viewerToken);
    const got = received(socket);
    const ack = (await socket.emitWithAck('subscribe', { channels: ['ai'] })) as SubscribeAck;
    expect(ack.results['ai']).toMatchObject({ mode: 'live' });
    const seq = await publish('ai.started', {
      analysisId: randomUUID(),
      instrumentId: BTC,
      trigger: 'event',
    });
    await until(() => got.length > 0);
    expect(got[0]).toMatchObject({ ch: 'ai', seq, type: 'ai.started', data: { instrumentId: BTC } });

    // A reconnecting client gets what it missed.
    const later = await publish('ai.budget', { budget: { state: 'throttled' } });
    const again = await connect(viewerToken);
    const replayed = received(again);
    const back = (await again.emitWithAck('subscribe', {
      channels: ['ai'],
      since: { ai: seq },
    })) as SubscribeAck;
    expect(back.results['ai']).toMatchObject({ mode: 'replayed' });
    await until(() => replayed.length > 0);
    expect(replayed.map((e) => e.seq)).toEqual([later]);

    // Too far back to replay: the budget and the latest analyses instead.
    const fresh = await connect(analystToken);
    const snap = (await fresh.emitWithAck('subscribe', {
      channels: ['ai'],
      since: { ai: '1-0' },
    })) as SubscribeAck;
    expect(snap.results['ai']).toMatchObject({
      mode: 'snapshot',
      snapshot: { budget: { state: expect.any(String) }, latest: expect.any(Array) },
    });
  });

  it('shows Grok and the budget in the system health from the jobs service’s report', async () => {
    await status({
      status: 'degraded',
      detail: 'grok-4.3 is not offered; using grok-4.20-0309-non-reasoning',
    });
    const health = await api('GET', '/system/health', viewerToken);
    expect(health.body.ai).toMatchObject({ status: 'degraded', keyConfigured: true });
    await status(null);
    expect((await api('GET', '/system/health', viewerToken)).body.ai).toBeUndefined();
  });
});
