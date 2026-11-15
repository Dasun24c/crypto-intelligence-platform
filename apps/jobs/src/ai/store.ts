import type { Kysely } from 'kysely';
import type { AiSettings } from '@cip/contracts';
import { type AiAnalysisRow, aiSettings, aiSpend, type Database, type NewAiAnalysis } from '@cip/db';
import { budgetPeriods, type Spend } from '@cip/ai';

/** An identical context's accepted analysis is reused for this long (architecture §8). */
export const CACHE_MS = 30 * 60_000;

/** The `ai` schema as the jobs service writes it (data model §6, migration 0014). */
export class AiStore {
  constructor(private readonly db: Kysely<Database>) {}

  /** The admins' settings, or the defaults. */
  settings(): Promise<AiSettings> {
    return aiSettings(this.db);
  }

  /** What the UTC day and month `now` falls in have cost (USD). */
  spend(now: number): Promise<Spend> {
    return aiSpend(this.db, budgetPeriods(now));
  }

  /** An accepted analysis of the same instrument with the same context, within the cache window. */
  async cacheSource(instrumentId: string, hash: string, now: number): Promise<AiAnalysisRow | undefined> {
    return this.db
      .selectFrom('ai.analyses')
      .selectAll()
      .where('instrument_id', '=', instrumentId)
      .where('context_hash', '=', hash)
      .where('status', '=', 'accepted')
      .where('created_at', '>=', new Date(now - CACHE_MS))
      .where('created_at', '<=', new Date(now))
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
  }

  /** Stores an analysis once (a job run again after a crash finds it there). */
  async insert(a: NewAiAnalysis): Promise<boolean> {
    const r = await this.db
      .insertInto('ai.analyses')
      .values(a)
      .onConflict((oc) => oc.column('id').doNothing())
      .executeTakeFirst();
    return Number(r.numInsertedOrUpdatedRows ?? 0n) > 0;
  }

  async get(id: string): Promise<AiAnalysisRow | undefined> {
    return this.db.selectFrom('ai.analyses').selectAll().where('id', '=', id).executeTakeFirst();
  }
}
