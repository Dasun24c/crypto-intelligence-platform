import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { calendarKnownFrom, loadEngineCalendar } from './calendar.js';
import { createDb } from './client.js';
import type { Database } from './types.js';

const MIN = 60_000;

let owner: Kysely<Database>;
let jobs: Kysely<Database>;
let analyzer: Kysely<Database>;

beforeAll(() => {
  owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 2 });
  jobs = createDb({ connectionString: inject('dbRoleUrls').svc_jobs, max: 2 });
  analyzer = createDb({ connectionString: inject('dbRoleUrls').svc_analyzer, max: 2 });
});

afterAll(async () => {
  await owner.destroy();
  await jobs.destroy();
  await analyzer.destroy();
});

/** A CPI date as the jobs service writes it; the triggers record its revision 1. */
async function addEvent(db: Kysely<Database>, scheduledAt: number, id: string = randomUUID()) {
  await db
    .insertInto('market.economic_events')
    .values({
      id,
      source: 'fred',
      source_ref: `10:test-${id}`,
      release: 'cpi',
      title: 'Consumer Price Index',
      category: 'inflation',
      impact: 'high',
      scheduled_at: new Date(scheduledAt),
      time_confirmed: false,
    })
    .execute();
  return id;
}

const revisions = (id: string) =>
  owner
    .selectFrom('market.economic_event_revisions')
    .select(['revision', 'recorded_at', 'scheduled_at', 'status'])
    .where('event_id', '=', id)
    .orderBy('revision')
    .execute();

/** A later version recorded at a chosen time (the triggers record at now(), so the owner writes it). */
const version = (
  id: string,
  revision: number,
  recordedAt: number,
  scheduledAt: number,
  status = 'scheduled',
) => ({
  event_id: id,
  revision,
  recorded_at: new Date(recordedAt),
  scheduled_at: new Date(scheduledAt),
  time_confirmed: false,
  title: 'Consumer Price Index',
  currency: 'USD',
  impact: 'high' as const,
  status: status as 'scheduled' | 'cancelled' | 'superseded',
});

async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

describe('calendarKnownFrom', () => {
  it('is the second whole minute after the change was recorded (rulebook I38)', () => {
    const t = Date.UTC(2026, 10, 12, 10, 0);
    expect(calendarKnownFrom(t)).toBe(t + MIN);
    expect(calendarKnownFrom(t + 1)).toBe(t + 2 * MIN);
    expect(calendarKnownFrom(t + 59_999)).toBe(t + 2 * MIN);
  });
});

