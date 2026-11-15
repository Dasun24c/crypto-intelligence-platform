import {
  ColorType,
  createChart,
  CrosshairMode,
  type DeepPartial,
  type ChartOptions,
  type IChartApi,
  type Time,
  TickMarkType,
} from 'lightweight-charts';
import { useCallback, useRef, useState } from 'react';
import { safeTimeZone } from '../lib/format.js';
import { alpha, chartColors } from './theme.js';

/** Lightweight Charts' times are UTC seconds; labels follow the user's display time zone. */
export function toChartTime(ms: number): Time {
  return Math.floor(ms / 1000) as Time;
}

function fromChartTime(time: Time): number {
  return typeof time === 'number'
    ? time * 1000
    : Date.parse(typeof time === 'string' ? time : `${time.year}-${time.month}-${time.day}`);
}

function formatter(timeZone: string, options: Intl.DateTimeFormatOptions): (ms: number) => string {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: safeTimeZone(timeZone),
    hourCycle: 'h23',
    ...options,
  });
  return (ms) => f.format(new Date(ms));
}

/** The shared look of every chart: the dark theme, a crosshair, times in `timeZone`. */
export function baseChartOptions(timeZone: string): DeepPartial<ChartOptions> {
  const c = chartColors();
  const full = formatter(timeZone, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const ticks: Record<TickMarkType, (ms: number) => string> = {
    [TickMarkType.Year]: formatter(timeZone, { year: 'numeric' }),
    [TickMarkType.Month]: formatter(timeZone, { month: 'short' }),
    [TickMarkType.DayOfMonth]: formatter(timeZone, { day: '2-digit', month: 'short' }),
    [TickMarkType.Time]: formatter(timeZone, { hour: '2-digit', minute: '2-digit' }),
    [TickMarkType.TimeWithSeconds]: formatter(timeZone, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }),
  };
  return {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: c.surface },
      textColor: c.muted,
      fontFamily: '"Inter Variable", Inter, system-ui, sans-serif',
      fontSize: 11,
      // The attribution is shown under every chart (ChartAttribution), with the NOTICE text.
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: alpha(c.border, 0.5) },
      horzLines: { color: alpha(c.border, 0.5) },
    },
    rightPriceScale: { borderColor: c.border },
    timeScale: {
      borderColor: c.border,
      timeVisible: true,
      secondsVisible: false,
      tickMarkFormatter: (time: Time, type: TickMarkType) => ticks[type](fromChartTime(time)),
    },
    localization: { timeFormatter: (time: Time) => full(fromChartTime(time)) },
    crosshair: { mode: CrosshairMode.Normal },
  };
}

/** Charts `useChart` has removed; removing a chart removes its series with it. */
const removedCharts = new WeakSet<IChartApi>();

/**
 * Whether `chart` was removed. React detaches a component's refs, which removes its chart, before
 * it runs the component's effect cleanups: a cleanup that removes series must check this first,
 * since the library throws when asked to remove a series from a removed chart.
 */
export function chartRemoved(chart: IChartApi): boolean {
  return removedCharts.has(chart);
}

/**
 * A chart in the element the returned `ref` is attached to, for as long as it is mounted; `chart` is
 * null until then. The ref callback creates it and its cleanup removes it (React 19 ref cleanups).
 * `annotate` writes a data attribute on the container (the charts' test hooks).
 */
export function useChart(
  timeZone: string,
  extra: DeepPartial<ChartOptions> = {},
): {
  ref: (el: HTMLDivElement | null) => (() => void) | undefined;
  chart: IChartApi | null;
  annotate: (name: string, value: string) => void;
} {
  const [chart, setChart] = useState<IChartApi | null>(null);
  const element = useRef<HTMLDivElement | null>(null);
  const extraJson = JSON.stringify(extra);
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) return undefined;
      element.current = el;
      const created = createChart(el, {
        ...baseChartOptions(timeZone),
        ...(JSON.parse(extraJson) as object),
      });
      setChart(created);
      return () => {
        setChart(null);
        element.current = null;
        removedCharts.add(created);
        created.remove();
      };
    },
    [timeZone, extraJson],
  );
  const annotate = useCallback((name: string, value: string) => {
    const el = element.current;
    if (el && el.dataset[name] !== value) el.dataset[name] = value;
  }, []);
  return { ref, chart, annotate };
}
