/**
 * Helpers for the synthetic golden fixtures (rulebook §12). A case is a hand-designed candle pattern
 * plus the detections the rulebook says it must (and must not) produce, worked out by hand from the
 * pattern's geometry, never by running the engine. Bearish cases are exact mirror images of bullish
 * ones: every rule is symmetric under p → 2M − p, so mirroring the candles mirrors the answer.
 */

export type Tf = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
export const TF_MS: Record<Tf, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

/** [open, high, low, close]; null is a missing candle (an unrepairable gap). */
export type Bar = [number, number, number, number];
export type Slot = Bar | null;

export type CaseClass = 'bullish' | 'bearish' | 'negative' | 'closure' | 'reopening' | 'thin_book' | 'other';

/**
 * An expected (or forbidden) event: its type, the index of the deciding candle on `tf` (the main
 * series by default), its entity key, and a partial match of its data.
 */
export interface Exp {
  type: string;
  at?: number;
  tf?: Tf;
  /** notExpected only: events decided at or before / at or after this candle index. */
  before?: number;
  after?: number;
  key?: string;
  data?: Record<string, unknown>;
}

export interface Series {
  tf: Tf;
  bars: Slot[];
  /** Extras per candle: a 1m micro profile, a partial candle, or the volume. */
  extras?: Record<number, { profile?: number[] | null; partial?: boolean; volume?: number }>;
}

export interface Case {
  id: string;
  concept: string;
  class: CaseClass;
  description: string;
  profile?: 'crypto-majors' | 'gold';
  params?: Record<string, unknown>;
  /** Epoch ms of candle 0 of the main series. */
  start: number;
  /** The main series: `at` indices refer to it. */
  main: Series;
  /** More timeframes, each starting at `start` unless given its own. */
  more?: (Series & { start?: number })[];
  closures?: { from: number; to: number; reason: 'weekend' | 'daily_break' | 'holiday' }[];
  expected: Exp[];
  notExpected?: Exp[];
  /** Event filters every matching event of which must be among `expected`. */
  exhaustive?: Record<string, unknown>[];
}

/** Monday 2026-01-05 00:00 UTC. */
export const MONDAY = Date.UTC(2026, 0, 5);

export const r2 = (x: number) => Math.round(x * 100) / 100;

/** A price as the venue writes it: at most 2 decimals here, no trailing zeros. */
export function fmt(x: number): string {
  return r2(x)
    .toFixed(2)
    .replace(/\.?0+$/, '');
}

/** Flat candles around `p`: high p + half, low p − half, so the true range is 2 × half. */
export const flat = (n: number, p = 100, half = 0.75): Bar[] =>
  Array.from({ length: n }, () => [p, p + half, p - half, p] as Bar);

/**
 * n candles stepping evenly from a to b. Each candle's wick reaches `wick` beyond its body on both
 * sides. With wick = |step| (the default "drift"), body/range is 1/3: never a displacement.
 */
export function run(a: number, b: number, n: number, wick?: number): Bar[] {
  const step = (b - a) / n;
  const w = wick ?? Math.abs(step);
  return Array.from({ length: n }, (_, j) => {
    const o = r2(a + step * j);
    const c = r2(a + step * (j + 1));
    return [o, r2(Math.max(o, c) + w), r2(Math.min(o, c) - w), c] as Bar;
  });
}

/** Runs through the given turning points: zig([100, 104, 102], [8, 4]). */
export function zig(points: number[], lens: number[], wick?: number): Bar[] {
  return points.slice(1).flatMap((p, i) => run(points[i]!, p, lens[i]!, wick));
}

/** A single candle. */
export const bar = (o: number, h: number, l: number, c: number): Bar => [o, h, l, c];

/** Index of the last candle of each run in a zig (the turning points). */
export function pivots(offset: number, lens: number[]): number[] {
  const out: number[] = [];
  let i = offset - 1;
  for (const n of lens) out.push((i += n));
  return out;
}

/** The first index from `from` whose close satisfies `test`. */
export function firstClose(bars: Slot[], from: number, test: (c: number) => boolean): number {
  for (let i = from; i < bars.length; i++) if (bars[i] && test(bars[i]![3])) return i;
  throw new Error('no such close');
}

