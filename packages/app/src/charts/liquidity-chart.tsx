import { CandlestickSeries, type ISeriesApi } from 'lightweight-charts';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Candle, ChartOverlay, Tf } from '@cip/contracts';
import { TF_MS } from '@cip/domain';
import { Button } from '@cip/ui';
import { stepDecimals } from '../lib/decimal.js';
import { formatInstant } from '../lib/format.js';
import { ChartAttribution } from './attribution.js';
import {
  type DrawnRecord,
  OVERLAY_KIND_LABELS,
  OVERLAY_KINDS,
  type OverlayItem,
  type OverlayKind,
  overlayItems,
} from './overlay-items.js';
import { OverlayPrimitive, TimeIndex } from './overlay-primitive.js';
import { chartColors } from './theme.js';
import { chartRemoved, toChartTime, useChart } from './use-chart.js';

export interface LiquidityChartProps {
  instrumentId: string;
  tf: Tf;
  /** Closed candles of the window, oldest first. */
  candles: readonly Candle[];
  overlay: ChartOverlay | null;
  /** The overlay is the one for exactly these candles' window (`data-ready` for tests). */
  ready: boolean;
  /** The overlay kinds to draw (the page's toggles). */
  visible: ReadonlySet<OverlayKind>;
  priceTick: string;
  timeZone: string;
  /** Accessible name, e.g. "BTCUSDT 1h candles with SMC overlays". */
  label: string;
}

/**
 * Writes what the chart drew to the container (criterion 7.1's test hook): `data-drawn` is the
 * JSON list of drawn items, sorted by kind and id, rewritten only when it changes.
 */
function writeDrawn(annotate: (name: string, value: string) => void, records: DrawnRecord[]): void {
  const sorted = [...records].sort((a, b) =>
    a.kind === b.kind ? (a.id < b.id ? -1 : 1) : a.kind < b.kind ? -1 : 1,
  );
  annotate('drawn', JSON.stringify(sorted));
  annotate('drawnCount', String(sorted.length));
}

/**
 * The Liquidity Map's chart (REQUIREMENTS §6): candles with the SMC overlay (swings, BOS/CHOCH/MSS,
 * ranges, liquidity levels with their status, zones with their fill, sweeps and thin-book wicks,
 * setups' hypothetical levels) and, for PAXG, the gold-market closures shaded.
 */
export function LiquidityChart(props: LiquidityChartProps) {
  const { instrumentId, tf, candles, overlay, ready, visible, priceTick, timeZone, label } = props;
  const { ref, chart, annotate } = useChart(timeZone);
  // The candle series lives as long as the chart (and its price format); effects run in order, so
  // the data effect below always finds the current one.
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const [primitive] = useState(() => new OverlayPrimitive((records) => writeDrawn(annotate, records)));
  const summaryId = useId();

  useEffect(() => {
    if (!chart) return;
    const c = chartColors();
    const dp = stepDecimals(priceTick);
    const s = chart.addSeries(CandlestickSeries, {
      upColor: c.bull,
      downColor: c.bear,
      wickUpColor: c.bull,
      wickDownColor: c.bear,
      borderVisible: false,
      priceLineVisible: false,
      priceFormat: { type: 'price', precision: dp, minMove: Number(priceTick) },
    });
    s.attachPrimitive(primitive);
    series.current = s;
    return () => {
      series.current = null;
      // Unmounting removed the chart, and this series with it, before this cleanup runs; the
      // primitive is attached again to the next chart's series.
      if (chartRemoved(chart)) return;
      s.detachPrimitive(primitive);
      chart.removeSeries(s);
    };
  }, [chart, primitive, priceTick]);

  const fmt = useMemo(() => (ms: number) => formatInstant(ms, timeZone), [timeZone]);
  const items = useMemo(
    () => (overlay ? overlayItems(overlay, candles, tf, fmt) : []),
    [overlay, candles, tf, fmt],
  );
  const index = useMemo(
    () =>
      new TimeIndex(
        candles.map((c) => c.t),
        TF_MS[tf],
      ),
    [candles, tf],
  );

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    s.setData(
      candles.map((c) => ({
        time: toChartTime(c.t),
        open: Number(c.o),
        high: Number(c.h),
        low: Number(c.l),
        close: Number(c.c),
      })),
    );
    primitive.setData(items, index, visible);
  }, [chart, priceTick, candles, items, index, visible, primitive]);

  // Show the whole window when the instrument or timeframe changes (and on the first data).
  const hasData = candles.length > 0;
  useEffect(() => {
    if (chart && hasData) chart.timeScale().fitContent();
  }, [chart, hasData, instrumentId, tf]);

  const shown = items.filter((i) => visible.has(i.kind));
  const from = candles[0]?.t ?? null;
  const to = candles.length ? candles.at(-1)!.t + TF_MS[tf] : null;
  const counts = OVERLAY_KINDS.map((k) => [k, shown.filter((i) => i.kind === k).length] as const).filter(
    ([, n]) => n > 0,
  );

  return (
    <figure className="space-y-2">
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="secondary" onClick={() => chart?.timeScale().fitContent()}>
          Fit all
        </Button>
      </div>
      <div
        ref={ref}
        role="img"
        aria-label={label}
        aria-describedby={summaryId}
        className="h-[480px] w-full overflow-hidden rounded-md border border-border"
        data-chart="liquidity"
        data-instrument={instrumentId}
        data-tf={tf}
        data-from={from ?? ''}
        data-to={to ?? ''}
        data-run={overlay?.run?.id ?? ''}
        data-ready={ready && chart !== null ? 'true' : 'false'}
      />
      <figcaption id={summaryId} className="text-xs text-fg-muted">
        {from === null || to === null
          ? 'No candles yet.'
          : `${candles.length} candles from ${fmt(from)} to ${fmt(to)}. ${
              counts.length
                ? `Drawn: ${counts.map(([k, n]) => `${n} ${OVERLAY_KIND_LABELS[k].toLowerCase()}`).join(', ')}.`
                : 'Nothing detected in this window.'
            }`}
      </figcaption>
      <OverlayTable items={shown} />
      <ChartAttribution />
    </figure>
  );
}

/** The chart's text alternative: every drawn item, as a table (WCAG 1.1.1). */
function OverlayTable({ items }: { items: readonly OverlayItem[] }) {
  if (items.length === 0) return null;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-fg-muted">Overlay as a table ({items.length} items)</summary>
      <div className="mt-2 max-h-80 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-fg-muted">
              <th scope="col" className="py-1 pr-3 font-medium">
                Kind
              </th>
              <th scope="col" className="py-1 font-medium">
                Detail
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={`${i.kind}:${i.id}`} className="border-t border-border">
                <td className="py-1 pr-3 whitespace-nowrap">{OVERLAY_KIND_LABELS[i.kind]}</td>
                <td className="py-1">{i.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
