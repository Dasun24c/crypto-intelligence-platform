import { type ReactNode, useId } from 'react';
import type { IndicatorPoint, Tf } from '@cip/contracts';
import {
  type ChartCandle,
  type ChartWindow,
  extent,
  formatCandleTime,
  formatCompact,
  formatFixed,
  formatIndicator,
  type IndicatorField,
  inWindow,
  niceTicks,
  segments,
  tickDecimals,
  type TimedValue,
} from '../lib/analysis.js';
import { formatDecimal } from '../lib/decimal.js';

/**
 * Technical Analysis charts, drawn as inline SVG (no chart library) on one time axis: the last
 * candles of the window, one slot per candle, so the panels line up. A line is drawn only between
 * consecutive candles that both have a value: missing candles and warm-up values stay blank. The
 * part of the window before the run started (warm-up) is shaded, and the candle in progress is
 * dashed. Each chart repeats its facts in a text summary for screen readers; every number comes
 * from the API.
 */

const W = 720;
const PAD = { left: 64, right: 10, top: 10, bottom: 22 };
const PLOT_W = W - PAD.left - PAD.right;

interface Frame {
  readonly height: number;
  readonly top: number;
  readonly bottom: number;
  /** Width of one candle's slot. */
  readonly slot: number;
  /** Left edge of the slot of the candle that opens at `t`. */
  x(t: number): number;
  /** Middle of that slot. */
  cx(t: number): number;
  y(v: number): number;
}

function frame(w: ChartWindow, height: number, [lo, hi]: readonly [number, number]): Frame {
  const slot = PLOT_W / w.slots;
  const top = PAD.top;
  const bottom = height - PAD.bottom;
  const x = (t: number) => PAD.left + ((t - w.from) / w.tfMs) * slot;
  return {
    height,
    top,
    bottom,
    slot,
    x,
    cx: (t) => x(t) + slot / 2,
    y: (v) => bottom - ((v - lo) / (hi - lo)) * (bottom - top),
  };
}

/** A value range with some margin; a flat range is widened so it still has a height. */
function padded(range: readonly [number, number] | null, margin = 0.08): [number, number] {
  if (!range) return [0, 1];
  let [lo, hi] = range;
  if (hi <= lo) {
    const d = Math.abs(lo) * 0.01 || 1;
    lo -= d;
    hi += d;
  }
  const m = (hi - lo) * margin;
  return [lo - m, hi + m];
}

/** A series' look: colour from the theme tokens, plus a dash pattern so colour is not the only cue. */
interface SeriesStyle {
  readonly stroke: string;
  readonly fill: string;
  readonly dash?: string;
}

const STYLE = {
  emaFast: { stroke: 'stroke-accent', fill: 'fill-accent' },
  emaMid: { stroke: 'stroke-warn', fill: 'fill-warn' },
  emaSlow: { stroke: 'stroke-fg', fill: 'fill-fg' },
  vwap: { stroke: 'stroke-fg-muted', fill: 'fill-fg-muted', dash: '5 3' },
  rsi: { stroke: 'stroke-accent', fill: 'fill-accent' },
  macd: { stroke: 'stroke-accent', fill: 'fill-accent' },
  macdSignal: { stroke: 'stroke-warn', fill: 'fill-warn', dash: '4 3' },
} as const satisfies Record<string, SeriesStyle>;

const OVERLAYS = ['emaFast', 'emaMid', 'emaSlow', 'vwap'] as const;

// -----------------------------------------------------------------------------------------------
// Building blocks
// -----------------------------------------------------------------------------------------------

