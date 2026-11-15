import type { Slot } from './slot.js';
import type { Direction } from './types.js';

/** A price at a candle (slot index). */
export interface Extreme {
  price: number;
  index: number;
}

/**
 * A level structure can break, with the extreme its breaking leg would start from (rulebook §2.2):
 * for a high, the lowest low since it formed; for a low, the highest high.
 */
export interface Anchor extends Extreme {
  /** Swing key, or null for a protected level that is a plain extreme (no swing formed). */
  key: string | null;
  leg: Extreme;
}

export interface SwingRef extends Extreme {
  key: string;
}

/** Structure on one timeframe at one swing order (internal or external). */
export interface StructState {
  trend: 'undefined' | Direction;
  /** Latest confirmed, unbroken swing high; its leg is the lowest low after its candle. */
  refHigh: Anchor | null;
  refLow: Anchor | null;
  /** Bullish trend: its leg is the highest high since it was set. */
  protectedLow: Anchor | null;
  protectedHigh: Anchor | null;
  /** The latest confirmed swings, broken or not. */
  lastHigh: SwingRef | null;
  lastLow: SwingRef | null;
  /** Slot index of the latest break; −1 before the first. */
  prevBreak: number;
  /** Extremes over the candles after the latest break. */
  sinceHigh: Extreme | null;
  sinceLow: Extreme | null;
}

export const newStructState = (): StructState => ({
  trend: 'undefined',
  refHigh: null,
  refLow: null,
  protectedLow: null,
  protectedHigh: null,
  lastHigh: null,
  lastLow: null,
  prevBreak: -1,
  sinceHigh: null,
  sinceLow: null,
});

// Ties go to the latest candle: a leg starts where price was last at its extreme.
const lower = (e: Extreme | null, price: number, index: number): Extreme =>
  e === null || price <= e.price ? { price, index } : e;
const higher = (e: Extreme | null, price: number, index: number): Extreme =>
  e === null || price >= e.price ? { price, index } : e;

/** Takes candle `n` into every tracked extreme. */
export function extendExtremes(st: StructState, s: Slot, n: number): void {
  if (st.refHigh) st.refHigh.leg = lower(st.refHigh.leg, s.l, n);
  if (st.refLow) st.refLow.leg = higher(st.refLow.leg, s.h, n);
  if (st.protectedLow) st.protectedLow.leg = higher(st.protectedLow.leg, s.h, n);
  if (st.protectedHigh) st.protectedHigh.leg = lower(st.protectedHigh.leg, s.l, n);
  st.sinceHigh = higher(st.sinceHigh, s.h, n);
  st.sinceLow = lower(st.sinceLow, s.l, n);
}

/**
 * A newly confirmed swing becomes the reference level on its side. `leg` is the opposite extreme
 * over the candles after the swing candle, up to the current one.
 */
export function takeSwing(st: StructState, swing: SwingRef, kind: 'high' | 'low', leg: Extreme): void {
  if (kind === 'high') {
    st.refHigh = { ...swing, leg };
    st.lastHigh = swing;
  } else {
    st.refLow = { ...swing, leg };
    st.lastLow = swing;
  }
}

/** What a close does to structure, before displacement is known. */
export interface Break {
  direction: Direction;
  type: 'bos' | 'choch';
  isInitial: boolean;
  anchor: Anchor;
}

/**
 * The break caused by close `c` (rulebook §2.2 table), with ε the break buffer in price units.
 * Also forgets reference levels the close broke without a structure event (a pullback through
 * the latest swing inside a trend).
 */
export function testBreak(st: StructState, c: number, eps: number): Break | null {
  const above = (a: Anchor | null) => a !== null && c >= a.price + eps;
  const below = (a: Anchor | null) => a !== null && c <= a.price - eps;
  if (st.trend === 'bullish') {
    if (below(st.protectedLow))
      return { direction: 'bearish', type: 'choch', isInitial: false, anchor: st.protectedLow! };
    if (above(st.refHigh))
      return { direction: 'bullish', type: 'bos', isInitial: false, anchor: st.refHigh! };
    if (below(st.refLow)) st.refLow = null;
    return null;
  }
  if (st.trend === 'bearish') {
    if (above(st.protectedHigh))
      return { direction: 'bullish', type: 'choch', isInitial: false, anchor: st.protectedHigh! };
    if (below(st.refLow)) return { direction: 'bearish', type: 'bos', isInitial: false, anchor: st.refLow! };
    if (above(st.refHigh)) st.refHigh = null;
    return null;
  }
  if (above(st.refHigh)) return { direction: 'bullish', type: 'bos', isInitial: true, anchor: st.refHigh! };
  if (below(st.refLow)) return { direction: 'bearish', type: 'bos', isInitial: true, anchor: st.refLow! };
  return null;
}

/**
 * The state after break `b` at candle `n` (slot `s`): the new trend, and the new protected level,
 * which is the most recent swing on the other side that formed after the previous break, or else
 * the extreme since that break (rulebook §2.2). Reference levels the close went through are spent.
 */
export function applyBreak(st: StructState, b: Break, s: Slot, n: number, eps: number): void {
  if (b.direction === 'bullish') {
    const swing = st.lastLow && st.lastLow.index > st.prevBreak ? st.lastLow : null;
    const base = swing ?? { key: null, ...st.sinceLow! };
    st.protectedLow = { key: base.key, price: base.price, index: base.index, leg: { price: s.h, index: n } };
    st.protectedHigh = null;
    st.trend = 'bullish';
    if (st.refHigh && s.c >= st.refHigh.price + eps) st.refHigh = null;
  } else {
    const swing = st.lastHigh && st.lastHigh.index > st.prevBreak ? st.lastHigh : null;
    const base = swing ?? { key: null, ...st.sinceHigh! };
    st.protectedHigh = { key: base.key, price: base.price, index: base.index, leg: { price: s.l, index: n } };
    st.protectedLow = null;
    st.trend = 'bearish';
    if (st.refLow && s.c <= st.refLow.price - eps) st.refLow = null;
  }
  st.prevBreak = n;
  st.sinceHigh = null;
  st.sinceLow = null;
}
