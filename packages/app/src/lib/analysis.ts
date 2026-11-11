import {
  type AnalysisStatus,
  type Candle,
  type IndicatorParams,
  type IndicatorPoint,
  type IndicatorSeries,
  type IndicatorsClosedEvent,
  type Tf,
  TIMEFRAMES,
} from '@cip/contracts';
import { formatAge, safeTimeZone } from './format.js';

/**
 * Technical Analysis state (Phase 3): the run's indicator points and the candles they were computed
 * from, as REST returned them plus what the live channels delivered since. Points and candles merge
 * by open time, so a value that is both in a REST response and in a live message counts once.
 * Nothing is computed here: every number shown comes from the API.
 */

const MINUTE = 60_000;

/** Candle length per timeframe (as `TF_MS` in @cip/domain). */
export const TF_MS: Readonly<Record<Tf, number>> = {
  '1m': MINUTE,
  '5m': 5 * MINUTE,
  '15m': 15 * MINUTE,
  '1h': 60 * MINUTE,
  '4h': 240 * MINUTE,
  '1d': 1_440 * MINUTE,
};

export const TF_LABEL: Readonly<Record<Tf, string>> = {
  '1m': '1 minute',
  '5m': '5 minutes',
  '15m': '15 minutes',
  '1h': '1 hour',
  '4h': '4 hours',
  '1d': '1 day',
};

/** The timeframe shown when the link names none. */
export const DEFAULT_TF: Tf = '1h';

export function isTimeframe(value: unknown): value is Tf {
  return typeof value === 'string' && (TIMEFRAMES as readonly string[]).includes(value);
}

/** Candles the charts show, and how many candles and points the page loads over REST. */
export const CHART_CANDLES = 150;

// -----------------------------------------------------------------------------------------------
// Indicator values
// -----------------------------------------------------------------------------------------------

/** Every value an indicator point carries, in the order the values table lists them. */
export const INDICATOR_FIELDS = [
  'rsi',
  'macd',
  'macdSignal',
  'macdHist',
  'emaFast',
  'emaMid',
  'emaSlow',
  'vwap',
  'atr',
  'volumeZ',
  'volumeAnomaly',
  'trend',
  'trendStrength',
] as const satisfies readonly (keyof IndicatorPoint)[];
export type IndicatorField = (typeof INDICATOR_FIELDS)[number];

/** Indicator names with the run's own settings ("EMA 20"), never hard-coded periods. */
export function indicatorLabels(params: IndicatorParams | null): Record<IndicatorField, string> {
  return {
    rsi: params ? `RSI ${params.rsi.period}` : 'RSI',
    macd: params ? `MACD ${params.macd.fast}/${params.macd.slow}/${params.macd.signal}` : 'MACD',
    macdSignal: params ? `MACD signal ${params.macd.signal}` : 'MACD signal',
    macdHist: 'MACD histogram',
    emaFast: params ? `EMA ${params.ema.fast}` : 'Fast EMA',
    emaMid: params ? `EMA ${params.ema.mid}` : 'Mid EMA',
    emaSlow: params ? `EMA ${params.ema.slow}` : 'Slow EMA',
    vwap: 'VWAP',
    atr: params ? `ATR ${params.atr.period}` : 'ATR',
    volumeZ: params ? `Volume z-score (${params.volume.lookback} candles)` : 'Volume z-score',
    volumeAnomaly: params ? `Volume anomaly (z ≥ ${params.volume.zThreshold})` : 'Volume anomaly',
    trend: 'Trend',
    trendStrength: 'Trend strength',
  };
}

/** A value exactly as the API sent it, for `data-value`: a JSON number, string, boolean or `null`. */
export function dataValue(value: number | boolean | string | null): string {
  return JSON.stringify(value);
}

const numberFormats = new Map<number, Intl.NumberFormat>();

function numberFormat(dp: number): Intl.NumberFormat {
  let format = numberFormats.get(dp);
  if (!format) {
    format = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: dp,
      maximumFractionDigits: dp,
      signDisplay: 'negative',
    });
    numberFormats.set(dp, format);
  }
  return format;
}

/**
 * A derived number for reading: `dp` decimals with thousands separators, and more decimals for a
 * value below 1 so it keeps three significant digits (an ATR of 0.0000123 is not shown as 0.00).
 * The exact number is always available next to it (`data-value`, tooltips).
 */
export function formatIndicator(value: number, dp: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const digits = abs > 0 && abs < 1 ? Math.max(dp, Math.min(12, 2 - Math.floor(Math.log10(abs)))) : dp;
  return numberFormat(digits).format(value);
}