const MIRROR_WORDS: Record<string, string> = {
  high: 'low',
  low: 'high',
  bullish: 'bearish',
  bearish: 'bullish',
  buy_side: 'sell_side',
  sell_side: 'buy_side',
  breakout_up: 'breakout_down',
  breakout_down: 'breakout_up',
};
const LEVEL_PAIRS: [string, string][] = [
  ['eqh', 'eql'],
  ['pdh', 'pdl'],
  ['pwh', 'pwl'],
  ['pmh', 'pml'],
  ['session_high', 'session_low'],
  ['range_high', 'range_low'],
  ['weekend_high', 'weekend_low'],
  ['swing_high', 'swing_low'],
  // Zone types (§4.3): a demand zone's mirror image is a supply zone.
  ['demand', 'supply'],
];
const LEVEL_MIRROR = new Map<string, string>(
  LEVEL_PAIRS.flatMap(([a, b]) => [
    [a, b],
    [b, a],
  ]),
);
const PRICE_FIELDS = new Set(['price', 'breakPrice', 'levelPrice', 'extremePrice', 'equilibrium']);
const KEY_FIELDS = new Set([
  'key',
  'level',
  'brokenSwing',
  'group',
  'sourceRefs',
  'droppedBreaches',
  'linkedZone',
  'structureEvent',
]);

/** Entity keys carry the side: `lv:4h:swing_low:s:…` ↔ `lv:4h:swing_high:b:…`, `sw:…:h:…` ↔ `…:l:…`. */
export function mirrorKey(key: string): string {
  const p = key.split(':');
  const flip = (x: string) => (x === 'b' ? 's' : x === 's' ? 'b' : x === 'h' ? 'l' : x === 'l' ? 'h' : x);
  switch (p[0]) {
    case 'lv':
      return [p[0], p[1], LEVEL_MIRROR.get(p[2]!) ?? p[2], flip(p[3]!), ...p.slice(4)].join(':');
    case 'sw':
      return [p[0], p[1], p[2], flip(p[3]!), ...p.slice(4)].join(':');
    case 'sg':
      return [p[0], p[1], flip(p[2]!), ...p.slice(3)].join(':');
    case 'sp': {
      // sp:{tf}:{level key, 5 parts}:{breach time}
      const level = p.slice(2, 7).join(':');
      return [p[0], p[1], mirrorKey(level), ...p.slice(7)].join(':');
    }
    case 'zn':
      // zn:{tf}:{type}:{bu|be}:{origin}
      return [p[0], p[1], LEVEL_MIRROR.get(p[2]!) ?? p[2], p[3] === 'bu' ? 'be' : 'bu', ...p.slice(4)].join(
        ':',
      );
    default:
      return key;
  }
}

function mirrorValue(field: string, v: unknown, m: number): unknown {
  if (Array.isArray(v)) return v.map((x) => mirrorValue(field, x, m));
  if (v && typeof v === 'object') return mirrorFields(v as Record<string, unknown>, m);
  if (typeof v === 'string' && KEY_FIELDS.has(field)) return mirrorKey(v);
  if (PRICE_FIELDS.has(field) && (typeof v === 'string' || typeof v === 'number'))
    return typeof v === 'string' ? fmt(2 * m - Number(v)) : r2(2 * m - v);
  if (typeof v === 'string' && field === 'levelType') return LEVEL_MIRROR.get(v) ?? v;
  if (typeof v === 'string' && v in MIRROR_WORDS) return MIRROR_WORDS[v];
  return v;
}

/** Mirrors an expectation's fields (not its event type). */
export function mirrorFields(o: Record<string, unknown>, m: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if ((k === 'high' || k === 'low') && typeof v === 'string')
      out[k === 'high' ? 'low' : 'high'] = fmt(2 * m - Number(v));
    // A zone's edges swap: the mirror of its top is the new bottom.
    else if ((k === 'top' || k === 'bottom') && typeof v === 'string')
      out[k === 'top' ? 'bottom' : 'top'] = fmt(2 * m - Number(v));
    else if (k === 'type' && typeof v === 'string') out[k] = LEVEL_MIRROR.get(v) ?? v;
    else if (k === 'notionalBeyondUsd' && typeof v === 'string' && typeof o.levelPrice === 'string')
      // Notional = volume beyond × level price: the volume stays, the price is mirrored.
      out[k] = ((Number(v) / Number(o.levelPrice)) * (2 * m - Number(o.levelPrice))).toFixed(2);
    else out[k] = mirrorValue(k, v, m);
  }
  return out;
}

const mirrorBar = (b: Slot, m: number): Slot =>
  b ? [r2(2 * m - b[0]), r2(2 * m - b[2]), r2(2 * m - b[1]), r2(2 * m - b[3])] : null;

