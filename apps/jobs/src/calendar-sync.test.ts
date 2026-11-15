import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  beaEvents,
  beaRelease,
  CalendarSourceError,
  type ExistingEvent,
  fetchFredDates,
  fredEvents,
  newYorkDate,
  newYorkTime,
  parseFredDates,
  parseIcs,
  planSync,
} from './calendar-sync.js';

/** BEA's schedule as served on 2026-11-12 (CRLF, folded lines, UTC times). */
const BEA = readFileSync(new URL('../test/fixtures/bea-schedule-2026-11-12.ics', import.meta.url), 'utf8');
const NOW = Date.parse('2026-11-12T10:00:00Z');

describe('BEA schedule', () => {
  it('reads every event, unfolding lines before unescaping', () => {
    const events = parseIcs(BEA);
    expect(events).toHaveLength(169);
    expect(events[1]).toEqual({
      uid: '2ec758be-402b-4164-9af0-55c3c0edb310',
      summary: 'Gross Domestic Product, 4th Quarter and Year 2024 (Advance Estimate)',
      start: Date.parse('2025-01-30T13:30:00Z'),
    });
    expect(events.every((e) => !e.summary.includes('\\'))).toBe(true);
  });

  it('keeps the headline GDP estimates and Personal Income and Outlays, nothing by state or county', () => {
    expect(beaRelease('GDP (Advance Estimate), 3rd Quarter 2026')).toBe('gdp');
    expect(beaRelease('Gross Domestic Product, 4th Quarter and Year 2024 (Advance Estimate)')).toBe('gdp');
    expect(beaRelease('Personal Income and Outlays, October 2026')).toBe('personal_income_outlays');
    expect(beaRelease('GDP by County and Personal Income by County, 2025')).toBeNull();
    expect(
      beaRelease('Gross Domestic Product by State and Personal Income by State, 2nd Quarter 2026'),
    ).toBeNull();
    expect(beaRelease('Real Personal Consumption Expenditures by State, 2025')).toBeNull();
    expect(beaRelease('U.S. International Trade in Goods and Services, September 2026')).toBeNull();
  });

  it('lists the releases between 12 November 2026 and 15 January 2027 with their times (criterion 7.3)', () => {
    const window = beaEvents(BEA).filter(
      (e) => e.scheduledAt >= NOW && e.scheduledAt < Date.parse('2027-01-15T00:00:00Z'),
    );
    expect(
      window.map((e) => [new Date(e.scheduledAt).toISOString(), e.release, e.title, e.timeConfirmed]),
    ).toEqual([
      [
        '2026-11-25T13:30:00.000Z',
        'gdp',
        'GDP (Second Estimate) and Corporate Profits, 3rd Quarter 2026',
        true,
      ],
      [
        '2026-11-25T13:30:00.000Z',
        'personal_income_outlays',
        'Personal Income and Outlays, October 2026',
        true,
      ],
      [
        '2026-12-23T13:30:00.000Z',
        'gdp',
        'GDP (Third Estimate), Industries, Corporate Profits, State GDP, and State Personal Income, 3rd Quarter 2026',
        true,
      ],
      [
        '2026-12-23T13:30:00.000Z',
        'personal_income_outlays',
        'Personal Income and Outlays, November 2026',
        true,
      ],
    ]);
    // 13:30 UTC is 08:30 in New York in winter.
    expect(newYorkDate(window[0]!.scheduledAt)).toBe('2026-11-25');
  });

  it('reads local times in the event or calendar time zone', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'X-WR-TIMEZONE:America/New_York',
      'BEGIN:VEVENT',
      'UID:a',
      'SUMMARY:Personal Income and Outlays\\, May 2026',
      'DTSTART;TZID=America/New_York:20260626T100000',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:b',
      'SUMMARY:GDP (Advance Estimate)\\, 2nd Quarter 2026',
      'DTSTART:20260730T083000',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:c',
      'SUMMARY:GDP (Second Estimate)\\, 2nd Quarter 2026',
      'DTSTART;VALUE=DATE:20260827',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\n');
    expect(beaEvents(ics).map((e) => [e.sourceRef, new Date(e.scheduledAt).toISOString()])).toEqual([
      ['a', '2026-06-26T14:00:00.000Z'],
      ['b', '2026-07-30T12:30:00.000Z'],
    ]);
  });
});

