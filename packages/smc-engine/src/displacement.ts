import type { SmcParams } from './params.js';
import type { Ring } from './ring.js';
import type { Slot } from './slot.js';
import type { Direction } from './types.js';

/** A displacement found in a leg, by slot index (rulebook §2.3). */
export interface FoundDisplacement {
  from: number;
  to: number;
  bodyAtr: number;
}

const moves = (s: Slot, dir: Direction) => (dir === 'bullish' ? s.c > s.o : s.c < s.o);

/**
 * The strongest displacement in the leg [from, to] (slot indices, inclusive) in direction `dir`:
 *
 * - **Single candle**: it moves in `dir`, body ≥ candleBodyAtr × ATR at its close, body/range ≥ candleBodyRatio.
 * - **Leg**: legMinCandles to legMaxCandles consecutive candles moving in `dir`, each with
 *   body/range ≥ legCandleBodyRatio, total body ≥ legBodyAtr × ATR at the last candle's close.
 *
 * "Strongest" is the largest body in ATR; ties go to the earliest start, then the shortest. Only
 * retained, gap-free candles count. Null when there is none.
 */
export function findDisplacement(
  ring: Ring<Slot>,
  dir: Direction,
  from: number,
  to: number,
  p: SmcParams['displacement'],
): FoundDisplacement | null {
  let best: FoundDisplacement | null = null;
  const consider = (cand: FoundDisplacement) => {
    if (
      !best ||
      cand.bodyAtr > best.bodyAtr ||
      (cand.bodyAtr === best.bodyAtr &&
        (cand.from < best.from || (cand.from === best.from && cand.to < best.to)))
    )
      best = cand;
  };
  const start = Math.max(from, ring.first);
  for (let i = start; i <= to; i++) {
    const s = ring.get(i);
    if (!s || s.gap || s.atr === null || s.atr <= 0) continue;
    const range = s.h - s.l;
    const body = Math.abs(s.c - s.o);
    if (moves(s, dir) && body >= p.candleBodyAtr * s.atr && body >= p.candleBodyRatio * range)
      consider({ from: i, to: i, bodyAtr: body / s.atr });
    let total = 0;
    for (let len = 1; len <= p.legMaxCandles; len++) {
      const j = i - len + 1;
      if (j < start) break;
      const x = ring.get(j)!;
      if (x.gap || !moves(x, dir)) break;
      const xBody = Math.abs(x.c - x.o);
      if (xBody < p.legCandleBodyRatio * (x.h - x.l)) break;
      total += xBody;
      if (len >= p.legMinCandles && total >= p.legBodyAtr * s.atr)
        consider({ from: j, to: i, bodyAtr: total / s.atr });
    }
  }
  return best;
}

/**
 * Whether an FVG in direction `dir` (rulebook §4.2) has its middle candle in [from, to] and its
 * third candle at or before `last` (the break candle: later candles are not known yet). Bullish:
 * L(i+1) − H(i−1) ≥ minSizeAtr × ATR at the close of i+1; bearish mirrors it.
 */
export function createdFvg(
  ring: Ring<Slot>,
  dir: Direction,
  from: number,
  to: number,
  last: number,
  minSizeAtr: number,
): boolean {
  for (let i = Math.max(from, ring.first + 1); i <= to && i + 1 <= last; i++) {
    const a = ring.get(i - 1);
    const b = ring.get(i);
    const c = ring.get(i + 1);
    if (!a || !b || !c || a.gap || b.gap || c.gap || c.atr === null) continue;
    const size = dir === 'bullish' ? c.l - a.h : a.l - c.h;
    if (size > 0 && size >= minSizeAtr * c.atr) return true;
  }
  return false;
}
