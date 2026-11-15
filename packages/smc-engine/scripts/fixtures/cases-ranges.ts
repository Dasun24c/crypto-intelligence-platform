/**
 * Rulebook §2.4 trading ranges, on 5m candles (a setup timeframe, where ranges are detected). A
 * range needs 48 contiguous candles, so the earliest detection is at candle 47. Bullish = a range
 * that ends in a breakout up; bearish = the mirror (breakout down).
 */
import { bar, type Case, type Exp, flat, fmt, keys, run, type Slot, timeline, withMirrors } from './lib.ts';

const TF = '5m';
const START = Date.UTC(2026, 0, 6, 8); // Tuesday 08:00 UTC
const T = timeline(START, TF);
const RANGE_EVENTS = [{ type: 'range_detected' }, { type: 'range_ended' }];

const detected = (at: number, high: number, low: number, eq: string, windowStart = 0): Exp => ({
  type: 'range_detected',
  at,
  key: keys.range(TF, T.close(at)),
  data: {
    high: fmt(high),
    low: fmt(low),
    equilibrium: eq,
    windowStart: T.iso(windowStart),
    detectedAt: T.isoClose(at),
  },
});
const ended = (detectedAt: number, at: number, reason: string): Exp => ({
  type: 'range_ended',
  at,
  key: keys.range(TF, T.close(detectedAt)),
  data: { endedAt: T.isoClose(at), reason },
});
/** A range's two levels: created with it, and their status when it ends. */
function rangeLevels(at: number, high: number, low: number, end?: { at: number; up: boolean | null }): Exp[] {
  const hk = keys.level(TF, 'range_high', 'buy_side', T.close(at));
  const lk = keys.level(TF, 'range_low', 'sell_side', T.close(at));
  const out: Exp[] = [
    {
      type: 'level_created',
      at,
      key: hk,
      data: {
        type: 'range_high',
        side: 'buy_side',
        price: fmt(high),
        location: 'external',
        sourceRefs: [keys.range(TF, T.close(at))],
      },
    },
    {
      type: 'level_created',
      at,
      key: lk,
      data: { type: 'range_low', side: 'sell_side', price: fmt(low), location: 'external' },
    },
  ];
  if (end) {
    out.push({
      type: 'level_status',
      at: end.at,
      key: hk,
      data:
        end.up === true
          ? { status: 'broken', reason: 'broken' }
          : { status: 'expired', reason: 'range_ended' },
    });
    out.push({
      type: 'level_status',
      at: end.at,
      key: lk,
      data:
        end.up === false
          ? { status: 'broken', reason: 'broken' }
          : { status: 'expired', reason: 'range_ended' },
    });
  }
  return out;
}

const base = (id: string, cls: Case['class'], description: string, bars: Slot[]): Case => ({
  id,
  concept: 'ranges',
  class: cls,
  description,
  start: START,
  main: { tf: TF, bars },
  expected: [],
  exhaustive: RANGE_EVENTS,
});

/** 34 candles cycling 100 → 100.9 → 100 in steps of 0.3 (drift wicks of 0.3) after 14 flat ones. */
const CYCLE: Slot[] = Array.from({ length: 34 }, (_, j) => {
  const p = j % 6;
  const o = p < 3 ? 100 + 0.3 * p : 100.9 - 0.3 * (p - 3);
  const c = p < 3 ? o + 0.3 : o - 0.3;
  return bar(o, Math.max(o, c) + 0.3, Math.min(o, c) - 0.3, c);
});

