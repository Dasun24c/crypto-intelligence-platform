/**
 * Rulebook §2: swings, BOS, CHOCH, MSS and displacement, on 4h candles (a timeframe with structure
 * and sweeps but no ranges or sessions, so the patterns stay isolated).
 *
 * The patterns are zigzags of "drift" candles (body = step, wicks = step, body/range 1/3: never a
 * displacement) between turning points, with a flat start whose true range (1.5) equals the drift's,
 * so ATR(14) is 1.5 throughout unless a case says otherwise. In a drift zigzag with step 0.5 the
 * swing at a top Q is the last rising candle, price Q + 0.5 (the next candle ties it, and ties go
 * to the first); at a bottom P, the last falling candle, price P − 0.5.
 */
import {
  bar,
  type Case,
  type Exp,
  flat,
  fmt,
  keys,
  MONDAY,
  refSwings,
  run,
  type Slot,
  timeline,
  withMirrors,
  zig,
} from './lib.ts';

const TF = '4h';
const T = timeline(MONDAY, TF);

const swingKey = (level: 'internal' | 'external', kind: 'high' | 'low', i: number) =>
  keys.swing(TF, level, kind, T.open(i));

function base(id: string, concept: string, cls: Case['class'], description: string, bars: Slot[]): Case {
  return { id, concept, class: cls, description, start: MONDAY, main: { tf: TF, bars }, expected: [] };
}

// ── §2.1 Swings: bullish = swing lows (the turn up), bearish = the mirror (swing highs) ──────────

function swings(
  id: string,
  cls: Case['class'],
  description: string,
  bars: Slot[],
  more: Partial<Case> = {},
): Case {
  const expected: Exp[] = [];
  for (const [level, k] of [
    ['internal', 2],
    ['external', 5],
  ] as const)
    for (const s of refSwings(bars, k, 'low'))
      expected.push({
        type: 'swing_confirmed',
        at: s.index + k,
        key: swingKey(level, 'low', s.index),
        data: {
          kind: 'low',
          level,
          price: fmt(s.price),
          candleTime: T.iso(s.index),
          confirmedAt: T.isoClose(s.index + k),
        },
      });
  return {
    ...base(id, 'swings', cls, description, bars),
    ...more,
    expected: [...expected, ...(more.expected ?? [])],
    exhaustive: [{ type: 'swing_confirmed', data: { kind: 'low' } }],
  };
}