function ChartFigure({
  title,
  summary,
  height,
  legend,
  children,
}: {
  title: string;
  summary: string;
  height: number;
  legend?: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  const descId = useId();
  return (
    <figure className="space-y-2">
      <svg
        viewBox={`0 0 ${W} ${height}`}
        role="img"
        aria-labelledby={`${titleId} ${descId}`}
        className="h-auto w-full"
      >
        <title id={titleId}>{title}</title>
        <desc id={descId}>{summary}</desc>
        {children}
      </svg>
      <figcaption className="space-y-1 text-xs text-fg-muted">
        {legend}
        <p>{summary}</p>
      </figcaption>
    </figure>
  );
}

function LineKey({ style }: { style: SeriesStyle }) {
  return (
    <svg width="18" height="8" aria-hidden className="shrink-0">
      <line
        x1="1"
        x2="17"
        y1="4"
        y2="4"
        className={style.stroke}
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray={style.dash}
      />
    </svg>
  );
}

function SwatchKey({ className, dashed = false }: { className: string; dashed?: boolean }) {
  return (
    <svg width="10" height="10" aria-hidden className="shrink-0">
      <rect
        x="0.5"
        y="0.5"
        width="9"
        height="9"
        rx="1"
        className={className}
        strokeDasharray={dashed ? '2 2' : undefined}
      />
    </svg>
  );
}

function Legend({ items }: { items: { key: string; label: string; icon: ReactNode }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1">
      {items.map((i) => (
        <li key={i.key} className="inline-flex items-center gap-1.5">
          {i.icon}
          {i.label}
        </li>
      ))}
    </ul>
  );
}

/** The part of the window before the run started: history that primed the indicators. */
function WarmupBand({ f, w, runFrom }: { f: Frame; w: ChartWindow; runFrom: number | null }) {
  if (runFrom === null || runFrom <= w.from) return null;
  const x0 = f.x(w.from);
  const x1 = f.x(Math.min(runFrom, w.to));
  return (
    <g>
      <rect x={x0} y={f.top} width={x1 - x0} height={f.bottom - f.top} className="fill-surface-3" />
      {x1 - x0 >= 48 ? (
        <text x={x0 + 4} y={f.top + 10} className="fill-fg-muted text-[10px]">
          warm-up
        </text>
      ) : null}
      {runFrom < w.to ? (
        <line x1={x1} x2={x1} y1={f.top} y2={f.bottom} className="stroke-border-strong" />
      ) : null}
    </g>
  );
}

function ValueAxis({
  f,
  ticks,
  format,
}: {
  f: Frame;
  ticks: readonly number[];
  format: (v: number) => string;
}) {
  return (
    <g>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={PAD.left} x2={W - PAD.right} y1={f.y(v)} y2={f.y(v)} className="stroke-border" />
          <text
            x={PAD.left - 6}
            y={f.y(v)}
            textAnchor="end"
            dominantBaseline="middle"
            className="fill-fg-muted text-[10px] tabular-nums"
          >
            {format(v)}
          </text>
        </g>
      ))}
    </g>
  );
}

function TimeAxis({
  f,
  w,
  tf,
  timeZone,
  inProgress = false,
}: {
  f: Frame;
  w: ChartWindow;
  tf: Tf;
  timeZone: string;
  /** The newest candle has not closed yet: said on the axis, where no candle hides it. */
  inProgress?: boolean;
}) {
  return (
    <g className="fill-fg-muted text-[10px]">
      <text x={PAD.left} y={f.height - 6}>
        {formatCandleTime(w.from, tf, timeZone)}
      </text>
      <text x={W - PAD.right} y={f.height - 6} textAnchor="end">
        {formatCandleTime(w.to - w.tfMs, tf, timeZone)}
        {inProgress ? ' (in progress)' : ''}
      </text>
    </g>
  );
}

/** A dashed guide through the slot of the candle in progress. */
function InProgressGuide({ f, candle }: { f: Frame; candle: ChartCandle | undefined }) {
  if (!candle?.inProgress) return null;
  return (
    <line
      x1={f.cx(candle.t)}
      x2={f.cx(candle.t)}
      y1={f.top}
      y2={f.bottom}
      className="stroke-border-strong"
      strokeDasharray="2 3"
    />
  );
}

function Line({ f, segs, style }: { f: Frame; segs: readonly TimedValue[][]; style: SeriesStyle }) {
  return (
    <g>
      {segs.map((seg) =>
        seg.length === 1 ? (
          <circle key={seg[0]!.t} cx={f.cx(seg[0]!.t)} cy={f.y(seg[0]!.v)} r={1.5} className={style.fill} />
        ) : (
          <polyline
            key={seg[0]!.t}
            points={seg.map((p) => `${f.cx(p.t).toFixed(1)},${f.y(p.v).toFixed(1)}`).join(' ')}
            fill="none"
            className={style.stroke}
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            strokeDasharray={style.dash}
          />
        ),
      )}
    </g>
  );
}