export const rangeCases: Case[] = withMirrors([
  {
    ...base(
      'range-flat-breakout-001',
      'bullish',
      '48 flat candles (high 100.5, low 99.5, ATR 1): height 1 ≤ 6 ATR, no net movement, every candle touches both sides: a range at 47, equilibrium 100. Closes 101.0 and 101.3 are each at least 0.25 ATR above 100.5: breakout up at the second (49). The range high is broken, the range low ends with the range.',
      [
        ...flat(48, 100, 0.5),
        bar(100, 101.2, 99.9, 101),
        bar(101, 101.5, 100.8, 101.3),
        ...run(101.3, 102, 3),
      ],
    ),
    expected: [
      detected(47, 100.5, 99.5, '100'),
      ended(47, 49, 'breakout_up'),
      ...rangeLevels(47, 100.5, 99.5, { at: 49, up: true }),
    ],
  },
  {
    ...base(
      'range-sweep-then-breakout-001',
      'bullish',
      'A flat range 199–201 (ATR 2). Candle 48 wicks to 201.5 and closes inside: a sweep of the range high, which stays active (§3.4 rule 7). 50 closes 0.1 above the high, less than 0.25 ATR: not beyond. 51 and 52 close 0.8 and 1.4 above: breakout up at 52.',
      [
        ...flat(48, 200, 1),
        bar(200, 201.5, 199.5, 200.4),
        bar(200.4, 200.8, 199.8, 200.2),
        bar(200.2, 201.2, 199.9, 201.1),
        bar(201.1, 202, 200.9, 201.8),
        bar(201.8, 202.6, 201.6, 202.4),
      ],
    ),
    expected: [
      detected(47, 201, 199, '200'),
      ended(47, 52, 'breakout_up'),
      ...rangeLevels(47, 201, 199, { at: 52, up: true }),
      {
        type: 'sweep',
        at: 48,
        data: {
          kind: 'wick',
          levelType: 'range_high',
          levelPrice: '201',
          extremePrice: '201.5',
          levelStatus: 'active',
          levelSweepCount: 1,
        },
      },
    ],
  },
  {
    ...base(
      'range-oscillation-breakout-001',
      'bullish',
      '14 flat candles, then 34 candles oscillating 100–100.9 (highs to 101.2, lows to 99.7): over 48 candles the closes travel 10.2 but end only 0.6 from where they began (efficiency 0.06). High 101.2 touched every 6 candles, low 99.5 by the flat start. Range at 47, equilibrium 100.35; breakout up at 49.',
      [...flat(14, 100, 0.5), ...CYCLE, bar(100.6, 101.9, 100.5, 101.8), bar(101.8, 102.3, 101.6, 102.2)],
    ),
    expected: [detected(47, 101.2, 99.5, '100.35'), ended(47, 49, 'breakout_up')],
  },
  {
    ...base(
      'range-too-tall-001',
      'negative',
      'Tiny candles (ATR about 0.3) with two spikes to 101.6 and two to 98.4, each pair 10 candles apart: touches and sideways movement pass, but the height (3.2) is more than 6 ATR. No range.',
      [
        ...flat(20, 100, 0.1),
        bar(100, 101.6, 99.9, 100),
        ...flat(4, 100, 0.1),
        bar(100, 100.1, 98.4, 100),
        ...flat(4, 100, 0.1),
        bar(100, 101.6, 99.9, 100),
        ...flat(4, 100, 0.1),
        bar(100, 100.1, 98.4, 100),
        ...flat(20, 100, 0.1),
      ],
    ),
    expected: [],
  },
  {
    ...base(
      'range-trending-001',
      'negative',
      'A steady climb of 0.1 per candle with wide wicks (ATR 3.1): height 7.8 is within 6 ATR and both sides are touched, but the closes move one way (efficiency 1.0 > 0.30). No range.',
      [...run(100, 104.8, 48, 1.5), ...run(104.8, 105.5, 7, 1.5)],
    ),
    expected: [],
  },
  {
    ...base(
      'range-touches-too-close-001',
      'negative',
      'Flat candles except two neighbours (30, 31) reaching 100.6: the high is touched by candles only 1 apart, not 5. No range while they are in the window.',
      [
        ...flat(30, 100, 0.25),
        bar(100, 100.6, 99.75, 100),
        bar(100, 100.6, 99.75, 100),
        ...flat(28, 100, 0.25),
      ],
    ),
    expected: [],
  },
  {
    ...base(
      'range-expired-001',
      'other',
      'A flat range never breaks out: it ends as expired 300 candles after detection (347), and a new one is detected at the next candle (348).',
      flat(355, 100, 0.5),
    ),
    expected: [
      detected(47, 100.5, 99.5, '100'),
      ended(47, 347, 'expired'),
      detected(348, 100.5, 99.5, '100', 301),
    ],
  },
  {
    ...base(
      'range-data-gap-001',
      'other',
      'A flat range, then candle 50 is missing for good: the gap ends the range (data_gap) and its levels expire with it (§9).',
      [...flat(50, 100, 0.5), null, ...flat(5, 100, 0.5)],
    ),
    expected: [
      detected(47, 100.5, 99.5, '100'),
      ended(47, 50, 'data_gap'),
      ...rangeLevels(47, 100.5, 99.5, { at: 50, up: null }),
      { type: 'gap_marker', at: 50, data: { endedRange: keys.range(TF, T.close(47)) } },
    ],
  },
]);