const swingCases: Case[] = [
  swings(
    'swing-low-v-001',
    'bullish',
    'A V-shaped dip: the bottom candle (index 23, low 95) is lower than the 5 candles before and no higher than the 5 after, so it is an internal swing (confirmed at 25) and an external one (confirmed at 28). The rising candle after it ties its low, and ties go to the first.',
    [...flat(20), ...run(100, 96, 4), ...run(96, 100, 4), ...flat(10)],
  ),
  swings(
    'swing-low-internal-only-001',
    'bullish',
    'Two dips: 96 at index 20 is internal and external; 97 at index 23 is below the 2 candles before it but not the 5 (96 is 3 candles earlier), so it is internal only.',
    [
      ...flat(20),
      bar(100, 100.5, 96, 96.5),
      bar(97.4, 98, 97.3, 97.8),
      bar(97.8, 98.2, 97.5, 98),
      bar(98, 98.3, 97, 97.2),
      bar(97.2, 98.5, 97.1, 98.4),
      bar(98.4, 99, 98.2, 98.9),
      ...flat(12),
    ],
    { notExpected: [{ type: 'swing_confirmed', data: { level: 'external', candleTime: T.iso(23) } }] },
  ),
  swings(
    'swing-low-tie-001',
    'bullish',
    'Equal lows of 96 at indices 21 and 22: the first is the swing (strictly below the candles before it, no higher than those after); the second is not, because it is not strictly below the first.',
    [
      ...flat(20),
      bar(100, 100.5, 98, 98.2),
      bar(98.2, 98.4, 96, 96.5),
      bar(96.5, 97, 96, 96.8),
      bar(96.8, 98, 96.6, 97.9),
      bar(97.9, 99, 97.7, 98.9),
      ...flat(12),
    ],
    { notExpected: [{ type: 'swing_confirmed', data: { candleTime: T.iso(22) } }] },
  ),
  swings(
    'swing-low-gap-001',
    'negative',
    'The would-be swing low at index 21 has a missing candle (22, an unrepairable gap) in its window, and so does every later candidate within reach: no swing low at all (§2.1, §9).',
    [
      ...flat(20),
      bar(100, 100.5, 98, 98.2),
      bar(98.2, 98.4, 96, 96.5),
      null,
      bar(96.8, 98, 96.6, 97.9),
      ...flat(12),
    ],
    { expected: [{ type: 'gap_marker', at: 22, data: { from: T.iso(22) } }] },
  ),
  swings(
    'swing-low-unconfirmed-001',
    'negative',
    'The lowest candle is the second-to-last: the two candles that would confirm it never come, so it stays provisional and nothing is emitted.',
    [...flat(20), bar(100, 100.5, 96, 96.5), bar(96.5, 97, 96.2, 96.9)],
  ),
  swings(
    'swing-low-undercut-001',
    'negative',
    'The low of 97 at index 20 is undercut two candles later (96.5): not a swing. The undercutting candle is one (control).',
    [
      ...flat(20),
      bar(100, 100.5, 97, 97.5),
      bar(97.5, 98, 97.2, 97.8),
      bar(97.8, 97.9, 96.5, 96.7),
      bar(96.9, 98, 96.8, 97.9),
      bar(97.9, 99, 97.7, 98.9),
      ...flat(12),
    ],
    { notExpected: [{ type: 'swing_confirmed', data: { candleTime: T.iso(20) } }] },
  ),
];

// ── §2.2 Structure ────────────────────────────────────────────────────────────────────────────

interface Brk {
  at: number;
  level: 'internal' | 'external';
  type: 'bos' | 'choch' | 'mss';
  direction: 'bullish' | 'bearish';
  price: number;
  /** Index of the broken swing, or null for a plain extreme. */
  swing: number | null;
  initial?: boolean;
  displacement?: Record<string, unknown> | null;
}

function structure(b: Brk): Exp {
  const kind = b.direction === 'bullish' ? (b.type === 'bos' ? 'high' : 'high') : 'low';
  // A bullish break takes out a high (refHigh or protectedHigh); a bearish one a low.
  const data: Record<string, unknown> = {
    level: b.level,
    type: b.type,
    direction: b.direction,
    breakPrice: fmt(b.price),
    breakCandleTime: T.iso(b.at),
    isInitial: b.initial ?? false,
    brokenSwing: b.swing === null ? null : swingKey(b.level, kind, b.swing),
  };
  if (b.displacement !== undefined) data.displacement = b.displacement;
  return {
    type: 'structure',
    at: b.at,
    key: `st:${TF}:${b.level === 'internal' ? 'int' : 'ext'}:${b.type}:${T.open(b.at)}`,
    data,
  };
}

/** The same break on internal and external structure. */
const both = (b: Omit<Brk, 'level'>): Exp[] => [
  structure({ ...b, level: 'internal' }),
  structure({ ...b, level: 'external' }),
];

const ALL_STRUCTURE = [{ type: 'structure' }];

/**
 * Two higher highs: flat to 100, then 100 → 104 (8) → 102 (4) → 106 (8) → 104 (4) → 108 (8).
 * Tops at 27 (104.5), 39 (106.5), 51 (108.5); bottoms at 31 (101.5), 43 (103.5). Both swing orders
 * see every turn (each run is long enough). The first close above 104.5 is 105 at 37 (36 closes at
 * exactly 104.5, not a tick above): the initial BOS. The first close above 106.5 is 107 at 49.
 */
