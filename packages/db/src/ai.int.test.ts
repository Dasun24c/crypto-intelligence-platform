import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { DEFAULT_AI_SETTINGS } from '@cip/contracts';
import { AI_SETTINGS_KEY, aiDetailFromRow, aiSettings, aiSpend, aiSummaryFromRow } from './ai.js';
import { createDb } from './client.js';
import type { Database, NewAiAnalysis } from './types.js';

const BTC = '019a6f00-0000-7000-8000-000000000001';
/** 3 October 2026, 12:00 UTC: a day no other test of this file writes. */
const DAY = Date.UTC(2026, 9, 3, 12);
const H = 3_600_000;

let owner: Kysely<Database>;
let api: Kysely<Database>;
let jobs: Kysely<Database>;
let others: Kysely<Database>[];
const userId = randomUUID();

beforeAll(async () => {
  owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 2 });
  api = createDb({ connectionString: inject('dbRoleUrls').svc_api, max: 2 });
  jobs = createDb({ connectionString: inject('dbRoleUrls').svc_jobs, max: 2 });
  others = (['svc_ingestor', 'svc_analyzer', 'svc_broker'] as const).map((r) =>
    createDb({ connectionString: inject('dbRoleUrls')[r], max: 1 }),
  );
  await owner
    .insertInto('app.users')
    .values({
      id: userId,
      email: `${userId}@cip.test`,
      display_name: 'AI',
      role: 'analyst',
      password_hash: 'x',
    })
    .execute();
});

afterAll(async () => {
  await owner.deleteFrom('app.settings').where('key', '=', AI_SETTINGS_KEY).execute();
  for (const db of [owner, api, jobs, ...others]) await db.destroy();
});

async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

function analysis(over: Partial<NewAiAnalysis> = {}): NewAiAnalysis {
  return {
    id: randomUUID(),
    instrument_id: BTC,
    trigger: 'event',
    trigger_refs: JSON.stringify([{ kind: 'sweep', id: 'w1', score: 50, at: DAY }]),
    request_reason: null,
    setup_id: null,
    requested_by: null,
    context_hash: 'a'.repeat(64),
    context: JSON.stringify({ contextVersion: '1' }),
    prompt_version: 'ai-1',
    model_requested: 'grok-4.3',
    model_reported: 'grok-4.3-1120',
    status: 'accepted',
    cache_source_id: null,
    stance: 'neutral',
    confidence: 'low',
    response: JSON.stringify({ headline: 'A calm market' }),
    validation: JSON.stringify({ errors: [], warnings: [] }),
    error: null,
    input_tokens: 6_000,
    cached_input_tokens: 0,
    output_tokens: 800,
    reasoning_tokens: 0,
    cost_usd: '0.0095',
    latency_ms: 1_200,
    created_at: new Date(DAY),
    ...over,
  };
}

