import { sql } from 'kysely';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { calendarKnownFrom, createDb } from '@cip/db';
import { calendarAt } from '@cip/smc-engine';
import { AnalysisRepository } from '../src/analysis/repository.ts';

/**
 * The economic calendar as the analyzer gives it to the engine (Phase 7, rulebook I38): nothing
 * until the first complete FRED sync, then every version of every event with the time from which
 * it was known. The engine reads only what was known at each decision, so a live run and a later
 * replay of the same period see the same calendar.
 */
const owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 2 });
const db = createDb({ connectionString: inject('dbRoleUrls').svc_analyzer, max: 2 });
const repo = new AnalysisRepository(db);
const AT = Date.UTC(2027, 1, 10, 13, 30); // a CPI release
const ID = '019a7000-0000-7000-8000-0000000ab001';

afterAll(async () => {
  await owner.destroy();
  await db.destroy();
});

describe('the economic calendar for the engine', () => {
  it('is unavailable until FRED first synced, then holds each version from when it was known', async () => {
    expect(await repo.calendar(AT - 86_400_000, AT + 86_400_000)).toEqual({ economicEvents: null });

    await owner
      .insertInto('market.economic_events')
      .values({
        id: ID,
        source: 'fred',
        source_ref: '10:2027-02-10',
        release: 'cpi',
        title: 'Consumer Price Index (CPI)',
        category: 'inflation',
        impact: 'high',
        scheduled_at: new Date(AT),
        time_confirmed: false,
        actual: null,
        forecast: null,
        previous: null,
        created_by: null,
      })
      .execute();
    // Moved a day later, in a separate transaction (a later sync).
    await owner
      .updateTable('market.economic_events')
      .set({ scheduled_at: new Date(AT + 86_400_000) })
      .where('id', '=', ID)
      .execute();
    const synced = new Date(Date.now() - 5 * 60_000);
    await owner
      .insertInto('market.calendar_syncs')
      .values({
        id: '019a7000-0000-7000-8000-0000000ab002',
        source: 'fred',
        started_at: synced,
        finished_at: synced,
        status: 'ok',
      })
      .execute();
    const revisions = await owner
      .selectFrom('market.economic_event_revisions')
      .select(['revision', 'recorded_at'])
      .where('event_id', '=', ID)
      .orderBy('revision')
      .execute();
    expect(revisions.map((r) => r.revision)).toEqual([1, 2]);

    const context = await repo.calendar(AT - 86_400_000, AT + 2 * 86_400_000);
    expect(context.calendarAvailableFrom).toBe(calendarKnownFrom(synced.getTime()));
    const [k1, k2] = revisions.map((r) => calendarKnownFrom(r.recorded_at.getTime())) as [number, number];
    const expected = [
      ...(k2 > k1
        ? [{ id: ID, scheduledAt: AT, currency: 'USD', impact: 'high', knownFrom: k1, knownUntil: k2 }]
        : []),
      {
        id: ID,
        scheduledAt: AT + 86_400_000,
        currency: 'USD',
        impact: 'high',
        knownFrom: k2,
        knownUntil: null,
      },
    ];
    expect(context.economicEvents).toEqual(expected);

    // What the engine reads at a decision: nothing before availability, the newest version after.
    const step = { closures: [], ...context };
    expect(calendarAt(step, context.calendarAvailableFrom! - 1)).toBeNull();
    expect(calendarAt(step, Math.max(k2, context.calendarAvailableFrom!))).toEqual([expected.at(-1)]);
  });

  it('cannot change the calendar: the analyzer only reads it', async () => {
    await expect(
      sql`UPDATE market.economic_events SET impact = 'low' WHERE id = ${ID}`.execute(db),
    ).rejects.toThrow(/permission denied/);
  });
});