/** A number with exactly `dp` decimals and thousands separators (axis labels). */
export function formatFixed(value: number, dp: number): string {
  return numberFormat(dp).format(value);
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/** "12.5", "1.2K", "3.4M": a volume axis label (`dp` decimals below 10,000). */
export function formatCompact(value: number, dp: number): string {
  return Math.abs(value) < 10_000 ? formatFixed(value, dp) : compact.format(value);
}

/** Decimals for prices and price distances: the instrument's tick, at least 2. */
export function priceDecimals(tickDecimals: number): number {
  return Math.max(2, tickDecimals);
}

// -----------------------------------------------------------------------------------------------
// Live indicator points
// -----------------------------------------------------------------------------------------------

const LIVE_POINTS_KEPT = 1_000;

export interface LivePoints {
  /** The run the live points belong to. */
  readonly runId: string | null;
  readonly points: ReadonlyMap<number, IndicatorPoint>;
}

export const NO_LIVE_POINTS: LivePoints = { runId: null, points: new Map() };

export type LivePointsAction =
  | { type: 'closed'; event: IndicatorsClosedEvent }
  /** A resync snapshot replaced the series: what was received before is in it. */
  | { type: 'reset' };

export function livePointsReducer(state: LivePoints, action: LivePointsAction): LivePoints {
  if (action.type === 'reset') return state === NO_LIVE_POINTS ? state : NO_LIVE_POINTS;
  const { runId, point } = action.event;
  // A point of another run starts over: the run was replaced, and earlier points belong to the old one.
  const points = new Map(runId === state.runId ? state.points : []);
  points.set(point.t, point);
  if (points.size > LIVE_POINTS_KEPT) {
    const oldest = points.keys().next();
    if (!oldest.done) points.delete(oldest.value);
  }
  return { runId, points };
}

/** The loaded series with the live points of the same run merged in by open time, oldest first. */
export function mergeSeries(base: IndicatorSeries, live: LivePoints): IndicatorSeries {
  if (base.run === null || live.runId !== base.run.id || live.points.size === 0) return base;
  const byT = new Map(base.points.map((p) => [p.t, p]));
  for (const [t, p] of live.points) byT.set(t, p);
  return { ...base, points: [...byT.values()].sort((a, b) => a.t - b.t) };
}

/** An `indicators.closed` message's data, if it has the expected shape. */
export function closedEvent(data: unknown): IndicatorsClosedEvent | null {
  if (typeof data !== 'object' || data === null) return null;
  const e = data as Partial<IndicatorsClosedEvent>;
  if (typeof e.runId !== 'string' || typeof e.instrumentId !== 'string' || !isTimeframe(e.tf)) return null;
  if (typeof e.point !== 'object' || e.point === null || typeof e.point.t !== 'number') return null;
  return e as IndicatorsClosedEvent;
}

/** The series in an `indicators:` resync snapshot (`{ series }`), if it has the expected shape. */
export function snapshotSeries(snapshot: unknown): IndicatorSeries | null {
  if (typeof snapshot !== 'object' || snapshot === null) return null;
  const series = (snapshot as { series?: Partial<IndicatorSeries> }).series;
  if (typeof series !== 'object' || series === null || !Array.isArray(series.points)) return null;
  if (typeof series.instrumentId !== 'string' || !isTimeframe(series.tf)) return null;
  return series as IndicatorSeries;
}

// -----------------------------------------------------------------------------------------------
// Candles
// -----------------------------------------------------------------------------------------------

const LIVE_CANDLES_KEPT = CHART_CANDLES + 10;

export interface LiveCandle {
  readonly candle: Candle;
  /** From `candle.closed`; an update (the candle in progress) is not. */
  readonly closed: boolean;
}

export type LiveCandles = ReadonlyMap<number, LiveCandle>;

export const NO_LIVE_CANDLES: LiveCandles = new Map();

export type LiveCandlesAction = { type: 'update' | 'closed'; candle: Candle };

export function liveCandlesReducer(state: LiveCandles, action: LiveCandlesAction): LiveCandles {
  const { candle } = action;
  const closed = action.type === 'closed';
  // A closed candle is final: a late update never reopens it.
  if (!closed && state.get(candle.t)?.closed) return state;
  const next = new Map(state).set(candle.t, { candle, closed });
  while (next.size > LIVE_CANDLES_KEPT) {
    const oldest = Math.min(...next.keys());
    next.delete(oldest);
  }
  return next;
}

/** A candle in its wire form (`candle.update`, `candle.closed`, the subscribe snapshot), or null. */
export function wireCandle(data: unknown): Candle | null {
  if (typeof data !== 'object' || data === null) return null;
  const c = data as Partial<Candle>;
  if (typeof c.t !== 'number') return null;
  for (const v of [c.o, c.h, c.l, c.c, c.v]) if (typeof v !== 'string') return null;
  return c as Candle;
}

export interface ChartCandle extends Candle {
  /** Known only from `candle.update`: the candle has not closed (yet). */
  readonly inProgress: boolean;
}

/**
 * Stored candles and what the candles channel delivered, oldest first. Stored candles are final
 * (a stored candle never changes), so they win over a live copy of the same candle.
 */
export function mergeCandles(stored: readonly Candle[], live: LiveCandles): ChartCandle[] {
  const byT = new Map<number, ChartCandle>();
  for (const { candle, closed } of live.values()) byT.set(candle.t, { ...candle, inProgress: !closed });
  for (const c of stored) byT.set(c.t, { ...c, inProgress: false });
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

// -----------------------------------------------------------------------------------------------
// Chart geometry
// -----------------------------------------------------------------------------------------------

/** The time span the charts show: `slots` candles ending with the newest candle or point. */
export interface ChartWindow {
  readonly from: number;
  /** Exclusive: the close of the newest candle. */
  readonly to: number;
  readonly tfMs: number;
  readonly slots: number;
}

export function chartWindow(
  candles: readonly { t: number }[],
  points: readonly { t: number }[],
  tf: Tf,
  slots = CHART_CANDLES,
): ChartWindow | null {
  const last = Math.max(candles.at(-1)?.t ?? -Infinity, points.at(-1)?.t ?? -Infinity);
  if (last === -Infinity) return null;
  const tfMs = TF_MS[tf];
  const to = last + tfMs;
  return { from: to - slots * tfMs, to, tfMs, slots };
}

export function inWindow<T extends { t: number }>(items: readonly T[], w: ChartWindow): T[] {
  return items.filter((i) => i.t >= w.from && i.t < w.to);
}

export interface TimedValue {
  readonly t: number;
  readonly v: number;
}

/**
 * Runs of consecutive candles that all have a value. A line is drawn within a run only, so it never
 * crosses a missing candle or a value that is still warming up.
 */
export function segments<T extends { t: number }>(
  items: readonly T[],
  value: (item: T) => number | null,
  tfMs: number,
): TimedValue[][] {
  const out: TimedValue[][] = [];
  let current: TimedValue[] = [];
  let previous: number | null = null;
  for (const item of items) {
    const v = value(item);
    const usable = v !== null && Number.isFinite(v);
    if (current.length > 0 && (!usable || (previous !== null && item.t - previous !== tfMs))) {
      out.push(current);
      current = [];
    }
    if (usable) current.push({ t: item.t, v });
    previous = item.t;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** The smallest and largest finite values, or null when there are none. */
export function extent(values: Iterable<number | null>): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v === null || !Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo === Infinity ? null : [lo, hi];
}

/**
 * Evenly spaced round values inside [lo, hi], 1, 2 or 5 × a power of ten apart: the finest such
 * spacing that gives at most `count` + 1 of them.
 */
export function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (!(hi > lo)) return Number.isFinite(lo) ? [lo] : [];
  const power = 10 ** Math.floor(Math.log10((hi - lo) / count));
  for (const step of [1, 2, 5, 10, 20].map((m) => m * power)) {
    const first = Math.ceil(lo / step) * step;
    const n = Math.floor((hi - first) / step + 1e-9) + 1;
    if (n <= count + 1)
      return Array.from({ length: n }, (_, i) => Number((first + i * step).toPrecision(12)));
  }
  return [lo, hi];
}

/** Decimals a tick label needs at a given tick spacing. */
export function tickDecimals(ticks: readonly number[]): number {
  if (ticks.length < 2) return 2;
  const step = Math.abs(ticks[1]! - ticks[0]!);
  return Math.max(0, Math.min(12, -Math.floor(Math.log10(step))));
}

const timeFormats = new Map<string, Intl.DateTimeFormat>();

/** A candle's open time for chart labels: "10 Nov, 14:05", or "10 Nov 2026" on the daily chart. */
export function formatCandleTime(ms: number, tf: Tf, timeZone = 'UTC'): string {
  const zone = safeTimeZone(timeZone);
  const key = `${tf === '1d' ? 'day' : 'time'}:${zone}`;
  let format = timeFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(
      'en-GB',
      tf === '1d'
        ? { timeZone: zone, day: '2-digit', month: 'short', year: 'numeric' }
        : {
            timeZone: zone,
            day: '2-digit',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
          },
    );
    timeFormats.set(key, format);
  }
  return format.format(ms);
}

// -----------------------------------------------------------------------------------------------
// Analysis status
// -----------------------------------------------------------------------------------------------

/** Analysis lag (newest stored candle minus newest analysed one, worst timeframe), in words. */
export function formatLag(lagSec: number | null): string {
  return lagSec === null ? 'no candle analysed yet' : formatAge(lagSec * 1_000);
}

/** Why analysis of an instrument is held back, as a heading ("Paused: data gap — 1m: missing …"). */
export function pauseTitle(status: AnalysisStatus): string | null {
  if (!status.paused) return null;
  if (status.pauseReason === 'warming_up') return 'Paused: waiting for history';
  if (status.pauseReason === 'data_gap')
    return status.detail ? `Paused: data gap — ${status.detail}` : 'Paused: data gap';
  return status.detail ? `Paused — ${status.detail}` : 'Paused';
}
