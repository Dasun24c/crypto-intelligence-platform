/**
 * Rulebook §3.4 sweeps, false breakouts and breakouts (4h), and §3.5 thin-book wicks (5m with 1m
 * micro profiles). Bullish = a sell-side level below price is taken; the mirrors take buy-side
 * levels. The swept level is an unswept external swing low: in BASE, the bottom at 27 (95.5) is
 * confirmed as an external swing at 32, so its level is known from the close of 32.
 */
import {
  agg,
  bar,
  type Case,
  type Exp,
  flat,
  keys,
  run,
  type Series,
  type Slot,
  timeline,
  withMirrors,
  zig,
} from './lib.ts';

const H4 = '4h';
const T = timeline(Date.UTC(2026, 0, 5), H4);
/** Flat to 100, down to 96 (bottom 95.5 at 27), up to 99 (top 99.5 at 33), back to 97 at 37. */
const BASE: Slot[] = [...flat(20), ...run(100, 96, 8), ...run(96, 99, 6), ...run(99, 97, 4)];
const SWING_LOW = keys.level(H4, 'swing_low', 'sell_side', T.close(32));
const sweepKey = (tf: string, level: string, breach: number) => `sp:${tf}:${level}:${breach}`;
const group = (at: number) => `sg:${H4}:s:${T.close(at)}`;
const approx = (x: number, tol = 0.002) => ({ $approx: x, $tol: tol });

function sweep(
  at: number,
  breach: number,
  kind: 'wick' | 'false_breakout',
  data: Record<string, unknown>,
  level = SWING_LOW,
): Exp {
  return {
    type: 'sweep',
    at,
    key: sweepKey(H4, level, T.open(breach)),
    data: {
      kind,
      side: 'sell_side',
      group: group(at),
      breachCandleTime: T.iso(breach),
      confirmedCandleTime: T.iso(at),
      ...data,
    },
  };
}
const swept = (at: number, level = SWING_LOW): Exp => ({
  type: 'level_status',
  at,
  key: level,
  data: { status: 'swept', reason: 'swept' },
});
const broken = (at: number, level = SWING_LOW): Exp => ({
  type: 'level_status',
  at,
  key: level,
  data: { status: 'broken', reason: 'broken' },
});
const extreme = (at: number, price: string): Exp => ({
  type: 'level_created',
  at,
  key: keys.level(H4, 'sweep_extreme', 'sell_side', T.close(at)),
  data: { type: 'sweep_extreme', side: 'sell_side', price },
});

const base = (
  id: string,
  concept: string,
  cls: Case['class'],
  description: string,
  bars: Slot[],
  exhaustive: Record<string, unknown>[],
): Case => ({
  id,
  concept,
  class: cls,
  description,
  start: T.open(0),
  main: { tf: H4, bars },
  expected: [],
  exhaustive,
});
const SWEEPS = [{ type: 'sweep' }];
const OUTCOMES = [{ type: 'sweep' }, { type: 'level_status', data: { status: 'broken' } }];

/** BASE with two more swing lows at 95.5 (39 external, and with 27 equal lows known at 41). */
const TWO_LOWS: Slot[] = [...flat(20), ...zig([100, 96, 99, 96, 99], [8, 6, 6, 6]), ...run(99, 97, 4)];
const SWING_LOW_2 = keys.level(H4, 'swing_low', 'sell_side', T.close(44));
const EQL = keys.level(H4, 'eql', 'sell_side', T.close(41));

