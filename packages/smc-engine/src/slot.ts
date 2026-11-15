import { Ring, type RingState } from './ring.js';

/**
 * One timeframe position in the engine's look-back: a closed candle in price units, or a gap.
 * `gap` covers both a missing candle and a partial one (minutes missing for good): rules never
 * span a gap (rulebook §9).
 */
export interface Slot {
  /** Open time. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** ATR at this candle's close, in price units; null in ATR's warm-up and for missing candles. */
  atr: number | null;
  gap: boolean;
  /** Overlaps a gold-market closure (rulebook §3.6). */
  uc: boolean;
}

/** A slot as stored in a checkpoint: `[t, o, h, l, c, atr, bits]` (bit 0 gap, bit 1 closed). */
export type SlotTuple = [number, number, number, number, number, number | null, number];

export const toTuple = (s: Slot): SlotTuple => [
  s.t,
  s.o,
  s.h,
  s.l,
  s.c,
  s.atr,
  (s.gap ? 1 : 0) | (s.uc ? 2 : 0),
];

export const fromTuple = ([t, o, h, l, c, atr, bits]: SlotTuple): Slot => ({
  t,
  o,
  h,
  l,
  c,
  atr,
  gap: (bits & 1) !== 0,
  uc: (bits & 2) !== 0,
});

export function snapshotSlots(ring: Ring<Slot>): RingState<SlotTuple> {
  const s = ring.snapshot();
  return { capacity: s.capacity, start: s.start, items: s.items.map(toTuple) };
}

export function restoreSlots(state: RingState<SlotTuple>): Ring<Slot> {
  return Ring.restore({ capacity: state.capacity, start: state.start, items: state.items.map(fromTuple) });
}

/** Every slot in [from, to] is retained and not a gap. */
export function contiguous(ring: Ring<Slot>, from: number, to: number): boolean {
  if (!ring.holds(from, to)) return false;
  for (let i = from; i <= to; i++) if (ring.get(i)!.gap) return false;
  return true;
}
