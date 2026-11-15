import { useId } from 'react';
import { formatBps } from '../lib/decimal.js';
import type { SpreadPoint } from '../lib/activity.js';

const W = 640;
const H = 180;
const PAD = { left: 56, right: 12, top: 12, bottom: 24 };
/** Points further apart than this are not joined: the chart never draws through missing data. */
const GAP_MS = 30_000;

export function spreadSegments(points: readonly SpreadPoint[]): SpreadPoint[][] {
  const segments: SpreadPoint[][] = [];
  let current: SpreadPoint[] = [];
  for (const p of points) {
    const last = current.at(-1);
    if (last && p.ts - last.ts > GAP_MS) {
      segments.push(current);
      current = [];
    }
    current.push(p);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/**
 * A small line chart of the cross-venue spread in bps over [from, to], drawn as inline SVG (no chart
 * library). Missing stretches stay blank; a text summary gives the same facts to screen readers.
 */
export function SpreadChart({
  points,
  from,
  to,
  title,
}: {
  points: readonly SpreadPoint[];
  from: number;
  to: number;
  title: string;
}) {
  const titleId = useId();
  const descId = useId();
  if (points.length === 0) return null;
  const values = points.map((p) => p.bps);
  let lo = Math.min(0, ...values);
  let hi = Math.max(0, ...values);
  if (hi - lo < 1) {
    const mid = (hi + lo) / 2;
    lo = mid - 0.5;
    hi = mid + 0.5;
  }
  const margin = (hi - lo) * 0.1;
  lo -= margin;
  hi += margin;
  const span = Math.max(1, to - from);
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const x = (ts: number) => PAD.left + ((ts - from) / span) * iw;
  const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * ih;
  const segments = spreadSegments(points);
  const last = points.at(-1)!;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const summary = `Latest ${formatBps(last.bps, true)}; lowest ${formatBps(min, true)}, highest ${formatBps(max, true)} over ${points.length} points.`;
  const minutes = Math.round(span / 60_000);
  return (
    <figure className="space-y-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-labelledby={`${titleId} ${descId}`}
        className="h-auto w-full"
      >
        <title id={titleId}>{title}</title>
        <desc id={descId}>{summary}</desc>
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={y(0)}
          y2={y(0)}
          className="stroke-border-strong"
          strokeDasharray="4 4"
        />
        <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={H - PAD.bottom} className="stroke-border" />
        {[...new Set([Math.max(0, ...values), 0, Math.min(0, ...values)])].map((v) => (
          <text
            key={v}
            x={PAD.left - 6}
            y={y(v)}
            textAnchor="end"
            dominantBaseline="middle"
            className="fill-fg-muted text-[10px]"
          >
            {v === 0 ? '0' : v.toFixed(1)}
          </text>
        ))}
        <text x={PAD.left} y={H - 6} className="fill-fg-muted text-[10px]">
          −{minutes} min
        </text>
        <text x={W - PAD.right} y={H - 6} textAnchor="end" className="fill-fg-muted text-[10px]">
          now
        </text>
        {segments.map((seg) =>
          seg.length === 1 ? (
            <circle key={seg[0]!.ts} cx={x(seg[0]!.ts)} cy={y(seg[0]!.bps)} r={1.5} className="fill-accent" />
          ) : (
            <polyline
              key={seg[0]!.ts}
              points={seg.map((p) => `${x(p.ts).toFixed(1)},${y(p.bps).toFixed(1)}`).join(' ')}
              fill="none"
              className="stroke-accent"
              strokeWidth={1.5}
              strokeLinejoin="round"
            />
          ),
        )}
        <circle cx={x(last.ts)} cy={y(last.bps)} r={3} className="fill-accent" />
      </svg>
      <figcaption className="text-xs text-fg-muted">
        {summary} Blank stretches are periods without data.
      </figcaption>
    </figure>
  );
}
