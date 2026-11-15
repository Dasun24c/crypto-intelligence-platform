import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { type Kysely, sql } from 'kysely';
import {
  CONFIG_CHANNELS,
  type CalendarUpdated,
  type EconomicCategory,
  type EconomicRelease,
  type Impact,
  type SyncedSource,
} from '@cip/contracts';
import type { Database, EconomicEventStatus } from '@cip/db';
import { zonedTimeToUtc } from '@cip/domain';
import type { Logger } from '@cip/observability';

/**
 * The economic calendar sync (Phase 7; feasibility §6.1; rulebook §7 item 8 and I38):
 *
 * - FRED gives the release dates of CPI, the Employment Situation, GDP and Personal Income and
 *   Outlays, without times: each gets its release's standard New York time, `time_confirmed` false.
 * - BEA gives GDP and Personal Income and Outlays with their times. A BEA entry supersedes FRED's
 *   entry for the same release and New York date; if BEA stops listing it, FRED's comes back.
 * - FOMC statements are entered by an admin (the API); nothing here touches manual entries.
 *
 * Idempotent: a run that finds nothing new writes no event. Rows are never deleted; a date a source
 * no longer lists is cancelled. Triggers keep every version (migration 0010), which the engine reads
 * as known at each decision.
 */

export const CALENDAR_SYNC_EVERY_MS = 6 * 60 * 60_000;
export const NEW_YORK = 'America/New_York';
const DAY_MS = 86_400_000;

export interface ReleaseInfo {
  title: string;
  category: EconomicCategory;
  impact: Impact;
  /** The standard release time, New York (feasibility §6.1). */
  time: string;
}

/**
 * The standard releases. Impact is the platform's own rating: CPI, the Employment Situation and
 * FOMC statements are high (feasibility §6.1); GDP and Personal Income and Outlays medium.
 */
export const RELEASES: Readonly<Record<EconomicRelease, ReleaseInfo>> = {
  cpi: { title: 'Consumer Price Index (CPI)', category: 'inflation', impact: 'high', time: '08:30' },
  employment_situation: {
    title: 'Employment Situation (payrolls)',
    category: 'employment',
    impact: 'high',
    time: '08:30',
  },
  gdp: { title: 'Gross Domestic Product (GDP)', category: 'growth', impact: 'medium', time: '08:30' },
  personal_income_outlays: {
    title: 'Personal Income and Outlays (PCE prices)',
    category: 'inflation',
    impact: 'medium',
    time: '08:30',
  },
  fomc: { title: 'FOMC statement', category: 'central_bank', impact: 'high', time: '14:00' },
};

/** FRED's release ids (fred.stlouisfed.org/release?rid=…). */
export const FRED_RELEASES: readonly { id: number; release: EconomicRelease }[] = [
  { id: 10, release: 'cpi' },
  { id: 50, release: 'employment_situation' },
  { id: 53, release: 'gdp' },
  { id: 54, release: 'personal_income_outlays' },
];

/** What a source lists: one event, in the platform's terms. */
export interface DesiredEvent {
  sourceRef: string;
  release: EconomicRelease;
  title: string;
  category: EconomicCategory;
  impact: Impact;
  scheduledAt: number;
  timeConfirmed: boolean;
}

/** An event row as the sync compares it. */
export interface ExistingEvent {
  id: string;
  source_ref: string;
  release: EconomicRelease | null;
  title: string;
  category: EconomicCategory;
  impact: Impact;
  scheduled_at: Date;
  time_confirmed: boolean;
  status: EconomicEventStatus;
}

/** The changes one source's listing makes. */
export interface SyncPlan {
  insert: (DesiredEvent & { status: EconomicEventStatus })[];
  update: { id: string; event: DesiredEvent; status: EconomicEventStatus }[];
  cancel: string[];
  unchanged: number;
}