/** One transparent target per candle with its values as a native tooltip (the table has the latest). */
function HoverSlots({ f, slots }: { f: Frame; slots: readonly { t: number; text: string }[] }) {
  return (
    <g>
      {slots.map((s) => (
        <rect key={s.t} x={f.x(s.t)} y={f.top} width={f.slot} height={f.bottom - f.top} fill="transparent">
          <title>{s.text}</title>
        </rect>
      ))}
    </g>
  );
}

const byTime = (points: readonly IndicatorPoint[]) => new Map(points.map((p) => [p.t, p]));

/** A value for reading, or why there is none. */
function valueText(value: number | null, dp: number): string {
  return value === null ? 'warming up' : formatIndicator(value, dp);
}

// -----------------------------------------------------------------------------------------------
// Price
// -----------------------------------------------------------------------------------------------

export interface PriceChartProps {
  title: string;
  candles: readonly ChartCandle[];
  points: readonly IndicatorPoint[];
  window: ChartWindow;
  /** The run's start; earlier candles are warm-up. */
  runFrom: number | null;
  labels: Readonly<Record<IndicatorField, string>>;
  tf: Tf;
  /** Decimals for prices. */
  dp: number;
  quote: string;
  timeZone: string;
}

const PRICE_H = 260;

/** Candles with the EMA and VWAP overlays. */
export function PriceChart({
  title,
  candles,
  points,
  window: w,
  runFrom,
  labels,
  tf,
  dp,
  quote,
  timeZone,
}: PriceChartProps) {
  const shown = inWindow(candles, w);
  const pts = inWindow(points, w);
  const range = extent([
    ...shown.flatMap((c) => [Number(c.h), Number(c.l)]),
    ...pts.flatMap((p) => OVERLAYS.map((k) => p[k])),
  ]);
  const f = frame(w, PRICE_H, padded(range));
  const ticks = range ? niceTicks(range[0], range[1], 4) : [];
  const tickDp = tickDecimals(ticks);
  const at = byTime(pts);
  const time = (t: number) => formatCandleTime(t, tf, timeZone);
  const vwapOnDaily = tf === '1d';

  const last = shown.at(-1);
  const high = shown.reduce<ChartCandle | null>((m, c) => (m && Number(m.h) >= Number(c.h) ? m : c), null);
  const low = shown.reduce<ChartCandle | null>((m, c) => (m && Number(m.l) <= Number(c.l) ? m : c), null);
  const latest = pts.at(-1);
  const parts: string[] = [];
  if (last && high && low)
    parts.push(
      `${shown.length} candles from ${time(shown[0]!.t)} to ${time(last.t)}.`,
      `Last price ${formatDecimal(last.c, dp)} ${quote}${last.inProgress ? ' (candle in progress)' : ''}; high ${formatDecimal(high.h, dp)}, low ${formatDecimal(low.l, dp)}.`,
    );
  else parts.push('No candles stored in this window.');
  if (latest)
    parts.push(
      `At ${time(latest.t)}: ${OVERLAYS.filter((k) => k !== 'vwap' || !vwapOnDaily)
        .map((k) => `${labels[k]} ${valueText(latest[k], dp)}`)
        .join(', ')}.`,
    );
  if (runFrom !== null && runFrom > w.from) parts.push(`Candles before ${time(runFrom)} are warm-up.`);
  const summary = parts.join(' ');

  const legend = (
    <Legend
      items={[
        ...OVERLAYS.map((k) => ({
          key: k,
          label: k === 'vwap' && vwapOnDaily ? `${labels.vwap} (not computed on 1d)` : labels[k],
          icon: <LineKey style={STYLE[k]} />,
        })),
        { key: 'warmup', label: 'Warm-up (before the run)', icon: <SwatchKey className="fill-surface-3" /> },
        {
          key: 'progress',
          label: 'Candle in progress (dashed)',
          icon: <SwatchKey className="fill-none stroke-fg-muted" dashed />,
        },
      ]}
    />
  );

  return (
    <ChartFigure title={title} summary={summary} height={PRICE_H} legend={legend}>
      <WarmupBand f={f} w={w} runFrom={runFrom} />
      <ValueAxis f={f} ticks={ticks} format={(v) => formatFixed(v, tickDp)} />
      <TimeAxis f={f} w={w} tf={tf} timeZone={timeZone} inProgress={shown.at(-1)?.inProgress} />
      <InProgressGuide f={f} candle={shown.at(-1)} />
      {shown.map((c) => {
        const open = Number(c.o);
        const close = Number(c.c);
        const up = close >= open;
        const bodyTop = f.y(Math.max(open, close));
        const bodyBottom = f.y(Math.min(open, close));
        const width = Math.max(1, f.slot * 0.6);
        return (
          <g
            key={c.t}
            className={up ? 'stroke-bull' : 'stroke-bear'}
            strokeDasharray={c.inProgress ? '2 2' : undefined}
          >
            <line x1={f.cx(c.t)} x2={f.cx(c.t)} y1={f.y(Number(c.h))} y2={f.y(Number(c.l))} />
            {/* Rising candles are hollow and falling ones filled: direction is not colour alone. */}
            <rect
              x={f.cx(c.t) - width / 2}
              y={bodyTop}
              width={width}
              height={Math.max(1, bodyBottom - bodyTop)}
              className={up || c.inProgress ? 'fill-surface' : 'fill-bear'}
            />
          </g>
        );
      })}
      {OVERLAYS.map((k) => (
        <Line key={k} f={f} segs={segments(pts, (p) => p[k], w.tfMs)} style={STYLE[k]} />
      ))}
      <HoverSlots
        f={f}
        slots={shown.map((c) => {
          const p = at.get(c.t);
          const values = p ? OVERLAYS.map((k) => ` · ${labels[k]} ${valueText(p[k], dp)}`).join('') : '';
          return {
            t: c.t,
            text: `${time(c.t)}${c.inProgress ? ' (in progress)' : ''} · O ${formatDecimal(c.o, dp)} H ${formatDecimal(c.h, dp)} L ${formatDecimal(c.l, dp)} C ${formatDecimal(c.c, dp)}${values}`,
          };
        })}
      />
    </ChartFigure>
  );
}

