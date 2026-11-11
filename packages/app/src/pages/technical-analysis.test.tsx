import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { channels, type IndicatorPoint, type IndicatorSeries, type Instrument } from '@cip/contracts';
import { INDICATOR_FIELDS } from '../lib/analysis.js';
import {
  analysisStatus,
  BTC_BINANCE,
  BTC_REPLAY,
  candle,
  DEFAULT_PARAMS,
  health,
  PAXG_BINANCE,
  point,
  run,
  RUN_ID,
  series,
} from '../test/fixtures.js';
import { type ApiRequest, type ApiRoutes, mockApi, problem, renderApp, signedIn } from '../test/harness.js';

const MINUTE = 60_000;
const NOW = Math.floor(Date.now() / MINUTE) * MINUTE; // open time of the candle in progress
const LAST = NOW - MINUTE; // the latest closed candle
const RUN_FROM = LAST - 2 * MINUTE;
const OTHER_RUN = '019a7300-0000-7000-8000-000000000002';

const BTC: Instrument = { ...BTC_BINANCE, profile: { name: 'crypto-majors', version: 1 } };
const ID = BTC.id;
const INDICATORS = channels.indicators(ID, '1m');
const CANDLES = channels.candles(ID, '1m');
/** Settings other than the defaults: labels must come from them. */
const PARAMS = { ...DEFAULT_PARAMS, rsi: { period: 9 }, ema: { fast: 21, mid: 55, slow: 233 } };

/** Six closed candles up to LAST; the first three are warm-up (before the run started). */
const POINTS: IndicatorPoint[] = [5, 4, 3, 2, 1, 0].map((n) =>
  point(LAST - n * MINUTE, { warmup: LAST - n * MINUTE < RUN_FROM, rsi: 50 + n }),
);
const STORED = [5, 4, 3, 2, 1, 0].map((n) =>
  candle(LAST - n * MINUTE, String(74_000 - n), { o: String(73_990 - n), h: '74010.5', l: '73980.25' }),
);

const btcSeries = (points = POINTS, extra: Partial<IndicatorSeries> = {}) =>
  series(ID, '1m', points, { run: run({ from: RUN_FROM }), params: PARAMS, ...extra });

function api(routes: ApiRoutes = {}) {
  return mockApi({
    'GET /api/v1/instruments': [BTC, PAXG_BINANCE],
    'GET /api/v1/system/health': health([], { analysis: [analysisStatus(ID, { lagSec: 2 })] }),
    [`GET /api/v1/indicators/${ID}`]: btcSeries(),
    [`GET /api/v1/market/${ID}/candles`]: STORED,
    ...routes,
  });
}

const valuesTable = () =>
  screen.findByRole('table', { name: 'Indicator values of the latest closed candle' }, { timeout: 5_000 });

/** The values table as `data-indicator` → parsed `data-value`. */
function shownValues(table: HTMLElement): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const cell of table.querySelectorAll<HTMLElement>('[data-indicator]'))
    out[cell.dataset['indicator']!] = JSON.parse(cell.dataset['value']!);
  return out;
}

/** The values table's row for one indicator, by its label. */
const row = (table: HTMLElement, label: string) =>
  within(table).getByRole('rowheader', { name: label }).closest('tr')!;