/** The bearish (or bullish) twin of a case: candles reflected around m, expectations likewise. */
export function mirror(c: Case, id: string, m = 100): Case {
  // A micro profile runs from low to high, so the mirror reverses its buckets.
  const series = <S extends Series>(s: S): S => ({
    ...s,
    bars: s.bars.map((b) => mirrorBar(b, m)),
    extras: s.extras
      ? Object.fromEntries(
          Object.entries(s.extras).map(([i, x]) => [
            i,
            x.profile ? { ...x, profile: [...x.profile].reverse() } : x,
          ]),
        )
      : undefined,
  });
  const exp = (e: Exp): Exp => ({
    ...e,
    key: e.key === undefined ? undefined : mirrorKey(e.key),
    data: e.data === undefined ? undefined : mirrorFields(e.data, m),
  });
  return {
    ...c,
    id,
    class: c.class === 'bullish' ? 'bearish' : c.class === 'bearish' ? 'bullish' : c.class,
    description: `Mirror image of ${c.id}. ${c.description}`,
    main: series(c.main),
    more: c.more?.map(series),
    expected: c.expected.map(exp),
    notExpected: c.notExpected?.map(exp),
    exhaustive: c.exhaustive?.map((f) => mirrorFields(f, m)),
  };
}

/**
 * Rulebook §2.1, word for word, for the swing fixtures: candle i is a swing high of order k when its
 * high is above each of the k highs before it and at least each of the k after it, with no missing
 * candle in the 2k + 1 window. Confirmed at the close of i + k.
 */
export function refSwings(bars: Slot[], k: number, kind: 'high' | 'low'): { index: number; price: number }[] {
  const out: { index: number; price: number }[] = [];
  const v = (b: Bar) => (kind === 'high' ? b[1] : b[2]);
  for (let i = k; i + k < bars.length; i++) {
    const w = bars.slice(i - k, i + k + 1);
    if (w.some((b) => b === null)) continue;
    const x = v(bars[i]!);
    const before = w.slice(0, k).map((b) => v(b!));
    const after = w.slice(k + 1).map((b) => v(b!));
    const ok =
      kind === 'high'
        ? before.every((y) => x > y) && after.every((y) => x >= y)
        : before.every((y) => x < y) && after.every((y) => x <= y);
    if (ok) out.push({ index: i, price: x });
  }
  return out;
}

/** Candle times on one timeframe from `start`. */
export function timeline(start: number, tf: Tf) {
  const size = TF_MS[tf];
  return {
    open: (i: number) => start + i * size,
    close: (i: number) => start + (i + 1) * size,
    iso: (i: number) => new Date(start + i * size).toISOString(),
    isoClose: (i: number) => new Date(start + (i + 1) * size).toISOString(),
  };
}

/** Natural keys, as the engine writes them. */
export const keys = {
  swing: (tf: Tf, level: 'internal' | 'external', kind: 'high' | 'low', openMs: number) =>
    `sw:${tf}:${level === 'internal' ? 'int' : 'ext'}:${kind === 'high' ? 'h' : 'l'}:${openMs}`,
  level: (tf: Tf, type: string, side: 'buy_side' | 'sell_side', knownAt: number) =>
    `lv:${tf}:${type}:${side === 'buy_side' ? 'b' : 's'}:${knownAt}`,
  range: (tf: Tf, detectedAt: number) => `rg:${tf}:${detectedAt}`,
  zone: (tf: Tf, type: string, direction: 'bullish' | 'bearish', originFrom: number) =>
    `zn:${tf}:${type}:${direction === 'bullish' ? 'bu' : 'be'}:${originFrom}`,
  structure: (tf: Tf, level: 'internal' | 'external', type: string, breakOpen: number) =>
    `st:${tf}:${level === 'internal' ? 'int' : 'ext'}:${type}:${breakOpen}`,
};

/** Candles of a timeframe `factor` times longer: complete groups only (a group with a hole is null). */
export function agg(bars: Slot[], factor: number): Slot[] {
  const out: Slot[] = [];
  for (let i = 0; i + factor <= bars.length; i += factor) {
    const g = bars.slice(i, i + factor);
    if (g.some((b) => b === null)) {
      out.push(null);
      continue;
    }
    const b = g as Bar[];
    out.push([b[0]![0], Math.max(...b.map((x) => x[1])), Math.min(...b.map((x) => x[2])), b.at(-1)![3]]);
  }
  return out;
}

/** The middle of a case's price span, rounded to a cent: its mirror image stays in the same place. */
export function centre(c: Case): number {
  const bars = c.main.bars.filter((b): b is Bar => b !== null);
  return r2((Math.max(...bars.map((b) => b[1])) + Math.min(...bars.map((b) => b[2]))) / 2);
}

/** Every bullish/bearish case also appears as its mirror image, reflected around its own centre. */
export function withMirrors(cases: Case[]): Case[] {
  return cases.flatMap((c) =>
    c.class === 'bullish' || c.class === 'bearish'
      ? [c, mirror(c, c.id.replace(/-(\d+)$/, '-mirror-$1'), centre(c))]
      : [c],
  );
}
