import type { ChartOverlay, LevelType, Pattern, PoiZone, SetupSummary, Tf, ZoneType } from '@cip/contracts';
import { TF_MS } from '@cip/domain';

/**
 * What the Liquidity Map draws from `GET /smc/{id}/overlay` (REQUIREMENTS §6): one item per
 * detection, in data space (times and decimal prices). The renderer turns items into pixels and
 * records each item it drew (`drawnRecord`), which is the chart's test hook for overlay parity
 * (criterion 7.1).
 */
export const OVERLAY_KINDS = [
  'closure',
  'range',
  'zone',
  'level',
  'setup',
  'swing',
  'structure',
  'sweep',
] as const;
export type OverlayKind = (typeof OVERLAY_KINDS)[number];

export const OVERLAY_KIND_LABELS: Record<OverlayKind, string> = {
  closure: 'Gold-market closures',
  range: 'Ranges',
  zone: 'Zones (OB, FVG, supply, demand)',
  level: 'Liquidity levels',
  setup: 'Setups',
  swing: 'Swing points',
  structure: 'BOS, CHOCH and MSS',
  sweep: 'Sweeps and thin-book wicks',
};

export const LEVEL_LABELS: Record<LevelType, string> = {
  eqh: 'EQH',
  eql: 'EQL',
  pdh: 'PDH',
  pdl: 'PDL',
  pwh: 'PWH',
  pwl: 'PWL',
  pmh: 'PMH',
  pml: 'PML',
  session_high: 'Session high',
  session_low: 'Session low',
  range_high: 'Range high',
  range_low: 'Range low',
  weekend_high: 'Weekend high',
  weekend_low: 'Weekend low',
  swing_high: 'Swing high',
  swing_low: 'Swing low',
  sweep_extreme: 'Sweep extreme',
};

const SESSION_NAMES = { asia: 'Asia', london: 'London', new_york: 'New York' } as const;

export const ZONE_LABELS: Record<ZoneType, string> = {
  order_block: 'OB',
  fvg: 'FVG',
  supply: 'Supply',
  demand: 'Demand',
};

export const PATTERN_SHORT: Record<Pattern, string> = {
  double_liquidity_trap: 'P1',
  eq_near_poi: 'P2',
  htf_order_block: 'P3',
  sweep_outside_fill_inside: 'P4',
};

export const PATTERN_NAMES_LONG: Record<Pattern, string> = {
  double_liquidity_trap: 'Pattern 1: double liquidity trap',
  eq_near_poi: 'Pattern 2: equal highs or lows near a POI',
  htf_order_block: 'Pattern 3: higher-timeframe order block',
  sweep_outside_fill_inside: 'Pattern 4: sweep outside, fill inside',
};

export type SetupLineRole = 'entry' | 'invalidation' | 'target1' | 'target2';

interface Base {
  id: string;
  /** Short label drawn on the chart. */
  label: string;
  /** A sentence for the chart's table (its text alternative). */
  description: string;
}

export type OverlayItem =
  | (Base & { kind: 'closure'; from: number; to: number })
  | (Base & { kind: 'range'; from: number; to: number; high: string; low: string })
  | (Base & {
      kind: 'zone';
      from: number;
      to: number;
      top: string;
      bottom: string;
      zone: PoiZone;
    })
  | (Base & {
      kind: 'level';
      from: number;
      to: number;
      price: string;
      status: string;
      side: 'buy_side' | 'sell_side';
    })
  | (Base & {
      kind: 'setup';
      from: number;
      to: number;
      direction: 'bullish' | 'bearish';
      /** Where the start marker sits: the setup candle's low (bullish) or high (bearish). */
      anchor: string;
      lines: { role: SetupLineRole; price: string }[];
      setup: SetupSummary;
    })
  | (Base & { kind: 'swing'; at: number; price: string; side: 'high' | 'low' })
  | (Base & {
      kind: 'structure';
      at: number;
      price: string;
      from: number | null;
      type: 'bos' | 'choch' | 'mss';
      direction: 'bullish' | 'bearish';
    })
  | (Base & {
      kind: 'sweep';
      /** Where the marker sits: the confirming candle (the API windows sweeps by it). */
      at: number;
      price: string;
      side: 'buy_side' | 'sell_side';
      thinBook: boolean;
    });

