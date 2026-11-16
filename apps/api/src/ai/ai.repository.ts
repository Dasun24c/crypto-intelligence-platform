import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import {
  AI_STATUS_KEY,
  type AiAnalysesQuery,
  type AiAnalysisDetail,
  type AiAnalysisSummary,
  type AiBudgetStatus,
  type AiSettings,
  type AiStatusReport,
  AiStatusReportSchema,
  type AiUsage,
  type Page,
} from '@cip/contracts';
import {
  AI_SETTINGS_KEY,
  aiDetailFromRow,
  aiSettings,
  aiSpend,
  aiSummaryFromRow,
  type Database,
} from '@cip/db';
import { dec } from '@cip/domain';
import { budgetPeriods, budgetStatus } from '@cip/ai';
import { ProblemError } from '../common/problem.js';
import { decodeCursor, encodeCursor } from '../market/market.repository.js';
import { DB, REDIS } from '../tokens.js';
import type { Executor } from '../users/users.repository.js';

const DAY = 86_400_000;
/** `GET /ai/usage` covers at most this many days. */
const MAX_USAGE_DAYS = 400;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The `ai` schema as the API reads it (data model §6); only the jobs service writes analyses. */
@Injectable()
export class AiRepository {
  constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  settings(): Promise<AiSettings> {
    return aiSettings(this.db);
  }

  async saveSettings(ex: Executor, value: AiSettings, userId: string, now: Date): Promise<void> {
    const json = JSON.stringify(value);
    await ex
      .insertInto('app.settings')
      .values({ key: AI_SETTINGS_KEY, value: json, updated_by: userId, updated_at: now })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: json, updated_by: userId, updated_at: now }))
      .execute();
  }

  /** The budget now (NFR-08): the UTC day's and month's spend against the caps. */
  async budget(now: number, settings?: AiSettings): Promise<AiBudgetStatus> {
    const [s, spend] = await Promise.all([
      settings ? Promise.resolve(settings) : this.settings(),
      aiSpend(this.db, budgetPeriods(now)),
    ]);
    return budgetStatus(spend, s);
  }

  /** Grok's state as the jobs service last reported it, or null when it has not (or not lately). */
  async status(): Promise<AiStatusReport | null> {
    const raw = await this.redis.get(AI_STATUS_KEY);
    if (!raw) return null;
    try {
      const parsed = AiStatusReportSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** Newest first. */
  async list(q: AiAnalysesQuery): Promise<Page<AiAnalysisSummary>> {
    let query = this.db.selectFrom('ai.analyses').selectAll();
    if (q.instrumentId) query = query.where('instrument_id', '=', q.instrumentId);
    if (q.status) query = query.where('status', 'in', q.status);
    if (q.from !== undefined) query = query.where('created_at', '>=', new Date(q.from));
    if (q.to !== undefined) query = query.where('created_at', '<', new Date(q.to));
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      query = query.where((eb) =>
        eb.or([eb('created_at', '<', c.ts), eb.and([eb('created_at', '=', c.ts), eb('id', '<', c.id)])]),
      );
    }
    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(q.limit + 1)
      .execute();
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      items: page.map(aiSummaryFromRow),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  /** The latest analyses, for the `ai` channel's snapshot. */
  async latest(limit: number): Promise<AiAnalysisSummary[]> {
    return (await this.list({ limit })).items;
  }

  async detail(id: string): Promise<AiAnalysisDetail> {
    const row = await this.db.selectFrom('ai.analyses').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new ProblemError('NOT_FOUND', 'No such analysis.');
    return aiDetailFromRow(row);
  }

  /** Per UTC day from `from` to `to` (default: the last 30 days), and the budget now. */
  async usage(q: { from?: number; to?: number }, now: number): Promise<AiUsage> {
    const to = q.to ?? now;
    const from = q.from ?? to - 30 * DAY;
    if (from > to) throw new ProblemError('VALIDATION_FAILED', '`from` is after `to`.');
    if (to - from > MAX_USAGE_DAYS * DAY)
      throw new ProblemError('VALIDATION_FAILED', `At most ${MAX_USAGE_DAYS} days at a time.`);
    const [rows, budget] = await Promise.all([
      this.db
        .selectFrom('ai.daily_usage')
        .selectAll()
        .where('day', '>=', isoDay(from))
        .where('day', '<=', isoDay(to))
        .orderBy('day')
        .execute(),
      this.budget(now),
    ]);
    return {
      days: rows.map((r) => ({
        day: r.day,
        calls: r.calls,
        accepted: r.accepted,
        rejected: r.rejected,
        failed: r.failed,
        cacheHits: r.cache_hits,
        skipped: r.skipped,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        costUsd: dec(r.cost_usd).toString(),
      })),
      budget,
    };
  }

  /** The instrument a request names, if it is enabled and analysed. */
  async instrument(id: string): Promise<{ id: string; analysed: boolean } | undefined> {
    const row = await this.db
      .selectFrom('market.instruments')
      .select(['id', 'profile_id'])
      .where('id', '=', id)
      .where('enabled', '=', true)
      .executeTakeFirst();
    return row ? { id: row.id, analysed: row.profile_id !== null } : undefined;
  }

  /** The instrument a setup belongs to. */
  async setupInstrument(setupId: string): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('analysis.setups')
      .select('instrument_id')
      .where('id', '=', setupId)
      .executeTakeFirst();
    return row?.instrument_id;
  }
}