const wickCases: Case[] = [
  {
    ...base(
      'sweep-wick-001',
      'sweeps',
      'bullish',
      'Candle 38 wicks to 95.0, below the swing-low level 95.5 by more than max(0.02 ATR, a tick), and closes back above it at 96.2: a wick sweep, confirmed at its own close. Penetration 0.5 in ATR 1.55. No 1m profiles, so the liquidity is unverified. The level is swept and its extreme, 95.0, becomes a new level.',
      [...BASE, bar(97, 97.2, 95, 96.2), ...run(96.2, 98, 3)],
      SWEEPS,
    ),
    expected: [
      sweep(38, 38, 'wick', {
        levelType: 'swing_low',
        levelPrice: '95.5',
        extremePrice: '95',
        penetrationAtr: approx(0.5 / 1.55),
        notionalBeyondUsd: null,
        flags: ['liquidity_unverified'],
        levelStatus: 'swept',
        levelSweepCount: 1,
      }),
      swept(38),
      extreme(38, '95'),
    ],
  },
  {
    ...base(
      'sweep-group-001',
      'sweeps',
      'bullish',
      'Three sell-side levels at 95.5: two external swing lows and the equal lows they make. One candle (50) wicks through all three and closes back: three sweeps in one group, and a single new extreme level.',
      [...TWO_LOWS, bar(97, 97.2, 95, 96.2), ...run(96.2, 98, 3)],
      SWEEPS,
    ),
    expected: [
      sweep(50, 50, 'wick', { levelType: 'swing_low', extremePrice: '95' }, SWING_LOW),
      sweep(50, 50, 'wick', { levelType: 'eql', extremePrice: '95' }, EQL),
      sweep(50, 50, 'wick', { levelType: 'swing_low', extremePrice: '95' }, SWING_LOW_2),
      swept(50, SWING_LOW),
      swept(50, EQL),
      swept(50, SWING_LOW_2),
      extreme(50, '95'),
    ],
  },
  {
    ...base(
      'sweep-deep-001',
      'sweeps',
      'bullish',
      'A wick to 91.5, 4.0 below the level, more than 2 ATR (ATR 1.8 after this candle): the sweep is flagged deep (it cannot satisfy a pattern).',
      [...BASE, bar(97, 97.2, 91.5, 96), ...run(96, 98, 4)],
      SWEEPS,
    ),
    expected: [
      sweep(38, 38, 'wick', {
        extremePrice: '91.5',
        penetrationAtr: approx(4 / 1.8),
        flags: ['deep', 'liquidity_unverified'],
      }),
    ],
  },
  {
    ...base(
      'sweep-too-shallow-001',
      'sweeps',
      'negative',
      'A wick to 95.48: 0.02 below the level, less than the minimum penetration (0.02 × ATR 1.516 = 0.030). No breach, no sweep.',
      [...BASE, bar(97, 97.2, 95.48, 96.2), ...run(96.2, 98, 3)],
      SWEEPS,
    ),
    expected: [],
  },
  {
    ...base(
      'sweep-already-swept-001',
      'sweeps',
      'negative',
      'After the sweep at 38, candle 41 wicks to 95.2: below the swept level but above the new extreme (95.0). The swept level is used up, the extreme is not reached: no second sweep.',
      [
        ...BASE,
        bar(97, 97.2, 95, 96.2),
        bar(96.2, 96.9, 95.9, 96.7),
        bar(96.7, 97, 96.2, 96.4),
        bar(96.4, 96.6, 95.2, 96.3),
        bar(96.3, 97, 96.1, 96.9),
      ],
      SWEEPS,
    ),
    expected: [sweep(38, 38, 'wick', { extremePrice: '95' })],
    notExpected: [{ type: 'sweep', at: 41 }],
  },
  (() => {
    const hours = [...BASE, bar(97, 97.2, 95, 96.2), ...run(96.2, 98, 3)];
    const H1 = timeline(Date.UTC(2026, 0, 5), '1h');
    const level = keys.level('1h', 'swing_low', 'sell_side', H1.close(32));
    const c: Case = {
      id: 'sweep-shorter-level-001',
      concept: 'sweeps',
      class: 'negative',
      description:
        'The same pattern on 1h, with 4h candles built from it. The 1h candle sweeps the 1h swing low; the 4h candle that contains it trades through 95.5 and closes above it too, but a 1h level is not evaluated on 4h (only levels of the same or a longer timeframe).',
      start: Date.UTC(2026, 0, 5),
      main: { tf: '1h', bars: hours },
      more: [{ tf: H4, bars: agg(hours, 4) }],
      expected: [
        {
          type: 'sweep',
          tf: '1h',
          at: 38,
          key: sweepKey('1h', level, H1.open(38)),
          data: { kind: 'wick', levelType: 'swing_low', levelPrice: '95.5' },
        },
      ],
      notExpected: [{ type: 'sweep', tf: H4 }],
    };
    return c;
  })(),
];

