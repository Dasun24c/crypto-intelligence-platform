import type {
  AutoscaleInfo,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  Logical,
  SeriesAttachedParameter,
  Time,
} from 'lightweight-charts';
import {
  type DrawnRecord,
  drawnRecord,
  OVERLAY_KINDS,
  type OverlayItem,
  type OverlayKind,
} from './overlay-items.js';
import { alpha, CHART_FONT, type ChartColors, chartColors } from './theme.js';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];
type Ctx = CanvasRenderingContext2D;
type Layer = 'back' | 'front';

/** Behind the candles: shading and boxes. In front: lines and markers. */
const LAYER: Record<OverlayKind, Layer> = {
  closure: 'back',
  range: 'back',
  zone: 'back',
  level: 'front',
  setup: 'front',
  swing: 'front',
  structure: 'front',
  sweep: 'front',
};

/**
 * Maps times to the chart's logical positions: bar i opens at i and closes at i + 1. The chart has
 * no gaps between bars, so a time inside missing candles maps to the next stored bar.
 */
export class TimeIndex {
  constructor(
    private readonly opens: readonly number[],
    private readonly tfMs: number,
  ) {}

  get length(): number {
    return this.opens.length;
  }

  logical(t: number): number {
    const n = this.opens.length;
    if (n === 0) return 0;
    const first = this.opens[0]!;
    const last = this.opens[n - 1]!;
    if (t <= first) return (t - first) / this.tfMs;
    if (t >= last) return n - 1 + (t - last) / this.tfMs;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.opens[mid]! <= t) lo = mid;
      else hi = mid - 1;
    }
    const open = this.opens[lo]!;
    const span = Math.min(this.tfMs, this.opens[lo + 1]! - open);
    return lo + Math.min(1, (t - open) / span);
  }
}

class OverlayView implements IPrimitivePaneView {
  constructor(
    private readonly source: OverlayPrimitive,
    private readonly layer: Layer,
  ) {}

  zOrder(): 'bottom' | 'top' {
    return this.layer === 'back' ? 'bottom' : 'top';
  }

  renderer(): IPrimitivePaneRenderer {
    return { draw: (target: Target) => this.source.draw(target, this.layer) };
  }
}

/**
 * Draws the Liquidity Map's overlay on the candle series (Lightweight Charts primitives), and
 * reports after every paint exactly which items it drew: the overlay-parity test hook (7.1).
 * An item counts as drawn when it has coordinates and lies at least partly inside the pane.
 */
export class OverlayPrimitive implements ISeriesPrimitive<Time> {
  private param: SeriesAttachedParameter<Time> | null = null;
  private items: readonly OverlayItem[] = [];
  private visible: ReadonlySet<OverlayKind> = new Set(OVERLAY_KINDS);
  private index = new TimeIndex([], 60_000);
  private colors: ChartColors = chartColors();
  private readonly views = [new OverlayView(this, 'back'), new OverlayView(this, 'front')] as const;
  private readonly frame: Record<Layer, DrawnRecord[]> = { back: [], front: [] };
  private flushPending = false;
  private range: { minValue: number; maxValue: number } | null = null;

  constructor(private readonly onDrawn: (records: DrawnRecord[]) => void) {}

  attached(param: SeriesAttachedParameter<Time>): void {
    this.param = param;
  }

