import { describe, expect, it } from 'vitest';
import { CRYPTO_MAJORS_SMC_PARAMS, type SmcParams, validateSmcParams } from './params.js';
import { Ring } from './ring.js';
import type { Slot } from './slot.js';
import {
  displacementStarts,
  fillPct,
  findFvg,
  findOrderBlock,
  findSupplyDemand,
  locateZone,
  overlapShare,
  updateZone,
  type Zone,
} from './zones.js';

/** Candles as [open, high, low, close], ATR 10 unless given, one minute apart. */
type Bar = [number, number, number, number] | [number, number, number, number, number | null] | 'gap';
function ring(bars: Bar[]): Ring<Slot> {
  const r = new Ring<Slot>(64);
  bars.forEach((b, i) => {
    if (b === 'gap') r.push({ t: i * 60_000, o: 0, h: 0, l: 0, c: 0, atr: null, gap: true, uc: false });
    else
      r.push({
        t: i * 60_000,
        o: b[0],
        h: b[1],
        l: b[2],
        c: b[3],
        atr: b[4] === undefined ? 10 : b[4],
        gap: false,
        uc: false,
      });
  });
  return r;
}

const P = CRYPTO_MAJORS_SMC_PARAMS;
const zone = (over: Partial<Zone>): Zone => ({
  key: 'zn:5m:fvg:bu:0',
  tf: '5m',
  type: 'fvg',
  direction: 'bullish',
  top: 110,
  bottom: 100,
  originFrom: 0,
  originTo: 0,
  knownAt: 0,
  htf: false,
  location: 'none',
  structureEvent: null,
  linkedZone: null,
  sweptLiquidityAtOrigin: false,
  status: 'untouched',
  depth: 0,
  firstTouchAt: null,
  statusChangedAt: null,
  flags: [],
  expiresAt: 1e15,
  ...over,
});
const candle = (o: number, h: number, l: number, c: number): Slot => ({
  t: 0,
  o,
  h,
  l,
  c,
  atr: 10,
  gap: false,
  uc: false,
});

describe('§4.2 fair value gaps', () => {
  it('finds a bullish and a bearish gap at the minimum size, and nothing smaller', () => {
    // Bullish: L(n) − H(n−2) = 2 = 0.2 × ATR 10.
    expect(
      findFvg(
        ring([
          [100, 105, 99, 104],
          [104, 112, 104, 111],
          [111, 113, 107, 112],
        ]),
        2,
        0.2,
      ),
    ).toEqual({
      direction: 'bullish',
      from: 0,
      to: 2,
      top: 107,
      bottom: 105,
    });
    expect(
      findFvg(
        ring([
          [100, 105, 99, 104],
          [104, 112, 104, 111],
          [111, 113, 106.5, 112],
        ]),
        2,
        0.2,
      ),
    ).toBeNull();
    // Bearish: L(n−2) − H(n) = 3.
    expect(
      findFvg(
        ring([
          [100, 101, 95, 96],
          [96, 96, 88, 89],
          [89, 92, 87, 88],
        ]),
        2,
        0.2,
      ),
    ).toEqual({
      direction: 'bearish',
      from: 0,
      to: 2,
      top: 95,
      bottom: 92,
    });
  });

  it('needs three contiguous candles and an ATR', () => {
    expect(findFvg(ring(['gap', [104, 112, 104, 111], [111, 113, 107, 112]]), 2, 0.2)).toBeNull();
    expect(
      findFvg(
        ring([
          [100, 105, 99, 104],
          [104, 112, 104, 111],
          [111, 113, 107, 112, null],
        ]),
        2,
        0.2,
      ),
    ).toBeNull();
    // Touching candles leave no gap, even with no minimum.
    expect(
      findFvg(
        ring([
          [100, 105, 99, 104],
          [104, 112, 104, 111],
          [111, 113, 105, 112],
        ]),
        2,
        0,
      ),
    ).toBeNull();
  });
});