const falseBreakoutCases: Case[] = [
  {
    ...base(
      'false-breakout-next-candle-001',
      'false-breakouts',
      'bullish',
      'Candle 38 closes below the level (95.3): the breach is pending. 39 closes back above (96.0): a false breakout, confirmed at 39. The extreme is the lowest low from 38 to 39 (95.0).',
      [...BASE, bar(97, 97.2, 95, 95.3), bar(95.3, 96.2, 95.1, 96), ...run(96, 98, 3)],
      SWEEPS,
    ),
    expected: [
      sweep(39, 38, 'false_breakout', {
        levelPrice: '95.5',
        extremePrice: '95',
        penetrationAtr: approx(0.5 / 1.517857),
        levelStatus: 'swept',
      }),
      swept(39),
      extreme(39, '95'),
    ],
  },
  {
    ...base(
      'false-breakout-third-candle-001',
      'false-breakouts',
      'bullish',
      'The breach at 38 stays below the level for two more candles (lowest 94.8 at 39), and the third candle after it (41) closes back above: a false breakout, just inside the 3-candle window.',
      [
        ...BASE,
        bar(97, 97.2, 95, 95.3),
        bar(95.3, 95.6, 94.8, 95.2),
        bar(95.2, 95.4, 95, 95.3),
        bar(95.3, 96.3, 95.2, 96.1),
        ...run(96.1, 97, 2),
      ],
      SWEEPS,
    ),
    expected: [sweep(41, 38, 'false_breakout', { extremePrice: '94.8' }), swept(41), extreme(41, '94.8')],
  },
  {
    ...base(
      'false-breakout-deep-001',
      'false-breakouts',
      'bullish',
      'Breach at 38, a plunge to 91.0 at 39, and a close back above at 40: a false breakout whose extreme is 4.5 below the level, more than 2 ATR (1.958): deep.',
      [
        ...BASE,
        bar(97, 97.2, 95.2, 95.4),
        bar(95.4, 95.5, 91, 92),
        bar(92, 96.5, 91.8, 96.2),
        ...run(96.2, 97, 2),
      ],
      SWEEPS,
    ),
    expected: [
      sweep(40, 38, 'false_breakout', {
        extremePrice: '91',
        penetrationAtr: approx(4.5 / 1.958345),
        flags: ['deep', 'liquidity_unverified'],
      }),
    ],
  },
  {
    ...base(
      'false-breakout-too-late-001',
      'false-breakouts',
      'negative',
      'Below the level for the breach candle and the 3 after it (38–41): the level is broken at 41. The close back above at 42 is too late to be a false breakout.',
      [
        ...BASE,
        bar(97, 97.2, 95, 95.3),
        bar(95.3, 95.6, 95, 95.2),
        bar(95.2, 95.5, 95, 95.3),
        bar(95.3, 95.5, 95.1, 95.4),
        bar(95.4, 96.5, 95.3, 96.2),
      ],
      OUTCOMES,
    ),
    expected: [broken(41)],
  },
  {
    ...base(
      'false-breakout-close-at-level-001',
      'false-breakouts',
      'negative',
      'After the breach, three closes at exactly 95.5: at the level is not back above it. Broken at 41.',
      [
        ...BASE,
        bar(97, 97.2, 95, 95.3),
        bar(95.3, 95.8, 95.2, 95.5),
        bar(95.5, 95.8, 95.3, 95.5),
        bar(95.5, 95.7, 95.2, 95.5),
        ...run(95.5, 96.5, 2),
      ],
      OUTCOMES,
    ),
    expected: [broken(41)],
  },
  {
    ...base(
      'false-breakout-dropped-by-gap-001',
      'false-breakouts',
      'negative',
      'A pending breach at 38, then candle 39 is missing for good: the gap drops the pending breach (§9), so the close back above at 40 confirms nothing, and the level stays active.',
      [...BASE, bar(97, 97.2, 95, 95.3), null, bar(95.8, 96.3, 95.7, 96.1), ...run(96.1, 97, 2)],
      OUTCOMES,
    ),
    expected: [{ type: 'gap_marker', at: 39, data: { droppedBreaches: [SWING_LOW] } }],
  },
];

