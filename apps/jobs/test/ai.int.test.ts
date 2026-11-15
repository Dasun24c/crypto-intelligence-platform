import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  AI_EVENTS_STREAM,
  AI_STATUS_KEY,
  type AiContext,
  type AiJob,
  type AiResponse,
  type AiSettings,
  AiStatusReportSchema,
  ANALYSIS_EVENTS_STREAM,
  DEFAULT_AI_SETTINGS,
  SETUP_DISCLAIMER,
  type SetupTransitionMessage,
} from '@cip/contracts';
import { createDb, LAUNCH_PROFILE_IDS } from '@cip/db';
import { digestSlot, worstCaseUsd } from '@cip/ai';
import { GrokProvider } from '@cip/ai/provider';
import { createLogger } from '@cip/observability';
import { ContextBuilder } from '../src/ai/context.ts';
import { AiStatusReporter } from '../src/ai/status.ts';
import { AiStore } from '../src/ai/store.ts';
import {
  AiTriggerFollower,
  analysisIdOf,
  compareIds,
  cooldownKey,
  DIGEST_SLOT_KEY,
  TRIGGERS_CURSOR_KEY,
  TRIGGERS_LEASE,
} from '../src/ai/triggers.ts';
import { AiWorker } from '../src/ai/worker.ts';

/** Phase 9 (ADR 023): the jobs service's AI pipeline against a fake xAI API. */
const BTC = '019a6f00-0000-7000-8000-000000000001';
const ETH = '019a6f00-0000-7000-8000-000000000002';
const SOL = '019a6f00-0000-7000-8000-000000000003';
const PAXG = '019a6f00-0000-7000-8000-000000000004';
const RUN = '019a6f00-0000-7000-8000-0000000a1001';
/** 20 November 2026, 10:00 UTC. */
const NOW = Date.UTC(2026, 10, 20, 10, 0);
const H = 3_600_000;
const MIN = 60_000;
/** Not a real key; the fake API only checks that it arrives. */
const KEY = 'test-grok-key-0123456789';