const UP = [...flat(20), ...zig([100, 104, 102, 106, 104, 108], [8, 4, 8, 4, 8])];
const upBos: Exp[] = [
  ...both({
    at: 37,
    type: 'bos',
    direction: 'bullish',
    price: 104.5,
    swing: 27,
    initial: true,
    displacement: null,
  }),
  ...both({ at: 49, type: 'bos', direction: 'bullish', price: 106.5, swing: 39, displacement: null }),
];

const bosCases: Case[] = [
  {
    ...base(
      'bos-two-higher-highs-001',
      'structure-bos',
      'bullish',
      'Undefined trend, then a close above the first confirmed swing high (104.5) at 37: initial BOS on both swing orders. The next high (106.5) breaks at 49: a continuation BOS. Drift candles carry no displacement.',
      UP,
    ),
    expected: upBos,
    exhaustive: ALL_STRUCTURE,
  },
  {
    ...base(
      'bos-shorter-runs-001',
      'structure-bos',
      'bullish',
      '100 → 103 (6) → 101 (4) → 105 (8) → 103 (4) → 107 (8): tops at 25 (103.5) and 37 (105.5). 34 closes at exactly 103.5; 35 closes at 104 (initial BOS). 46 closes at 105.5; 47 at 106 (BOS).',
      [...flat(20), ...zig([100, 103, 101, 105, 103, 107], [6, 4, 8, 4, 8])],
    ),
    expected: [
      ...both({
        at: 35,
        type: 'bos',
        direction: 'bullish',
        price: 103.5,
        swing: 25,
        initial: true,
        displacement: null,
      }),
      ...both({ at: 47, type: 'bos', direction: 'bullish', price: 105.5, swing: 37, displacement: null }),
    ],
    exhaustive: ALL_STRUCTURE,
  },
  {
    ...base(
      'bos-wick-then-close-001',
      'structure-bos',
      'bullish',
      'A candle (36) wicks to 105.4, above the swing high of 104.5, but closes at 104.2: no break, a break is tested on the close. The next candle closes at 105: initial BOS at 37.',
      [
        ...flat(20),
        ...zig([100, 104, 102], [8, 4]),
        ...run(102, 104, 4),
        bar(104, 105.4, 103.8, 104.2),
        bar(104.2, 105.2, 104, 105),
        ...run(105, 107, 4),
      ],
    ),
    expected: both({ at: 37, type: 'bos', direction: 'bullish', price: 104.5, swing: 27, initial: true }),
    notExpected: [{ type: 'structure', at: 36 }],
    exhaustive: ALL_STRUCTURE,
  },
  {
    ...base(
      'bos-close-at-level-001',
      'structure-bos',
      'negative',
      'Price climbs back to the swing high of 104.5 and then closes at exactly 104.5 again and again, with wicks above: never a tick above, so no BOS.',
      [...flat(20), ...zig([100, 104, 102], [8, 4]), ...run(102, 104.5, 5), ...flat(6, 104.5)],
    ),
    expected: [],
    exhaustive: ALL_STRUCTURE,
  },
  {
    ...base(
      'bos-unconfirmed-high-001',
      'structure-bos',
      'negative',
      'The top at 27 (104.5) is exceeded two candles later (104.9), before it could be confirmed, and price keeps rising: no swing high is ever confirmed, so nothing can be broken.',
      [
        ...flat(20),
        ...run(100, 104, 8),
        bar(104, 104.2, 103.4, 103.6),
        bar(103.6, 104.9, 103.5, 104.8),
        ...run(104.8, 108, 8),
      ],
    ),
    expected: [],
    exhaustive: ALL_STRUCTURE,
  },
  {
    ...base(
      'bos-gap-in-window-001',
      'structure-bos',
      'negative',
      'The candle after the top (28) is missing for good: the top at 27 cannot be a swing on either order, so the rally through 104.5 to 106 breaks nothing.',
      [...flat(20), ...run(100, 104, 8), null, ...run(103.5, 102, 3), ...run(102, 106, 8)],
    ),
    expected: [{ type: 'gap_marker', at: 28 }],
    exhaustive: ALL_STRUCTURE,
  },
];