const breakoutCases: Case[] = [
  {
    ...base(
      'breakout-four-closes-001',
      'breakouts',
      'bullish',
      'The breach candle (38) and the next three close below 95.5: a genuine breakout down, so the level is broken at 41 (no sweep).',
      [
        ...BASE,
        bar(97, 97.2, 95, 95.3),
        bar(95.3, 95.4, 94.6, 95),
        bar(95, 95.2, 94.4, 94.8),
        bar(94.8, 95, 94.2, 94.5),
        ...run(94.5, 93, 3),
      ],
      OUTCOMES,
    ),
    expected: [broken(41)],
  },
  {
    ...base(
      'breakout-strong-001',
      'breakouts',
      'bullish',
      'A large candle closes far below the level (93.2) and price keeps falling: broken at 41.',
      [...BASE, bar(97, 97.1, 93, 93.2), ...run(93.2, 92, 3), ...run(92, 91, 2)],
      OUTCOMES,
    ),
    expected: [broken(41)],
  },
  {
    ...base(
      'breakout-equal-lows-001',
      'breakouts',
      'bullish',
      'Equal lows at 95.5 (and the two swing lows under them) are breached at 50 and stay below for three more candles: all three levels are broken at 53.',
      [
        ...TWO_LOWS,
        bar(97, 97.2, 95, 95.3),
        bar(95.3, 95.4, 94.6, 95),
        bar(95, 95.2, 94.4, 94.8),
        bar(94.8, 95, 94.2, 94.5),
        ...run(94.5, 93.5, 2),
      ],
      OUTCOMES,
    ),
    expected: [broken(53, SWING_LOW), broken(53, EQL), broken(53, SWING_LOW_2)],
  },
  {
    ...base(
      'breakout-closes-back-001',
      'breakouts',
      'negative',
      'Below the level for two candles after the breach, back above on the third: a false breakout (41), not a break.',
      [
        ...BASE,
        bar(97, 97.2, 95, 95.3),
        bar(95.3, 95.6, 94.8, 95.2),
        bar(95.2, 95.4, 95, 95.3),
        bar(95.3, 96.3, 95.2, 96.1),
        ...run(96.1, 97, 2),
      ],
      OUTCOMES,
    ),
    expected: [sweep(41, 38, 'false_breakout', { extremePrice: '94.8' })],
  },
  (() => {
    const T5 = timeline(Date.UTC(2026, 0, 6, 8), '5m');
    const c: Case = {
      id: 'breakout-range-level-exempt-001',
      concept: 'breakouts',
      class: 'negative',
      description:
        'A flat 5m range (99.5–100.5). Candle 48 closes 0.1 below the range low and price stays there for three more candles: the sweep rule would call the level broken, but an active range keeps its high and low (§3.4 rule 7), and closes only 0.1 beyond (less than 0.25 ATR) do not end the range.',
      start: T5.open(0),
      main: {
        tf: '5m',
        bars: [
          ...flat(48, 100, 0.5),
          bar(100, 100.1, 99.3, 99.4),
          ...Array.from({ length: 3 }, () => bar(99.4, 99.5, 99.3, 99.4)),
        ],
      },
      expected: [{ type: 'range_detected', at: 47 }],
      notExpected: [
        { type: 'level_status', key: keys.level('5m', 'range_low', 'sell_side', T5.close(47)) },
        { type: 'range_ended' },
        { type: 'sweep' },
      ],
    };
    return c;
  })(),
  {
    ...base(
      'breakout-undecided-001',
      'breakouts',
      'negative',
      'The data ends two candles after the breach, still below the level: neither a false breakout nor a break yet.',
      [...BASE, bar(97, 97.2, 95, 95.3), bar(95.3, 95.4, 95, 95.2)],
      OUTCOMES,
    ),
    expected: [],
  },
];

// ── §3.5 Thin-book wicks: 5m sweeps with 1m micro profiles (24 buckets from low to high) ────────

