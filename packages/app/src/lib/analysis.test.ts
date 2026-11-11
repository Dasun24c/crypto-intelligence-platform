import { describe, expect, it } from 'vitest';
import type { IndicatorsClosedEvent } from '@cip/contracts';
import { BTC_BINANCE, candle, DEFAULT_PARAMS, point, RUN_ID, series } from '../test/fixtures.js';
import {
  chartWindow,
  closedEvent,
  dataValue,
  extent,
  formatCandleTime,
  formatCompact,
  formatFixed,
  formatIndicator,
  formatLag,
  indicatorLabels,
  inWindow,
  isTimeframe,
  liveCandlesReducer,
  livePointsReducer,
  mergeCandles,
  mergeSeries,
  niceTicks,
  NO_LIVE_CANDLES,
  NO_LIVE_POINTS,
  pauseTitle,
  priceDecimals,
  segments,
  snapshotSeries,
  tickDecimals,
  wireCandle,
} from './analysis.js';

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 10, 10, 12, 0);
const OTHER_RUN = '019a7300-0000-7000-8000-000000000002';

const closed = (t: number, runId = RUN_ID, extra = {}): IndicatorsClosedEvent => ({
  instrumentId: BTC_BINANCE.id,
  tf: '1m',
  runId,
  point: point(t, extra),
});

describe('indicator labels and values', () => {
  it('names indicators with the run settings, never hard-coded periods', () => {
    const labels = indicatorLabels({ ...DEFAULT_PARAMS, ema: { fast: 21, mid: 55, slow: 233 } });
    expect(labels.emaFast).toBe('EMA 21');
    expect(labels.emaMid).toBe('EMA 55');
    expect(labels.emaSlow).toBe('EMA 233');
    expect(labels.rsi).toBe('RSI 14');
    expect(labels.macd).toBe('MACD 12/26/9');
    expect(labels.macdSignal).toBe('MACD signal 9');
    expect(labels.atr).toBe('ATR 14');
    expect(labels.volumeZ).toBe('Volume z-score (50 candles)');
    expect(labels.volumeAnomaly).toBe('Volume anomaly (z ≥ 3.5)');
    expect(indicatorLabels(null).emaFast).toBe('Fast EMA');
    expect(indicatorLabels(null).rsi).toBe('RSI');
  });

  it('keeps the exact value as JSON for data-value', () => {
    for (const v of [55.123456789, 2 / 3, 0.1 + 0.2, -73_500.25, 1e-7, 0]) {
      expect(dataValue(v)).toBe(JSON.stringify(v));
      expect(JSON.parse(dataValue(v))).toBe(v);
    }
    expect(dataValue(null)).toBe('null');
    expect(dataValue(true)).toBe('true');
    expect(dataValue('bullish')).toBe('"bullish"');
  });

  it('formats a number for reading, keeping three significant digits below 1', () => {
    expect(formatIndicator(74_010.12345678, 2)).toBe('74,010.12');
    expect(formatIndicator(55.123456789, 2)).toBe('55.12');
    expect(formatIndicator(0.0000123, 5)).toBe('0.0000123');
    expect(formatIndicator(-0.5, 2)).toBe('-0.500');
    expect(formatIndicator(0, 2)).toBe('0.00');
    expect(formatIndicator(-0.000001, 2)).toBe('-0.00000100');
    expect(formatIndicator(Number.NaN, 2)).toBe('—');
    expect(formatFixed(-0.001, 2)).toBe('0.00');
    expect(formatCompact(12.5, 1)).toBe('12.5');
    expect(formatCompact(1_234_567, 0)).toBe('1.2M');
    expect(priceDecimals(0)).toBe(2);
    expect(priceDecimals(5)).toBe(5);
  });

  it('accepts only the six timeframes', () => {
    expect(isTimeframe('4h')).toBe(true);
    expect(isTimeframe('2h')).toBe(false);
    expect(isTimeframe(undefined)).toBe(false);
  });
});