/**
 * CHOCH: the bullish trend of UP (protected low 103.5, the swing low at 43, on both orders) and a
 * drift decline from 108. The first close at or below 103.49 changes the character.
 */
const chochCases: Case[] = [
  {
    ...base(
      'choch-drift-001',
      'structure-choch',
      'bearish',
      'After two bullish BOS, a drift decline from 108: 60 closes at 103.5 (the protected low, not below it), 61 at 103: CHOCH on both orders, without displacement.',
      [...UP, ...run(108, 102, 12)],
    ),
    expected: [
      ...upBos,
      ...both({ at: 61, type: 'choch', direction: 'bearish', price: 103.5, swing: 43, displacement: null }),
    ],
    exhaustive: ALL_STRUCTURE,
  },
  {
    ...base(
      'choch-protected-extreme-001',
      'structure-choch',
      'bearish',
      'Initial BOS at 37; then two inside bars and a second BOS at 40 with no swing low formed since 37, so the protected low is the lowest low since that break: 104.6 (candle 38), not a swing (§2.2). 44 closes at 104.5: internal CHOCH with no broken swing. The external order saw no new swing high after 37, so it has only the initial BOS.',
      [
        ...flat(20),
        ...zig([100, 104, 102, 105], [8, 4, 6]),
        bar(105, 105.3, 104.6, 104.9),
        bar(104.9, 105.2, 104.7, 105.1),
        bar(105.1, 106.3, 105, 106.2),
        bar(106.2, 106.8, 106, 106.6),
        bar(106.6, 106.7, 105.9, 106),
        bar(106, 106.1, 105.2, 105.3),
        bar(105.3, 105.4, 104.4, 104.5),
      ],
    ),
    expected: [
      ...both({
        at: 37,
        type: 'bos',
        direction: 'bullish',
        price: 104.5,
        swing: 27,
        initial: true,
        displacement: null,
      }),
      structure({
        at: 40,
        level: 'internal',
        type: 'bos',
        direction: 'bullish',
        price: 105.5,
        swing: 37,
        displacement: null,
      }),
      structure({
        at: 44,
        level: 'internal',
        type: 'choch',
        direction: 'bearish',
        price: 104.6,
        swing: null,
        displacement: null,
      }),
    ],
    exhaustive: ALL_STRUCTURE,
  },
  {
    ...base(
      'choch-after-pullback-001',
      'structure-choch',
      'bearish',
      'After the second BOS a small pullback makes a swing low at 106.8 (candle 53). The decline closes below it at 58 (106.5): only a pullback inside the trend, no event. The protected low (103.5) breaks at 65: CHOCH.',
      [
        ...UP,
        bar(108, 108.3, 107.2, 107.4),
        bar(107.4, 107.6, 106.8, 107),
        bar(107, 107.9, 106.9, 107.7),
        bar(107.7, 108.2, 107.5, 108),
        ...run(108, 102, 12),
      ],
    ),
    expected: [
      ...upBos,
      ...both({ at: 65, type: 'choch', direction: 'bearish', price: 103.5, swing: 43, displacement: null }),
    ],
    notExpected: [{ type: 'structure', after: 52, before: 64 }],
    exhaustive: ALL_STRUCTURE,
  },
  {
    ...base(
      'choch-close-at-protected-001',
      'structure-choch',
      'negative',
      'The decline closes at exactly the protected low (103.5), then flat candles wick below it but close at 103.5: no CHOCH.',
      [...UP, ...run(108, 103.5, 9), ...flat(4, 103.5)],
    ),
    expected: upBos,
    exhaustive: ALL_STRUCTURE,
  },
  {
    ...base(
      'choch-reflow-only-001',
      'structure-choch',
      'negative',
      'The decline breaks the latest swing low (106.8, formed after the BOS) but stops at 104, above the protected low: a pullback, no event.',
      [
        ...UP,
        bar(108, 108.3, 107.2, 107.4),
        bar(107.4, 107.6, 106.8, 107),
        bar(107, 107.9, 106.9, 107.7),
        bar(107.7, 108.2, 107.5, 108),
        ...run(108, 104, 8),
      ],
    ),
    expected: upBos,
    exhaustive: ALL_STRUCTURE,
  },
  {
    ...base(
      'choch-not-from-undefined-001',
      'structure-choch',
      'negative',
      'With no trend yet, the first close below a swing low (95.5, at 37) is an initial bearish BOS, not a change of character.',
      [...flat(20), ...zig([100, 96, 98, 94], [8, 4, 8])],
    ),
    expected: both({
      at: 37,
      type: 'bos',
      direction: 'bearish',
      price: 95.5,
      swing: 27,
      initial: true,
      displacement: null,
    }),
    notExpected: [{ type: 'structure', data: { type: 'choch' } }],
    exhaustive: ALL_STRUCTURE,
  },
];

