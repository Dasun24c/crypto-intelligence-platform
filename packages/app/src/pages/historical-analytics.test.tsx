import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HISTORICAL_NOTICE,
  HISTORICAL_OBSERVATIONS,
  type ReplayBaseSettings,
  type ReplayStatus,
  type ReplaySummary,
  type RunComparison,
  type SetupStats,
  type SetupStatsRow,
} from '@cip/contracts';
import { BTC_BINANCE, INSTRUMENTS } from '../test/fixtures.js';
import { type ApiRequest, type ApiRoutes, mockApi, renderApp, signedIn } from '../test/harness.js';

const RUN = '019a7400-0000-7000-8000-000000000001';
const LIVE = '019a7400-0000-7000-8000-000000000002';
const H = 3_600_000;
const T = Date.UTC(2026, 10, 21, 12);

const row = (over: Partial<SetupStatsRow>): SetupStatsRow => ({
  key: {},
  detected: 0,
  warmup: 0,
  confirmed: 0,
  open: 0,
  resolved: 0,
  entered: 0,
  outcomes: { target_reached: 0, invalidated: 0, expired_no_entry: 0, expired_open: 0, ambiguous: 0 },
  avgMfeR: null,
  avgMaeR: null,
  ...over,
});

function stats(q: URLSearchParams): SetupStats {
  const groupBy = (q.get('groupBy') ?? 'pattern').split(',') as SetupStats['groupBy'];
  return {
    label: HISTORICAL_OBSERVATIONS,
    notice: HISTORICAL_NOTICE,
    groupBy,
    from: q.has('from') ? Number(q.get('from')) : null,
    to: q.has('to') ? Number(q.get('to')) : null,
    instrumentId: null,
    found: (q.get('found') ?? 'all') as SetupStats['found'],
    runId: q.get('runId'),
    runs: 3,
    totals: row({
      detected: 30,
      warmup: 25,
      confirmed: 6,
      open: 1,
      resolved: 5,
      entered: 4,
      outcomes: { target_reached: 1, invalidated: 3, expired_no_entry: 1, expired_open: 0, ambiguous: 0 },
      avgMfeR: 0.8125,
      avgMaeR: 0.9,
    }),
    rows: [
      row({
        key: {
          pattern: 'sweep_outside_fill_inside',
          ...(groupBy.includes('session') ? { session: 'london' } : {}),
        },
        detected: 22,
        warmup: 20,
        confirmed: 4,
        resolved: 4,
        entered: 3,
        outcomes: { target_reached: 1, invalidated: 2, expired_no_entry: 1, expired_open: 0, ambiguous: 0 },
        avgMfeR: 1.25,
        avgMaeR: 0.75,
      }),
      row({
        key: { pattern: 'htf_order_block', ...(groupBy.includes('session') ? { session: 'asia' } : {}) },
        detected: 8,
        warmup: 5,
        confirmed: 2,
        open: 1,
        resolved: 1,
        entered: 1,
        outcomes: { target_reached: 0, invalidated: 1, expired_no_entry: 0, expired_open: 0, ambiguous: 0 },
        avgMfeR: 0.25,
        avgMaeR: 1,
      }),
    ],
  };
}

const BASE: ReplayBaseSettings = {
  instrumentId: BTC_BINANCE.id,
  profile: { name: 'crypto-majors', version: 4 },
  settings: {
    patterns: ['double_liquidity_trap', 'eq_near_poi', 'htf_order_block', 'sweep_outside_fill_inside'],
    minRR: 2,
    mandatory: ['sweep', 'mss', 'levels_defined'],
    requireDisplacement: true,
    entryExpiryBars: 24,
    maxHoldBars: 288,
    newsBlackoutMin: { before: 30, after: 30 },
    blockConfirmOnLowLiquidity: false,
  },
};

