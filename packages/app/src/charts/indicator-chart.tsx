import {
  CandlestickSeries,
  createSeriesMarkers,
  HistogramSeries,
  type IChartApi,
  type IPrimitivePaneRenderer,
  type IPrimitivePaneView,
  type ISeriesPrimitive,
  LineSeries,
  LineStyle,
  type Logical,
  type SeriesAttachedParameter,
  type Time,
} from 'lightweight-charts';
import { useEffect, useId, useRef } from 'react';
import type { IndicatorPoint, Tf } from '@cip/contracts';
import { TF_MS } from '@cip/domain';
import { type ChartCandle, type IndicatorField, priceDecimals } from '../lib/analysis.js';
import { stepDecimals } from '../lib/decimal.js';
import { ChartAttribution } from './attribution.js';
import { indicatorSummaries } from './indicator-summary.js';
import { TimeIndex } from './overlay-primitive.js';
import { alpha, chartColors } from './theme.js';
import { chartRemoved, toChartTime, useChart } from './use-chart.js';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];

/** Shades the candles computed before the run started (its warm-up), like the Phase 3 charts did. */
class WarmupBand implements ISeriesPrimitive<Time> {
  private param: SeriesAttachedParameter<Time> | null = null;
  private until: number | null = null;
  private index = new TimeIndex([], 60_000);
  private readonly view: IPrimitivePaneView = {
    zOrder: () => 'bottom',
    renderer: () => ({ draw: (target: Target) => this.draw(target) }),
  };

  attached(param: SeriesAttachedParameter<Time>): void {
    this.param = param;
  }

  detached(): void {
    this.param = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view];
  }

  set(until: number | null, index: TimeIndex): void {
    this.until = until;
    this.index = index;
    this.param?.requestUpdate();
  }

  private draw(target: Target): void {
    const p = this.param;
    if (!p || this.until === null || this.index.length === 0) return;
    const ts = p.chart.timeScale();
    const x2 = ts.logicalToCoordinate((this.index.logical(this.until) - 0.5) as Logical);
    if (x2 === null || x2 <= 0) return;
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      context.fillStyle = alpha(chartColors().subtle, 0.12);
      context.fillRect(0, 0, Math.min(x2, mediaSize.width), mediaSize.height);
    });
  }
}

export interface IndicatorChartProps {
  /** Accessible name. */
  title: string;
  candles: readonly ChartCandle[];
  points: readonly IndicatorPoint[];
  labels: Readonly<Record<IndicatorField, string>>;
  /** The run's start: candles before it are its warm-up. */
  runFrom: number | null;
  tf: Tf;
  priceTick: string;
  quote: string;
  base: string;
  timeZone: string;
}

const PANE_HEIGHTS = [260, 90, 110, 120];

type Line = { time: Time; value: number };
function line(points: readonly IndicatorPoint[], field: keyof IndicatorPoint): Line[] {
  const out: Line[] = [];
  for (const p of points) {
    const v = p[field];
    if (typeof v === 'number') out.push({ time: toChartTime(p.t), value: v });
  }
  return out;
}

/**
 * The Technical Analysis chart (Phase 7, on Lightweight Charts): candles with the EMAs and VWAP,
 * then volume with its anomalies, RSI with 30/70 and MACD, on one time axis. Values come only from
 * the analyzer (GET /indicators and its channel); nothing is computed here. `data-series` holds
 * how many points each series drew.
 */