const M5 = '5m';
const T5 = timeline(Date.UTC(2026, 0, 6, 8), M5);
/** 15 flat, down to 96 (bottom 95.5 at 22, an external swing at 27), up to 99, back to 97 at 32. */
const BASE5: Slot[] = [...flat(15), ...run(100, 96, 8), ...run(96, 99, 6), ...run(99, 97, 4)];
const LEVEL5 = keys.level(M5, 'swing_low', 'sell_side', T5.close(27));

/** A 24-bucket profile with volume in the given buckets. */
const profile = (buckets: Record<number, number>): number[] =>
  Array.from({ length: 24 }, (_, b) => buckets[b] ?? 0);

/** The 1m candles of 5m candles 32–35: four per candle as given, profiles as given (default: 1 above). */
function minutes(
  bars: [number, number, number, number][],
  profiles: Record<number, number[] | null | 'missing'>,
): { series: Series & { start: number } } {
  const slots: Slot[] = bars.map((b, i) => (profiles[i] === 'missing' ? null : b));
  const extras: Series['extras'] = {};
  bars.forEach((_, i) => {
    const p = profiles[i];
    if (p === 'missing') return;
    extras[i] = { profile: p === undefined ? profile({ 23: 1 }) : p };
  });
  return { series: { tf: '1m', start: T5.open(32), bars: slots, extras } };
}

/** 1m candles for 5m 32 (97.5 → 97.0), the sweep candle 33 (97 → 96.2, low 95.0), 34 and 35. */
const M32: [number, number, number, number][] = [
  [97.5, 98, 97.3, 97.8],
  [97.8, 97.9, 97.4, 97.5],
  [97.5, 97.6, 96.9, 97.1],
  [97.1, 97.3, 96.5, 96.8],
  [96.8, 97.1, 96.7, 97],
];
const M33: [number, number, number, number][] = [
  [97, 97.2, 96.4, 96.5],
  [96.5, 96.6, 95, 95.4],
  [95.4, 96, 95.3, 95.9],
  [95.9, 96.1, 95.8, 96],
  [96, 96.3, 95.9, 96.2],
];
const M34: [number, number, number, number][] = [
  [96.2, 96.5, 96, 96.4],
  [96.4, 96.6, 96.3, 96.5],
  [96.5, 96.9, 96.4, 96.8],
  [96.8, 96.85, 96.6, 96.7],
  [96.7, 96.8, 96.6, 96.7],
];
const M35: [number, number, number, number][] = [
  [96.7, 96.9, 96.6, 96.8],
  [96.8, 97, 96.7, 96.9],
  [96.9, 97.1, 96.8, 97],
  [97, 97.2, 96.9, 97.1],
  [97.1, 97.3, 97, 97.2],
];
const WICK5: Slot[] = [
  ...BASE5,
  bar(97, 97.2, 95, 96.2),
  bar(96.2, 96.9, 96, 96.7),
  bar(96.7, 97.3, 96.6, 97.2),
];

function thin(
  id: string,
  cls: Case['class'],
  description: string,
  bars: Slot[],
  m: ReturnType<typeof minutes> | null,
  expected: Exp[],
  profileName?: 'gold',
): Case {
  return {
    id,
    concept: 'thin-book',
    class: cls,
    description,
    ...(profileName ? { profile: profileName } : {}),
    start: T5.open(0),
    main: { tf: M5, bars },
    more: m ? [m.series] : [],
    expected,
    exhaustive: [{ type: 'sweep', tf: M5 }],
  };
}
const sweep5 = (at: number, breach: number, kind: string, data: Record<string, unknown>): Exp => ({
  type: 'sweep',
  tf: M5,
  at,
  key: `sp:${M5}:${LEVEL5}:${T5.open(breach)}`,
  data: { kind, levelType: 'swing_low', levelPrice: '95.5', ...data },
});

/**
 * The sweep minute (5m 33, minute 1) trades from 95.0 to 96.6: buckets of 1/15, so buckets 0–3
 * (95.0–95.27) lie wholly below 95.5. Minute 2 (95.3–96.0) has volume only in buckets wholly above
 * the level. Volume beyond the level is then exactly what buckets 0–3 of minute 1 hold.
 */
const sweepMinutes = (below: number) =>
  minutes([...M32, ...M33, ...M34, ...M35], {
    6: profile({ 0: below, 1: below, 2: below, 3: below, 20: 50 }),
    7: profile({ 12: 30 }),
  });