/** A New York calendar date, YYYY-MM-DD, at `ms`. */
export function newYorkDate(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: NEW_YORK,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

/** The UTC instant of `hhmm` New York time on the date `ymd` (YYYY-MM-DD). */
export function newYorkTime(ymd: string, hhmm: string): number {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return zonedTimeToUtc(y, m, d, hhmm, NEW_YORK);
}

/** FRED's dates for one release, as events at the release's standard time. */
export function fredEvents(
  releaseId: number,
  release: EconomicRelease,
  dates: readonly string[],
): DesiredEvent[] {
  const info = RELEASES[release];
  return [...new Set(dates)].map((date) => ({
    sourceRef: `${releaseId}:${date}`,
    release,
    title: info.title,
    category: info.category,
    impact: info.impact,
    scheduledAt: newYorkTime(date, info.time),
    timeConfirmed: false,
  }));
}

/**
 * Compares a source's listing with its stored events. Past events stay as they are. A stored future
 * event the listing no longer has is cancelled, but only up to the last date the listing covers for
 * its release: a source that lists nothing for a release cancels nothing. `statusFor` says whether a
 * listed event is scheduled or superseded (FRED's dates that BEA lists with their times).
 */
export function planSync(
  existing: readonly ExistingEvent[],
  desired: readonly DesiredEvent[],
  now: number,
  statusFor: (d: DesiredEvent) => EconomicEventStatus = () => 'scheduled',
): SyncPlan {
  const todayStart = newYorkTime(newYorkDate(now), '00:00');
  const byRef = new Map(existing.map((e) => [e.source_ref, e]));
  const listed = new Set(desired.map((d) => d.sourceRef));
  const horizon = new Map<EconomicRelease, number>();
  for (const d of desired) horizon.set(d.release, Math.max(horizon.get(d.release) ?? 0, d.scheduledAt));
  const plan: SyncPlan = { insert: [], update: [], cancel: [], unchanged: 0 };
  for (const d of desired) {
    if (d.scheduledAt < todayStart) continue;
    const e = byRef.get(d.sourceRef);
    const status = statusFor(d);
    if (!e) {
      plan.insert.push({ ...d, status });
      continue;
    }
    const same =
      e.status === status &&
      e.release === d.release &&
      e.title === d.title &&
      e.category === d.category &&
      e.impact === d.impact &&
      e.scheduled_at.getTime() === d.scheduledAt &&
      e.time_confirmed === d.timeConfirmed;
    if (same) plan.unchanged++;
    else plan.update.push({ id: e.id, event: d, status });
  }
  for (const e of existing) {
    if (e.status === 'cancelled' || listed.has(e.source_ref) || e.release === null) continue;
    const t = e.scheduled_at.getTime();
    const until = horizon.get(e.release);
    if (t >= todayStart && until !== undefined && t <= until) plan.cancel.push(e.id);
  }
  return plan;
}

/** Applies a plan in one transaction; returns how many events changed. */
export async function applyPlan(db: Kysely<Database>, source: SyncedSource, plan: SyncPlan): Promise<number> {
  if (plan.insert.length + plan.update.length + plan.cancel.length === 0) return 0;
  await db.transaction().execute(async (trx) => {
    if (plan.insert.length)
      await trx
        .insertInto('market.economic_events')
        .values(
          plan.insert.map((d) => ({
            id: randomUUID(),
            source,
            source_ref: d.sourceRef,
            release: d.release,
            title: d.title,
            category: d.category,
            impact: d.impact,
            scheduled_at: new Date(d.scheduledAt),
            time_confirmed: d.timeConfirmed,
            status: d.status,
            actual: null,
            forecast: null,
            previous: null,
            created_by: null,
          })),
        )
        .execute();
    for (const u of plan.update)
      await trx
        .updateTable('market.economic_events')
        .set({
          release: u.event.release,
          title: u.event.title,
          category: u.event.category,
          impact: u.event.impact,
          scheduled_at: new Date(u.event.scheduledAt),
          time_confirmed: u.event.timeConfirmed,
          status: u.status,
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', u.id)
        .execute();
    if (plan.cancel.length)
      await trx
        .updateTable('market.economic_events')
        .set({ status: 'cancelled', updated_at: sql<Date>`now()` })
        .where('id', 'in', plan.cancel)
        .execute();
  });
  return plan.insert.length + plan.update.length + plan.cancel.length;
}

/**
 * FRED's entries for GDP and Personal Income and Outlays step aside for BEA's on the same New York
 * date (BEA has the time), and come back when BEA no longer lists that date. Returns the changes.
 */
export async function reconcileSuperseded(db: Kysely<Database>): Promise<number> {
  const covered = sql<boolean>`EXISTS (
    SELECT 1 FROM market.economic_events b
    WHERE b.source = 'bea' AND b.status = 'scheduled' AND b.release = f.release
      AND (b.scheduled_at AT TIME ZONE ${NEW_YORK})::date = (f.scheduled_at AT TIME ZONE ${NEW_YORK})::date)`;
  return db.transaction().execute(async (trx) => {
    const down = await sql`
      UPDATE market.economic_events f SET status = 'superseded', updated_at = now()
      WHERE f.source = 'fred' AND f.status = 'scheduled' AND f.release IN ('gdp', 'personal_income_outlays')
        AND ${covered}`.execute(trx);
    const up = await sql`
      UPDATE market.economic_events f SET status = 'scheduled', updated_at = now()
      WHERE f.source = 'fred' AND f.status = 'superseded' AND NOT ${covered}`.execute(trx);
    return Number(down.numAffectedRows ?? 0n) + Number(up.numAffectedRows ?? 0n);
  });
}

// ---------------------------------------------------------------- sources

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

const USER_AGENT = 'cip-calendar-sync/1';
const TIMEOUT_MS = 20_000;

/** A source failed; the message never carries the request URL (it may hold the FRED key). */
export class CalendarSourceError extends Error {}

async function getText(fetchImpl: FetchLike, url: string, what: string): Promise<string> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': USER_AGENT },
    });
  } catch (err) {
    throw new CalendarSourceError(`${what}: ${err instanceof Error ? err.name : 'request failed'}`);
  }
  if (!res.ok) throw new CalendarSourceError(`${what}: HTTP ${res.status}`);
  return res.text();
}