/** A chart's text summary (also in the SVG description, which this leaves out). */
const summary = (text: RegExp) => screen.getByText(text, { selector: 'figcaption p' });
const findSummary = (text: RegExp) => screen.findByText(text, { selector: 'figcaption p' });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Technical Analysis', () => {
  it('shows the run, the latest closed candle with every value exactly as the API sent it, and the charts', async () => {
    const { find } = api();
    const { session, user } = await signedIn();
    renderApp(`/analysis?instrument=${ID}&tf=1m`, session, user);
    const table = await valuesTable();

    expect(table.dataset['t']).toBe(String(LAST));
    expect(table.dataset['tf']).toBe('1m');
    expect(table.dataset['instrument']).toBe(ID);
    expect(table.dataset['run']).toBe(RUN_ID);
    expect(table.dataset['warmup']).toBe('false');
    const latest = POINTS.at(-1)!;
    expect(shownValues(table)).toEqual(Object.fromEntries(INDICATOR_FIELDS.map((f) => [f, latest[f]])));
    // Readable formatting, with labels from the run's settings.
    expect(within(row(table, 'RSI 9')).getByText('50.00')).toBeTruthy();
    expect(within(row(table, 'EMA 21')).getByText('74,010.12')).toBeTruthy();
    expect(within(row(table, 'EMA 233')).getByText('73,500.25')).toBeTruthy();
    expect(within(row(table, 'MACD 12/26/9')).getByText('12.35')).toBeTruthy();
    expect(within(row(table, 'Volume anomaly (z ≥ 3.5)')).getByText('No')).toBeTruthy();
    expect(within(row(table, 'Trend')).getByText('Bullish')).toBeTruthy();
    expect(within(row(table, 'Trend strength')).getByText('0.457')).toBeTruthy();
    expect(screen.getByText(/describes recent prices and is not a prediction/)).toBeTruthy();
    expect(screen.getByText(/Educational analysis — not financial advice/)).toBeTruthy();

    // The run: status, profile and start, and the lag System Health reports.
    const runCard = screen.getByRole('heading', { name: 'Analysis run' }).closest('section')!;
    expect(within(runCard).getByText('Live')).toBeTruthy();
    expect(within(runCard).getByText('crypto-majors v1')).toBeTruthy();
    expect(await within(runCard).findByText('2 s')).toBeTruthy();

    // The charts, each with a text summary.
    const price = screen.getByRole('img', { name: /candles with EMA 21, EMA 55, EMA 233 and VWAP/ });
    expect(price.querySelectorAll('polyline').length).toBeGreaterThan(0);
    expect(
      await findSummary(/^6 candles from .*Last price 74,000.00 USDT; high 74,010.50, low 73,980.25\./),
    ).toBeTruthy();
    expect(summary(/Candles before .* are warm-up\./)).toBeTruthy();
    expect(screen.getByRole('img', { name: /^RSI 9, 0 to 100/ })).toBeTruthy();
    expect(
      summary(/^RSI 9 50\.00 at .*; lowest 50\.00, highest 55\.00 over 6 candles\. 0 closed above 70/),
    ).toBeTruthy();
    expect(screen.getByRole('img', { name: /^MACD 12\/26\/9 with its signal line/ })).toBeTruthy();
    expect(summary(/MACD is above its signal line\./)).toBeTruthy();
    expect(screen.getByRole('img', { name: /^Volume per candle in BTC/ })).toBeTruthy();
    expect(summary(/No volume anomaly \(z ≥ 3\.5\) in this window\./)).toBeTruthy();

    // The latest 150 points and candles of the chosen timeframe.
    const request = find('GET', `/api/v1/indicators/${ID}`)[0]!;
    expect(request.url.searchParams.get('tf')).toBe('1m');
    expect(request.url.searchParams.get('limit')).toBe('150');
    expect(find('GET', `/api/v1/market/${ID}/candles`)[0]!.url.searchParams.get('tf')).toBe('1m');
    expect(screen.getByRole('link', { name: 'Technical Analysis' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('shows a dash and the reason for values that are still warming up', async () => {
    const early = point(LAST, {
      emaSlow: null,
      trend: null,
      trendStrength: null,
      volumeZ: null,
      volumeAnomaly: null,
      vwap: null,
      warmup: true,
    });
    api({
      [`GET /api/v1/indicators/${ID}`]: (r: ApiRequest) =>
        series(ID, r.url.searchParams.get('tf') === '1d' ? '1d' : '1m', [early], { run: run({ from: NOW }) }),
    });
    const { session, user } = await signedIn();
    const { router } = renderApp(`/analysis?instrument=${ID}&tf=1m`, session, user);
    let table = await valuesTable();
    expect(table.dataset['warmup']).toBe('true');
    expect(screen.getByText(/A warm-up candle: it closed before the run started\./)).toBeTruthy();
    const values = shownValues(table);
    expect(values['emaSlow']).toBeNull();
    expect(values['trend']).toBeNull();
    expect(values['volumeAnomaly']).toBeNull();
    expect(within(row(table, 'EMA 200')).getByText('warming up')).toBeTruthy();
    expect(within(row(table, 'Trend')).getByText('warming up')).toBeTruthy();
    expect(within(row(table, 'VWAP')).getByText('warming up')).toBeTruthy();

    // VWAP is never computed on the daily timeframe.
    await act(() => router.navigate({ to: '/analysis', search: { instrument: ID, tf: '1d' } }));
    await waitFor(() =>
      expect(screen.getByRole('table', { name: /latest closed candle/ }).dataset['tf']).toBe('1d'),
    );
    table = screen.getByRole('table', { name: /latest closed candle/ });
    expect(within(row(table, 'VWAP')).getByText('not computed on 1d')).toBeTruthy();
  });

  it('adds live points, follows the candle in progress and its close', async () => {
    api();
    const { session, server, user } = await signedIn();
    renderApp(`/analysis?instrument=${ID}&tf=1m`, session, user);
    const table = await valuesTable();
    await waitFor(() => expect(server.subscribed()).toEqual(expect.arrayContaining([INDICATORS, CANDLES])));

    server.push(
      CANDLES,
      'candle.update',
      candle(NOW, '74020', { o: '74000', h: '74025', l: '73999', v: '3.25' }),
    );
    expect(await findSummary(/Last price 74,020.00 USDT \(candle in progress\)/)).toBeTruthy();
    expect(summary(/The candle in progress has traded 3.25 BTC so far\./)).toBeTruthy();

    const next = point(NOW, { rsi: 61.5, volumeAnomaly: true, volumeZ: 4.2, trend: 'neutral' });
    server.push(
      CANDLES,
      'candle.closed',
      candle(NOW, '74021', { o: '74000', h: '74025', l: '73999', v: '3.5' }),
    );
    server.push(INDICATORS, 'indicators.closed', { instrumentId: ID, tf: '1m', runId: RUN_ID, point: next });
    await waitFor(() => expect(table.dataset['t']).toBe(String(NOW)));
    expect(shownValues(table)['rsi']).toBe(61.5);
    expect(within(row(table, 'Trend')).getByText('Neutral')).toBeTruthy();
    expect(within(row(table, 'Volume anomaly (z ≥ 3.5)')).getByText('Yes')).toBeTruthy();
    expect(await findSummary(/Last price 74,021.00 USDT; high/)).toBeTruthy();
    expect(summary(/1 volume anomaly in this window, the latest at/)).toBeTruthy();
    // A point for another instrument or timeframe never lands here.
    server.push(INDICATORS, 'indicators.closed', {
      instrumentId: ID,
      tf: '5m',
      runId: RUN_ID,
      point: point(NOW + MINUTE),
    });
    expect(table.dataset['t']).toBe(String(NOW));
  });

  it('reloads the series when a point from another run arrives (the profile changed)', async () => {
    let current = btcSeries();
    const { find } = api({
      [`GET /api/v1/indicators/${ID}`]: () => current,
      'GET /api/v1/system/health': health([]),
    });
    const { session, server, user } = await signedIn();
    renderApp(`/analysis?instrument=${ID}&tf=1m`, session, user);
    await valuesTable();
    await waitFor(() => expect(server.subscribed()).toContain(INDICATORS));
    expect(find('GET', `/api/v1/indicators/${ID}`)).toHaveLength(1);

    const replaced = point(NOW, { rsi: 40 });
    current = btcSeries([replaced], {
      run: run({
        id: OTHER_RUN,
        from: NOW,
        status: 'warming_up',
        profile: { name: 'crypto-majors', version: 2 },
      }),
    });
    server.push(INDICATORS, 'indicators.closed', {
      instrumentId: ID,
      tf: '1m',
      runId: OTHER_RUN,
      point: replaced,
    });
    expect(await screen.findByText('crypto-majors v2')).toBeTruthy();
    expect(find('GET', `/api/v1/indicators/${ID}`)).toHaveLength(2);
    expect((await valuesTable()).dataset['run']).toBe(OTHER_RUN);
    expect(screen.getAllByText('Warming up').length).toBeGreaterThan(0);
  });

  it('replaces the series with the resync snapshot when missed points cannot be replayed', async () => {
    api();
    const { session, server, user } = await signedIn();
    renderApp(`/analysis?instrument=${ID}&tf=1m`, session, user);
    const table = await valuesTable();
    await waitFor(() => expect(server.subscribed()).toContain(INDICATORS));

    const snapshot = btcSeries([point(NOW + 4 * MINUTE, { rsi: 33.25 })]);
    server.resyncSnapshots[INDICATORS] = { series: snapshot };
    const socket = server.sockets.last;
    act(() => socket.drop());
    expect(await screen.findByText('live connection down: refreshing every 5 s')).toBeTruthy();
    act(() => socket.open());
    await waitFor(() => expect(table.dataset['t']).toBe(String(NOW + 4 * MINUTE)));
    expect(shownValues(table)['rsi']).toBe(33.25);
    expect(screen.getByText('live updates')).toBeTruthy();
  });

  it('polls REST while the live connection is down', async () => {
    const { find } = api();
    const { session, server, user } = await signedIn();
    renderApp(`/analysis?instrument=${ID}&tf=1m`, session, user);
    await valuesTable();
    await waitFor(() => expect(server.subscribed()).toContain(INDICATORS));
    const before = find('GET', `/api/v1/indicators/${ID}`).length;
    act(() => server.sockets.last.drop());
    expect(await screen.findByText('live connection down: refreshing every 5 s')).toBeTruthy();
    await waitFor(() => expect(find('GET', `/api/v1/indicators/${ID}`).length).toBeGreaterThan(before), {
      timeout: 8_000,
    });
  }, 15_000);

  it('says when the instrument has never been analysed', async () => {
    api({
      [`GET /api/v1/indicators/${ID}`]: series(ID, '1m', [], { run: null, params: null }),
      [`GET /api/v1/indicators/${PAXG_BINANCE.id}`]: series(PAXG_BINANCE.id, '1m', [], {
        run: null,
        params: null,
      }),
      [`GET /api/v1/market/${PAXG_BINANCE.id}/candles`]: [],
      'GET /api/v1/system/health': health([]),
    });
    const { session, user } = await signedIn();
    const { router } = renderApp(`/analysis?instrument=${ID}&tf=1m`, session, user);
    expect(await screen.findByText('Not analysed yet')).toBeTruthy();
    expect(screen.getByText(/has not been analysed yet/)).toBeTruthy();
    expect(
      screen.getByText('No 1 minute candle has been analysed yet. Values appear here as candles close.'),
    ).toBeTruthy();
    // The candles are still charted, without indicator lines.
    expect(
      await screen.findByRole('img', { name: /candles with Fast EMA, Mid EMA, Slow EMA and VWAP/ }),
    ).toBeTruthy();

    await act(() => router.navigate({ to: '/analysis', search: { instrument: PAXG_BINANCE.id, tf: '1m' } }));
    expect(await screen.findByText(/has no instrument profile/)).toBeTruthy();
    expect(await screen.findByText('No 1 minute candle is stored for this instrument yet.')).toBeTruthy();
  });

  it('shows a paused run with the reason, the detail and the lag', async () => {
    api({
      'GET /api/v1/system/health': health([], {
        status: 'degraded',
        analysis: [
          analysisStatus(ID, {
            paused: true,
            pauseReason: 'data_gap',
            detail: '1m: missing 2026-11-10 12:01 (backfill running)',
            lagSec: 180,
          }),
        ],
      }),
    });
    const { session, user } = await signedIn();
    renderApp(`/analysis?instrument=${ID}&tf=1m`, session, user);
    expect(
      await screen.findByText(
        'Paused: data gap — 1m: missing 2026-11-10 12:01 (backfill running)',
        {},
        { timeout: 5_000 },
      ),
    ).toBeTruthy();
    expect(screen.getByText(/no candle is skipped\. Lag: 3 min\./)).toBeTruthy();
  });

  it('shows a run waiting for history as warming up', async () => {
    api({
      [`GET /api/v1/indicators/${ID}`]: btcSeries([], { run: run({ from: RUN_FROM, status: 'warming_up' }) }),
      'GET /api/v1/system/health': health([], {
        analysis: [
          analysisStatus(ID, {
            status: 'warming_up',
            paused: true,
            pauseReason: 'warming_up',
            detail: '1d: waiting for history',
            lagSec: null,
          }),
        ],
      }),
    });
    const { session, user } = await signedIn();
    renderApp(`/analysis?instrument=${ID}&tf=1m`, session, user);
    expect(await screen.findByText('Paused: waiting for history', {}, { timeout: 5_000 })).toBeTruthy();
    expect(screen.getByText(/1d: waiting for history\. The analyzer waits/)).toBeTruthy();
    expect(screen.getByText(/Lag: no candle analysed yet\./)).toBeTruthy();
    expect(screen.getByText('Warming up')).toBeTruthy();
  });

  it('says when the run has ended or no analyzer reports the instrument', async () => {
    api({
      [`GET /api/v1/indicators/${ID}`]: btcSeries(POINTS, {
        run: run({ from: RUN_FROM, status: 'superseded' }),
      }),
      'GET /api/v1/system/health': health([]),
    });
    const { session, user } = await signedIn();
    renderApp(`/analysis?instrument=${ID}&tf=1m`, session, user);
    expect(await screen.findByText('This run has ended')).toBeTruthy();
    expect(screen.getByText('Replaced by a newer run')).toBeTruthy();
    cleanup();

    api({ 'GET /api/v1/system/health': health([]) });
    const again = await signedIn();
    renderApp(`/analysis?instrument=${ID}&tf=1m`, again.session, again.user);
    expect(
      await screen.findByText(/No analyzer reports this instrument right now/, {}, { timeout: 5_000 }),
    ).toBeTruthy();
  });

  it('shows loading, then an error when the values cannot be loaded', async () => {
    let release = () => {};
    const answered = new Promise<void>((resolve) => (release = resolve));
    api({
      [`GET /api/v1/indicators/${ID}`]: async () => {
        await answered;
        return problem(500, 'The database is unreachable.');
      },
      [`GET /api/v1/market/${ID}/candles`]: problem(500, 'Candles are unavailable.'),
    });
    const { session, user } = await signedIn();
    renderApp(`/analysis?instrument=${ID}&tf=1m`, session, user);
    expect(await screen.findByText('Loading indicator values')).toBeTruthy();
    release();
    expect(await screen.findByText('Indicator values could not be loaded')).toBeTruthy();
    expect(screen.getByText('The database is unreachable.')).toBeTruthy();
  });

  it('says when the candles cannot be loaded, and keeps the indicator values', async () => {
    api({ [`GET /api/v1/market/${ID}/candles`]: problem(500, 'Candles are unavailable.') });
    const { session, user } = await signedIn();
    renderApp(`/analysis?instrument=${ID}&tf=1m`, session, user);
    expect(
      await screen.findByText(
        /Candles are unavailable\. The indicator lines are shown without the candles\./,
      ),
    ).toBeTruthy();
    expect((await valuesTable()).dataset['t']).toBe(String(LAST));
  });

  it('switches instrument and timeframe with the selectors, keeping the view linkable', async () => {
    const { find } = api({
      [`GET /api/v1/indicators/${ID}`]: (r: ApiRequest) =>
        r.url.searchParams.get('tf') === '5m' ? series(ID, '5m', [point(LAST - 4 * MINUTE)]) : btcSeries(),
    });
    const { session, user } = await signedIn();
    const { router } = renderApp('/analysis', session, user);
    // Without a link: the first instrument in Command Center order, on the default timeframe.
    expect(await screen.findByLabelText<HTMLSelectElement>('Instrument')).toBeTruthy();
    expect(screen.getByLabelText<HTMLSelectElement>('Instrument').value).toBe(ID);
    expect(screen.getByLabelText<HTMLSelectElement>('Timeframe').value).toBe('1h');

    const u = userEvent.setup();
    await u.selectOptions(screen.getByLabelText('Timeframe'), '5m');
    await waitFor(() => expect(router.state.location.search).toEqual({ instrument: ID, tf: '5m' }));
    await waitFor(() =>
      expect(screen.getByRole('table', { name: /latest closed candle/ }).dataset['tf']).toBe('5m'),
    );
    expect(find('GET', `/api/v1/indicators/${ID}`).some((r) => r.url.searchParams.get('tf') === '5m')).toBe(
      true,
    );

    await u.selectOptions(screen.getByLabelText('Instrument'), PAXG_BINANCE.id);
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ instrument: PAXG_BINANCE.id, tf: '5m' }),
    );
  });

  it('labels a replay instrument, and falls back when the link names an unknown instrument', async () => {
    mockApi({
      'GET /api/v1/instruments': [BTC_REPLAY],
      'GET /api/v1/system/health': health([]),
      [`GET /api/v1/indicators/${BTC_REPLAY.id}`]: series(BTC_REPLAY.id, '1h', []),
      [`GET /api/v1/market/${BTC_REPLAY.id}/candles`]: [],
    });
    const { session, user } = await signedIn();
    renderApp('/analysis?instrument=019a6f00-0000-7000-8000-00000000ffff&tf=2h', session, user);
    expect(await screen.findByText('That instrument is not available')).toBeTruthy();
    expect(screen.getByText('Replay instrument')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Replay');
    // An unknown timeframe falls back to the default.
    expect(screen.getByLabelText<HTMLSelectElement>('Timeframe').value).toBe('1h');
  });

  it('says when no instrument is enabled', async () => {
    mockApi({ 'GET /api/v1/instruments': [], 'GET /api/v1/system/health': health([]) });
    const { session, user } = await signedIn();
    renderApp('/analysis', session, user);
    expect(await screen.findByText('No instruments are enabled')).toBeTruthy();
  });
});