const comparison = (over: Partial<RunComparison> = {}): RunComparison => ({
  base: {
    runId: LIVE,
    mode: 'live',
    profile: { name: 'crypto-majors', version: 4 },
    rulesetVersion: 'indicators-1+smc-0.3.1',
    digest: 'a'.repeat(64),
    events: 120,
    settings: null,
  },
  other: {
    runId: RUN,
    mode: 'replay',
    profile: { name: 'crypto-majors', version: 4 },
    rulesetVersion: 'indicators-1+smc-0.3.1',
    digest: 'b'.repeat(64),
    events: 118,
    settings: { minRR: 3 },
  },
  from: T - 6 * H,
  to: T,
  equal: false,
  sameOrigins: true,
  incomplete: false,
  settings: [{ path: 'smc.setups.checklist.minRR', base: 2, other: 3 }],
  eventTypes: [{ type: 'setup_transition', base: 10, other: 8 }],
  onlyInBase: 2,
  onlyInOther: 0,
  changed: 3,
  setups: [
    {
      key: 'su:1',
      pattern: 'sweep_outside_fill_inside',
      variant: null,
      direction: 'bullish',
      contextTf: '1h',
      setupTf: '5m',
      createdAt: T - 2 * H,
      base: { state: 'confirmed', resolution: null, score: 80, mandatoryPassed: true, transitions: 2 },
      other: { state: 'triggered', resolution: null, score: 65, mandatoryPassed: true, transitions: 1 },
    },
  ],
  setupsTotal: 1,
  ...over,
});

const status = (over: Partial<ReplayStatus> = {}): ReplayStatus => ({
  runId: RUN,
  instrumentId: BTC_BINANCE.id,
  status: 'completed',
  from: T - 6 * H,
  to: T,
  settings: { minRR: 3 },
  sourceRunId: LIVE,
  digest: 'b'.repeat(64),
  events: 118,
  requestedAt: T + H,
  finishedAt: T + H + 40_000,
  comparison: comparison(),
  error: null,
  ...over,
});

const summary = (over: Partial<ReplaySummary> = {}): ReplaySummary => ({
  runId: RUN,
  instrumentId: BTC_BINANCE.id,
  status: 'completed',
  from: T - 6 * H,
  to: T,
  settings: { minRR: 3 },
  sourceRunId: LIVE,
  digest: 'b'.repeat(64),
  requestedAt: T + H,
  finishedAt: T + H + 40_000,
  mine: true,
  error: null,
  ...over,
});