/** Future release dates of one FRED release (fred/release/dates), from yesterday on. */
export async function fetchFredDates(
  fetchImpl: FetchLike,
  apiKey: string,
  releaseId: number,
  now: number,
): Promise<string[]> {
  const params = new URLSearchParams({
    release_id: String(releaseId),
    realtime_start: new Date(now - DAY_MS).toISOString().slice(0, 10),
    realtime_end: '9999-12-31',
    include_release_dates_with_no_data: 'true',
    sort_order: 'asc',
    limit: '1000',
    file_type: 'json',
    api_key: apiKey,
  });
  const body = await getText(
    fetchImpl,
    `https://api.stlouisfed.org/fred/release/dates?${params.toString()}`,
    `FRED release ${releaseId}`,
  );
  return parseFredDates(body, releaseId);
}

export function parseFredDates(body: string, releaseId: number): string[] {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new CalendarSourceError(`FRED release ${releaseId}: not JSON`);
  }
  const list = (json as { release_dates?: unknown }).release_dates;
  if (!Array.isArray(list)) throw new CalendarSourceError(`FRED release ${releaseId}: no release_dates`);
  const out: string[] = [];
  for (const item of list) {
    const date = (item as { date?: unknown }).date;
    if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) out.push(date);
  }
  return out;
}

/**
 * BEA's release schedule as an iCalendar feed (linked from bea.gov/news/schedule; public, no key).
 * Times are UTC (`…Z`); each release keeps its UID when it is rescheduled.
 */
export const BEA_CALENDAR_URL = 'https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics';

export interface IcsEvent {
  uid: string;
  summary: string;
  /** Epoch ms; null for an all-day or unreadable start. */
  start: number | null;
}

/** RFC 5545 text: `\,` `\;` `\\` and `\n`. */
function icsText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