const approx = (x: number, tol = 0.002) => ({ $approx: x, $tol: tol });

const mssCases: Case[] = [
  {
    ...base(
      'mss-single-candle-001',
      'structure-mss',
      'bearish',
      'The decline from 108 drifts to 105, then one candle (58) falls from 105 to 102.5: body 2.5 ≥ 1.2 × ATR (1.586) with body/range 0.93. It closes below the protected low, so the CHOCH has displacement in its leg: MSS. Its FVG would need the next candle, so createdFvg is false at the break.',
      [...UP, ...run(108, 105, 6), bar(105, 105.1, 102.4, 102.5), ...run(102.5, 101, 3)],
    ),
    expected: [
      ...upBos,
      ...both({
        at: 58,
        type: 'mss',
        direction: 'bearish',
        price: 103.5,
        swing: 43,
        displacement: { from: T.iso(58), to: T.iso(58), createdFvg: false, bodyAtr: approx(2.5 / 1.5857) },
      }),
    ],
    exhaustive: ALL_STRUCTURE,
  },
  {
    ...base(
      'mss-three-candle-leg-001',
      'structure-mss',
      'bearish',
      'Three bearish candles of body 1.2 and range 1.5 (ATR stays 1.5): none is a displacement alone (1.2 < 1.8), two together are not (2.4 < 3.0), three are (3.6 ≥ 3.0). The third closes below the protected low: MSS. The first and third leave a bearish FVG (105.5 above 105.0, 0.5 ≥ 0.2 ATR).',
      [
        ...UP,
        ...run(108, 106, 4),
        bar(106, 106.2, 104.7, 104.8),
        bar(104.8, 105, 103.5, 103.6),
        bar(103.6, 103.8, 102.3, 102.4),
        ...run(102.4, 101.4, 2),
      ],
    ),
    expected: [
      ...upBos,
      ...both({
        at: 58,
        type: 'mss',
        direction: 'bearish',
        price: 103.5,
        swing: 43,
        displacement: { from: T.iso(56), to: T.iso(58), createdFvg: true, bodyAtr: approx(2.4) },
      }),
    ],
    exhaustive: ALL_STRUCTURE,
  },
  {
    ...base(
      'mss-two-candle-leg-001',
      'structure-mss',
      'bearish',
      'Two bearish candles: the first alone is a displacement (body 1.9 ≥ 1.2 × 1.543), but the two together are stronger (3.6 in ATR 1.668 = 2.16), so the leg is reported. The second wicks back up to 105.6, so no FVG.',
      [
        ...UP,
        ...run(108, 106, 4),
        bar(106, 106.1, 104, 104.1),
        bar(104.1, 105.6, 102.3, 102.4),
        ...run(102.4, 101.4, 2),
      ],
    ),
    expected: [
      ...upBos,
      ...both({
        at: 57,
        type: 'mss',
        direction: 'bearish',
        price: 103.5,
        swing: 43,
        displacement: { from: T.iso(56), to: T.iso(57), createdFvg: false, bodyAtr: approx(3.6 / 1.66837) },
      }),
    ],
    exhaustive: ALL_STRUCTURE,
  },
  {
    ...base(
      'mss-without-displacement-001',
      'structure-mss',
      'negative',
      'The same CHOCH as choch-drift-001: the leg is drift candles only, so it stays a CHOCH, never an MSS (J1).',
      [...UP, ...run(108, 102, 12)],
    ),
    expected: [
      ...upBos,
      ...both({ at: 61, type: 'choch', direction: 'bearish', price: 103.5, swing: 43, displacement: null }),
    ],
    notExpected: [{ type: 'structure', data: { type: 'mss' } }],
    exhaustive: ALL_STRUCTURE,
  },
  {
    ...base(
      'mss-wrong-direction-001',
      'structure-mss',
      'negative',
      'The bearish leg contains a large bullish candle (58: 105 → 107.4), a displacement in the wrong direction. The leg has no bearish displacement, so the break at 65 is a CHOCH.',
      [...UP, ...run(108, 105, 6), bar(105, 107.5, 104.9, 107.4), ...run(107.4, 102.6, 8)],
    ),
    expected: [
      ...upBos,
      ...both({ at: 65, type: 'choch', direction: 'bearish', price: 103.5, swing: 43, displacement: null }),
    ],
    notExpected: [{ type: 'structure', data: { type: 'mss' } }],
    exhaustive: ALL_STRUCTURE,
  },
  {
    ...base(
      'mss-displacement-after-break-001',
      'structure-mss',
      'negative',
      'A drift CHOCH at 61, then a large bearish candle at 62. The displacement comes after the break, outside its leg: the CHOCH stays a CHOCH (no repainting).',
      [...UP, ...run(108, 103, 10), bar(103, 103.1, 100.4, 100.5), ...run(100.5, 100, 1)],
    ),
    expected: [
      ...upBos,
      ...both({ at: 61, type: 'choch', direction: 'bearish', price: 103.5, swing: 43, displacement: null }),
    ],
    notExpected: [{ type: 'structure', data: { type: 'mss' } }],
    exhaustive: ALL_STRUCTURE,
  },
];