const log = createLogger({ service: 'jobs', instance: 'test', level: 'silent' });
const owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 2 });
const db = createDb({ connectionString: inject('dbRoleUrls').svc_jobs, max: 4 });
const redis = new Redis(inject('redisUrl'));
const store = new AiStore(db);
const contexts = new ContextBuilder(db, redis);
const id = (n: number) => `019a6f00-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
let userId: string;

// ----- a fake xAI API -----

interface Seen {
  method: string;
  path: string;
  auth: string | undefined;
  body: { model: string; messages: { role: string; content: string }[]; [k: string]: unknown } | null;
}
interface Reply {
  status: number;
  body: unknown;
  delayMs?: number;
}
type Handler = (seen: Seen) => Reply;

class FakeXai {
  readonly seen: Seen[] = [];
  models = ['grok-4.3', 'grok-4.20-0309-non-reasoning'];
  modelsStatus = 200;
  url = '';
  private queue: Handler[] = [];
  private server: Server | null = null;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const seen: Seen = {
          method: req.method ?? '',
          path: req.url ?? '',
          auth: req.headers.authorization,
          body: raw ? (JSON.parse(raw) as Seen['body']) : null,
        };
        this.seen.push(seen);
        const reply = seen.path.endsWith('/models')
          ? { status: this.modelsStatus, body: { data: this.models.map((m) => ({ id: m })) } }
          : (this.queue.shift() ?? good)(seen);
        const send = () => {
          if (res.destroyed) return;
          res.writeHead(reply.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(reply.body));
        };
        if ('delayMs' in reply && reply.delayMs) setTimeout(send, reply.delayMs);
        else send();
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
  }

  next(...handlers: Handler[]): void {
    this.queue.push(...handlers);
  }

  calls(): Seen[] {
    return this.seen.filter((s) => s.path.endsWith('/chat/completions'));
  }

  reset(): void {
    this.seen.length = 0;
    this.queue = [];
    this.models = ['grok-4.3', 'grok-4.20-0309-non-reasoning'];
    this.modelsStatus = 200;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const fake = new FakeXai();

/** The context the worker sent, read back from the request. */
function contextOf(seen: Seen): AiContext {
  const user = seen.body!.messages.find((m) => m.role === 'user')!.content;
  return JSON.parse(user.split('Context (JSON):\n')[1]!) as AiContext;
}

const completion = (content: string, model = 'grok-4.3-1120'): Reply => ({
  status: 200,
  body: {
    model,
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 6_000, completion_tokens: 800, total_tokens: 6_800 },
  },
});

/** A valid answer for whatever context was sent: it cites the context's own ids and prices. */
function answerFor(ctx: AiContext): AiResponse {
  const level = ctx.levels[0];
  const setup = ctx.setups[0];
  return {
    stance: 'neutral',
    confidence: 'low',
    headline: 'A calm market with nothing decisive yet',
    summary: 'The platform sees the market but nothing that settles its direction.',
    observations: [
      { text: 'The platform reports the live market for this instrument.', refs: ['mkt'] },
      ...(level
        ? [{ text: `The nearest level is the ${level.type} at ${level.price}.`, refs: [level.id] }]
        : []),
      ...(setup ? [{ text: `A ${setup.direction} setup is ${setup.state}.`, refs: [setup.id] }] : []),
    ],
    supportingIndicators: [],
    risks: [
      { text: 'Conditions can change quickly.', refs: ['mkt'] },
      ...(ctx.goldMarket ? [{ text: 'The gold market sets the token’s value.', refs: ['gold'] }] : []),
    ],
    invalidation: { text: 'A new structure shift would change this view.', refs: ['instr'] },
    competingScenario: { text: 'A quiet market can break out either way.', refs: ['mkt'] },
    dataQualityNotes: ctx.dataQuality.length ? ['Some of the platform data is missing or warming up.'] : [],
  };
}

const good: Handler = (seen) => completion(JSON.stringify(answerFor(contextOf(seen))));
/** A price that is nowhere in the context (V3). */
const ungrounded: Handler = (seen) => {
  const a = answerFor(contextOf(seen));
  a.observations.push({ text: 'Price may revisit 12345.67 soon.', refs: ['mkt'] });
  return completion(JSON.stringify(a));
};
/** A made-up id (V2) and certainty language (V4). */
const overconfident: Handler = (seen) => {
  const a = answerFor(contextOf(seen));
  a.observations = [{ text: 'A rally is guaranteed from here.', refs: ['lvl:deadbeef'] }];
  return completion(JSON.stringify(a));
};

// ----- helpers -----

function job(instrumentId: string, over: Partial<AiJob> = {}): AiJob {
  return {
    analysisId: randomUUID(),
    trigger: 'on_demand',
    instrumentId,
    score: 100,
    triggerRefs: [{ kind: 'request', id: 'test', score: 100, at: NOW }],
    requestedBy: userId,
    reason: 'market_summary',
    setupId: null,
    queuedAt: NOW,
    ...over,
  };
}

function worker(o: {
  now: number | (() => number);
  key?: string | null;
  timeoutMs?: number;
  model?: (s: AiSettings) => string;
}) {
  const provider = new GrokProvider({
    baseUrl: fake.url,
    apiKey: () => (o.key === null ? undefined : (o.key ?? KEY)),
    timeoutMs: o.timeoutMs,
    sleep: async () => undefined,
  });
  const now = o.now;
  return new AiWorker({
    store,
    contexts,
    provider,
    redis,
    log,
    model: o.model ?? ((s) => s.model),
    now: typeof now === 'number' ? () => now : now,
  });
}

async function settings(over: Partial<AiSettings>): Promise<void> {
  const value = JSON.stringify({ ...DEFAULT_AI_SETTINGS, ...over });
  await owner
    .insertInto('app.settings')
    .values({ key: 'ai', value, updated_by: null })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value }))
    .execute();
}

async function row(analysisId: string) {
  return owner.selectFrom('ai.analyses').selectAll().where('id', '=', analysisId).executeTakeFirstOrThrow();
}

/** The `ai:events` messages about one analysis, in order. */
async function eventsOf(analysisId: string): Promise<string[]> {
  const all = await redis.xrange(AI_EVENTS_STREAM, '-', '+');
  return all.filter(([, f]) => f[3]!.includes(analysisId)).map(([, f]) => f[1]!);
}

async function until(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ----- a live analysis run for BTC -----

async function seedRun(): Promise<void> {
  await owner
    .insertInto('analysis.detection_runs')
    .values({
      id: RUN,
      mode: 'live',
      instrument_id: BTC,
      profile_id: LAUNCH_PROFILE_IDS['crypto-majors'],
      ruleset_version: 'test',
      params_hash: 'hash',
      from_time: new Date(NOW - 30 * 24 * H),
      status: 'running',
      started_at: new Date(NOW - 30 * 24 * H),
    })
    .execute();
  const ind = (tf: '1h' | '4h', rsi: number, atr: number) => ({
    instrument_id: BTC,
    timeframe: tf,
    open_time: new Date(NOW - (tf === '1h' ? 2 : 8) * H),
    run_id: RUN,
    rsi,
    macd: 1,
    macd_signal: 0.5,
    macd_hist: 0.123456789,
    ema_fast: 65100.5,
    ema_mid: 65000,
    ema_slow: 64800.25,
    vwap: null,
    atr,
    volume_z: 3.4,
    volume_anomaly: true,
    trend: 'bullish' as const,
    trend_strength: 0.6,
  });
  await owner
    .insertInto('analysis.indicator_values')
    .values([ind('1h', 38.6, 400), ind('4h', 44.2, 900)])
    .execute();
  await owner
    .insertInto('analysis.swing_points')
    .values({
      id: id(0xa2001),
      run_id: RUN,
      instrument_id: BTC,
      timeframe: '1h',
      kind: 'high',
      structure_level: 'internal',
      price: '65210.50',
      candle_time: new Date(NOW - 6 * H),
      confirmed_at: new Date(NOW - 5 * H),
      flags: [],
    })
    .execute();
  await owner
    .insertInto('analysis.structure_events')
    .values({
      id: id(0xa2002),
      run_id: RUN,
      instrument_id: BTC,
      timeframe: '1h',
      structure_level: 'internal',
      type: 'mss',
      direction: 'bullish',
      broken_swing_id: id(0xa2001),
      break_price: '65210.50',
      break_candle_time: new Date(NOW - H),
      is_initial: false,
      displacement: null,
      flags: [],
    })
    .execute();
  const level = (
    n: number,
    type: string,
    status: 'active' | 'swept',
    price: string,
    changed: number | null,
  ) => ({
    id: id(n),
    run_id: RUN,
    instrument_id: BTC,
    origin_timeframe: '1h' as const,
    type,
    side: type.endsWith('l') ? ('sell_side' as const) : ('buy_side' as const),
    price,
    touches: 1,
    session_name: null,
    source_ref: JSON.stringify({ keys: [] }),
    location: 'none' as const,
    known_at: new Date(NOW - 20 * H),
    status,
    status_changed_at: changed === null ? null : new Date(changed),
    sweep_count: status === 'swept' ? 1 : 0,
    flags: [],
  });
  await owner
    .insertInto('analysis.liquidity_levels')
    .values([
      level(0xa2010, 'pdl', 'swept', '64150.00', NOW - 2 * H),
      level(0xa2011, 'pdh', 'active', '66820.40', null),
      // Swept a day ago: history, not context.
      level(0xa2012, 'pwl', 'swept', '61000.00', NOW - 30 * H),
    ] as never)
    .execute();
  await owner
    .insertInto('analysis.sweeps')
    .values({
      id: id(0xa2020),
      run_id: RUN,
      instrument_id: BTC,
      timeframe: '1h',
      level_id: id(0xa2010),
      group_id: id(0xa2021),
      kind: 'wick',
      side: 'sell_side',
      level_price: '64150.00',
      extreme_price: '64090.00',
      penetration_atr: 0.15,
      breach_candle_time: new Date(NOW - 2 * H),
      confirmed_candle_time: new Date(NOW - 2 * H),
      notional_beyond_usd: null,
      flags: [],
    })
    .execute();
  await owner
    .insertInto('analysis.poi_zones')
    .values({
      id: id(0xa2030),
      run_id: RUN,
      instrument_id: BTC,
      timeframe: '1h',
      type: 'order_block',
      direction: 'bullish',
      top: '64890.00',
      bottom: '64512.30',
      origin_from: new Date(NOW - 3 * H),
      origin_to: new Date(NOW - 2 * H),
      known_at: new Date(NOW - H),
      status: 'untouched',
      flags: [],
    } as never)
    .execute();
  const setup = (n: number, state: 'confirmed' | 'resolved', over: Record<string, unknown> = {}) => ({
    id: id(n),
    run_id: RUN,
    instrument_id: BTC,
    pattern: 'htf_order_block',
    variant: null,
    direction: 'bullish',
    context_tf: '4h',
    setup_tf: '15m',
    state,
    resolution: state === 'resolved' ? 'target_reached' : null,
    entry_zone_id: id(0xa2030),
    entry_price: '64890.00',
    invalidation_price: '64512.30',
    target1_price: '66820.40',
    target2_price: null,
    target1_ref: null,
    target2_ref: null,
    rr_target1: 5.111111,
    confluence_score: 82.5,
    mandatory_passed: true,
    quality_flags: [],
    flags: [],
    refs: JSON.stringify({ sweeps: [], mss: null, rangeId: null, poiId: null, levelIds: [] }),
    created_candle_time: new Date(NOW - 3 * H),
    updated_candle_time: new Date(NOW - H),
    resolved_candle_time: state === 'resolved' ? new Date(NOW - H) : null,
    ...over,
  });
  await owner
    .insertInto('analysis.setups')
    .values([
      setup(0xa2040, 'confirmed'),
      setup(0xa2041, 'resolved', { created_candle_time: new Date(NOW - 10 * H) }),
    ] as never)
    .execute();
  await owner
    .insertInto('analysis.setup_transitions')
    .values({
      setup_id: id(0xa2040),
      event_seq: 77,
      from_state: 'triggered',
      to_state: 'confirmed',
      candle_time: new Date(NOW - H - 15 * MIN),
      decided_at: new Date(NOW - H),
      processed_at: new Date(NOW - H + 1_000),
      reason: 'mss_confirmed',
      evidence: JSON.stringify({}),
    })
    .execute();
  await owner
    .insertInto('analysis.setup_checklist_results')
    .values([
      {
        setup_id: id(0xa2040),
        state: 'confirmed',
        item: 'sweep',
        credit: 1,
        weight: 15,
        mandatory: true,
        evidence: '{}',
      },
      {
        setup_id: id(0xa2040),
        state: 'confirmed',
        item: 'htf_bias',
        credit: 0.5,
        weight: 15,
        mandatory: false,
        evidence: '{}',
      },
      // An earlier state's evaluation is not the setup's checklist now.
      {
        setup_id: id(0xa2040),
        state: 'forming',
        item: 'sweep',
        credit: 0,
        weight: 15,
        mandatory: true,
        evidence: '{}',
      },
    ] as never)
    .execute();
  await owner
    .insertInto('market.economic_events')
    .values([
      {
        id: id(0xa2050),
        source: 'manual',
        source_ref: 'test-cpi',
        release: null,
        title: 'US CPI',
        category: 'inflation',
        impact: 'high',
        scheduled_at: new Date(NOW + 3 * H),
        time_confirmed: true,
        actual: null,
        forecast: null,
        previous: null,
        created_by: null,
      },
      {
        id: id(0xa2051),
        source: 'manual',
        source_ref: 'test-minor',
        release: null,
        title: 'A minor release',
        category: 'other',
        impact: 'low',
        scheduled_at: new Date(NOW + 4 * H),
        time_confirmed: true,
        actual: null,
        forecast: null,
        previous: null,
        created_by: null,
      },
    ] as never)
    .execute();
  await redis.set(
    `ticker:${BTC}`,
    JSON.stringify({
      instrumentId: BTC,
      ts: NOW,
      last: '65432.10',
      bid: '65432.00',
      ask: '65432.20',
      change24hPct: -1.8412,
      volume24hQuote: '1834500000.55',
    }),
  );
}

beforeAll(async () => {
  await fake.start();
  userId = randomUUID();
  await owner
    .insertInto('app.users')
    .values({
      id: userId,
      email: `${userId}@cip.test`,
      display_name: 'x',
      role: 'analyst',
      password_hash: 'x',
    })
    .execute();
  await seedRun();
});
afterEach(async () => {
  fake.reset();
  await owner.deleteFrom('app.settings').where('key', '=', 'ai').execute();
});
afterAll(async () => {
  await fake.stop();
  redis.disconnect();
  await db.destroy();
  await owner.destroy();
});

describe('the context the model sees (API contracts §6.1)', () => {
  it('is built from the live run, the ticker and the calendar, with short stable ids', async () => {
    const { context, runId, setupRef } = await contexts.build(BTC, NOW);
    expect(runId).toBe(RUN);
    expect(setupRef).toBeNull();
    expect(context.instrument).toMatchObject({ id: 'instr', assetClass: 'crypto', venue: 'binance' });
    expect(context.market).toEqual({
      id: 'mkt',
      last: '65432.10',
      change24hPct: -1.84,
      volume24hUsd: 1834500001,
      spreadBps: 0.03,
    });
    expect(context.goldMarket).toBeUndefined();
    // Six significant digits: what the model copies is what was sent.
    expect(context.indicators).toContainEqual({
      id: 'ind:1h:macd_hist',
      tf: '1h',
      name: 'macd_hist',
      value: 0.123457,
    });
    expect(context.indicators).toContainEqual({ id: 'ind:4h:rsi', tf: '4h', name: 'rsi', value: 44.2 });
    expect(context.structure.find((s) => s.id === 'str:1h')).toMatchObject({
      trend: 'bullish',
      lastEvent: { type: 'mss', direction: 'bullish', price: '65210.50' },
    });
    expect(context.structure.find((s) => s.id === 'str:15m')).toMatchObject({
      trend: 'undefined',
      lastEvent: null,
    });
    // Active levels and ones swept in the last 6 h, nearest first in 1h ATRs; not the old sweep.
    expect(context.levels.map((l) => [l.type, l.price, l.status, l.distanceAtr])).toEqual(
      [
        ['pdh', '66820.40', 'active', 3.5],
        ['pdl', '64150.00', 'swept', 3.2],
      ].sort((a, b) => (a[3] as number) - (b[3] as number)),
    );
    expect(context.levels.every((l) => /^lvl:[0-9a-f]{8}$/.test(l.id))).toBe(true);
    expect(context.zones).toEqual([
      expect.objectContaining({ type: 'order_block', top: '64890.00', bottom: '64512.30', fillPct: 0 }),
    ]);
    // The live setup with its current checklist; the resolved one only when reviewed.
    expect(context.setups).toHaveLength(1);
    expect(context.setups[0]).toMatchObject({
      pattern: 'htf_order_block',
      state: 'confirmed',
      entry: '64890.00',
      rr: 5.11111,
      score: 82.5,
    });
    expect(context.setups[0]!.checklist).toEqual(
      expect.arrayContaining([
        { item: 'sweep', credit: 1 },
        { item: 'htf_bias', credit: 0.5 },
      ]),
    );
    expect(context.setups[0]!.checklist).toHaveLength(2);
    // The last 6 h, newest first: the MSS and the transition an hour ago, the sweep two hours ago.
    expect(context.recentEvents.map((e) => e.type)).toEqual(
      expect.arrayContaining(['structure', 'sweep', 'setup']),
    );
    expect(context.recentEvents.at(-1)).toMatchObject({
      type: 'sweep',
      summary: expect.stringContaining('pdl at 64150.00'),
    });
    // The end of the setup's UUID, and the transition's number.
    expect(context.recentEvents.find((e) => e.type === 'setup')!.id).toMatch(/^evt:000a2040:\d+$/);
    expect(context.calendar).toEqual([expect.objectContaining({ title: 'US CPI', impact: 'high' })]);
    expect(context.dataQuality).toEqual([]);

    const reviewed = await contexts.build(BTC, NOW, { setupId: id(0xa2041) });
    expect(reviewed.context.setups).toHaveLength(2);
    expect(reviewed.setupRef).toBe(reviewed.context.setups.find((s) => s.state === 'resolved')!.id);
  });

  it('says what is missing: no live run, no ticker; and gives PAXG its gold market', async () => {
    const { context, runId } = await contexts.build(PAXG, NOW);
    expect(runId).toBeNull();
    expect(context.dataQuality.map((d) => d.code)).toEqual(['no_run', 'no_ticker']);
    expect(context.goldMarket).toMatchObject({
      id: 'gold',
      status: expect.stringMatching(/^(open|closed)$/),
    });
    expect(context.levels).toEqual([]);
  });
});

describe('an analysis (ADR 023 worker steps)', () => {
  it('calls Grok with structured output and keeps exactly what was sent and received (criteria 9.1, 9.6)', async () => {
    const j = job(BTC);
    const summary = await worker({ now: NOW }).run(j);
    expect(summary).toMatchObject({
      id: j.analysisId,
      status: 'accepted',
      stance: 'neutral',
      costUsd: '0.0095',
    });

    const [call] = fake.calls();
    expect(call!.auth).toBe(`Bearer ${KEY}`);
    expect(call!.body).toMatchObject({
      model: 'grok-4.3',
      max_completion_tokens: 2_000,
      reasoning_effort: 'low',
      response_format: { type: 'json_schema', json_schema: { name: 'cip_ai_analysis', strict: true } },
    });
    expect(call!.body!.messages[0]!.role).toBe('system');

    const r = await row(j.analysisId);
    expect(r.context).toEqual(contextOf(call!));
    expect(r.context_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.response).toEqual(answerFor(contextOf(call!)));
    expect(r.validation).toEqual({ errors: [], warnings: [] });
    expect(r).toMatchObject({
      status: 'accepted',
      prompt_version: 'ai-1',
      model_requested: 'grok-4.3',
      model_reported: 'grok-4.3-1120',
      input_tokens: 6_000,
      output_tokens: 800,
      reasoning_tokens: 0,
      cost_usd: '0.009500',
      repair_attempted: false,
      requested_by: userId,
      request_reason: 'market_summary',
    });
    expect(r.latency_ms).toBeGreaterThanOrEqual(0);
    expect(await eventsOf(j.analysisId)).toEqual(['ai.started', 'ai.completed']);

    // A job run again finds its analysis and calls nothing.
    await expect(worker({ now: NOW + MIN }).run(j)).resolves.toMatchObject({ id: j.analysisId });
    expect(fake.calls()).toHaveLength(1);
  });

  it('serves an identical context from the cache for 30 minutes, at no cost (criterion 9.4)', async () => {
    const at = NOW + 2 * H;
    const first = await worker({ now: at }).run(job(BTC));
    expect(first.status).toBe('accepted');
    const again = await worker({ now: at + 10 * MIN }).run(job(BTC));
    expect(again).toMatchObject({
      status: 'cache_hit',
      cacheSourceId: first.id,
      costUsd: '0',
      headline: first.headline,
    });
    expect(fake.calls()).toHaveLength(1);
    const r = await row(again.id);
    expect(r.response).toEqual((await row(first.id)).response);
    // Past the window it calls again.
    const later = await worker({ now: at + 31 * MIN }).run(job(BTC));
    expect(later.status).toBe('accepted');
    expect(fake.calls()).toHaveLength(2);
  });

  it('repairs an answer that fails validation once, keeping the first errors', async () => {
    fake.next(ungrounded, good);
    const j = job(ETH, { analysisId: randomUUID() });
    const summary = await worker({ now: NOW + 5 * H }).run(j);
    expect(summary).toMatchObject({ status: 'accepted', costUsd: '0.019' });
    const [, second] = fake.calls();
    const msgs = second!.body!.messages;
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(msgs[3]!.content).toContain('[V3]');
    const r = await row(j.analysisId);
    expect(r.repair_attempted).toBe(true);
    expect(r).toMatchObject({ input_tokens: 12_000, output_tokens: 1_600 });
    const v = r.validation as { errors: unknown[]; firstAttemptErrors: { rule: string }[] };
    expect(v.errors).toEqual([]);
    expect(v.firstAttemptErrors.map((e) => e.rule)).toEqual(['V3']);
  });

  it('rejects an answer that fails twice, and keeps it with what was wrong (criterion 9.2)', async () => {
    fake.next(ungrounded, overconfident);
    const j = job(SOL);
    const summary = await worker({ now: NOW + 6 * H }).run(j);
    expect(summary).toMatchObject({ status: 'rejected', headline: null, stance: null });
    const r = await row(j.analysisId);
    expect(r.repair_attempted).toBe(true);
    const v = r.validation as { errors: { rule: string }[]; firstAttemptErrors: { rule: string }[] };
    expect(new Set(v.errors.map((e) => e.rule))).toEqual(new Set(['V2', 'V4']));
    expect(v.firstAttemptErrors.map((e) => e.rule)).toEqual(['V3']);
    expect((r.response as AiResponse).observations[0]!.text).toContain('guaranteed');
    expect(r.cost_usd).toBe('0.019000');
    expect(await eventsOf(j.analysisId)).toEqual(['ai.started', 'ai.rejected']);
  });

  it('fails without a key and calls nothing', async () => {
    const j = job(ETH);
    const summary = await worker({ now: NOW + 7 * H, key: null }).run(j);
    expect(summary).toMatchObject({ status: 'failed', error: 'no_key', costUsd: '0' });
    expect(fake.calls()).toHaveLength(0);
    expect(await eventsOf(j.analysisId)).toEqual(['ai.started', 'ai.failed']);
  });

  it('counts a timed-out call at its worst case and never retries it (it may have been billed)', async () => {
    fake.next(() => ({ ...completion('{}'), delayMs: 2_000 }));
    const j = job(SOL);
    const summary = await worker({ now: NOW + 8 * H, timeoutMs: 200 }).run(j);
    expect(summary).toMatchObject({ status: 'failed', error: 'timeout' });
    expect(fake.calls()).toHaveLength(1);
    const r = await row(j.analysisId);
    expect(Number(r.cost_usd)).toBeGreaterThan(0.015);
    expect(r.input_tokens).toBeNull();
  });

  it('keeps the usage of an answer that came back without content', async () => {
    fake.next(() => ({
      status: 200,
      body: {
        model: 'grok-4.3-1120',
        choices: [{ message: { content: null }, finish_reason: 'length' }],
        usage: { prompt_tokens: 5_000, completion_tokens: 2_000, total_tokens: 7_000 },
      },
    }));
    const j = job(SOL);
    const summary = await worker({ now: NOW + 9 * H }).run(j);
    expect(summary).toMatchObject({ status: 'failed', error: 'bad_response', costUsd: '0.01125' });
    expect(await row(j.analysisId)).toMatchObject({ input_tokens: 5_000, output_tokens: 2_000 });
  });

  it('stores a context that could not be built as a failure', async () => {
    const broken = new AiWorker({
      store,
      contexts: { build: () => Promise.reject(new Error('database gone')) },
      provider: new GrokProvider({ baseUrl: fake.url, apiKey: () => KEY }),
      redis,
      log,
      model: (s) => s.model,
      now: () => NOW + 10 * H,
    });
    const j = job(ETH);
    await expect(broken.run(j)).resolves.toMatchObject({ status: 'failed', error: 'context_unavailable' });
    const detail = await row(j.analysisId);
    expect(detail.context_hash).toBe('');
    expect(fake.calls()).toHaveLength(0);
  });
});

describe('the budget (NFR-08, criterion 9.3)', () => {
  it('stops at the daily cap before a call that could pass it, and resumes the next UTC day', async () => {
    // Each fake call costs $0.0095; a call's worst case is about $0.016: two fit under $0.03, a third does not.
    await settings({ dailyCapUsd: 0.03 });
    const day = Date.UTC(2026, 11, 2, 9, 0);
    const w = worker({ now: day });
    expect((await w.run(job(BTC))).status).toBe('accepted');
    expect((await w.run(job(ETH))).status).toBe('accepted');
    const third = job(SOL);
    await expect(w.run(third)).resolves.toMatchObject({
      status: 'skipped_budget',
      error: 'daily_cap',
      costUsd: '0',
    });
    expect(fake.calls()).toHaveLength(2);
    const spent = await store.spend(day);
    expect(Number(spent.day)).toBeCloseTo(0.019, 6);
    expect(Number(spent.day)).toBeLessThanOrEqual(0.03);
    // The budget is announced, exhausted: the app shows "AI budget reached".
    const budget = (await redis.xrevrange(AI_EVENTS_STREAM, '+', '-', 'COUNT', 1))[0]![1];
    expect(budget[1]).toBe('ai.budget');
    expect(JSON.parse(budget[3]!)).toMatchObject({ budget: { state: 'exhausted', enabled: true } });
    // The next UTC day starts afresh.
    const next = worker({ now: Date.UTC(2026, 11, 3, 0, 5) });
    expect((await next.run(job(SOL))).status).toBe('accepted');
    expect(fake.calls()).toHaveLength(3);
  });

  it('stops at the monthly cap too, and calls nothing while switched off', async () => {
    await settings({ monthlyCapUsd: 0.01 });
    const at = Date.UTC(2027, 0, 5, 9, 0);
    await expect(worker({ now: at }).run(job(BTC))).resolves.toMatchObject({
      status: 'skipped_budget',
      error: 'monthly_cap',
    });
    await settings({ enabled: false });
    await expect(worker({ now: at }).run(job(BTC))).resolves.toMatchObject({
      status: 'skipped_budget',
      error: 'disabled',
    });
    expect(fake.calls()).toHaveLength(0);
  });
});

describe('the significance follower (architecture §8, criterion 9.4)', () => {
  function sweep(instrumentId: string, n: number) {
    return JSON.stringify({
      instrumentId,
      runId: RUN,
      seq: n,
      tf: '1h',
      time: Date.now(),
      type: 'sweep',
      data: { id: `sweep-${n}`, levelType: n % 2 ? 'pdh' : 'pdl' },
    });
  }
  function confirmed(instrumentId: string): string {
    const t = Date.now();
    const m: SetupTransitionMessage = {
      id: randomUUID(),
      instrumentId,
      runId: RUN,
      pattern: 'htf_order_block',
      variant: null,
      direction: 'bullish',
      contextTf: '4h',
      setupTf: '15m',
      state: 'confirmed',
      resolution: null,
      displayLabel: 'Confirmed',
      levels: { entry: '100', invalidation: '99', target1: '105', target2: null, rr: 5 },
      score: 80,
      mandatoryPassed: true,
      qualityFlags: [],
      flags: [],
      createdAt: t - H,
      updatedAt: t,
      resolvedAt: null,
      disclaimer: SETUP_DISCLAIMER,
      transition: {
        from: 'triggered',
        to: 'confirmed',
        reason: 'mss_confirmed',
        candleTime: t - 15 * MIN,
        decidedAt: t,
        processedAt: t,
        late: false,
        evidence: {},
      },
    };
    return JSON.stringify(m);
  }

  async function follower(o: { clock: { now: number }; hasKey?: boolean }) {
    const jobs: { name: string; data: AiJob; jobId: string }[] = [];
    const announced: AiJob[] = [];
    const reader = new Redis(inject('redisUrl'), { maxRetriesPerRequest: null });
    const f = new AiTriggerFollower({
      db,
      redis,
      reader,
      queue: {
        add: async (name: string, data: AiJob, opts?: { jobId?: string }) => {
          jobs.push({ name, data, jobId: opts!.jobId! });
          return {} as never;
        },
      } as never,
      store,
      log,
      instance: `test-${randomUUID()}`,
      hasKey: () => o.hasKey ?? true,
      announce: async (j) => {
        announced.push(j);
      },
      now: () => o.clock.now,
      blockMs: 50,
    });
    return { f, jobs, announced, reader };
  }

  async function reset() {
    await redis.del(
      TRIGGERS_LEASE,
      TRIGGERS_CURSOR_KEY,
      DIGEST_SLOT_KEY,
      ...[BTC, ETH, SOL, PAXG].map(cooldownKey),
    );
  }

  it('turns a burst of 20 events into one analysis, then cools the instrument down', async () => {
    await reset();
    // Events from before it started are history, not news.
    await redis.xadd(ANALYSIS_EVENTS_STREAM, '*', 'type', 'smc', 'data', sweep(ETH, 0));
    const clock = { now: Date.now() };
    const { f, jobs, announced, reader } = await follower({ clock });
    await f.start();
    try {
      expect(f.holding).toBe(true);
      let lastId = '';
      for (let n = 1; n <= 20; n++)
        lastId = (await redis.xadd(ANALYSIS_EVENTS_STREAM, '*', 'type', 'smc', 'data', sweep(ETH, n)))!;
      // Unrelated entries are read past.
      await redis.xadd(ANALYSIS_EVENTS_STREAM, '*', 'type', 'indicators.closed', 'data', '{not json');
      await until(() => compareIds(f.position, lastId) > 0);
      // While the window is open, the saved cursor stays before it.
      expect(await redis.get(TRIGGERS_CURSOR_KEY)).not.toBe(f.position);
      clock.now = Date.now() + 61_000;
      await f.tick();
      expect(jobs).toHaveLength(1);
      const [queued] = jobs;
      expect(queued!.name).toBe('event');
      expect(queued!.jobId).toMatch(new RegExp(`^event\\.${ETH}\\.\\d+$`));
      expect(queued!.data).toMatchObject({
        analysisId: analysisIdOf(queued!.jobId),
        trigger: 'event',
        instrumentId: ETH,
        score: 1_000,
        requestedBy: null,
        reason: null,
      });
      expect(queued!.data.triggerRefs).toHaveLength(20);
      expect(announced).toHaveLength(1);
      expect(Number(await redis.get(cooldownKey(ETH)))).toBe(clock.now + 15 * MIN);

      // During the cooldown more sweeps open nothing; a confirmed setup still does.
      const quiet = await redis.xadd(ANALYSIS_EVENTS_STREAM, '*', 'type', 'smc', 'data', sweep(ETH, 21));
      await until(() => compareIds(f.position, quiet!) >= 0);
      const confirmation = await redis.xadd(
        ANALYSIS_EVENTS_STREAM,
        '*',
        'type',
        'setup',
        'data',
        confirmed(ETH),
      );
      await until(() => compareIds(f.position, confirmation!) >= 0);
      clock.now = Date.now() + 2 * 61_000;
      await f.tick();
      expect(jobs).toHaveLength(2);
      expect(jobs[1]!.data.triggerRefs.map((r) => r.kind)).toEqual(['setup.confirmed']);
    } finally {
      await f.stop();
      reader.disconnect();
    }
  });

  it('queues nothing while switched off or without a key', async () => {
    await reset();
    const clock = { now: Date.now() };
    const { f, jobs, reader } = await follower({ clock, hasKey: false });
    await f.start();
    try {
      let last = '';
      for (let n = 30; n < 33; n++)
        last = (await redis.xadd(ANALYSIS_EVENTS_STREAM, '*', 'type', 'smc', 'data', sweep(SOL, n)))!;
      await until(() => compareIds(f.position, last) >= 0);
      clock.now = Date.now() + 61_000;
      await f.tick();
      expect(jobs).toHaveLength(0);
    } finally {
      await f.stop();
      reader.disconnect();
    }
  });

  it('queues a digest per monitored instrument on its primary venue when a 4-hour slot begins', async () => {
    await reset();
    const slot = digestSlot(Date.now());
    const clock = { now: slot + 10 * MIN };
    const { f, jobs, reader } = await follower({ clock });
    await f.start();
    try {
      await f.tick();
      expect(jobs).toHaveLength(0); // starting up is not a reason to spend
      clock.now = slot + 4 * H + MIN;
      await f.tick();
      await f.tick();
      expect(jobs.map((j) => j.data.instrumentId).sort()).toEqual([BTC, ETH, SOL, PAXG].sort());
      expect(jobs.every((j) => j.name === 'digest' && j.data.score === 30)).toBe(true);
      expect(jobs[0]!.jobId).toBe(`digest.${jobs[0]!.data.instrumentId}.${slot + 4 * H}`);
    } finally {
      await f.stop();
      reader.disconnect();
    }
  });

  it('lets only one instance follow: the lease', async () => {
    await reset();
    const clock = { now: Date.now() };
    const a = await follower({ clock });
    const b = await follower({ clock });
    await a.f.start();
    await b.f.start();
    try {
      expect(a.f.holding).toBe(true);
      expect(b.f.holding).toBe(false);
    } finally {
      await a.f.stop();
      await b.f.stop();
      a.reader.disconnect();
      b.reader.disconnect();
    }
  });
});

describe('the provider status (system health)', () => {
  function reporter(key: string | null) {
    return new AiStatusReporter({
      store,
      provider: new GrokProvider({ baseUrl: fake.url, apiKey: () => key ?? undefined, retries: 0 }),
      redis,
      log,
      hasKey: () => key !== null,
      now: () => NOW,
    });
  }
  const stored = async () => AiStatusReportSchema.parse(JSON.parse((await redis.get(AI_STATUS_KEY))!));

  it('is down without a key, ok with one, and degraded on the fallback model', async () => {
    await reporter(null).refresh();
    expect(await stored()).toMatchObject({
      status: 'down',
      detail: 'no Grok API key is configured',
      keyConfigured: false,
      model: null,
    });
    expect(fake.seen).toHaveLength(0);

    await reporter(KEY).refresh();
    expect(await stored()).toMatchObject({
      status: 'ok',
      keyConfigured: true,
      model: 'grok-4.3',
      budget: { state: 'ok' },
    });
    expect(await redis.pttl(AI_STATUS_KEY)).toBeGreaterThan(60_000);

    fake.models = ['grok-4.20-0309-non-reasoning'];
    const fallback = reporter(KEY);
    await fallback.refresh();
    expect(await stored()).toMatchObject({ status: 'degraded', model: 'grok-4.20-0309-non-reasoning' });
    const j = job(BTC);
    await expect(
      worker({ now: NOW + 11 * H, model: (s) => fallback.model(s) }).run(j),
    ).resolves.toMatchObject({
      status: 'accepted',
    });
    expect(fake.calls()[0]!.body!.model).toBe('grok-4.20-0309-non-reasoning');
    expect((await row(j.analysisId)).model_requested).toBe('grok-4.20-0309-non-reasoning');

    fake.models = ['grok-2'];
    await reporter(KEY).refresh();
    expect(await stored()).toMatchObject({ status: 'down', model: null });

    fake.modelsStatus = 401;
    await reporter(KEY).refresh();
    expect(await stored()).toMatchObject({ status: 'down', detail: 'the Grok API refused the key' });
  });

  it('says when analyses are switched off', async () => {
    await settings({ enabled: false });
    await reporter(KEY).refresh();
    expect((await stored()).detail).toBe('grok-4.3; analyses are switched off');
  });
});

describe('the worst case', () => {
  it('reserves the answer’s limit and the reasoning allowance', () => {
    expect(worstCaseUsd(8_000, DEFAULT_AI_SETTINGS, 'grok-4.3').toString()).toBe('0.025');
  });
});