/** The chart's window: its first candle's open to its last candle's close. */
export interface ChartWindow {
  from: number;
  to: number;
}

export interface CandleRef {
  t: number;
  h: string;
  l: string;
}

/** The overlay as items, in drawing order (background first). */
export function overlayItems(
  overlay: ChartOverlay,
  candles: readonly CandleRef[],
  tf: Tf,
  fmtTime: (ms: number) => string = (ms) => new Date(ms).toISOString(),
): OverlayItem[] {
  if (candles.length === 0) return [];
  const win: ChartWindow = { from: candles[0]!.t, to: candles.at(-1)!.t + TF_MS[tf] };
  const end = (t: number | null) => Math.min(t ?? win.to, win.to);
  const out: OverlayItem[] = [];

  for (const c of overlay.closures)
    out.push({
      kind: 'closure',
      id: `closure:${c.from}`,
      from: c.from,
      to: c.to,
      label: 'Gold market closed',
      description: `Gold market closed (${c.reason.replace('_', ' ')}) from ${fmtTime(c.from)} to ${fmtTime(c.to)}`,
    });

  for (const r of overlay.ranges)
    out.push({
      kind: 'range',
      id: r.id,
      from: r.windowStart,
      to: end(r.endedAt),
      high: r.high,
      low: r.low,
      label: 'Range',
      description: `Range ${r.low}–${r.high} from ${fmtTime(r.windowStart)}${r.endedAt ? ` to ${fmtTime(r.endedAt)} (${(r.endReason ?? 'ended').replace('_', ' ')})` : ', still active'}`,
    });

  for (const z of overlay.zones) {
    const ended = (z.status === 'invalidated' || z.status === 'expired') && z.statusChangedAt !== null;
    const name = `${z.htf && z.type === 'order_block' ? 'HTF ' : ''}${ZONE_LABELS[z.type]}`;
    const fill =
      z.status === 'untouched' ? 'untouched' : `${z.status.replace('_', ' ')}, ${z.fillPct}% filled`;
    out.push({
      kind: 'zone',
      id: z.id,
      from: z.originFrom,
      to: end(ended ? z.statusChangedAt : null),
      top: z.top,
      bottom: z.bottom,
      zone: z,
      label: z.status === 'untouched' ? name : `${name} ${z.fillPct}%`,
      description: `${z.direction === 'bullish' ? 'Bullish' : 'Bearish'} ${name} ${z.bottom}–${z.top} (${z.tf}), ${fill}`,
    });
  }

  for (const l of overlay.levels) {
    const name =
      l.sessionName && (l.type === 'session_high' || l.type === 'session_low')
        ? `${SESSION_NAMES[l.sessionName]} ${l.type === 'session_high' ? 'high' : 'low'}`
        : LEVEL_LABELS[l.type];
    out.push({
      kind: 'level',
      id: l.id,
      from: l.knownAt,
      to: end(l.status !== 'active' ? l.statusChangedAt : null),
      price: l.price,
      status: l.status,
      side: l.side,
      label: name,
      description: `${name} at ${l.price} (${l.tf}), ${l.status}${l.touches > 1 ? `, ${l.touches} touches` : ''}`,
    });
  }

  for (const s of overlay.setups) {
    const lines: { role: SetupLineRole; price: string }[] = [];
    for (const role of ['entry', 'invalidation', 'target1', 'target2'] as const) {
      const price = s.levels[role];
      if (price !== null) lines.push({ role, price });
    }
    const start = candles.find((c) => c.t + TF_MS[tf] >= s.createdAt) ?? candles[0]!;
    const short = `${PATTERN_SHORT[s.pattern]}${s.variant ?? ''}`;
    out.push({
      kind: 'setup',
      id: s.id,
      from: s.createdAt,
      to: end(s.resolvedAt),
      direction: s.direction,
      anchor: s.direction === 'bullish' ? start.l : start.h,
      lines,
      setup: s,
      label: `${short} ${s.displayLabel}`,
      description: `${PATTERN_NAMES_LONG[s.pattern]}${s.variant ? ` (variant ${s.variant})` : ''}, ${s.direction}, ${s.displayLabel.toLowerCase()}, score ${s.score}${
        lines.length
          ? `; ${lines.map((l) => `${l.role === 'target1' ? 'T1' : l.role === 'target2' ? 'T2' : l.role} ${l.price}`).join(', ')}`
          : ''
      }`,
    });
  }

  for (const s of overlay.swings)
    out.push({
      kind: 'swing',
      id: s.id,
      at: s.candleTime,
      price: s.price,
      side: s.kind,
      label: s.kind === 'high' ? 'H' : 'L',
      description: `${s.level === 'external' ? 'External' : 'Internal'} swing ${s.kind} at ${s.price}, ${fmtTime(s.candleTime)}`,
    });

  const swingTime = new Map(overlay.swings.map((s) => [s.id, s.candleTime]));
  for (const e of overlay.structure)
    out.push({
      kind: 'structure',
      id: e.id,
      at: e.breakCandleTime,
      price: e.breakPrice,
      from: e.brokenSwingId ? (swingTime.get(e.brokenSwingId) ?? null) : null,
      type: e.type,
      direction: e.direction,
      label: e.type.toUpperCase(),
      description: `${e.direction === 'bullish' ? 'Bullish' : 'Bearish'} ${e.type.toUpperCase()} (${e.level}) through ${e.breakPrice}, ${fmtTime(e.breakCandleTime)}`,
    });

  for (const s of overlay.sweeps) {
    const thinBook = s.flags.includes('thin_book');
    out.push({
      kind: 'sweep',
      id: s.id,
      at: s.confirmedAt - 1,
      price: s.extremePrice,
      side: s.side,
      thinBook,
      label: thinBook ? 'Thin book' : s.kind === 'false_breakout' ? 'False breakout' : 'Sweep',
      description: `${thinBook ? 'Thin-book wick' : s.kind === 'false_breakout' ? 'False breakout' : 'Sweep'} of the ${LEVEL_LABELS[s.levelType]} at ${s.levelPrice}, reaching ${s.extremePrice}, ${fmtTime(s.breachAt)}`,
    });
  }
  return out;
}

