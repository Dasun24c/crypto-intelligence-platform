import { readFileSync } from 'node:fs';
import { Redis } from 'ioredis';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { CONFIG_CHANNELS } from '@cip/contracts';
import { calendarKnownFrom, createDb, loadEngineCalendar } from '@cip/db';
import { createLogger } from '@cip/observability';
import { BEA_CALENDAR_URL, type FetchLike, syncCalendar } from '../src/calendar-sync.ts';

const owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 2 });
const jobsDb = createDb({ connectionString: inject('dbRoleUrls').svc_jobs, max: 2 });
const analyzerDb = createDb({ connectionString: inject('dbRoleUrls').svc_analyzer, max: 2 });
const redis = new Redis(inject('redisUrl'));
const sub = new Redis(inject('redisUrl'));
const log = createLogger({ service: 'jobs', instance: 'test', level: 'silent' });
const BEA = readFileSync(new URL('./fixtures/bea-schedule-2026-11-12.ics', import.meta.url), 'utf8');
const NOW = Date.parse('2026-11-12T10:00:00Z');

const published: string[] = [];
beforeAll(async () => {
  await sub.subscribe(CONFIG_CHANNELS.calendar);
  sub.on('message', (_ch, message) => published.push(message));
});

afterAll(async () => {
  await owner.destroy();
  await jobsDb.destroy();
  await analyzerDb.destroy();
  redis.disconnect();
  sub.disconnect();
});

/** FRED (dates per release id) and BEA (the recorded schedule) as the sync fetches them. */
function sources(fred: Record<number, string[]>, opts: { fredStatus?: number } = {}): FetchLike {
  return async (url) => {
    if (url.startsWith('https://api.stlouisfed.org/fred/release/dates?')) {
      if (opts.fredStatus) return { ok: false, status: opts.fredStatus, text: async () => 'error' };
      const id = Number(new URL(url).searchParams.get('release_id'));
      const dates = (fred[id] ?? []).map((date) => ({ release_id: id, date }));
      return { ok: true, status: 200, text: async () => JSON.stringify({ release_dates: dates }) };
    }
    if (url === BEA_CALENDAR_URL) return { ok: true, status: 200, text: async () => BEA };
    return { ok: false, status: 404, text: async () => '' };
  };
}

const FRED = {
  10: ['2026-12-10', '2027-01-13'],
  50: ['2026-12-04', '2027-01-08'],
  53: ['2026-11-25', '2026-12-23'],
  54: ['2026-11-25', '2026-12-23'],
};

const sync = (fetch: FetchLike, fredApiKey: string | null = 'test-key') =>
  syncCalendar({ db: jobsDb, redis, log, fetch, fredApiKey: fredApiKey ?? undefined, now: () => NOW });

const revisions = async () =>
  Number(
    (
      await owner
        .selectFrom('market.economic_event_revisions')
        .select((eb) => eb.fn.countAll().as('n'))
        .executeTakeFirstOrThrow()
    ).n,
  );

const settle = () => new Promise((r) => setTimeout(r, 200));