export function IndicatorChart(props: IndicatorChartProps) {
  const { title, candles, points, labels, runFrom, tf, priceTick, quote, base, timeZone } = props;
  const { ref, chart, annotate } = useChart(timeZone);
  const summaryId = useId();
  const series = useRef<ReturnType<typeof createSeries> | null>(null);

  useEffect(() => {
    if (!chart) return;
    const created = createSeries(chart, priceTick, labels);
    series.current = created;
    return () => {
      series.current = null;
      // Unmounting removed the chart, and its series with it, before this cleanup runs.
      if (chartRemoved(chart)) return;
      created.markers.detach();
      created.candles.detachPrimitive(created.warmup);
      for (const s of created.all) chart.removeSeries(s);
    };
  }, [chart, priceTick, labels]);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    const c = chartColors();
    s.candles.setData(
      candles.map((k) => ({
        time: toChartTime(k.t),
        open: Number(k.o),
        high: Number(k.h),
        low: Number(k.l),
        close: Number(k.c),
        ...(k.inProgress ? { color: alpha(c.muted, 0.6), wickColor: alpha(c.muted, 0.6) } : {}),
      })),
    );
    s.volume.setData(
      candles.map((k) => ({
        time: toChartTime(k.t),
        value: Number(k.v),
        color: alpha(Number(k.c) >= Number(k.o) ? c.bull : c.bear, k.inProgress ? 0.3 : 0.6),
      })),
    );
    const counts: Record<string, number> = { candles: candles.length, volume: candles.length };
    for (const [name, field] of [
      ['emaFast', 'emaFast'],
      ['emaMid', 'emaMid'],
      ['emaSlow', 'emaSlow'],
      ['vwap', 'vwap'],
      ['rsi', 'rsi'],
      ['macd', 'macd'],
      ['macdSignal', 'macdSignal'],
    ] as const) {
      const data = line(points, field);
      s.lines[name].setData(data);
      counts[name] = data.length;
    }
    const hist = points
      .filter((p) => typeof p.macdHist === 'number')
      .map((p) => ({
        time: toChartTime(p.t),
        value: p.macdHist!,
        color: alpha(p.macdHist! >= 0 ? c.bull : c.bear, 0.6),
      }));
    s.macdHist.setData(hist);
    counts['macdHist'] = hist.length;
    const anomalies = points.filter((p) => p.volumeAnomaly === true);
    s.markers.setMarkers(
      anomalies.map((p) => ({
        time: toChartTime(p.t),
        position: 'aboveBar' as const,
        shape: 'circle' as const,
        color: c.warn,
        size: 0.6,
      })),
    );
    counts['anomalies'] = anomalies.length;
    s.warmup.set(
      runFrom,
      new TimeIndex(
        candles.map((k) => k.t),
        TF_MS[tf],
      ),
    );
    annotate('series', JSON.stringify(counts));
  }, [chart, priceTick, labels, candles, points, runFrom, tf, annotate]);

  const hasData = candles.length > 0 || points.length > 0;
  useEffect(() => {
    if (chart && hasData) chart.timeScale().fitContent();
  }, [chart, hasData, tf]);

  const text = indicatorSummaries({
    candles,
    points,
    labels,
    runFrom,
    tf,
    dp: priceDecimals(stepDecimals(priceTick)),
    quote,
    base,
    timeZone,
  });
  return (
    <figure className="space-y-2">
      <div
        ref={ref}
        role="img"
        aria-label={title}
        aria-describedby={summaryId}
        className="h-[600px] w-full overflow-hidden rounded-md border border-border"
        data-chart="indicators"
      />
      <figcaption id={summaryId} className="space-y-1 text-xs text-fg-muted">
        <p>{text.price}</p>
        <p>{text.volume}</p>
        <p>{text.rsi}</p>
        <p>{text.macd}</p>
        <p>
          Panes, top to bottom: price with {labels.emaFast}, {labels.emaMid}, {labels.emaSlow} and{' '}
          {labels.vwap}; volume with {labels.volumeAnomaly.toLowerCase()} marked; {labels.rsi} with guides at
          30 and 70; {labels.macd} with its signal line and histogram. Shaded: the run&apos;s warm-up.
        </p>
      </figcaption>
      <ChartAttribution />
    </figure>
  );
}

function createSeries(chart: IChartApi, priceTick: string, labels: Readonly<Record<IndicatorField, string>>) {
  const c = chartColors();
  const price = { type: 'price' as const, precision: stepDecimals(priceTick), minMove: Number(priceTick) };
  const lineOpts = (color: string, title: string, pane: number, extra: object = {}) =>
    chart.addSeries(
      LineSeries,
      {
        color,
        lineWidth: 1,
        title,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        ...extra,
      },
      pane,
    );
  const candles = chart.addSeries(CandlestickSeries, {
    upColor: c.bull,
    downColor: c.bear,
    wickUpColor: c.bull,
    wickDownColor: c.bear,
    borderVisible: false,
    priceLineVisible: false,
    priceFormat: price,
  });
  const warmup = new WarmupBand();
  candles.attachPrimitive(warmup);
  const lines = {
    emaFast: lineOpts(c.accent, labels.emaFast, 0, { priceFormat: price }),
    emaMid: lineOpts(c.ok, labels.emaMid, 0, { priceFormat: price }),
    emaSlow: lineOpts(c.info, labels.emaSlow, 0, { priceFormat: price, lineStyle: LineStyle.Dashed }),
    vwap: lineOpts(c.fg, labels.vwap, 0, { priceFormat: price, lineStyle: LineStyle.Dotted }),
    rsi: lineOpts(c.accent, labels.rsi, 2),
    macd: lineOpts(c.accent, labels.macd, 3),
    macdSignal: lineOpts(c.warn, labels.macdSignal, 3),
  };
  const volume = chart.addSeries(
    HistogramSeries,
    { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false },
    1,
  );
  const macdHist = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, 3);
  for (const level of [30, 70])
    lines.rsi.createPriceLine({
      price: level,
      color: alpha(c.muted, 0.6),
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: '',
    });
  const markers = createSeriesMarkers(volume, []);
  const panes = chart.panes();
  panes.forEach((p, i) => p.setHeight(PANE_HEIGHTS[i] ?? 100));
  return {
    candles,
    warmup,
    lines,
    volume,
    macdHist,
    markers,
    all: [candles, volume, macdHist, ...Object.values(lines)],
  };
}