describe('the calendar the engine reads (rulebook I38)', () => {
  // Each test schedules its events in a month of its own in 2030, away from the others.

  it('is unavailable until the first complete FRED sync, and stays available from then on', async () => {
    const [from, to] = [Date.UTC(2030, 0, 1), Date.UTC(2030, 1, 1)];
    const sync = (source: 'fred' | 'bea', status: 'ok' | 'failed' | 'skipped', finishedAt: number) =>
      jobs
        .insertInto('market.calendar_syncs')
        .values({
          id: randomUUID(),
          source,
          status,
          started_at: new Date(finishedAt - 5_000),
          finished_at: new Date(finishedAt),
        })
        .execute();
    expect((await loadEngineCalendar(analyzer, from, to)).availableFrom).toBeNull();

    // BEA alone, a FRED sync skipped for want of a key, a failed one: still unavailable.
    const t = Date.UTC(2026, 10, 12, 6, 3, 30);
    await sync('bea', 'ok', t);
    await sync('fred', 'skipped', t);
    await sync('fred', 'failed', t + 10 * MIN);
    expect((await loadEngineCalendar(analyzer, from, to)).availableFrom).toBeNull();

    // The first complete FRED sync decides, not the latest.
    await sync('fred', 'ok', t + 20 * MIN);
    await sync('fred', 'ok', t + 30 * MIN);
    expect((await loadEngineCalendar(analyzer, from, to)).availableFrom).toBe(
      calendarKnownFrom(t + 20 * MIN),
    );
  });

  it('gives each version the period it was known; a cancellation only ends the one before', async () => {
    const [march11, march12] = [Date.UTC(2030, 2, 11, 12, 30), Date.UTC(2030, 2, 12, 12, 30)];
    const id = await addEvent(jobs, march11);
    const t1 = (await revisions(id))[0]!.recorded_at.getTime();
    // The release moves a day ten minutes later, and is cancelled ten minutes after that.
    await owner
      .insertInto('market.economic_event_revisions')
      .values([version(id, 2, t1 + 10 * MIN, march12), version(id, 3, t1 + 20 * MIN, march12, 'cancelled')])
      .execute();
    const other = await addEvent(jobs, Date.UTC(2030, 5, 10, 12, 30));

    const expected = [
      {
        id,
        scheduledAt: march11,
        currency: 'USD',
        impact: 'high',
        knownFrom: calendarKnownFrom(t1),
        knownUntil: calendarKnownFrom(t1 + 10 * MIN),
      },
      {
        id,
        scheduledAt: march12,
        currency: 'USD',
        impact: 'high',
        knownFrom: calendarKnownFrom(t1 + 10 * MIN),
        knownUntil: calendarKnownFrom(t1 + 20 * MIN),
      },
    ];
    const march = await loadEngineCalendar(analyzer, Date.UTC(2030, 2, 1), Date.UTC(2030, 3, 1));
    expect(march.events.filter((e) => e.id === id)).toEqual(expected);
    expect(march.events.some((e) => e.id === other)).toBe(false);
    // An event in the window in any of its versions comes with all of them: a decision on the 11th
    // must see the release that was then scheduled for that day, though it moved later.
    const twelfth = await loadEngineCalendar(analyzer, Date.UTC(2030, 2, 12), Date.UTC(2030, 2, 13));
    expect(twelfth.events.filter((e) => e.id === id)).toEqual(expected);
  });

  it('drops a version replaced within its own minute: it never counted for a decision', async () => {
    const [april9, april10] = [Date.UTC(2030, 3, 9, 12, 30), Date.UTC(2030, 3, 10, 12, 30)];
    const id = randomUUID();
    // One transaction: both versions are recorded at the same now().
    await jobs.transaction().execute(async (trx) => {
      await addEvent(trx, april9, id);
      await trx
        .updateTable('market.economic_events')
        .set({ scheduled_at: new Date(april10) })
        .where('id', '=', id)
        .execute();
    });
    const revs = await revisions(id);
    expect(revs.map((r) => r.revision)).toEqual([1, 2]);
    expect(revs[1]!.recorded_at).toEqual(revs[0]!.recorded_at);
    const { events } = await loadEngineCalendar(analyzer, Date.UTC(2030, 3, 1), Date.UTC(2030, 4, 1));
    expect(events.filter((e) => e.id === id)).toEqual([
      {
        id,
        scheduledAt: april10,
        currency: 'USD',
        impact: 'high',
        knownFrom: calendarKnownFrom(revs[1]!.recorded_at.getTime()),
        knownUntil: null,
      },
    ]);
  });
});

describe('economic events (migration 0010)', () => {
  it('records a revision for each change the engine reads, and keeps every one', async () => {
    const id = await addEvent(jobs, Date.UTC(2030, 6, 15, 12, 30));
    // The published figure is not part of a version.
    await jobs.updateTable('market.economic_events').set({ actual: '0.3%' }).where('id', '=', id).execute();
    expect((await revisions(id)).map((r) => r.revision)).toEqual([1]);
    await jobs
      .updateTable('market.economic_events')
      .set({ status: 'cancelled' })
      .where('id', '=', id)
      .execute();
    expect((await revisions(id)).map((r) => [r.revision, r.status])).toEqual([
      [1, 'scheduled'],
      [2, 'cancelled'],
    ]);
    const event = await analyzer
      .selectFrom('market.economic_events')
      .select('revision')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(event.revision).toBe(2);

    // Never deleted or rewritten, not even by the owner; only the triggers write revisions.
    expect(await sqlState(jobs.deleteFrom('market.economic_events').where('id', '=', id).execute())).toBe(
      '42501',
    );
    expect(await sqlState(owner.deleteFrom('market.economic_events').where('id', '=', id).execute())).toBe(
      '42501',
    );
    expect(
      await sqlState(
        owner
          .updateTable('market.economic_event_revisions')
          .set({ title: 'x' })
          .where('event_id', '=', id)
          .execute(),
      ),
    ).toBe('42501');
    expect(
      await sqlState(
        owner.deleteFrom('market.economic_event_revisions').where('event_id', '=', id).execute(),
      ),
    ).toBe('42501');
    expect(
      await sqlState(
        jobs
          .insertInto('market.economic_event_revisions')
          .values(version(id, 3, Date.now(), Date.UTC(2030, 6, 15, 12, 30)))
          .execute(),
      ),
    ).toBe('42501');
  });
});