describe('economic calendar sync', () => {
  it('syncs FRED and BEA; BEA supersedes FRED for GDP and PCE; a second run changes nothing', async () => {
    const first = await sync(sources(FRED));
    expect(first.results.map((r) => [r.source, r.status, r.inserted, r.updated, r.cancelled])).toEqual([
      ['fred', 'ok', 8, 0, 0],
      ['bea', 'ok', expect.any(Number), 0, 0],
      // (BEA lists GDP and Personal Income and Outlays through 2027.)
    ]);
    const window = await jobsDb
      .selectFrom('market.economic_events')
      .select(['source', 'release', 'scheduled_at', 'time_confirmed', 'status', 'impact'])
      .where('scheduled_at', '>=', new Date(NOW))
      .where('scheduled_at', '<', new Date(NOW + 60 * 86_400_000))
      .orderBy('scheduled_at')
      .orderBy('release')
      .orderBy('source')
      .execute();
    expect(
      window.map((r) => [
        r.scheduled_at.toISOString(),
        r.release,
        r.source,
        r.status,
        r.time_confirmed,
        r.impact,
      ]),
    ).toEqual([
      ['2026-11-25T13:30:00.000Z', 'gdp', 'bea', 'scheduled', true, 'medium'],
      ['2026-11-25T13:30:00.000Z', 'gdp', 'fred', 'superseded', false, 'medium'],
      ['2026-11-25T13:30:00.000Z', 'personal_income_outlays', 'bea', 'scheduled', true, 'medium'],
      ['2026-11-25T13:30:00.000Z', 'personal_income_outlays', 'fred', 'superseded', false, 'medium'],
      ['2026-12-04T13:30:00.000Z', 'employment_situation', 'fred', 'scheduled', false, 'high'],
      ['2026-12-10T13:30:00.000Z', 'cpi', 'fred', 'scheduled', false, 'high'],
      ['2026-12-23T13:30:00.000Z', 'gdp', 'bea', 'scheduled', true, 'medium'],
      ['2026-12-23T13:30:00.000Z', 'gdp', 'fred', 'superseded', false, 'medium'],
      ['2026-12-23T13:30:00.000Z', 'personal_income_outlays', 'bea', 'scheduled', true, 'medium'],
      ['2026-12-23T13:30:00.000Z', 'personal_income_outlays', 'fred', 'superseded', false, 'medium'],
      ['2027-01-08T13:30:00.000Z', 'employment_situation', 'fred', 'scheduled', false, 'high'],
    ]);
    await settle();
    expect(published).toHaveLength(1);
    expect(JSON.parse(published[0]!)).toMatchObject({ reason: 'sync', changed: first.changed });

    const before = await revisions();
    const second = await sync(sources(FRED));
    expect(second.changed).toBe(0);
    expect(second.results.every((r) => r.inserted + r.updated + r.cancelled === 0)).toBe(true);
    expect(await revisions()).toBe(before);
    await settle();
    expect(published).toHaveLength(1);
  });

  it('keeps every version: a moved date is cancelled and replaced, each counting from when it was known', async () => {
    await sync(sources({ ...FRED, 10: ['2026-12-11', '2027-01-13'] }));
    const rows = await owner
      .selectFrom('market.economic_events as e')
      .innerJoin('market.economic_event_revisions as r', 'r.event_id', 'e.id')
      .select(['e.id', 'e.source_ref', 'r.revision', 'r.status', 'r.recorded_at'])
      .where('e.source_ref', 'in', ['10:2026-12-10', '10:2026-12-11'])
      .orderBy('e.source_ref')
      .orderBy('r.revision')
      .execute();
    expect(rows.map((r) => [r.source_ref, r.revision, r.status])).toEqual([
      ['10:2026-12-10', 1, 'scheduled'],
      ['10:2026-12-10', 2, 'cancelled'],
      ['10:2026-12-11', 1, 'scheduled'],
    ]);
    const cal = await loadEngineCalendar(analyzerDb, NOW, NOW + 60 * 86_400_000);
    const firstFred = await owner
      .selectFrom('market.calendar_syncs')
      .select('finished_at')
      .where('source', '=', 'fred')
      .where('status', '=', 'ok')
      .orderBy('finished_at')
      .executeTakeFirstOrThrow();
    expect(cal.availableFrom).toBe(calendarKnownFrom(firstFred.finished_at!.getTime()));
    const cpi = cal.events.filter((e) => e.id === rows[0]!.id || e.id === rows[2]!.id);
    const recorded = (i: number) => calendarKnownFrom(rows[i]!.recorded_at.getTime());
    // The 10 December version counted only if it was cancelled in a later minute than it was recorded.
    expect(cpi).toEqual([
      ...(recorded(1) > recorded(0)
        ? [
            expect.objectContaining({
              id: rows[0]!.id,
              scheduledAt: Date.parse('2026-12-10T13:30:00Z'),
              knownFrom: recorded(0),
              knownUntil: recorded(1),
            }),
          ]
        : []),
      expect.objectContaining({
        id: rows[2]!.id,
        scheduledAt: Date.parse('2026-12-11T13:30:00Z'),
        knownFrom: recorded(2),
        knownUntil: null,
      }),
    ]);
    // FRED's GDP and PCE dates were superseded from the start, so the engine has only BEA's.
    const nov25 = await owner
      .selectFrom('market.economic_events')
      .select(['id', 'source'])
      .where('scheduled_at', '=', new Date('2026-11-25T13:30:00Z'))
      .execute();
    const bea = new Set(nov25.filter((r) => r.source === 'bea').map((r) => r.id));
    const inCalendar = cal.events.filter((e) => e.scheduledAt === Date.parse('2026-11-25T13:30:00Z'));
    expect(inCalendar).toHaveLength(2);
    expect(inCalendar.every((e) => bea.has(e.id))).toBe(true);
  });

  it('skips FRED without a key and fails a source without touching its events', async () => {
    const skipped = await sync(sources(FRED), null);
    expect(skipped.results.map((r) => [r.source, r.status, r.error])).toEqual([
      ['fred', 'skipped', 'not configured'],
      ['bea', 'ok', null],
    ]);
    const before = await revisions();
    await expect(sync(sources(FRED, { fredStatus: 500 }))).rejects.toThrow('FRED release 10: HTTP 500');
    expect(await revisions()).toBe(before);
    const failed = await owner
      .selectFrom('market.calendar_syncs')
      .select(['source', 'status', 'error'])
      .where('status', '=', 'failed')
      .execute();
    expect(failed).toEqual([{ source: 'fred', status: 'failed', error: 'FRED release 10: HTTP 500' }]);
  });

  it('counts each version from the second whole minute after it was recorded (rulebook I38)', async () => {
    const id = '019a7000-0000-7000-8000-00000000c0de';
    const at = Date.parse('2027-03-10T12:30:00Z');
    await owner
      .insertInto('market.economic_events')
      .values({
        id,
        source: 'manual',
        source_ref: 'test-versions',
        release: 'cpi',
        title: 'CPI (test)',
        category: 'inflation',
        impact: 'high',
        scheduled_at: new Date(at),
        time_confirmed: true,
        actual: null,
        forecast: null,
        previous: null,
        created_by: null,
      })
      .execute();
    const first = await owner
      .selectFrom('market.economic_event_revisions')
      .select('recorded_at')
      .where('event_id', '=', id)
      .executeTakeFirstOrThrow();
    const t0 = first.recorded_at.getTime();
    // Later versions with chosen times (only the owner can write revisions directly).
    const revision = (n: number, offsetMs: number, scheduledAt: number, status: string) =>
      sql`INSERT INTO market.economic_event_revisions
            (event_id, revision, recorded_at, scheduled_at, time_confirmed, title, currency, impact, status)
          VALUES (${id}, ${n}, ${new Date(t0 + offsetMs)}, ${new Date(scheduledAt)}, true, 'CPI (test)', 'USD', 'high', ${status})`.execute(
        owner,
      );
    await revision(2, 10 * 60_000, at + 3_600_000, 'scheduled');
    await revision(3, 20 * 60_000 + 30_000, at + 3_600_000, 'cancelled');
    const cal = await loadEngineCalendar(analyzerDb, at - 86_400_000, at + 86_400_000);
    const k = (ms: number) => Math.ceil(ms / 60_000) * 60_000 + 60_000;
    expect(cal.events.filter((e) => e.id === id)).toEqual([
      { id, scheduledAt: at, currency: 'USD', impact: 'high', knownFrom: k(t0), knownUntil: k(t0 + 600_000) },
      {
        id,
        scheduledAt: at + 3_600_000,
        currency: 'USD',
        impact: 'high',
        knownFrom: k(t0 + 600_000),
        knownUntil: k(t0 + 1_230_000),
      },
    ]);
  });

  it('keeps the history: events are never deleted and revisions never change', async () => {
    await expect(sql`DELETE FROM market.economic_events`.execute(owner)).rejects.toThrow(/keeps its history/);
    await expect(
      sql`UPDATE market.economic_event_revisions SET impact = 'low'`.execute(owner),
    ).rejects.toThrow(/keeps its history/);
    await expect(sql`DELETE FROM market.economic_events`.execute(jobsDb)).rejects.toThrow();
    await expect(
      sql`INSERT INTO market.economic_event_revisions (event_id, revision, recorded_at, scheduled_at, time_confirmed, title, currency, impact, status)
          SELECT id, 99, now(), scheduled_at, true, title, currency, impact, status FROM market.economic_events LIMIT 1`.execute(
        jobsDb,
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