describe('AI analyses (migration 0014, ADR 023)', () => {
  it('lets only the jobs service write analyses; the api reads them; the other services cannot', async () => {
    const row = analysis();
    await jobs.insertInto('ai.analyses').values(row).execute();
    expect((await api.selectFrom('ai.analyses').select('id').where('id', '=', row.id).execute()).length).toBe(
      1,
    );
    expect((await api.selectFrom('ai.daily_usage').selectAll().execute()).length).toBeGreaterThan(0);
    // 42501: insufficient privilege.
    expect(await sqlState(api.insertInto('ai.analyses').values(analysis()).execute())).toBe('42501');
    expect(await sqlState(jobs.updateTable('ai.analyses').set({ status: 'rejected' }).execute())).toBe(
      '42501',
    );
    expect(await sqlState(jobs.deleteFrom('ai.analyses').execute())).toBe('42501');
    for (const db of others)
      expect(await sqlState(db.selectFrom('ai.analyses').select('id').execute())).toBe('42501');
    // The jobs service reads the admins' AI settings.
    expect(await sqlState(jobs.selectFrom('app.settings').select('key').execute())).toBeUndefined();
  });

  it('refuses analyses that break the rules: an accepted one needs its answer, a cache hit its source, a request its reason', async () => {
    const insert = (over: Partial<NewAiAnalysis>) =>
      sqlState(jobs.insertInto('ai.analyses').values(analysis(over)).execute());
    // 23514: check violation.
    expect(await insert({ stance: null })).toBe('23514');
    expect(await insert({ response: null })).toBe('23514');
    expect(await insert({ status: 'cache_hit' })).toBe('23514');
    expect(await insert({ trigger: 'on_demand' })).toBe('23514');
    expect(await insert({ request_reason: 'refresh' })).toBe('23514');
    expect(await insert({ status: 'maybe' as never })).toBe('23514');
    expect(
      await insert({
        trigger: 'on_demand',
        request_reason: 'setup_review',
        setup_id: randomUUID(),
        requested_by: userId,
      }),
    ).toBeUndefined();
    expect(await insert({ status: 'rejected', stance: null, confidence: null })).toBeUndefined();
  });

  it('reads the settings, or the defaults when there are none or they no longer validate', async () => {
    await owner.deleteFrom('app.settings').where('key', '=', AI_SETTINGS_KEY).execute();
    expect(await aiSettings(jobs)).toEqual(DEFAULT_AI_SETTINGS);
    const mine = { ...DEFAULT_AI_SETTINGS, dailyCapUsd: 2 };
    await owner
      .insertInto('app.settings')
      .values({ key: AI_SETTINGS_KEY, value: JSON.stringify(mine), updated_by: null })
      .execute();
    expect(await aiSettings(jobs)).toEqual(mine);
    await owner
      .updateTable('app.settings')
      .set({ value: JSON.stringify({ ...mine, model: 'unpriced' }) })
      .where('key', '=', AI_SETTINGS_KEY)
      .execute();
    expect(await aiSettings(jobs)).toEqual(DEFAULT_AI_SETTINGS);
  });

  it('sums the spend of a UTC day and month, and nothing outside them', async () => {
    const periods = (at: number) => {
      const d = new Date(at);
      return {
        dayStart: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
        dayEnd: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1),
        monthStart: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1),
        monthEnd: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1),
      };
    };
    const at = Date.UTC(2026, 6, 15, 12);
    const rows = [
      analysis({ created_at: new Date(at), cost_usd: '0.01' }),
      analysis({ created_at: new Date(at + 11 * H), cost_usd: '0.02' }), // 23:00 the same day
      analysis({ created_at: new Date(at - 24 * H), cost_usd: '0.04' }), // the day before
      analysis({ created_at: new Date(at + 12 * H), cost_usd: '0.08' }), // the next day
      analysis({ created_at: new Date(Date.UTC(2026, 7, 1)), cost_usd: '1' }), // next month
      analysis({
        created_at: new Date(at),
        status: 'failed',
        stance: null,
        confidence: null,
        response: null,
        cost_usd: null,
      }),
    ];
    await jobs.insertInto('ai.analyses').values(rows).execute();
    const spend = await aiSpend(api, periods(at));
    expect(Number(spend.day)).toBeCloseTo(0.03, 6);
    expect(Number(spend.month)).toBeCloseTo(0.15, 6);
    expect(await aiSpend(api, periods(Date.UTC(2026, 5, 1)))).toEqual({ day: '0', month: '0' });
  });

  it('shows a summary and a detail: the headline only for accepted and cached answers, and no context when none was built', async () => {
    const accepted = analysis({ cost_usd: '0.009500' });
    const rejected = analysis({
      status: 'rejected',
      stance: null,
      confidence: null,
      response: JSON.stringify({ headline: 'A rally is guaranteed' }),
      validation: JSON.stringify({
        errors: [{ rule: 'V4', path: 'headline', message: '"guaranteed" is not allowed' }],
        warnings: [],
        firstAttemptErrors: [{ rule: 'V3', path: 'summary', message: 'invented' }],
      }),
      repair_attempted: true,
    });
    const cached = analysis({ status: 'cache_hit', cache_source_id: accepted.id, cost_usd: '0' });
    const failed = analysis({
      status: 'failed',
      stance: null,
      confidence: null,
      response: null,
      context_hash: '',
      context: '{}',
      error: 'context_unavailable',
      cost_usd: null,
      input_tokens: null,
      output_tokens: null,
    });
    await jobs.insertInto('ai.analyses').values([accepted, rejected, cached, failed]).execute();
    const read = async (id: string) =>
      await api.selectFrom('ai.analyses').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

    expect(aiSummaryFromRow(await read(accepted.id))).toMatchObject({
      status: 'accepted',
      headline: 'A calm market',
      stance: 'neutral',
      costUsd: '0.0095',
      createdAt: DAY,
    });
    expect(aiSummaryFromRow(await read(rejected.id))).toMatchObject({ headline: null, stance: null });
    expect(aiSummaryFromRow(await read(cached.id))).toMatchObject({
      headline: 'A calm market',
      cacheSourceId: accepted.id,
    });
    expect(aiSummaryFromRow(await read(failed.id))).toMatchObject({
      costUsd: null,
      error: 'context_unavailable',
    });

    const detail = aiDetailFromRow(await read(rejected.id));
    expect(detail.validation.firstAttemptErrors).toEqual([
      { rule: 'V3', path: 'summary', message: 'invented' },
    ]);
    expect(detail).toMatchObject({
      repairAttempted: true,
      contextHash: 'a'.repeat(64),
      promptVersion: 'ai-1',
    });
    expect(detail.context).toEqual({ contextVersion: '1' });
    const none = aiDetailFromRow(await read(failed.id));
    expect(none.context).toBeNull();
    expect(none.validation).toEqual({ errors: [], warnings: [] });
    expect(none.usage).toMatchObject({ inputTokens: null, costUsd: null, latencyMs: 1_200 });
  });
});