/** What the test hook records for a drawn item: its identity and the values it was drawn from. */
export type DrawnRecord = { kind: OverlayKind; id: string } & Record<
  string,
  string | number | boolean | null
>;

export function drawnRecord(item: OverlayItem): DrawnRecord {
  switch (item.kind) {
    case 'closure':
      return { kind: item.kind, id: item.id, from: item.from, to: item.to };
    case 'range':
      return { kind: item.kind, id: item.id, from: item.from, high: item.high, low: item.low };
    case 'zone':
      return {
        kind: item.kind,
        id: item.id,
        from: item.from,
        top: item.top,
        bottom: item.bottom,
        status: item.zone.status,
        fillPct: item.zone.fillPct,
      };
    case 'level':
      return { kind: item.kind, id: item.id, from: item.from, price: item.price, status: item.status };
    case 'setup': {
      const price = (role: SetupLineRole) => item.lines.find((l) => l.role === role)?.price ?? null;
      return {
        kind: item.kind,
        id: item.id,
        state: item.setup.state,
        entry: price('entry'),
        invalidation: price('invalidation'),
        target1: price('target1'),
        target2: price('target2'),
      };
    }
    case 'swing':
      return { kind: item.kind, id: item.id, at: item.at, price: item.price, side: item.side };
    case 'structure':
      return { kind: item.kind, id: item.id, at: item.at, price: item.price, type: item.type };
    case 'sweep':
      return { kind: item.kind, id: item.id, at: item.at + 1, price: item.price, thinBook: item.thinBook };
  }
}
