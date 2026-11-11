import type { Timeframe } from '@cip/domain';
import type { SmcParams } from './params.js';
import type { Ring } from './ring.js';
import { contiguous, type Slot } from './slot.js';
import type { Direction, EngineFlag, Location, ZoneStatus, ZoneStatusData, ZoneType } from './types.js';

/**
 * A point of interest the engine tracks (rulebook §4). Prices are in units. Bullish zones (demand,
 * bullish order blocks and FVGs) are approached from above: the top is the proximal edge and the
 * bottom the distal edge. Bearish zones mirror this.
 */
export interface Zone {
  key: string;
  tf: Timeframe;
  type: ZoneType;
  direction: Direction;
  top: number;
  bottom: number;
  /** Open times of its first and last candle. */
  originFrom: number;
  originTo: number;
  knownAt: number;
  htf: boolean;
  location: Location;
  structureEvent: string | null;
  linkedZone: string | null;
  sweptLiquidityAtOrigin: boolean;
  status: ZoneStatus;
  /** The deepest penetration from the proximal edge so far, in units (at most the height). */
  depth: number;
  firstTouchAt: number | null;
  statusChangedAt: number | null;
  flags: EngineFlag[];
  expiresAt: number;
}

export const zoneKey = (tf: Timeframe, type: ZoneType, direction: Direction, originFrom: number) =>
  `zn:${tf}:${type}:${direction === 'bullish' ? 'bu' : 'be'}:${originFrom}`;

/** Still tracked for touches and fills: not invalidated and not expired. */
export const isLive = (z: Pick<Zone, 'status'>) =>
  z.status === 'untouched' || z.status === 'partially_filled' || z.status === 'filled';

/**
 * §4.4 fillPct: the deepest penetration in % of the height, floored to 0.01 (100 only at the far
 * edge). Exact: prices are whole units, so the ratio is taken in integers (a float ratio would read
 * 29 % as 28.99).
 */
export function fillPct(z: Pick<Zone, 'top' | 'bottom' | 'depth'>): number {
  const height = BigInt(z.top - z.bottom);
  const depth = BigInt(Math.min(z.depth, z.top - z.bottom));
  return Number((depth * 10_000n) / height) / 100;
}

/**
 * §4.4 for one candle of the zone's timeframe (never the candle that created it). A candle touches
 * a bullish zone when its low reaches the top (the proximal edge); the fill deepens to the lowest
 * low, up to the bottom (`filled`); a close below the bottom (the distal edge) invalidates it.
 * Bearish zones mirror this. Statuses only move forward. Returns why the zone changed, or null.
 */
export function updateZone(z: Zone, s: Slot, time: number): ZoneStatusData['reason'] | null {
  const bullish = z.direction === 'bullish';
  const height = z.top - z.bottom;
  const reach = bullish ? z.top - s.l : s.h - z.bottom;
  // A close beyond the distal edge implies the candle reached the proximal edge.
  if (reach < 0) return null;
  const invalid = bullish ? s.c < z.bottom : s.c > z.top;
  const firstTouch = z.firstTouchAt === null;
  if (firstTouch) z.firstTouchAt = time;
  const depth = Math.min(reach, height);
  const deeper = depth > z.depth;
  if (deeper) z.depth = depth;
  const status: ZoneStatus = invalid ? 'invalidated' : z.depth >= height ? 'filled' : 'partially_filled';
  if (status !== z.status) {
    z.status = status;
    z.statusChangedAt = time;
  }
  if (invalid) return 'invalidated';
  if (firstTouch) return 'touch';
  return deeper ? 'fill' : null;
}

/**
 * §4.5 for a zone: with an active range on its timeframe, `internal` when it lies within the
 * range's high and low, `external` when it lies entirely at or beyond one of them, `straddling`
 * otherwise; `none` without a range.
 */
export function locateZone(
  top: number,
  bottom: number,
  range: { high: number; low: number } | null,
): Location {
  if (!range) return 'none';
  if (bottom >= range.low && top <= range.high) return 'internal';
  if (top <= range.low || bottom >= range.high) return 'external';
  return 'straddling';
}

/** The overlap of two zones as a share of the smaller one's height (§4.3 linking). */
export function overlapShare(a: Pick<Zone, 'top' | 'bottom'>, b: Pick<Zone, 'top' | 'bottom'>): number {
  const overlap = Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom);
  if (overlap <= 0) return 0;
  return overlap / Math.min(a.top - a.bottom, b.top - b.bottom);
}

/** A zone a detection rule found: slot indices of its first and last candle, prices in units. */
export interface FoundZone {
  direction: Direction;
  from: number;
  to: number;
  top: number;
  bottom: number;
}

/**
 * §4.2: the fair value gap whose third candle is slot `n`. Bullish when L(n) > H(n−2), zone
 * [H(n−2), L(n)]; bearish when H(n) < L(n−2), zone [H(n), L(n−2)]; at least minSizeAtr × ATR at
 * the third candle's close. The three candles must be contiguous.
 */
export function findFvg(ring: Ring<Slot>, n: number, minSizeAtr: number): FoundZone | null {
  if (!contiguous(ring, n - 2, n)) return null;
  const a = ring.get(n - 2)!;
  const c = ring.get(n)!;
  if (c.atr === null) return null;
  const min = minSizeAtr * c.atr;
  if (c.l > a.h && c.l - a.h >= min)
    return { direction: 'bullish', from: n - 2, to: n, top: c.l, bottom: a.h };
  if (c.h < a.l && a.l - c.h >= min)
    return { direction: 'bearish', from: n - 2, to: n, top: a.l, bottom: c.h };
  return null;
}

const closesUp = (s: Slot) => s.c > s.o;
const closesDown = (s: Slot) => s.c < s.o;

