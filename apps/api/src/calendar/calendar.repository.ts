import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import {
  type BlackoutWindow,
  type CalendarStatus,
  type CalendarSync,
  type CreateEconomicEventRequest,
  type EconomicEvent,
  type Impact,
  SYNCED_SOURCES,
  type UpdateEconomicEventRequest,
} from '@cip/contracts';
import { calendarKnownFrom, type Database, type EconomicEventRow } from '@cip/db';
import { DB } from '../tokens.js';

const IMPACT_RANK: Record<Impact, number> = { low: 0, medium: 1, high: 2 };
/** A source not synced successfully for this long makes the calendar degraded. */
export const CALENDAR_STALE_MS = 24 * 60 * 60_000;

export function toEconomicEvent(r: EconomicEventRow): EconomicEvent {
  return {
    id: r.id,
    source: r.source,
    sourceRef: r.source_ref,
    release: r.release,
    title: r.title,
    country: r.country,
    currency: r.currency,
    category: r.category,
    impact: r.impact,
    scheduledAt: r.scheduled_at.getTime(),
    timeConfirmed: r.time_confirmed,
    actual: r.actual,
    forecast: r.forecast,
    previous: r.previous,
    updatedAt: r.updated_at.getTime(),
  };
}

/** The economic calendar as the API serves it (Phase 7). Only scheduled events are listed. */
@Injectable()
export class CalendarRepository {
  constructor(@Inject(DB) private readonly db: Kysely<Database>) {}

  async events(from: number, to: number, minImpact: Impact | undefined): Promise<EconomicEvent[]> {
    let q = this.db
      .selectFrom('market.economic_events')
      .selectAll()
      .where('status', '=', 'scheduled')
      .where('scheduled_at', '>=', new Date(from))
      .where('scheduled_at', '<=', new Date(to));
    if (minImpact)
      q = q.where(
        'impact',
        'in',
        (['low', 'medium', 'high'] as const).filter((i) => IMPACT_RANK[i] >= IMPACT_RANK[minImpact]),
      );
    const rows = await q.orderBy('scheduled_at').orderBy('title').execute();
    return rows.map(toEconomicEvent);
  }