export const thinBookCases: Case[] = [
  thin(
    'thin-book-wick-001',
    'bullish',
    'A wick sweep with 2.0 units traded below the level across its 1m candles: 2.0 × 95.5 = 191 USD, under the 100,000 crypto threshold: thin_book (the sweep cannot satisfy a pattern on its own).',
    WICK5,
    sweepMinutes(0.5),
    [sweep5(33, 33, 'wick', { notionalBeyondUsd: '191.00', flags: ['thin_book'] })],
  ),
  thin(
    'thin-book-thick-001',
    'bullish',
    'The same sweep with 1,200 units below the level: 114,600 USD, above the threshold. Not thin.',
    WICK5,
    sweepMinutes(300),
    [sweep5(33, 33, 'wick', { notionalBeyondUsd: '114600.00', flags: [] })],
  ),
  thin(
    'thin-book-false-breakout-001',
    'bullish',
    'A false breakout: 5m 33 closes below the level and 34 closes back above. The volume beyond the level is summed over the 1m candles of both (six minutes trade below it, 0.25 each): 1.5 × 95.5 = 143.25 USD. Thin.',
    [...BASE5, bar(97, 97.2, 95, 95.3), bar(95.3, 96.3, 95.2, 96.1), bar(96.1, 96.8, 96, 96.7)],
    minutes(
      [
        ...M32,
        [97, 97.2, 96.4, 96.5],
        [96.5, 96.6, 95, 95.4],
        [95.4, 95.6, 95.2, 95.3],
        [95.3, 95.5, 95.2, 95.4],
        [95.4, 95.5, 95.2, 95.3],
        [95.3, 95.6, 95.2, 95.5],
        [95.5, 95.9, 95.4, 95.8],
        [95.8, 96, 95.7, 95.9],
        [95.9, 96.3, 95.8, 96.2],
        [96.2, 96.2, 96, 96.1],
        [96.1, 96.4, 96, 96.3],
        [96.3, 96.5, 96.2, 96.4],
        [96.4, 96.6, 96.3, 96.5],
        [96.5, 96.8, 96.4, 96.6],
        [96.6, 96.8, 96.5, 96.7],
      ],
      Object.fromEntries([6, 7, 8, 9, 10, 11].map((i) => [i, profile({ 0: 0.25 })])),
    ),
    [sweep5(34, 33, 'false_breakout', { notionalBeyondUsd: '143.25', flags: ['thin_book'] })],
  ),
  thin(
    'thin-book-missing-profile-001',
    'negative',
    'The second minute after the wick has no micro profile (its trades were not all received): the volume beyond the level is unknown. The sweep is liquidity_unverified, still counts, and is never called thin.',
    WICK5,
    minutes([...M32, ...M33, ...M34, ...M35], { 6: profile({ 0: 0.5 }), 7: null }),
    [sweep5(33, 33, 'wick', { notionalBeyondUsd: null, flags: ['liquidity_unverified'] })],
  ),
  thin(
    'thin-book-missing-minute-001',
    'negative',
    'One 1m candle of the sweep window is missing for good: liquidity_unverified, not thin.',
    WICK5,
    minutes([...M32, ...M33, ...M34, ...M35], { 6: profile({ 0: 0.5 }), 8: 'missing' }),
    [sweep5(33, 33, 'wick', { notionalBeyondUsd: null, flags: ['liquidity_unverified'] })],
  ),
  thin(
    'thin-book-no-minutes-001',
    'negative',
    'No 1m candles at all (history backfilled from 5m REST candles): liquidity_unverified, not thin.',
    WICK5,
    null,
    [sweep5(33, 33, 'wick', { notionalBeyondUsd: null, flags: ['liquidity_unverified'] })],
  ),
];

export const sweepCases: Case[] = withMirrors([
  ...wickCases,
  ...falseBreakoutCases,
  ...breakoutCases,
  ...thinBookCases,
]);

export { BASE, BASE5, minutes, M32, M33, M34, M35, profile, sweepMinutes, thin, sweep5, T as T4, T5, WICK5 };