/**
 * §4.1: the order block of a break in `direction` whose leg starts at slot `legStart`. Bearish: the
 * last up-close candle among the leg-start candle and the `lookback − 1` candles before it, with the
 * up-close candles directly before it as one cluster of at most `maxClusterCandles`. Zone: the
 * cluster's highest high and lowest low (`wick`), or its bodies (`body`). Bullish mirrors this with
 * down-close candles. Null when there is none, or a gap comes first.
 */
export function findOrderBlock(
  ring: Ring<Slot>,
  direction: Direction,
  legStart: number,
  p: SmcParams['orderBlocks'],
): FoundZone | null {
  const opposite = direction === 'bearish' ? closesUp : closesDown;
  let ob = -1;
  for (let i = legStart; i > legStart - p.lookback; i--) {
    const s = ring.get(i);
    if (!s || s.gap) return null;
    if (opposite(s)) {
      ob = i;
      break;
    }
  }
  if (ob < 0) return null;
  let from = ob;
  while (ob - from + 1 < p.maxClusterCandles) {
    const s = ring.get(from - 1);
    if (!s || s.gap || !opposite(s)) break;
    from--;
  }
  let top = -Infinity;
  let bottom = Infinity;
  for (let i = from; i <= ob; i++) {
    const s = ring.get(i)!;
    top = Math.max(top, p.zoneMode === 'wick' ? s.h : Math.max(s.o, s.c));
    bottom = Math.min(bottom, p.zoneMode === 'wick' ? s.l : Math.min(s.o, s.c));
  }
  return top > bottom ? { direction, from, to: ob, top, bottom } : null;
}

const moves = (s: Slot, dir: Direction) => (dir === 'bullish' ? s.c > s.o : s.c < s.o);

/**
 * Starts of the displacements in `dir` (§2.3) that end at slot `n`, longest first: legs of
 * legMaxCandles down to legMinCandles candles, then candle n alone. ATR is taken at n's close.
 */
export function displacementStarts(
  ring: Ring<Slot>,
  dir: Direction,
  n: number,
  p: SmcParams['displacement'],
): number[] {
  const last = ring.get(n);
  if (!last || last.gap || last.atr === null || last.atr <= 0) return [];
  const atr = last.atr;
  const out: number[] = [];
  for (let len = p.legMaxCandles; len >= p.legMinCandles; len--) {
    const from = n - len + 1;
    let total = 0;
    let ok = true;
    for (let i = from; i <= n && ok; i++) {
      const x = ring.get(i);
      if (!x || x.gap || !moves(x, dir) || Math.abs(x.c - x.o) < p.legCandleBodyRatio * (x.h - x.l))
        ok = false;
      else total += Math.abs(x.c - x.o);
    }
    if (ok && total >= p.legBodyAtr * atr) out.push(from);
  }
  const body = Math.abs(last.c - last.o);
  if (moves(last, dir) && body >= p.candleBodyAtr * atr && body >= p.candleBodyRatio * (last.h - last.l))
    out.push(n);
  return out;
}

/**
 * §4.3: the supply or demand zone whose departure ends at slot `n`. The departure is a displacement
 * ending at n (longest first). Its base is the run of small-bodied candles (body ≤ baseBodyAtr × ATR
 * at each candle's close) ending right before the departure, or, when that candle is not small, one
 * candle earlier; at most the last baseMaxCandles of the run. The departure must travel
 * departureAtr × ATR (at n) beyond the base: for demand, its highest high above the base's.
 * Demand: proximal (top) = the highest body top in the base, distal (bottom) = its lowest low.
 * Supply mirrors this.
 */
export function findSupplyDemand(
  ring: Ring<Slot>,
  n: number,
  d: SmcParams['displacement'],
  sd: SmcParams['supplyDemand'],
): FoundZone | null {
  const last = ring.get(n);
  if (!last || last.gap || last.atr === null) return null;
  const small = (i: number) => {
    const x = ring.get(i);
    return !!x && !x.gap && x.atr !== null && Math.abs(x.c - x.o) <= sd.baseBodyAtr * x.atr;
  };
  for (const dir of ['bullish', 'bearish'] as const) {
    for (const from of displacementStarts(ring, dir, n, d)) {
      const end = small(from - 1) ? from - 1 : from - 2;
      if (!small(end)) continue;
      let start = end;
      while (end - start + 1 < sd.baseMaxCandles && small(start - 1)) start--;
      if (!contiguous(ring, start, n)) continue;
      let baseHigh = -Infinity;
      let baseLow = Infinity;
      let bodyTop = -Infinity;
      let bodyBottom = Infinity;
      for (let i = start; i <= end; i++) {
        const x = ring.get(i)!;
        baseHigh = Math.max(baseHigh, x.h);
        baseLow = Math.min(baseLow, x.l);
        bodyTop = Math.max(bodyTop, Math.max(x.o, x.c));
        bodyBottom = Math.min(bodyBottom, Math.min(x.o, x.c));
      }
      let moveHigh = -Infinity;
      let moveLow = Infinity;
      for (let i = from; i <= n; i++) {
        const x = ring.get(i)!;
        moveHigh = Math.max(moveHigh, x.h);
        moveLow = Math.min(moveLow, x.l);
      }
      const travel = dir === 'bullish' ? moveHigh - baseHigh : baseLow - moveLow;
      if (travel < sd.departureAtr * last.atr) continue;
      const zone =
        dir === 'bullish'
          ? { direction: dir, from: start, to: end, top: bodyTop, bottom: baseLow }
          : { direction: dir, from: start, to: end, top: baseHigh, bottom: bodyBottom };
      if (zone.top > zone.bottom) return zone;
    }
  }
  return null;
}