/** §2.3 on the initial bullish BOS of a 104.5 swing high (bottom 101.5 at 31). */
const BASE_UP = [...flat(20), ...zig([100, 104, 102], [8, 4])];

const displacementCases: Case[] = [
  {
    ...base(
      'displacement-single-candle-001',
      'displacement',
      'bullish',
      'One candle from 101.9 to 105.2 (body 3.3, range 3.5) after a bearish candle: body ≥ 1.2 × ATR (1.583) and body/range 0.94. It breaks the swing high, and the BOS records it.',
      [...BASE_UP, bar(102, 102.4, 101.8, 101.9), bar(101.9, 105.3, 101.8, 105.2), ...run(105.2, 106, 2)],
    ),
    expected: both({
      at: 33,
      type: 'bos',
      direction: 'bullish',
      price: 104.5,
      swing: 27,
      initial: true,
      displacement: { from: T.iso(33), to: T.iso(33), createdFvg: false, bodyAtr: approx(3.3 / 1.58316) },
    }),
    exhaustive: ALL_STRUCTURE,
  },
  {
    ...base(
      'displacement-two-candle-leg-001',
      'displacement',
      'bullish',
      'Two bullish candles (bodies 1.5 and 2.5, body/range ≥ 0.88): the second alone qualifies, the pair is stronger (4.0 in ATR 1.599 = 2.50). The second leaves a bullish FVG over the bottom candle (103.4 above 103.0).',
      [...BASE_UP, bar(102, 103.6, 101.9, 103.5), bar(103.5, 106.1, 103.4, 106), ...run(106, 107, 2)],
    ),
    expected: both({
      at: 33,
      type: 'bos',
      direction: 'bullish',
      price: 104.5,
      swing: 27,
      initial: true,
      displacement: { from: T.iso(32), to: T.iso(33), createdFvg: true, bodyAtr: approx(4 / 1.59898) },
    }),
    exhaustive: ALL_STRUCTURE,
  },
  {
    ...base(
      'displacement-four-candle-leg-001',
      'displacement',
      'bullish',
      'From a 100.5 bottom, four candles of body 1.15 and range 1.45: none qualifies alone, three do (3.45 ≥ 2 × 1.49) but four are the strongest (4.6 in ATR 1.487 = 3.09). The fourth closes above the 105.5 swing high.',
      [
        ...flat(20),
        ...zig([100, 105, 101], [10, 8]),
        ...[0, 1, 2, 3].map((j) => {
          const o = 101 + 1.15 * j;
          return bar(o, o + 1.3, o - 0.15, o + 1.15);
        }),
        ...run(105.6, 106.2, 2),
      ],
    ),
    expected: both({
      at: 41,
      type: 'bos',
      direction: 'bullish',
      price: 105.5,
      swing: 29,
      initial: true,
      displacement: {
        from: T.iso(38),
        to: T.iso(41),
        createdFvg: true,
        bodyAtr: approx(4.6 / 1.48709, 0.005),
      },
    }),
    exhaustive: ALL_STRUCTURE,
  },
  {
    ...base(
      'displacement-long-wicks-001',
      'displacement',
      'negative',
      'A big bullish candle (body 2.7) breaks the swing high but its upper wick makes body/range 0.49 < 0.6, and the candle before it is bearish, so there is no leg either: BOS without displacement.',
      [...BASE_UP, bar(102, 102.4, 101.8, 101.9), bar(101.9, 107.3, 101.8, 104.6), ...run(104.6, 105.6, 2)],
    ),
    expected: both({
      at: 33,
      type: 'bos',
      direction: 'bullish',
      price: 104.5,
      swing: 27,
      initial: true,
      displacement: null,
    }),
    exhaustive: ALL_STRUCTURE,
  },
  {
    ...base(
      'displacement-small-pair-001',
      'displacement',
      'negative',
      'Two strong-looking candles (body 1.0, body/range 0.83) break the swing high after a wide, small-bodied candle (body/range 0.41, which ends any leg). Together they are only 2.0 against 2 × ATR ≈ 2.84: no displacement.',
      [
        ...BASE_UP,
        bar(102, 102.4, 101.8, 101.9),
        bar(101.9, 103.3, 101.6, 102.6),
        bar(102.6, 103.7, 102.5, 103.6),
        bar(103.6, 104.7, 103.5, 104.6),
        ...run(104.6, 105.2, 2),
      ],
    ),
    expected: both({
      at: 35,
      type: 'bos',
      direction: 'bullish',
      price: 104.5,
      swing: 27,
      initial: true,
      displacement: null,
    }),
    exhaustive: ALL_STRUCTURE,
  },
  {
    ...base(
      'displacement-five-small-candles-001',
      'displacement',
      'negative',
      'Five bullish candles of body 0.6 (body/range 0.75) from 101.5, the fifth closing above the 104 swing high: five together (3.0) would reach 2 × ATR (2.57), but a leg has at most four, and four are only 2.4.',
      [
        ...flat(20),
        ...zig([100, 103.5, 101.5], [7, 4]),
        ...[0, 1, 2, 3, 4].map((j) => {
          const o = 101.5 + 0.6 * j;
          return bar(o, o + 0.7, o - 0.1, o + 0.6);
        }),
        ...run(104.5, 105, 1),
      ],
    ),
    expected: both({
      at: 35,
      type: 'bos',
      direction: 'bullish',
      price: 104,
      swing: 26,
      initial: true,
      displacement: null,
    }),
    exhaustive: ALL_STRUCTURE,
  },
];

export const structureCases: Case[] = withMirrors([
  ...swingCases,
  ...bosCases,
  ...chochCases,
  ...mssCases,
  ...displacementCases,
]);