// -----------------------------------------------------------------------------------------------
// RSI
// -----------------------------------------------------------------------------------------------

const RSI_H = 120;
const RSI_GUIDES = [30, 70] as const;

export function RsiChart({
  points,
  window: w,
  runFrom,
  label,
  tf,
  timeZone,
}: {
  points: readonly IndicatorPoint[];
  window: ChartWindow;
  runFrom: number | null;
  label: string;
  tf: Tf;
  timeZone: string;
}) {
  const pts = inWindow(points, w);
  const f = frame(w, RSI_H, [0, 100]);
  const valued = pts.filter((p) => p.rsi !== null);
  const latest = valued.at(-1);
  const range = extent(valued.map((p) => p.rsi));
  const above = valued.filter((p) => p.rsi! > 70).length;
  const below = valued.filter((p) => p.rsi! < 30).length;
  const summary =
    latest && range
      ? `${label} ${formatIndicator(latest.rsi!, 2)} at ${formatCandleTime(latest.t, tf, timeZone)}; lowest ${formatIndicator(range[0], 2)}, highest ${formatIndicator(range[1], 2)} over ${valued.length} candles. ${above} closed above 70 and ${below} below 30.`
      : `${label} is warming up: no value in this window yet.`;
  return (
    <ChartFigure title={`${label}, 0 to 100, with guides at 30 and 70`} summary={summary} height={RSI_H}>
      <WarmupBand f={f} w={w} runFrom={runFrom} />
      <ValueAxis f={f} ticks={[0, 100]} format={(v) => String(v)} />
      {RSI_GUIDES.map((v) => (
        <g key={v}>
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={f.y(v)}
            y2={f.y(v)}
            className="stroke-border-strong"
            strokeDasharray="4 4"
          />
          <text
            x={PAD.left - 6}
            y={f.y(v)}
            textAnchor="end"
            dominantBaseline="middle"
            className="fill-fg-muted text-[10px] tabular-nums"
          >
            {v}
          </text>
        </g>
      ))}
      <TimeAxis f={f} w={w} tf={tf} timeZone={timeZone} />
      <Line f={f} segs={segments(pts, (p) => p.rsi, w.tfMs)} style={STYLE.rsi} />
      <HoverSlots
        f={f}
        slots={pts.map((p) => ({
          t: p.t,
          text: `${formatCandleTime(p.t, tf, timeZone)} · ${label} ${valueText(p.rsi, 2)}`,
        }))}
      />
    </ChartFigure>
  );
}