function icsDateTime(params: string[], value: string, calendarZone: string | null): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (z) return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const zone = params.find((p) => p.startsWith('TZID='))?.slice(5) ?? calendarZone;
  if (!zone) return null;
  return zonedTimeToUtc(Number(y), Number(mo), Number(d), `${h}:${mi}`, zone) + Number(s) * 1000;
}

/** The VEVENTs of an iCalendar feed: lines unfolded first (a fold may split an escape). */
export function parseIcs(text: string): IcsEvent[] {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n');
  let calendarZone: string | null = null;
  const out: IcsEvent[] = [];
  let current: { uid?: string; summary?: string; start?: number | null } | null = null;
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const [name = '', ...params] = line.slice(0, colon).split(';');
    const value = line.slice(colon + 1);
    const key = name.toUpperCase();
    if (key === 'BEGIN' && value === 'VEVENT') current = {};
    else if (key === 'END' && value === 'VEVENT') {
      if (current?.uid && current.summary !== undefined)
        out.push({ uid: current.uid, summary: current.summary, start: current.start ?? null });
      current = null;
    } else if (!current) {
      if (key === 'X-WR-TIMEZONE' || (key === 'TZID' && !calendarZone)) calendarZone = value.trim();
    } else if (key === 'UID') current.uid = value.trim();
    else if (key === 'SUMMARY') current.summary = icsText(value).trim();
    else if (key === 'DTSTART') current.start = icsDateTime(params, value, calendarZone);
  }
  return out;
}

/**
 * Which tracked release a BEA entry is: the headline GDP estimates ("GDP (Advance Estimate), …",
 * formerly "Gross Domestic Product, … (Advance Estimate)") and Personal Income and Outlays. Not GDP
 * by state or county, nor state personal income or consumption.
 */