describe('live indicator points', () => {
  it('adds points by open time and replaces a point received twice', () => {
    let state = livePointsReducer(NO_LIVE_POINTS, { type: 'closed', event: closed(T0) });
    state = livePointsReducer(state, { type: 'closed', event: closed(T0 + MINUTE) });
    state = livePointsReducer(state, { type: 'closed', event: closed(T0 + MINUTE, RUN_ID, { rsi: 61 }) });
    expect(state.runId).toBe(RUN_ID);
    expect([...state.points.keys()]).toEqual([T0, T0 + MINUTE]);
    expect(state.points.get(T0 + MINUTE)?.rsi).toBe(61);
  });

  it('starts over when a point of another run arrives, and on a resync', () => {
    let state = livePointsReducer(NO_LIVE_POINTS, { type: 'closed', event: closed(T0) });
    state = livePointsReducer(state, { type: 'closed', event: closed(T0 + MINUTE, OTHER_RUN) });
    expect(state.runId).toBe(OTHER_RUN);
    expect([...state.points.keys()]).toEqual([T0 + MINUTE]);
    expect(livePointsReducer(state, { type: 'reset' })).toBe(NO_LIVE_POINTS);
    expect(livePointsReducer(NO_LIVE_POINTS, { type: 'reset' })).toBe(NO_LIVE_POINTS);
  });

  it('keeps at most 1,000 points', () => {
    let state = NO_LIVE_POINTS;
    for (let i = 0; i < 1_005; i++)
      state = livePointsReducer(state, { type: 'closed', event: closed(T0 + i * MINUTE) });
    expect(state.points.size).toBe(1_000);
    expect(state.points.has(T0)).toBe(false);
    expect(state.points.has(T0 + 1_004 * MINUTE)).toBe(true);
  });

  it('merges live points of the loaded run into the series, in time order', () => {
    const base = series(BTC_BINANCE.id, '1m', [point(T0), point(T0 + MINUTE, { warmup: true })]);
    let live = livePointsReducer(NO_LIVE_POINTS, { type: 'closed', event: closed(T0 + 2 * MINUTE) });
    live = livePointsReducer(live, { type: 'closed', event: closed(T0 + MINUTE) });
    const merged = mergeSeries(base, live);
    expect(merged.points.map((p) => p.t)).toEqual([T0, T0 + MINUTE, T0 + 2 * MINUTE]);
    expect(merged.points[1]!.warmup).toBe(false);
    // Points of another run, or a series without a run, are left alone.
    const other = livePointsReducer(NO_LIVE_POINTS, {
      type: 'closed',
      event: closed(T0 + 3 * MINUTE, OTHER_RUN),
    });
    expect(mergeSeries(base, other)).toBe(base);
    const never = series(BTC_BINANCE.id, '1m', [], { run: null, params: null });
    expect(mergeSeries(never, live)).toBe(never);
    expect(mergeSeries(base, NO_LIVE_POINTS)).toBe(base);
  });

  it('reads indicators.closed messages and resync snapshots defensively', () => {
    expect(closedEvent(closed(T0))?.point.t).toBe(T0);
    expect(closedEvent(null)).toBeNull();
    expect(closedEvent({ ...closed(T0), tf: '2h' })).toBeNull();
    expect(closedEvent({ ...closed(T0), point: null })).toBeNull();
    expect(closedEvent({ ...closed(T0), runId: 7 })).toBeNull();
    const s = series(BTC_BINANCE.id, '1m', [point(T0)]);
    expect(snapshotSeries({ series: s })).toBe(s);
    expect(snapshotSeries({ largeTrades: [] })).toBeNull();
    expect(snapshotSeries(null)).toBeNull();
    expect(snapshotSeries({ series: { ...s, points: 'none' } })).toBeNull();
    expect(snapshotSeries({ series: { ...s, tf: 'x' } })).toBeNull();
  });
});

describe('candles', () => {
  it('follows the candle in progress and keeps a closed candle final', () => {
    let state = liveCandlesReducer(NO_LIVE_CANDLES, { type: 'update', candle: candle(T0, '100') });
    state = liveCandlesReducer(state, { type: 'update', candle: candle(T0, '101') });
    expect(state.get(T0)).toEqual({ candle: candle(T0, '101'), closed: false });
    state = liveCandlesReducer(state, { type: 'closed', candle: candle(T0, '102') });
    const final = state;
    // A late update never reopens a closed candle.
    expect(liveCandlesReducer(final, { type: 'update', candle: candle(T0, '99') })).toBe(final);
    expect(final.get(T0)?.closed).toBe(true);
  });

  it('keeps the newest candles only', () => {
    let state = NO_LIVE_CANDLES;
    for (let i = 0; i < 200; i++)
      state = liveCandlesReducer(state, { type: 'closed', candle: candle(T0 + i * MINUTE, '100') });
    expect(state.size).toBe(160);
    expect(Math.min(...state.keys())).toBe(T0 + 40 * MINUTE);
  });

  it('merges stored and live candles; stored ones are final', () => {
    let live = liveCandlesReducer(NO_LIVE_CANDLES, { type: 'update', candle: candle(T0 + MINUTE, '105') });
    live = liveCandlesReducer(live, { type: 'update', candle: candle(T0 + 2 * MINUTE, '106') });
    const merged = mergeCandles([candle(T0, '100'), candle(T0 + MINUTE, '104')], live);
    expect(merged.map((c) => [c.t, c.c, c.inProgress])).toEqual([
      [T0, '100', false],
      [T0 + MINUTE, '104', false],
      [T0 + 2 * MINUTE, '106', true],
    ]);
  });

  it('reads wire candles defensively', () => {
    expect(wireCandle(candle(T0, '1'))?.t).toBe(T0);
    expect(wireCandle(null)).toBeNull();
    expect(wireCandle({ t: 'x' })).toBeNull();
    expect(wireCandle({ ...candle(T0, '1'), c: 1 })).toBeNull();
  });
});