describe('§4.1 order blocks', () => {
  const ob = P.orderBlocks;
  it('takes the last up-close candle at or before a bearish leg, with the up-close candles just before it', () => {
    // 0 down, 1–3 up, 4 up (the leg start, the high), then the bearish leg.
    const r = ring([
      [100, 101, 98, 99],
      [99, 102, 98, 101],
      [101, 104, 100, 103],
      [103, 106, 102, 105],
      [105, 110, 104, 108],
    ]);
    // The cluster is capped at 3: candles 2–4.
    expect(findOrderBlock(r, 'bearish', 4, ob)).toEqual({
      direction: 'bearish',
      from: 2,
      to: 4,
      top: 110,
      bottom: 100,
    });
    expect(findOrderBlock(r, 'bearish', 4, { ...ob, zoneMode: 'body' })).toEqual({
      direction: 'bearish',
      from: 2,
      to: 4,
      top: 108,
      bottom: 101,
    });
    expect(findOrderBlock(r, 'bearish', 4, { ...ob, maxClusterCandles: 1 })).toMatchObject({
      from: 4,
      to: 4,
    });
  });

  it('searches back at most `lookback` candles from the leg start, and not across a gap', () => {
    // Bullish leg from candle 6: the last down-close candle is 1, six candles back.
    const r = ring([
      [100, 101, 98, 99],
      [99, 100, 95, 96],
      [96, 99, 95, 98],
      [98, 100, 97, 99],
      [99, 101, 98, 100],
      [100, 102, 99, 101],
      [101, 103, 100, 102],
    ]);
    expect(findOrderBlock(r, 'bullish', 6, ob)).toBeNull();
    expect(findOrderBlock(r, 'bullish', 6, { ...ob, lookback: 6 })).toEqual({
      direction: 'bullish',
      from: 0,
      to: 1,
      top: 101,
      bottom: 95,
    });
    const g = ring([[99, 100, 95, 96], 'gap', [98, 100, 97, 99]]);
    expect(findOrderBlock(g, 'bullish', 2, ob)).toBeNull();
  });
});

describe('§4.3 supply and demand', () => {
  const d = P.displacement;
  const sd = P.supplyDemand;
  it('lists displacements ending at a candle, longest first', () => {
    // 2 and 3 move up with full bodies: a 2-candle leg (total 24 ≥ 2 ATR) and candle 3 alone (14 ≥ 1.2 ATR).
    const r = ring([
      [100, 101, 99, 100],
      [100, 101, 99, 100.5],
      [101, 111, 101, 111],
      [111, 125, 111, 125],
    ]);
    expect(displacementStarts(r, 'bullish', 3, d)).toEqual([2, 3]);
    expect(displacementStarts(r, 'bearish', 3, d)).toEqual([]);
  });

  it('builds demand from the base before the departure: proximal at the highest body, distal at the lowest low', () => {
    // Base 0–1 (bodies ≤ 5), departure 2–3 travels 125 − 102 = 23 ≥ 20 beyond the base's high.
    const r = ring([
      [100, 102, 97, 101],
      [101, 101.5, 98, 99],
      [101, 111, 101, 111],
      [111, 125, 111, 125],
    ]);
    expect(findSupplyDemand(r, 3, d, sd)).toEqual({
      direction: 'bullish',
      from: 0,
      to: 1,
      top: 101,
      bottom: 97,
    });
    // Not far enough beyond the base.
    expect(findSupplyDemand(r, 3, d, { ...sd, departureAtr: 2.5 })).toBeNull();
  });

  it('allows one candle between base and departure, and keeps the last baseMaxCandles of a long base', () => {
    const quiet: Bar = [100, 101, 99, 100.5];
    // Base 0–5 (six small candles); candle 6 closes down with a 6-point body (not small, not part of
    // the departure); the departure is 7–8, so the base ends one candle before it.
    const r = ring([
      quiet,
      quiet,
      quiet,
      quiet,
      quiet,
      quiet,
      [106, 107, 99, 100],
      [107, 118, 107, 118],
      [118, 131, 118, 131],
    ]);
    expect(displacementStarts(r, 'bullish', 8, d)).toEqual([7, 8]);
    expect(findSupplyDemand(r, 8, d, sd)).toMatchObject({ direction: 'bullish', from: 2, to: 5 });
    expect(findSupplyDemand(r, 8, d, { ...sd, baseMaxCandles: 1 })).toMatchObject({ from: 5, to: 5 });
    // Two candles between: no base.
    const far = ring([
      quiet,
      quiet,
      [106, 107, 99, 100],
      [106, 107, 99, 100],
      [107, 118, 107, 118],
      [118, 131, 118, 131],
    ]);
    expect(findSupplyDemand(far, 5, d, sd)).toBeNull();
  });

  it('mirrors for supply, and needs a base', () => {
    const r = ring([
      [100, 103, 99, 101],
      [101, 102, 98.5, 100],
      [99, 99, 89, 89],
      [89, 89, 75, 75],
    ]);
    expect(findSupplyDemand(r, 3, d, sd)).toEqual({
      direction: 'bearish',
      from: 0,
      to: 1,
      top: 103,
      bottom: 100,
    });
    const noBase = ring([
      [100, 110, 99, 109],
      [109, 120, 108, 119],
      [99, 99, 89, 89],
      [89, 89, 75, 75],
    ]);
    expect(findSupplyDemand(noBase, 3, d, sd)).toBeNull();
  });
});