// -----------------------------------------------------------------------------------------------
// MACD
// -----------------------------------------------------------------------------------------------

const MACD_H = 140;

export function MacdChart({
  points,
  window: w,
  runFrom,
  labels,
  tf,
  dp,
  timeZone,
}: {
  points: readonly IndicatorPoint[];
  window: ChartWindow;
  runFrom: number | null;
  labels: Readonly<Record<IndicatorField, string>>;
  tf: Tf;
  dp: number;
  timeZone: string;
}) {
  const pts = inWindow(points, w);
  const range = extent([0, ...pts.flatMap((p) => [p.macd, p.macdSignal, p.macdHist])]);
  const f = frame(w, MACD_H, padded(range));
  const ticks = range ? niceTicks(range[0], range[1], 3) : [];
  const tickDp = tickDecimals(ticks);
  const width = Math.max(1, f.slot * 0.6);
  const latest = pts.filter((p) => p.macd !== null).at(-1);
  let summary = `${labels.macd} is warming up: no value in this window yet.`;
  if (latest) {
    const hist = latest.macdHist;
    const relation =
      hist === null
        ? ''
        : hist > 0
          ? ' MACD is above its signal line.'
          : hist < 0
            ? ' MACD is below its signal line.'
            : '';
    summary = `${labels.macd} at ${formatCandleTime(latest.t, tf, timeZone)}: MACD ${valueText(latest.macd, dp)}, signal ${valueText(latest.macdSignal, dp)}, histogram ${valueText(hist, dp)}.${relation}`;
  }
  const legend = (
    <Legend
      items={[
        { key: 'macd', label: 'MACD', icon: <LineKey style={STYLE.macd} /> },
        { key: 'signal', label: labels.macdSignal, icon: <LineKey style={STYLE.macdSignal} /> },
        { key: 'up', label: 'Histogram above zero', icon: <SwatchKey className="fill-bull" /> },
        { key: 'down', label: 'Histogram below zero', icon: <SwatchKey className="fill-bear" /> },
      ]}
    />
  );
  return (
    <ChartFigure
      title={`${labels.macd} with its signal line and histogram`}
      summary={summary}
      height={MACD_H}
      legend={legend}
    >
      <WarmupBand f={f} w={w} runFrom={runFrom} />
      <ValueAxis f={f} ticks={ticks} format={(v) => formatFixed(v, tickDp)} />
      <line x1={PAD.left} x2={W - PAD.right} y1={f.y(0)} y2={f.y(0)} className="stroke-border-strong" />
      <TimeAxis f={f} w={w} tf={tf} timeZone={timeZone} />
      {pts.map((p) =>
        p.macdHist === null ? null : (
          <rect
            key={p.t}
            x={f.cx(p.t) - width / 2}
            y={Math.min(f.y(0), f.y(p.macdHist))}
            width={width}
            height={Math.max(0.5, Math.abs(f.y(p.macdHist) - f.y(0)))}
            className={p.macdHist >= 0 ? 'fill-bull' : 'fill-bear'}
            fillOpacity={0.6}
          />
        ),
      )}
      <Line f={f} segs={segments(pts, (p) => p.macd, w.tfMs)} style={STYLE.macd} />
      <Line f={f} segs={segments(pts, (p) => p.macdSignal, w.tfMs)} style={STYLE.macdSignal} />
      <HoverSlots
        f={f}
        slots={pts.map((p) => ({
          t: p.t,
          text: `${formatCandleTime(p.t, tf, timeZone)} · MACD ${valueText(p.macd, dp)} · signal ${valueText(p.macdSignal, dp)} · histogram ${valueText(p.macdHist, dp)}`,
        }))}
      />
    </ChartFigure>
  );
}

// -----------------------------------------------------------------------------------------------
// Volume
// -----------------------------------------------------------------------------------------------