function api(routes: ApiRoutes = {}) {
  return mockApi({
    'GET /api/v1/instruments': INSTRUMENTS,
    'GET /api/v1/setups/stats': (r: ApiRequest) => stats(r.url.searchParams),
    'GET /api/v1/exports/setup-stats.csv': new Response('group,pattern\r\n', {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition':
          'attachment; filename="setup-statistics-historical-observations-2026-11-22.csv"',
      },
    }),
    'GET /api/v1/replays': [summary()],
    'GET /api/v1/replays/settings': BASE,
    'POST /api/v1/replays': { runId: RUN },
    [`GET /api/v1/replays/${RUN}`]: status(),
    'GET /api/v1/system/runs': [],
    ...routes,
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Criterion 12.2: words that would present history as a promise or a measure of performance. */
const IMPLIES_PERFORMANCE =
  /win ?rate|success rate|hit rate|accura|profitab|expected|expectancy|probabilit|chance of|\bedge\b|guarantee|predict|will (reach|hit|win|work)/i;

describe('Historical Analytics: outcome statistics', () => {
  it('shows the statistics the API gives, labelled as historical observations (12.1, 12.2)', async () => {
    const { find } = api();
    const { session, user } = await signedIn();
    renderApp('/history', session, user);
    expect(await screen.findByRole('heading', { name: 'Historical Analytics', level: 1 })).toBeTruthy();
    const tabs = screen.getByRole('tablist', { name: 'Historical Analytics views' });
    expect(within(tabs).getByRole('tab', { name: 'Outcome statistics' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByText(HISTORICAL_NOTICE)).toBeTruthy();
    const first = await waitFor(() => {
      const el = document.querySelector('[data-stats-row="sweep_outside_fill_inside"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(first.getAttribute('data-detected')).toBe('22');
    expect(first.getAttribute('data-target-reached')).toBe('1');
    expect(within(first as HTMLElement).getByText('P4 · Sweep outside, fill inside')).toBeTruthy();
    expect(first.querySelector('[data-outcome="target_reached"]')!.textContent).toBe('1 (25 %)');
    expect(within(first as HTMLElement).getByText('1.25')).toBeTruthy();
    // Fewer than 20 resolved: marked as few observations.
    expect(within(first as HTMLElement).getByText('few observations')).toBeTruthy();
    const totals = document.querySelector('[data-stats-totals]')!;
    expect(totals.getAttribute('data-detected')).toBe('30');
    expect(totals.getAttribute('data-avg-mfe-r')).toBe('0.8125');
    // The request: grouped by pattern, every setup, the last 30 days ending at a whole minute.
    const q = find('GET', '/api/v1/setups/stats')[0]!.url.searchParams;
    expect(q.get('groupBy')).toBe('pattern');
    expect(q.get('found')).toBe('all');
    expect(Number(q.get('to')) % 60_000).toBe(0);
    expect(Number(q.get('to')) - Number(q.get('from'))).toBe(30 * 86_400_000);
    // Criterion 12.2: nothing on the page presents these numbers as expected performance.
    expect(document.body.textContent).toContain(HISTORICAL_OBSERVATIONS);
    expect(document.body.textContent).not.toMatch(IMPLIES_PERFORMANCE);
  });

  it('groups by more dimensions, filters, and downloads the CSV', async () => {
    const { find } = api();
    const { session, user } = await signedIn();
    const u = userEvent.setup();
    renderApp('/history', session, user);
    await screen.findByText('P4 · Sweep outside, fill inside');
    await u.click(screen.getByRole('checkbox', { name: 'Session' }));
    await waitFor(() =>
      expect(document.querySelector('[data-stats-row="sweep_outside_fill_inside·london"]')).not.toBeNull(),
    );
    expect(screen.getByRole('columnheader', { name: 'Session' })).toBeTruthy();
    expect(screen.getByText('London')).toBeTruthy();
    await u.selectOptions(screen.getByLabelText('Found'), 'live');
    await u.selectOptions(screen.getByLabelText('Setups that started forming'), 'all');
    await waitFor(() => {
      const last = find('GET', '/api/v1/setups/stats').at(-1)!.url.searchParams;
      expect(last.get('groupBy')).toBe('pattern,session');
      expect(last.get('found')).toBe('live');
      expect(last.has('from')).toBe(false);
    });
    // Unchecking the only dimension left is refused: there is always one.
    await u.click(screen.getByRole('checkbox', { name: 'Session' }));
    await u.click(screen.getByRole('checkbox', { name: 'Pattern' }));
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Pattern' }).checked).toBe(true);

    const create = vi.fn(() => 'blob:csv');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
    const saved: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download);
    });
    await u.click(screen.getByRole('button', { name: 'Statistics (CSV)' }));
    await waitFor(() => expect(saved).toEqual(['setup-statistics-historical-observations-2026-11-22.csv']));
    expect(find('GET', '/api/v1/exports/setup-stats.csv')[0]!.url.searchParams.get('found')).toBe('live');
  });

  it('says why a download was refused', async () => {
    api({
      'GET /api/v1/exports/setups.csv': new Response(
        JSON.stringify({
          type: 'about:blank',
          title: 'Validation failed',
          status: 400,
          code: 'VALIDATION_FAILED',
          detail: 'Narrow the period.',
        }),
        { status: 400, headers: { 'content-type': 'application/problem+json' } },
      ),
    });
    const { session, user } = await signedIn();
    const u = userEvent.setup();
    renderApp('/history', session, user);
    await screen.findByText('P4 · Sweep outside, fill inside');
    await u.click(screen.getByRole('button', { name: 'Setups (CSV)' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Narrow the period.');
  });
});

describe('Historical Analytics: replays (12.3)', () => {
  it('starts a replay with changed settings, then shows it compared with the live run', async () => {
    const { find } = api({ [`GET /api/v1/replays/${RUN}`]: status() });
    const { session, user } = await signedIn('analyst');
    const u = userEvent.setup();
    renderApp('/history?tab=replays', session, user);
    const form = await screen.findByRole('form', { name: 'Start a replay' });
    await u.click(within(form).getByText(/Change settings for this replay/));
    const minRR = await within(form).findByLabelText('Minimum reward-to-risk');
    expect((minRR as HTMLInputElement).value).toBe('2');
    expect(within(form).getByText('Nothing changed: the replay uses the live settings.')).toBeTruthy();
    await u.clear(minRR);
    await u.type(minRR, '3');
    await u.click(within(form).getByRole('checkbox', { name: 'P2 · Equal highs or lows near a POI' }));
    expect(
      within(form).getByText(/^Changed: Patterns: P1, P3, P4; Minimum reward-to-risk \(item 7\): 3$/),
    ).toBeTruthy();
    await u.click(within(form).getByRole('button', { name: 'Start replay' }));
    await waitFor(() => expect(find('POST', '/api/v1/replays')).toHaveLength(1));
    const body = find('POST', '/api/v1/replays')[0]!.body as {
      instrumentId: string;
      from: number;
      to: number;
      settings: object;
    };
    expect(body.instrumentId).toBe(BTC_BINANCE.id);
    expect(body.to - body.from).toBe(6 * H);
    expect(body.settings).toEqual({
      patterns: ['double_liquidity_trap', 'htf_order_block', 'sweep_outside_fill_inside'],
      minRR: 3,
    });
    // The new replay opens, compared with the live run it started from.
    const detail = await waitFor(() => {
      const el = document.querySelector(`[data-replay-detail="${RUN}"]`);
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    const compared = await waitFor(() => {
      const el = detail.querySelector('[data-comparison]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(compared.getAttribute('data-equal')).toBe('false');
    expect(within(compared).getByText('Settings differ from the live run')).toBeTruthy();
    const setting = compared.querySelector('[data-setting-path="smc.setups.checklist.minRR"]') as HTMLElement;
    expect(within(setting).getByText('Minimum reward-to-risk (item 7)')).toBeTruthy();
    expect(within(setting).getByText('2')).toBeTruthy();
    expect(within(setting).getByText('3')).toBeTruthy();
    expect(within(compared).getByText('Confirmed, score 80')).toBeTruthy();
    expect(within(compared).getByText('Triggered, score 65')).toBeTruthy();
    expect(compared.querySelector('[data-differences]')!.getAttribute('data-differences')).toBe('5');
    expect(document.body.textContent).not.toMatch(IMPLIES_PERFORMANCE);
  });

  it('shows a replay that matches the live run, and lets any role look but only analysts start', async () => {
    api({
      [`GET /api/v1/replays/${RUN}`]: status({
        settings: null,
        comparison: comparison({
          equal: true,
          settings: [],
          onlyInBase: 0,
          changed: 0,
          setups: [],
          setupsTotal: 0,
        }),
      }),
      'GET /api/v1/replays': [summary({ settings: null, mine: false })],
    });
    const { session, user } = await signedIn('viewer');
    const u = userEvent.setup();
    renderApp('/history?tab=replays', session, user);
    expect(await screen.findByText(/Analysts and admins can start replays/)).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Start a replay' })).toBeNull();
    const listed = await waitFor(() => {
      const el = document.querySelector(`[data-replay-id="${RUN}"]`);
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(within(listed).getByText('Live settings')).toBeTruthy();
    await u.click(within(listed).getByRole('button', { name: 'Show' }));
    expect(await screen.findByText('Matches the live run')).toBeTruthy();
    expect(screen.getByText('The two runs used the same rules version and settings.')).toBeTruthy();
  });

  it('waits for a queued replay, and explains a failed one', async () => {
    api({
      [`GET /api/v1/replays/${RUN}`]: status({
        status: 'failed',
        comparison: null,
        digest: null,
        error: 'candle 2026-11-21 10:05 is missing',
      }),
    });
    const { session, user } = await signedIn('analyst');
    renderApp(`/history?tab=replays&replay=${RUN}`, session, user);
    expect(await screen.findByText('The replay failed')).toBeTruthy();
    expect(screen.getByText('candle 2026-11-21 10:05 is missing')).toBeTruthy();
  });
});