  detached(): void {
    this.param = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  setData(items: readonly OverlayItem[], index: TimeIndex, visible: ReadonlySet<OverlayKind>): void {
    this.items = items;
    this.index = index;
    this.visible = visible;
    this.colors = chartColors();
    this.range = priceRange(items, visible);
    this.param?.requestUpdate();
  }

  /** Every drawn price is on screen: the overlay widens the auto-scaled price range. */
  autoscaleInfo(): AutoscaleInfo | null {
    return this.range ? { priceRange: this.range } : null;
  }

  draw(target: Target, layer: Layer): void {
    const param = this.param;
    if (!param) return;
    const records: DrawnRecord[] = [];
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      const ctx = context;
      ctx.save();
      ctx.font = CHART_FONT;
      for (const item of this.items) {
        if (LAYER[item.kind] !== layer || !this.visible.has(item.kind)) continue;
        if (this.drawItem(ctx, item, param, mediaSize.width, mediaSize.height))
          records.push(drawnRecord(item));
      }
      ctx.restore();
    });
    this.frame[layer] = records;
    if (!this.flushPending) {
      this.flushPending = true;
      queueMicrotask(() => {
        this.flushPending = false;
        this.onDrawn([...this.frame.back, ...this.frame.front]);
      });
    }
  }

  /** Draws one item; false when it has no coordinates or lies outside the pane. */
  private drawItem(
    ctx: Ctx,
    item: OverlayItem,
    p: SeriesAttachedParameter<Time>,
    width: number,
    height: number,
  ): boolean {
    const ts = p.chart.timeScale();
    const edge = (t: number) => ts.logicalToCoordinate((this.index.logical(t) - 0.5) as Logical);
    const bar = (t: number) => ts.logicalToCoordinate(Math.floor(this.index.logical(t) + 1e-9) as Logical);
    const y = (price: string) => p.series.priceToCoordinate(Number(price));
    const inside = (x1: number, x2: number) => x2 >= 0 && x1 <= width;
    const c = this.colors;

    switch (item.kind) {
      case 'closure': {
        const x1 = edge(item.from);
        const x2 = edge(item.to);
        if (x1 === null || x2 === null || !inside(x1, x2)) return false;
        ctx.fillStyle = alpha(c.info, 0.08);
        ctx.fillRect(x1, 0, Math.max(1, x2 - x1), height);
        if (x2 - x1 > 90) label(ctx, 'Gold market closed', x1 + 4, 12, c.muted);
        return true;
      }
      case 'range': {
        const x1 = edge(item.from);
        const x2 = edge(item.to);
        const yt = y(item.high);
        const yb = y(item.low);
        if (x1 === null || x2 === null || yt === null || yb === null || !inside(x1, x2)) return false;
        ctx.fillStyle = alpha(c.accent, 0.05);
        ctx.fillRect(x1, yt, x2 - x1, yb - yt);
        ctx.strokeStyle = alpha(c.accent, 0.6);
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(x1, yt, x2 - x1, yb - yt);
        ctx.setLineDash([]);
        label(ctx, item.label, x1 + 3, yt - 3, c.accent);
        return true;
      }
      case 'zone': {
        const x1 = edge(item.from);
        const x2 = edge(item.to);
        const yt = y(item.top);
        const yb = y(item.bottom);
        if (x1 === null || x2 === null || yt === null || yb === null || !inside(x1, x2)) return false;
        const z = item.zone;
        const hue = z.direction === 'bullish' ? c.bull : c.bear;
        const strength = {
          untouched: 0.2,
          partially_filled: 0.13,
          filled: 0.07,
          invalidated: 0.04,
          expired: 0.04,
        }[z.status];
        ctx.fillStyle = alpha(hue, strength);
        ctx.fillRect(x1, yt, Math.max(2, x2 - x1), Math.max(1, yb - yt));
        ctx.strokeStyle = alpha(hue, z.status === 'invalidated' || z.status === 'expired' ? 0.35 : 0.7);
        ctx.setLineDash(z.type === 'fvg' ? [3, 3] : []);
        ctx.strokeRect(x1, yt, Math.max(2, x2 - x1), Math.max(1, yb - yt));
        ctx.setLineDash([]);
        if (yb - yt >= 10) label(ctx, item.label, x1 + 3, yt + 10, hue);
        return true;
      }
      case 'level': {
        const x1 = edge(item.from);
        const x2 = edge(item.to);
        const yl = y(item.price);
        if (x1 === null || x2 === null || yl === null || !inside(x1, x2)) return false;
        const hue = item.side === 'buy_side' ? c.bear : c.bull;
        ctx.strokeStyle = item.status === 'expired' ? alpha(hue, 0.4) : hue;
        ctx.lineWidth = item.status === 'active' ? 1.25 : 1;
        ctx.setLineDash(item.status === 'swept' ? [5, 3] : item.status === 'broken' ? [1, 3] : []);
        line(ctx, x1, yl, x2, yl);
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
        label(ctx, item.label, Math.min(x2, width - 60) + 3, yl - 3, hue);
        return true;
      }
      case 'setup': {
        const x1 = edge(item.from);
        const x2 = edge(item.to);
        const ya = y(item.anchor);
        if (x1 === null || x2 === null || ya === null || !inside(x1, x2)) return false;
        const hue = item.direction === 'bullish' ? c.bull : c.bear;
        for (const l of item.lines) {
          const yl = y(l.price);
          if (yl === null) continue;
          const color = l.role === 'invalidation' ? c.crit : l.role === 'entry' ? c.fg : c.ok;
          ctx.strokeStyle = color;
          ctx.setLineDash(l.role === 'entry' ? [6, 3] : l.role === 'invalidation' ? [] : [2, 3]);
          line(ctx, x1, yl, x2, yl);
          const name =
            l.role === 'target1'
              ? 'T1'
              : l.role === 'target2'
                ? 'T2'
                : l.role === 'entry'
                  ? 'Entry'
                  : 'Invalidation';
          label(ctx, name, x1 + 3, yl - 3, color);
        }
        ctx.setLineDash([]);
        // The start marker: a diamond beyond the candle where the setup began forming.
        const xm = bar(item.from) ?? x1;
        const ym = ya + (item.direction === 'bullish' ? 14 : -14);
        ctx.fillStyle = hue;
        ctx.beginPath();
        ctx.moveTo(xm, ym - 5);
        ctx.lineTo(xm + 5, ym);
        ctx.lineTo(xm, ym + 5);
        ctx.lineTo(xm - 5, ym);
        ctx.closePath();
        ctx.fill();
        label(ctx, item.label, xm + 7, ym + 4, hue);
        return true;
      }
      case 'swing': {
        const x = bar(item.at);
        const ys = y(item.price);
        if (x === null || ys === null || !inside(x, x)) return false;
        const up = item.side === 'low';
        const tip = up ? ys + 5 : ys - 5;
        ctx.fillStyle = up ? c.bull : c.bear;
        ctx.beginPath();
        ctx.moveTo(x, tip);
        ctx.lineTo(x - 4, up ? tip + 7 : tip - 7);
        ctx.lineTo(x + 4, up ? tip + 7 : tip - 7);
        ctx.closePath();
        ctx.fill();
        return true;
      }
      case 'structure': {
        const x2 = bar(item.at);
        const ys = y(item.price);
        if (x2 === null || ys === null) return false;
        const x1 = item.from !== null ? (bar(item.from) ?? x2) : x2 - 24;
        if (!inside(Math.min(x1, x2), Math.max(x1, x2))) return false;
        const hue = item.direction === 'bullish' ? c.bull : c.bear;
        ctx.strokeStyle = hue;
        ctx.setLineDash(item.type === 'choch' ? [4, 2] : []);
        line(ctx, x1, ys, x2, ys);
        ctx.setLineDash([]);
        label(ctx, item.label, (x1 + x2) / 2 - 12, item.direction === 'bullish' ? ys - 4 : ys + 12, hue);
        return true;
      }
      case 'sweep': {
        const x = bar(item.at);
        const ys = y(item.price);
        if (x === null || ys === null || !inside(x, x)) return false;
        const hue = item.side === 'buy_side' ? c.bear : c.bull;
        ctx.strokeStyle = item.thinBook ? c.warn : hue;
        ctx.fillStyle = alpha(item.thinBook ? c.warn : hue, item.thinBook ? 0 : 0.5);
        ctx.beginPath();
        ctx.arc(x, ys, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (item.thinBook) label(ctx, 'thin book', x + 7, ys + 4, c.warn);
        return true;
      }
    }
  }
}

/** The prices the visible items are drawn at (closures have none). */
function priceRange(
  items: readonly OverlayItem[],
  visible: ReadonlySet<OverlayKind>,
): { minValue: number; maxValue: number } | null {
  let lo = Infinity;
  let hi = -Infinity;
  const add = (p: string) => {
    const v = Number(p);
    if (Number.isFinite(v)) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  };
  for (const i of items) {
    if (!visible.has(i.kind)) continue;
    const prices =
      i.kind === 'range'
        ? [i.high, i.low]
        : i.kind === 'zone'
          ? [i.top, i.bottom]
          : i.kind === 'setup'
            ? i.lines.map((l) => l.price)
            : i.kind === 'closure'
              ? []
              : [i.price];
    for (const p of prices) add(p);
  }
  return lo <= hi ? { minValue: lo, maxValue: hi } : null;
}

function line(ctx: Ctx, x1: number, y1: number, x2: number, y2: number): void {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function label(ctx: Ctx, text: string, x: number, y: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}