  async find(id: string): Promise<EconomicEventRow | undefined> {
    return this.db.selectFrom('market.economic_events').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async create(
    trx: Kysely<Database>,
    body: CreateEconomicEventRequest,
    userId: string,
  ): Promise<EconomicEventRow> {
    const id = uuidv7();
    return trx
      .insertInto('market.economic_events')
      .values({
        id,
        source: 'manual',
        source_ref: `manual:${id}`,
        release: body.release,
        title: body.title,
        country: body.country,
        currency: body.currency,
        category: body.category,
        impact: body.impact,
        scheduled_at: new Date(body.scheduledAt),
        time_confirmed: body.timeConfirmed,
        actual: null,
        forecast: null,
        previous: null,
        created_by: userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async update(
    trx: Kysely<Database>,
    id: string,
    body: UpdateEconomicEventRequest,
  ): Promise<EconomicEventRow> {
    return trx
      .updateTable('market.economic_events')
      .set({
        ...(body.release !== undefined ? { release: body.release } : {}),
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.category !== undefined ? { category: body.category } : {}),
        ...(body.impact !== undefined ? { impact: body.impact } : {}),
        ...(body.scheduledAt !== undefined ? { scheduled_at: new Date(body.scheduledAt) } : {}),
        ...(body.timeConfirmed !== undefined ? { time_confirmed: body.timeConfirmed } : {}),
        ...(body.currency !== undefined ? { currency: body.currency } : {}),
        ...(body.country !== undefined ? { country: body.country } : {}),
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** Rows are kept for the engine's history (rulebook I38): removing an entry cancels it. */
  async cancel(trx: Kysely<Database>, id: string): Promise<void> {
    await trx
      .updateTable('market.economic_events')
      .set({ status: 'cancelled', updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /** When the calendar last changed: the newest event change or sync. */
  async lastChange(): Promise<number | null> {
    const row = await this.db
      .selectFrom('market.economic_events')
      .select((eb) => eb.fn.max('updated_at').as('at'))
      .executeTakeFirst();
    return row?.at ? new Date(row.at).getTime() : null;
  }

  async status(now: number): Promise<CalendarStatus> {
    const [syncs, firstFred, blackouts] = await Promise.all([
      Promise.all(
        SYNCED_SOURCES.map(async (source) => {
          const [last, success] = await Promise.all([
            this.db
              .selectFrom('market.calendar_syncs')
              .selectAll()
              .where('source', '=', source)
              .orderBy('started_at', 'desc')
              .limit(1)
              .executeTakeFirst(),
            this.db
              .selectFrom('market.calendar_syncs')
              .select((eb) => eb.fn.max('finished_at').as('at'))
              .where('source', '=', source)
              .where('status', '=', 'ok')
              .executeTakeFirst(),
          ]);
          const lastSync: CalendarSync | null = last
            ? {
                source,
                startedAt: last.started_at.getTime(),
                finishedAt: last.finished_at?.getTime() ?? null,
                status: last.status,
                inserted: last.inserted,
                updated: last.updated,
                unchanged: last.unchanged,
                cancelled: last.cancelled,
                error: last.error,
              }
            : null;
          return {
            source,
            configured: lastSync?.status !== 'skipped',
            lastSync,
            lastSuccessAt: success?.at ? new Date(success.at).getTime() : null,
          };
        }),
      ),
      this.db
        .selectFrom('market.calendar_syncs')
        .select((eb) => eb.fn.min('finished_at').as('at'))
        .where('source', '=', 'fred')
        .where('status', '=', 'ok')
        .executeTakeFirst(),
      this.blackouts(),
    ]);
    const availableFrom = firstFred?.at ? calendarKnownFrom(new Date(firstFred.at).getTime()) : null;
    const available = availableFrom !== null && now >= availableFrom;
    const problems: string[] = [];
    for (const s of syncs) {
      const name = s.source === 'fred' ? 'FRED' : 'BEA';
      if (!s.lastSync) problems.push(`${name}: not synced yet`);
      else if (s.lastSync.status === 'skipped') problems.push(`${name}: no API key configured`);
      else if (s.lastSync.status === 'failed')
        problems.push(`${name}: last sync failed (${s.lastSync.error ?? 'unknown'})`);
      else if (s.lastSuccessAt === null || now - s.lastSuccessAt > CALENDAR_STALE_MS)
        problems.push(`${name}: no successful sync in 24 h`);
    }
    const status = !available ? 'down' : problems.length ? 'degraded' : 'ok';
    const detail = !available
      ? `Unavailable: checklist item 8 fails as calendar_unavailable until the first complete FRED sync. ${problems.join('; ')}`.trim()
      : problems.length
        ? problems.join('; ')
        : 'FRED and BEA synced';
    return { available, availableFrom, status, detail, sources: syncs, blackouts };
  }

  /** Each profile in use, with its news blackout (rulebook §7 item 8) and its instruments. */
  async blackouts(): Promise<BlackoutWindow[]> {
    const rows = await this.db
      .selectFrom('market.instruments as i')
      .innerJoin('market.instrument_profiles as p', 'p.id', 'i.profile_id')
      .select(['i.id as instrumentId', 'p.id as profileId', 'p.name', 'p.version', 'p.params'])
      .where('i.enabled', '=', true)
      .orderBy('p.name')
      .orderBy('i.id')
      .execute();
    const byProfile = new Map<string, BlackoutWindow>();
    for (const r of rows) {
      const checklist = (r.params as { smc?: { setups?: { checklist?: Record<string, unknown> } } } | null)
        ?.smc?.setups?.checklist;
      const window = checklist?.['newsBlackoutMin'] as { before?: number; after?: number } | undefined;
      const currencies = checklist?.['newsCurrencies'];
      if (!window || typeof window.before !== 'number' || typeof window.after !== 'number') continue;
      const entry = byProfile.get(r.profileId) ?? {
        profile: r.name,
        version: r.version,
        beforeMin: window.before,
        afterMin: window.after,
        currencies: Array.isArray(currencies)
          ? currencies.filter((c): c is string => typeof c === 'string')
          : [],
        instrumentIds: [],
      };
      entry.instrumentIds.push(r.instrumentId);
      byProfile.set(r.profileId, entry);
    }
    return [...byProfile.values()];
  }
}