describe('§4.4 touches, fills and invalidation', () => {
  it('counts a touch at the proximal edge, deepens the fill, fills at the far edge', () => {
    const z = zone({});
    expect(updateZone(z, candle(120, 121, 111, 115), 1)).toBeNull(); // above the zone
    expect(updateZone(z, candle(115, 116, 110, 112), 2)).toBe('touch');
    expect(z).toMatchObject({ status: 'partially_filled', depth: 0, firstTouchAt: 2, statusChangedAt: 2 });
    expect(updateZone(z, candle(112, 113, 107, 111), 3)).toBe('fill');
    expect(fillPct(z)).toBe(30);
    expect(updateZone(z, candle(111, 113, 108, 112), 4)).toBeNull(); // not deeper
    expect(updateZone(z, candle(108, 109, 99, 100), 5)).toBe('fill'); // through the bottom, closed on it
    expect(z).toMatchObject({ status: 'filled', statusChangedAt: 5, firstTouchAt: 2 });
    expect(fillPct(z)).toBe(100);
    expect(updateZone(z, candle(100, 104, 99.99, 99.99), 6)).toBe('invalidated');
    expect(z.status).toBe('invalidated');
  });

  it('invalidates a bearish zone on a close above its top in one candle', () => {
    const z = zone({ direction: 'bearish', type: 'supply' });
    expect(updateZone(z, candle(95, 99.5, 94, 99), 1)).toBeNull(); // below the bottom
    expect(updateZone(z, candle(99, 113, 98, 111), 2)).toBe('invalidated');
    expect(z).toMatchObject({ status: 'invalidated', firstTouchAt: 2, depth: 10 });
  });

  it('floors the fill to 0.01 %, exactly, so only the far edge reads 100', () => {
    expect(fillPct({ top: 300_000_000, bottom: 0, depth: 299_999_999 })).toBe(99.99);
    expect(fillPct({ top: 3, bottom: 0, depth: 1 })).toBe(33.33);
    expect(fillPct({ top: 3, bottom: 0, depth: 3 })).toBe(100);
    // 29 %: a float ratio (0.29 × 10,000 = 2,899.999…) would floor to 28.99.
    expect(fillPct({ top: 10_100_000_000, bottom: 10_000_000_000, depth: 29_000_000 })).toBe(29);
    // A BTC-sized zone: depth × 10,000 is beyond 2^53, still exact.
    expect(fillPct({ top: 7_400_000_000_000, bottom: 7_300_000_000_000, depth: 57_000_000_000 })).toBe(57);
  });
});

describe('§4.5 location and §4.3 overlap', () => {
  const range = { high: 200, low: 100 };
  it('places a zone inside, outside or across the active range', () => {
    expect(locateZone(150, 120, range)).toBe('internal');
    expect(locateZone(200, 100, range)).toBe('internal');
    expect(locateZone(100, 90, range)).toBe('external');
    expect(locateZone(220, 200, range)).toBe('external');
    expect(locateZone(210, 190, range)).toBe('straddling');
    expect(locateZone(150, 120, null)).toBe('none');
  });

  it('measures overlap against the smaller zone', () => {
    expect(overlapShare({ top: 110, bottom: 100 }, { top: 105, bottom: 95 })).toBe(0.5);
    expect(overlapShare({ top: 110, bottom: 100 }, { top: 108, bottom: 104 })).toBe(1);
    expect(overlapShare({ top: 110, bottom: 100 }, { top: 100, bottom: 90 })).toBe(0);
  });
});

describe('zone parameters', () => {
  const bad = (change: (p: SmcParams) => void) => {
    const p = JSON.parse(JSON.stringify(P)) as SmcParams;
    change(p);
    return () => validateSmcParams(p);
  };
  it('refuses unusable settings', () => {
    expect(bad((p) => (p.orderBlocks.zoneMode = 'mid' as 'wick'))).toThrow(/zoneMode/);
    expect(bad((p) => (p.orderBlocks.lookback = 0))).toThrow(/orderBlocks.lookback/);
    expect(bad((p) => (p.orderBlocks.breakWithinBars = 60))).toThrow(/at most 64/);
    expect(bad((p) => (p.supplyDemand.baseMaxCandles = 60))).toThrow(/at most 64/);
    expect(bad((p) => (p.supplyDemand.departureAtr = 0))).toThrow(/departureAtr/);
    expect(bad((p) => (p.expiry.fvgCandles = 0))).toThrow(/fvgCandles/);
  });
});