export function beaRelease(summary: string): 'gdp' | 'personal_income_outlays' | null {
  if (/^GDP \(/.test(summary) || /^Gross Domestic Product,/.test(summary)) return 'gdp';
  if (/^Personal Income and Outlays\b/.test(summary)) return 'personal_income_outlays';
  return null;
}

/** BEA's GDP and Personal Income and Outlays entries, with their own times. */
export function beaEvents(ics: string): DesiredEvent[] {
  const out: DesiredEvent[] = [];
  for (const e of parseIcs(ics)) {
    const release = beaRelease(e.summary);
    if (!release || e.start === null) continue;
    const info = RELEASES[release];
    out.push({
      sourceRef: e.uid,
      release,
      title: e.summary,
      category: info.category,
      impact: info.impact,
      scheduledAt: e.start,
      timeConfirmed: true,
    });
  }
  return out;
}

export async function fetchBea(fetchImpl: FetchLike): Promise<DesiredEvent[]> {
  const ics = await getText(fetchImpl, BEA_CALENDAR_URL, 'BEA schedule');
  if (!ics.includes('BEGIN:VCALENDAR')) throw new CalendarSourceError('BEA schedule: not an iCalendar feed');
  return beaEvents(ics);
}

// ---------------------------------------------------------------- the task

export interface CalendarSyncDeps {
  db: Kysely<Database>;
  redis: Pick<Redis, 'publish'>;
  log: Pick<Logger, 'info' | 'warn'>;
  fetch: FetchLike;
  fredApiKey: string | undefined;
  now?: () => number;
}

export interface SourceResult {
  source: SyncedSource;
  status: 'ok' | 'failed' | 'skipped';
  inserted: number;
  updated: number;
  unchanged: number;
  cancelled: number;
  error: string | null;
}

async function existingFor(db: Kysely<Database>, source: SyncedSource): Promise<ExistingEvent[]> {
  return db
    .selectFrom('market.economic_events')
    .select([
      'id',
      'source_ref',
      'release',
      'title',
      'category',
      'impact',
      'scheduled_at',
      'time_confirmed',
      'status',
    ])
    .where('source', '=', source)
    .execute();
}

/** `release:date` (New York) of BEA's scheduled entries: the FRED dates they supersede. */
async function beaCovered(db: Kysely<Database>): Promise<Set<string>> {
  const rows = await db
    .selectFrom('market.economic_events')
    .select(['release', 'scheduled_at'])
    .where('source', '=', 'bea')
    .where('status', '=', 'scheduled')
    .execute();
  return new Set(rows.map((r) => `${r.release}:${newYorkDate(r.scheduled_at.getTime())}`));
}

async function runSource(
  deps: CalendarSyncDeps,
  source: SyncedSource,
  list: (() => Promise<DesiredEvent[]>) | null,
  statusFor?: () => Promise<(d: DesiredEvent) => EconomicEventStatus>,
): Promise<SourceResult> {
  const now = deps.now ?? Date.now;
  const id = randomUUID();
  const startedAt = new Date(now());
  const blank = { inserted: 0, updated: 0, unchanged: 0, cancelled: 0 };
  if (!list) {
    await deps.db
      .insertInto('market.calendar_syncs')
      .values({
        id,
        source,
        started_at: startedAt,
        finished_at: startedAt,
        status: 'skipped',
        error: 'not configured',
      })
      .execute();
    return { source, status: 'skipped', ...blank, error: 'not configured' };
  }
  await deps.db
    .insertInto('market.calendar_syncs')
    .values({ id, source, started_at: startedAt, status: 'running' })
    .execute();
  let result: SourceResult;
  try {
    const desired = await list();
    const plan = planSync(await existingFor(deps.db, source), desired, now(), await statusFor?.());
    await applyPlan(deps.db, source, plan);
    result = {
      source,
      status: 'ok',
      inserted: plan.insert.length,
      updated: plan.update.length,
      unchanged: plan.unchanged,
      cancelled: plan.cancel.length,
      error: null,
    };
  } catch (err) {
    const message = err instanceof CalendarSourceError ? err.message : `${source}: ${String(err)}`;
    result = { source, status: 'failed', ...blank, error: message.slice(0, 500) };
  }
  await deps.db
    .updateTable('market.calendar_syncs')
    .set({
      finished_at: new Date(now()),
      status: result.status,
      inserted: result.inserted,
      updated: result.updated,
      unchanged: result.unchanged,
      cancelled: result.cancelled,
      error: result.error,
    })
    .where('id', '=', id)
    .execute();
  return result;
}

/**
 * One sync of every source: BEA first, so FRED's dates that BEA lists are written as superseded
 * from the start; then the reconciliation (a FRED date BEA no longer lists comes back). Announces a
 * change on `config:calendar` (the analyzer reloads; the API tells clients). Throws when a configured
 * source failed, so the queue retries; every attempt is recorded in market.calendar_syncs.
 */
export async function syncCalendar(
  deps: CalendarSyncDeps,
): Promise<{ results: SourceResult[]; changed: number }> {
  const now = deps.now ?? Date.now;
  const key = deps.fredApiKey;
  const bea = await runSource(deps, 'bea', () => fetchBea(deps.fetch));
  const fred = await runSource(
    deps,
    'fred',
    key
      ? async () => {
          const out: DesiredEvent[] = [];
          for (const r of FRED_RELEASES)
            out.push(...fredEvents(r.id, r.release, await fetchFredDates(deps.fetch, key, r.id, now())));
          return out;
        }
      : null,
    async () => {
      const covered = await beaCovered(deps.db);
      return (d) => (covered.has(`${d.release}:${newYorkDate(d.scheduledAt)}`) ? 'superseded' : 'scheduled');
    },
  );
  const reconciled = await reconcileSuperseded(deps.db);
  const results = [fred, bea];
  const changed = results.reduce((n, r) => n + r.inserted + r.updated + r.cancelled, 0) + reconciled;
  if (changed > 0) {
    const message: CalendarUpdated = { at: now(), reason: 'sync', changed };
    await deps.redis.publish(CONFIG_CHANNELS.calendar, JSON.stringify(message));
  }
  for (const r of results)
    (r.status === 'failed' ? deps.log.warn : deps.log.info).call(
      deps.log,
      { ...r },
      'calendar source synced',
    );
  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length) throw new CalendarSourceError(failed.map((r) => r.error).join('; '));
  return { results, changed };
}