describe('chart geometry', () => {
  it('ends the window with the newest candle or point', () => {
    const w = chartWindow([{ t: T0 }], [{ t: T0 + MINUTE }], '1m', 10)!;
    expect(w).toEqual({ from: T0 + 2 * MINUTE - 10 * MINUTE, to: T0 + 2 * MINUTE, tfMs: MINUTE, slots: 10 });
    expect(chartWindow([], [], '1h')).toBeNull();
    expect(inWindow([{ t: w.from - MINUTE }, { t: w.from }, { t: w.to }], w)).toEqual([{ t: w.from }]);
  });

  it('never joins values across a missing candle or a null', () => {
    const items = [
      { t: 0, v: 1 },
      { t: 1, v: 2 },
      { t: 2, v: null },
      { t: 3, v: 4 },
      { t: 4, v: 5 },
      { t: 6, v: 7 }, // t = 5 is missing
      { t: 7, v: Number.NaN },
    ];
    expect(segments(items, (i) => i.v, 1)).toEqual([
      [
        { t: 0, v: 1 },
        { t: 1, v: 2 },
      ],
      [
        { t: 3, v: 4 },
        { t: 4, v: 5 },
      ],
      [{ t: 6, v: 7 }],
    ]);
    expect(segments([], () => 1, 1)).toEqual([]);
  });

  it('finds the value range and round tick values', () => {
    expect(extent([3, null, -1, Number.POSITIVE_INFINITY, 2])).toEqual([-1, 3]);
    expect(extent([null])).toBeNull();
    expect(niceTicks(0, 100, 4)).toEqual([0, 50, 100]);
    expect(niceTicks(73_412, 74_133, 4)).toEqual([73_600, 73_800, 74_000]);
    expect(niceTicks(0.99981, 0.99993, 4)).toEqual([0.99985, 0.9999]);
    // The finest round spacing that fits, not the first one at least a quarter of the span.
    expect(niceTicks(-21, 45, 3)).toEqual([-20, 0, 20, 40]);
    expect(niceTicks(0, 220, 2)).toEqual([0, 100, 200]);
    expect(niceTicks(5, 5)).toEqual([5]);
    expect(niceTicks(Number.NaN, 1)).toEqual([]);
    expect(tickDecimals([73_500, 73_600])).toBe(0);
    expect(tickDecimals([0.99985, 0.9999])).toBe(5);
    expect(tickDecimals([1])).toBe(2);
  });

  it('labels candle times for the axis in the display time zone', () => {
    expect(formatCandleTime(T0 + 5 * MINUTE, '1m', 'UTC')).toBe('10 Nov, 12:05');
    expect(formatCandleTime(T0, '1d', 'UTC')).toBe('10 Nov 2026');
    expect(formatCandleTime(T0, '1h', 'Asia/Colombo')).toBe('10 Nov, 17:30');
    expect(formatCandleTime(T0, '1h', 'Not/AZone')).toBe('10 Nov, 12:00');
  });
});

describe('analysis status', () => {
  const status = {
    instrumentId: BTC_BINANCE.id,
    runId: RUN_ID,
    status: 'running' as const,
    lagSec: 12,
    paused: true,
    detail: '1m: missing 2026-11-10 12:01 (backfill running)',
    updatedAt: T0,
  };

  it('words a pause by its reason', () => {
    expect(pauseTitle({ ...status, pauseReason: 'data_gap' })).toBe(
      'Paused: data gap — 1m: missing 2026-11-10 12:01 (backfill running)',
    );
    expect(pauseTitle({ ...status, pauseReason: 'data_gap', detail: '' })).toBe('Paused: data gap');
    expect(pauseTitle({ ...status, pauseReason: 'warming_up', detail: '1d: waiting for history' })).toBe(
      'Paused: waiting for history',
    );
    expect(pauseTitle({ ...status, detail: 'profile gold v2 has invalid indicator settings' })).toBe(
      'Paused — profile gold v2 has invalid indicator settings',
    );
    expect(pauseTitle({ ...status, detail: '' })).toBe('Paused');
    expect(pauseTitle({ ...status, paused: false })).toBeNull();
  });

  it('words the lag', () => {
    expect(formatLag(null)).toBe('no candle analysed yet');
    expect(formatLag(0)).toBe('0 s');
    expect(formatLag(12.4)).toBe('12 s');
    expect(formatLag(180)).toBe('3 min');
  });
});