describe('FRED release dates', () => {
  const body = JSON.stringify({
    realtime_start: '2026-11-11',
    realtime_end: '9999-12-31',
    order_by: 'release_date',
    sort_order: 'asc',
    count: 3,
    offset: 0,
    limit: 1000,
    release_dates: [
      { release_id: 10, date: '2026-12-10' },
      { release_id: 10, date: '2027-01-13' },
      { release_id: 10, date: 'not a date' },
    ],
  });

  it('reads the dates and refuses anything else', () => {
    expect(parseFredDates(body, 10)).toEqual(['2026-12-10', '2027-01-13']);
    expect(() => parseFredDates('<xml/>', 10)).toThrow(CalendarSourceError);
    expect(() => parseFredDates('{}', 10)).toThrow(/no release_dates/);
  });

  it('gives each date the standard New York time, without claiming it is confirmed', () => {
    const [december, july] = [
      ...fredEvents(10, 'cpi', ['2026-12-10']),
      ...fredEvents(50, 'employment_situation', ['2026-07-02']),
    ];
    expect(december).toMatchObject({
      sourceRef: '10:2026-12-10',
      release: 'cpi',
      impact: 'high',
      category: 'inflation',
      scheduledAt: Date.parse('2026-12-10T13:30:00Z'), // 08:30 EST
      timeConfirmed: false,
    });
    expect(july!.scheduledAt).toBe(Date.parse('2026-07-02T12:30:00Z')); // 08:30 EDT
    expect(newYorkTime('2026-12-09', '14:00')).toBe(Date.parse('2026-12-09T19:00:00Z'));
  });

  it('asks for future dates and keeps the key out of its errors', async () => {
    const urls: string[] = [];
    const ok = async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => body };
    };
    await fetchFredDates(ok, 'secret-key', 10, NOW);
    const url = new URL(urls[0]!);
    expect(url.origin + url.pathname).toBe('https://api.stlouisfed.org/fred/release/dates');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      release_id: '10',
      realtime_start: '2026-11-11',
      include_release_dates_with_no_data: 'true',
      file_type: 'json',
      api_key: 'secret-key',
    });
    const refused = async () => ({
      ok: false,
      status: 400,
      text: async () => 'Bad Request. api_key=secret-key',
    });
    await expect(fetchFredDates(refused, 'secret-key', 10, NOW)).rejects.toThrow('FRED release 10: HTTP 400');
    const down = async () => {
      throw new TypeError(`fetch failed for https://api.stlouisfed.org/?api_key=secret-key`);
    };
    const err: unknown = await fetchFredDates(down, 'secret-key', 10, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CalendarSourceError);
    expect((err as Error).message).not.toContain('secret-key');
  });
});

describe('the sync plan', () => {
  const cpi = (date: string) => fredEvents(10, 'cpi', [date])[0]!;
  const stored = (date: string, extra: Partial<ExistingEvent> = {}): ExistingEvent => {
    const d = cpi(date);
    return {
      id: `id-${date}`,
      source_ref: d.sourceRef,
      release: 'cpi',
      title: d.title,
      category: d.category,
      impact: d.impact,
      scheduled_at: new Date(d.scheduledAt),
      time_confirmed: false,
      status: 'scheduled',
      ...extra,
    };
  };

  it('inserts what is new, leaves what is unchanged and updates what changed', () => {
    const plan = planSync(
      [stored('2026-12-10'), stored('2027-01-13', { scheduled_at: new Date('2027-01-13T15:00:00Z') })],
      [cpi('2026-12-10'), cpi('2027-01-13'), cpi('2027-02-11')],
      NOW,
    );
    expect(plan.insert.map((d) => d.sourceRef)).toEqual(['10:2027-02-11']);
    expect(plan.update.map((u) => u.id)).toEqual(['id-2027-01-13']);
    expect(plan.unchanged).toBe(1);
    expect(plan.cancel).toEqual([]);
  });

  it('is idempotent: the same listing twice changes nothing the second time', () => {
    const listing = [cpi('2026-12-10'), cpi('2027-01-13')];
    const plan = planSync([stored('2026-12-10'), stored('2027-01-13')], listing, NOW);
    expect(plan).toEqual({ insert: [], update: [], cancel: [], unchanged: 2 });
  });

  it('cancels a future date the source dropped, but only within what it still lists', () => {
    const plan = planSync(
      [stored('2026-12-10'), stored('2027-01-20'), stored('2027-06-10'), stored('2026-11-10')],
      [cpi('2027-01-13'), cpi('2027-02-11')],
      NOW,
    );
    // 2027-06-10 lies beyond the listing's last date; 2026-11-10 is past.
    expect(plan.cancel).toEqual(['id-2026-12-10', 'id-2027-01-20']);
    expect(planSync([stored('2026-12-10')], [], NOW).cancel).toEqual([]);
  });

  it('ignores dates already past, and follows the status the caller gives (BEA supersedes FRED)', () => {
    const superseded = () => 'superseded' as const;
    const plan = planSync(
      [stored('2026-12-10', { status: 'superseded' })],
      [cpi('2026-11-01'), cpi('2026-12-10')],
      NOW,
      superseded,
    );
    expect(plan).toEqual({ insert: [], update: [], cancel: [], unchanged: 1 });
    // BEA no longer lists the day: FRED's entry is scheduled again.
    const back = planSync([stored('2026-12-10', { status: 'superseded' })], [cpi('2026-12-10')], NOW);
    expect(back.update).toEqual([{ id: 'id-2026-12-10', event: cpi('2026-12-10'), status: 'scheduled' }]);
    // A new date BEA already covers is written as superseded from the start.
    expect(planSync([], [cpi('2027-01-13')], NOW, superseded).insert).toEqual([
      { ...cpi('2027-01-13'), status: 'superseded' },
    ]);
  });
});