const VOLUME_H = 110;

export function VolumeChart({
  candles,
  points,
  window: w,
  runFrom,
  labels,
  tf,
  base,
  timeZone,
}: {
  candles: readonly ChartCandle[];
  points: readonly IndicatorPoint[];
  window: ChartWindow;
  runFrom: number | null;
  labels: Readonly<Record<IndicatorField, string>>;
  tf: Tf;
  base: string;
  timeZone: string;
}) {
  const shown = inWindow(candles, w);
  const at = byTime(inWindow(points, w));
  const max = Math.max(0, ...shown.map((c) => Number(c.v)));
  const f = frame(w, VOLUME_H, [0, max > 0 ? max * 1.15 : 1]);
  const ticks = max > 0 ? niceTicks(0, max, 2) : [0];
  const tickDp = tickDecimals(ticks);
  const width = Math.max(1, f.slot * 0.6);
  const time = (t: number) => formatCandleTime(t, tf, timeZone);
  const anomalies = shown.filter((c) => at.get(c.t)?.volumeAnomaly === true);
  const closed = shown.filter((c) => !c.inProgress).at(-1);
  const forming = shown.at(-1)?.inProgress ? shown.at(-1) : undefined;
  const parts: string[] = [];
  if (closed)
    parts.push(`Volume of the last closed candle (${time(closed.t)}): ${formatDecimal(closed.v)} ${base}.`);
  if (forming) parts.push(`The candle in progress has traded ${formatDecimal(forming.v)} ${base} so far.`);
  parts.push(
    anomalies.length === 0
      ? `No ${labels.volumeAnomaly.toLowerCase()} in this window.`
      : `${anomalies.length} volume ${anomalies.length === 1 ? 'anomaly' : 'anomalies'} in this window, the latest at ${time(anomalies.at(-1)!.t)}.`,
  );
  const summary = parts.join(' ');
  const legend = (
    <Legend
      items={[
        { key: 'volume', label: `Volume (${base})`, icon: <SwatchKey className="fill-fg-subtle" /> },
        { key: 'anomaly', label: labels.volumeAnomaly, icon: <SwatchKey className="fill-warn" /> },
      ]}
    />
  );
  return (
    <ChartFigure
      title={`Volume per candle in ${base}, with volume anomalies marked`}
      summary={summary}
      height={VOLUME_H}
      legend={legend}
    >
      <WarmupBand f={f} w={w} runFrom={runFrom} />
      <ValueAxis f={f} ticks={ticks} format={(v) => formatCompact(v, tickDp)} />
      <TimeAxis f={f} w={w} tf={tf} timeZone={timeZone} inProgress={shown.at(-1)?.inProgress} />
      <InProgressGuide f={f} candle={shown.at(-1)} />
      {shown.map((c) => {
        const top = f.y(Number(c.v));
        const anomaly = at.get(c.t)?.volumeAnomaly === true;
        return (
          <g key={c.t}>
            <rect
              x={f.cx(c.t) - width / 2}
              y={top}
              width={width}
              height={Math.max(0.5, f.y(0) - top)}
              className={
                c.inProgress ? 'fill-none stroke-fg-subtle' : anomaly ? 'fill-warn' : 'fill-fg-subtle'
              }
              strokeDasharray={c.inProgress ? '2 2' : undefined}
            />
            {/* A marker above the bar: an anomaly is not shown by colour alone. */}
            {anomaly ? (
              <path
                d={`M ${f.cx(c.t) - 3} ${top - 7} L ${f.cx(c.t) + 3} ${top - 7} L ${f.cx(c.t)} ${top - 2} Z`}
                className="fill-warn"
              />
            ) : null}
          </g>
        );
      })}
      <HoverSlots
        f={f}
        slots={shown.map((c) => {
          const p = at.get(c.t);
          const z = p ? ` · z ${valueText(p.volumeZ, 2)}${p.volumeAnomaly ? ' (anomaly)' : ''}` : '';
          return {
            t: c.t,
            text: `${time(c.t)}${c.inProgress ? ' (in progress)' : ''} · volume ${formatDecimal(c.v)} ${base}${z}`,
          };
        })}
      />
    </ChartFigure>
  );
}
