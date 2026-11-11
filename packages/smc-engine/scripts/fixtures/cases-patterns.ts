/**
 * Rulebook §6 patterns, §7 checklist and §8 outcomes, on the (1h, 5m) pair: 5m candles only unless a
 * case needs the context, so `htf_bias` is 0 (no 1h trend) and `poi_present` is half (an entry zone
 * without a context POI). Cases are described bearish, as the rulebook describes the patterns, and
 * mirrored into bullish twins.
 *
 * Every Pattern 1 and 4 case starts from the same range (candles 0–47): flat candles at 100 (high
 * 100.75, low 99.25) with touches of 102 at 20 and 32 and of 96 at 26 and 38. The §2.4 window first
 * fits at 47 (it needs 48 candles), so the range [96, 102] is detected there, and its levels are
 * known from 47's close: range_high and range_low, plus equal highs (34) and lows (40) and the
 * external swing levels of the touches, all at 102 and 96. ATR values quoted come from the
 * reference `atrs` in lib.ts (Wilder, 14), and buffers round away from the entry to the cent.
 */
import {
  atrs,
  bar,
  type Bar,
  type Case,
  type Exp,
  flat,
  keys,
  MONDAY,
  r2,
  run,
  timeline,
  withMirrors,
} from './lib.ts';

const T = timeline(MONDAY, '5m');
type Dir = 'bullish' | 'bearish';

/** The shared range, detected at candle 47. */
const top = () => bar(100, 102, 99.25, 100);
const bottom = () => bar(100, 100.75, 96, 100);
export const RANGE: Bar[] = [
  ...flat(20),
  top(),
  ...flat(5),
  bottom(),
  ...flat(5),
  top(),
  ...flat(5),
  bottom(),
  ...flat(9),
];
const DETECTED = 47;
const RANGE_HIGH = keys.level('5m', 'range_high', 'buy_side', T.close(DETECTED));
const RANGE_LOW = keys.level('5m', 'range_low', 'sell_side', T.close(DETECTED));

const cents = (x: number) => Math.round(x * 100);
/** Invalidation: the sweep extreme plus 0.10 ATR (at the sweep's confirming candle), rounded up to the cent. */
export function invalidation(extreme: number, atr: number, dir: Dir = 'bearish'): number {
  const buffer = Math.ceil(r2(0.1 * atr * 100 * 1e4) / 1e4 - 1e-6) / 100;
  return r2(dir === 'bearish' ? extreme + buffer : extreme - buffer);
}
/** a / b floored to 4 decimals, as the engine reports R multiples. */
export const ratio4 = (a: number, b: number) => Math.floor((cents(a) * 10_000) / cents(b)) / 10_000;

const PATTERN_CODE = {
  double_liquidity_trap: 'p1',
  eq_near_poi: 'p2',
  htf_order_block: 'p3',
  sweep_outside_fill_inside: 'p4',
} as const;
export type Pattern = keyof typeof PATTERN_CODE;

export const setupKey = (pattern: Pattern, dir: Dir, created: number, tl = T) =>
  keys.setup('5m', '1h', PATTERN_CODE[pattern], dir, tl.close(created));

/** One transition of setup `key`, decided at candle `at` (5m). */
export const transition = (key: string, at: number, data: Record<string, unknown>): Exp => ({
  type: 'setup_transition',
  at,
  key,
  data,
});

/** Every confirmation must be labelled: no other setup may confirm in a case. */
export const CONFIRMATIONS = [{ type: 'setup_transition', data: { to: 'confirmed' } }];

/** The checklist as credits, in rulebook order: htf, liquidity, poi, sweep, mss, levels, rr, news. */
export function checklist(credits: [number, number, number, number, number, number, number, number]) {
  const items = [
    'htf_bias',
    'liquidity_marked',
    'poi_present',
    'sweep',
    'mss',
    'levels_defined',
    'risk_reward',
    'news_clear',
  ];
  return items.map((item, i) => ({ item, credit: credits[i] }));
}
const WEIGHTS = [15, 10, 15, 15, 20, 5, 15, 5];
export const score = (credits: number[]) => credits.reduce((s, c, i) => s + c * WEIGHTS[i]!, 0);

const base = (id: string, concept: string, cls: Case['class'], description: string, bars: Bar[]): Case => ({
  id,
  concept,
  class: cls,
  description,
  start: MONDAY,
  main: { tf: '5m', bars },
  expected: [],
});

/** A 5m sweep's key, from its level key and breach candle. */
const sweep = (level: string, breach: number) => keys.sweep('5m', level, T.open(breach));
const fvg = (dir: Dir, from: number) => keys.zone('5m', 'fvg', dir, T.open(from));
const ob = (dir: Dir, from: number) => keys.zone('5m', 'order_block', dir, T.open(from));

// ── Pattern 1, variant A: both sweeps at the range high (bearish) ─────────────────────────────

const P1 = 'double_liquidity_trap';
const P1_KEY = setupKey(P1, 'bearish', DETECTED);
const forming = transition(P1_KEY, DETECTED, {
  from: null,
  to: 'forming',
  pattern: P1,
  direction: 'bearish',
});

/**
 * Candles 48–64 of the basic Pattern 1 cases: S1 at 55 (high 102.5 sweeps everything at 102 and
 * closes back at 100.25), then an internal swing low at 60 (low 98.5, the MSS anchor; the flats
 * around it have lows of 99.25).
 */
const S1_AT_55: Bar[] = [
  ...flat(7),
  bar(100, 102.5, 99.25, 100.25),
  ...flat(4),
  bar(100, 100.75, 98.5, 100),
  ...flat(4),
];

function p1a001(): Case {
  const bars: Bar[] = [
    ...RANGE,
    ...S1_AT_55,
    bar(100, 102.3, 99.5, 100.5), // 65 S2
    bar(100.5, 100.6, 97.4, 97.5), // 66 MSS: closes below 98.5 with a displacement candle
    bar(97.5, 98.2, 96.9, 97.2), // 67 completes the FVG [98.2, 99.5]
    bar(97.2, 98.3, 97, 98), // 68 touches the entry 98.2
    bar(98, 98.1, 97, 97.1), // 69
    bar(97.1, 97.2, 95.9, 95.95), // 70 low 95.9 reaches T1 96
  ];
  const a = atrs(bars);
  const inv = invalidation(102.3, a[65]!);
  const rr = ratio4(98.2 - 96, inv - 98.2);
  const credits = [0, 1, 0.5, 1, 1, 1, 0, 1];
  return {
    ...base(
      'p1-a-bearish-001',
      'pattern-1-a',
      'bearish',
      `Range [96, 102] from 47 (the setup forms). S1 at 55 sweeps 102 (high 102.5, close 100.25); S2 at 65, 10 candles later, sweeps the range high again (102.3): triggered, variant A, invalidation 102.3 + 0.10 × ATR ${a[65]!.toFixed(4)} = ${inv}. The MSS anchor is the internal swing low at 60 (98.5). Candle 66 closes at 97.5 with a body of 3.1 (ATR ${a[66]!.toFixed(4)}): MSS with displacement. No FVG exists yet at 66; 67 completes the bearish FVG [98.2, 99.5] (65's low 99.5 above 67's high 98.2), the first in the leg: confirmed at 67, entry 98.2. T1 is 96 (the range low, 2.2 below the entry, more than 1 ATR); nothing below it, so no T2. R:R ${rr} < 2. Score ${score(credits)}: no context (0), range high swept (10), entry zone only (7.5), sweep, MSS, levels (40), R:R fails (0), no news (5). 68 touches 98.2 (entry_active); 70's low 95.9 reaches 96: target reached, MFE (98.2 − 95.9)/R, MAE (98.3 − 98.2)/R, 3 bars.`,
      bars,
    ),
    expected: [
      forming,
      transition(P1_KEY, 65, {
        from: 'forming',
        to: 'triggered',
        variant: 'A',
        reason: 'sweeps_A',
        levels: { invalidation: String(inv) },
        refs: { sweeps: [sweep(RANGE_HIGH, 55), sweep(RANGE_HIGH, 65)] },
      }),
      transition(P1_KEY, 67, {
        from: 'triggered',
        to: 'confirmed',
        levels: { entry: '98.2', invalidation: String(inv), target1: '96', target2: null, rr },
        entryZone: fvg('bearish', 65),
        checklist: checklist(credits as never),
        score: score(credits),
        mandatoryPassed: true,
      }),
      transition(P1_KEY, 68, {
        from: 'confirmed',
        to: 'entry_active',
        evidence: { entry: '98.2', high: '98.3', low: '97' },
      }),
      transition(P1_KEY, 70, {
        from: 'entry_active',
        to: 'resolved',
        resolution: 'target_reached',
        reason: 'target1_reached',
        evidence: { target1: '96', high: '97.2', low: '95.9' },
        outcome: {
          result: 'target_reached',
          entryTouchedAt: T.isoClose(68),
          mfeR: ratio4(98.2 - 95.9, inv - 98.2),
          maeR: ratio4(98.3 - 98.2, inv - 98.2),
          barsHeld: 3,
          resolvedWithTf: null,
        },
      }),
    ],
    exhaustive: CONFIRMATIONS,
  };
}

/**
 * S2 five candles after S1 (the window's minimum); the entry is close to the sweep, so R:R ≥ 2.
 * Price then runs back through the invalidation: invalidated after entry.
 */
function p1a002(): Case {
  const bars: Bar[] = [
    ...RANGE,
    ...flat(5), // 48-52
    bar(100, 101.2, 99.9, 101), // 53
    ...flat(2, 101, 0.4), // 54-55 (lows 100.6)
    bar(101, 101.3, 100, 100.9), // 56: internal swing low 100 (the anchor)
    ...flat(3, 101, 0.4), // 57-59
    bar(101, 102.5, 100.7, 101.2), // 60 S1: sweeps 102, closes back at 101.2
    ...flat(4, 101, 0.4), // 61-64
    bar(101.2, 102.2, 100.8, 101.3), // 65 S2: 5 candles after S1
    bar(101.3, 101.4, 98.9, 99), // 66 MSS: closes below 100, body 2.3
    bar(99, 100.3, 98.8, 99.2), // 67 completes the FVG [100.3, 100.8]
    bar(99.2, 100.5, 99.1, 100.4), // 68 touches 100.3
    bar(100.4, 101.8, 100.3, 101.7), // 69
    bar(101.7, 102.6, 101.6, 102.5), // 70 reaches the invalidation
  ];
  const a = atrs(bars);
  const inv = invalidation(102.2, a[65]!);
  const rr = ratio4(100.3 - 96, inv - 100.3);
  const credits = [0, 1, 0.5, 1, 1, 1, 1, 1];
  return {
    ...base(
      'p1-a-bearish-002',
      'pattern-1-a',
      'bearish',
      `Range [96, 102] from 47. Price lifts to 101; an internal swing low forms at 56 (low 100, flats around it at 100.6). S1 at 60 sweeps 102 (high 102.5, close 101.2); S2 at 65, exactly 5 candles later, sweeps it again (102.2): triggered (A), invalidation ${inv} (ATR ${a[65]!.toFixed(4)}). 66 closes at 99 below the anchor 100, a displacement candle (body 2.3, ATR ${a[66]!.toFixed(4)}); 67 completes the FVG [100.3, 100.8] (65's low 100.8): confirmed at 67, entry 100.3, T1 96, R:R ${rr} ≥ 2 (score ${score(credits)}). 68 touches 100.3; 70's high 102.6 reaches ${inv}: invalidated after entry.`,
      bars,
    ),
    expected: [
      forming,
      transition(P1_KEY, 65, {
        from: 'forming',
        to: 'triggered',
        variant: 'A',
        levels: { invalidation: String(inv) },
      }),
      transition(P1_KEY, 67, {
        from: 'triggered',
        to: 'confirmed',
        levels: { entry: '100.3', invalidation: String(inv), target1: '96', target2: null, rr },
        entryZone: fvg('bearish', 65),
        checklist: checklist(credits as never),
        score: score(credits),
      }),
      transition(P1_KEY, 68, { from: 'confirmed', to: 'entry_active' }),
      transition(P1_KEY, 70, {
        from: 'entry_active',
        to: 'resolved',
        resolution: 'invalidated',
        outcome: {
          result: 'invalidated',
          mfeR: ratio4(100.3 - 99.1, inv - 100.3),
          maeR: ratio4(102.6 - 100.3, inv - 100.3),
          barsHeld: 3,
        },
      }),
    ],
    exhaustive: CONFIRMATIONS,
  };
}

/**
 * S1 takes a buy-side level just below the range high (within 0.5 ATR of it); S2 takes the range
 * high. After confirmation price falls to T1 without touching the entry.
 */
function p1a003(): Case {
  const bars: Bar[] = [
    ...RANGE,
    ...flat(3), // 48-50
    bar(100, 101.7, 99.25, 100), // 51: external swing high 101.7 (level known at 56)
    ...flat(5), // 52-56
    bar(100, 101.9, 99.25, 100.3), // 57 S1: sweeps 101.7, not 102
    ...flat(4), // 58-61
    bar(100, 100.75, 98.6, 100), // 62 anchor 98.6
    ...flat(4), // 63-66
    bar(100, 102.3, 99.5, 100.5), // 67 S2: sweeps 102 and S1's extreme 101.9
    bar(100.5, 100.6, 97.4, 97.5), // 68 MSS
    bar(97.5, 98.2, 96.9, 97.2), // 69 FVG [98.2, 99.5]
    bar(97.2, 97.3, 95.9, 95.95), // 70 reaches 96 without touching 98.2
  ];
  const a = atrs(bars);
  const inv = invalidation(102.3, a[67]!);
  const swing = keys.level('5m', 'swing_high', 'buy_side', T.close(56));
  return {
    ...base(
      'p1-a-bearish-003',
      'pattern-1-a',
      'bearish',
      `Range [96, 102] from 47. An external swing high at 51 (101.7) becomes a level at 56. S1 at 57 sweeps it (high 101.9, below the 102.03 a breach of the range high needs): 101.7 is 0.3 below the range high, within 0.5 × ATR (${(0.5 * a[57]!).toFixed(4)}), so it counts as S1. S2 at 67 sweeps the range high (102.3; also S1's extreme 101.9): triggered (A), invalidation ${inv}. 68 breaks the anchor (62, 98.6) with displacement; 69 completes the FVG [98.2, 99.5]: confirmed at 69, entry 98.2, T1 96. 70 falls to 95.9 with a high of 97.3: the target came before the entry, so the setup resolves expired_no_entry.`,
      bars,
    ),
    expected: [
      forming,
      transition(P1_KEY, 67, {
        from: 'forming',
        to: 'triggered',
        variant: 'A',
        refs: { sweeps: [sweep(swing, 57), sweep(RANGE_HIGH, 67)] },
        levels: { invalidation: String(inv) },
      }),
      transition(P1_KEY, 69, {
        from: 'triggered',
        to: 'confirmed',
        levels: { entry: '98.2', target1: '96' },
      }),
      transition(P1_KEY, 70, {
        from: 'confirmed',
        to: 'resolved',
        resolution: 'expired_no_entry',
        reason: 'target_before_entry',
        evidence: { target1: '96', high: '97.3', low: '95.9' },
        outcome: { result: 'expired_no_entry', entryTouchedAt: null, mfeR: null, maeR: null, barsHeld: null },
      }),
    ],
    notExpected: [{ type: 'setup_transition', key: P1_KEY, data: { to: 'entry_active' } }],
    exhaustive: CONFIRMATIONS,
  };
}

/** A two-candle displacement leg; the entry is never touched within 24 candles. */
function p1a004(): Case {
  const bars: Bar[] = [
    ...RANGE,
    ...S1_AT_55,
    bar(100, 102.3, 99.5, 100.5), // 65 S2
    bar(100.5, 100.6, 98.4, 98.6), // 66 body 1.9: no break (98.6 > 98.5), no displacement alone
    bar(98.6, 98.7, 96.7, 96.8), // 67 body 1.8: breaks 98.5; 66–67 is a displacement leg
    ...flat(24, 97.5), // 68-91, highs 98.25 below the entry 98.7
  ];
  const a = atrs(bars);
  const inv = invalidation(102.3, a[65]!);
  return {
    ...base(
      'p1-a-bearish-004',
      'pattern-1-a',
      'bearish',
      `As p1-a-bearish-001 up to S2 at 65 (triggered, invalidation ${inv}). 66 (body 1.9) closes at 98.6, above the anchor 98.5; 67 (body 1.8) closes at 96.8 below it. Neither candle is a displacement alone (1.2 × ATR is ${(1.2 * a[66]!).toFixed(3)} and ${(1.2 * a[67]!).toFixed(3)}), but together they are a leg of 3.7 ≥ 2 × ATR ${a[67]!.toFixed(4)}: MSS at 67. 67 also completes the FVG [98.7, 99.5] (65's low 99.5 over 67's high 98.7): confirmed at 67, entry 98.7, T1 96. The next 24 candles stay below 98.7 and above 96: expired_no_entry at 91 (67 + 24).`,
      bars,
    ),
    expected: [
      forming,
      transition(P1_KEY, 65, { from: 'forming', to: 'triggered', variant: 'A' }),
      transition(P1_KEY, 67, {
        from: 'triggered',
        to: 'confirmed',
        levels: { entry: '98.7', invalidation: String(inv), target1: '96' },
        entryZone: fvg('bearish', 65),
      }),
      transition(P1_KEY, 91, {
        from: 'confirmed',
        to: 'resolved',
        resolution: 'expired_no_entry',
        reason: 'entry_window_passed',
        evidence: { window: { from: T.iso(68), to: T.iso(91) } },
      }),
    ],
    exhaustive: CONFIRMATIONS,
  };
}

/**
 * The sweep candle itself breaks the anchor with displacement (MSS at S2), 60 candles after S1 (the
 * window's maximum); no FVG in the leg, so the entry is the leg's order block.
 */
function p1a005(): Case {
  const bars: Bar[] = [
    ...RANGE,
    ...flat(2), // 48-49
    bar(100, 102.5, 99.25, 100.25), // 50 S1
    ...flat(54), // 51-104
    bar(100, 100.75, 98.5, 100), // 105 anchor 98.5
    ...flat(3), // 106-108
    bar(100, 101.6, 99.9, 101.5), // 109 up-close: the order block
    bar(101.5, 102.3, 98, 98.1), // 110 S2 (60 after S1): sweeps 102, closes at 98.1
    bar(98.1, 99.2, 97.6, 98.3), // 111 no FVG with 110's low 98
    bar(98.3, 99.95, 98.2, 99.8), // 112 touches the entry 99.9? no: high 99.95 ≥ 99.9
    bar(99.8, 99.9, 97.5, 97.6), // 113
    bar(97.6, 97.7, 95.8, 95.9), // 114 reaches 96
  ];
  const a = atrs(bars);
  const inv = invalidation(102.3, a[110]!);
  return {
    ...base(
      'p1-a-bearish-005',
      'pattern-1-a',
      'bearish',
      `Range [96, 102] from 47. S1 at 50 (102.5); S2 at 110, exactly 60 candles later, is a single candle that sweeps 102 (high 102.3) and closes at 98.1, below the anchor (105, 98.5), with a body of 3.4 out of 4.3 (ATR ${a[110]!.toFixed(4)}): triggered and MSS at 110, invalidation ${inv}. The leg starts at 110, so no FVG can complete by 111 (111's high 99.2 is above 110's low 98): the entry falls back to the leg's order block, 109 (the up-close candle before the drop, [99.9, 101.6], created by the break at 110). Confirmed at 111, entry 99.9, T1 96. 112 touches 99.9; 114 reaches 96: target reached.`,
      bars,
    ),
    expected: [
      transition(P1_KEY, 110, {
        from: 'forming',
        to: 'triggered',
        variant: 'A',
        refs: { sweeps: [sweep(RANGE_HIGH, 50), sweep(RANGE_HIGH, 110)] },
      }),
      transition(P1_KEY, 111, {
        from: 'triggered',
        to: 'confirmed',
        levels: { entry: '99.9', invalidation: String(inv), target1: '96' },
        entryZone: ob('bearish', 109),
      }),
      transition(P1_KEY, 112, { from: 'confirmed', to: 'entry_active' }),
      transition(P1_KEY, 114, { from: 'entry_active', to: 'resolved', resolution: 'target_reached' }),
    ],
    exhaustive: CONFIRMATIONS,
  };
}

// Near misses (Pattern 1 variant A).

const NO_P1_CONFIRMATION = { type: 'setup_transition', data: { pattern: P1, to: 'confirmed' } };
const NO_P1_TRIGGER = { type: 'setup_transition', key: P1_KEY, data: { to: 'triggered' } };

function p1aNegatives(): Case[] {
  const afterS2 = (tail: Bar[]): Bar[] => [...RANGE, ...S1_AT_55, bar(100, 102.3, 99.5, 100.5), ...tail];
  return [
    {
      ...base(
        'p1-a-negative-no-mss-001',
        'pattern-1-a',
        'negative',
        'The card’s warning: two sweeps of the range high (55, 65) and no MSS. Price stays at 100 for 14 candles, never closing below the anchor 98.5: triggered at 65, then expired at 78 (the MSS had to come by 65 + 12). Never more than "watching".',
        afterS2(flat(14)),
      ),
      expected: [
        transition(P1_KEY, 65, { from: 'forming', to: 'triggered', variant: 'A' }),
        transition(P1_KEY, 78, {
          from: 'triggered',
          to: 'resolved',
          resolution: 'expired',
          reason: 'no_mss',
          evidence: { window: { from: T.iso(65), to: T.iso(77) } },
        }),
      ],
      notExpected: [NO_P1_CONFIRMATION],
    },
    {
      ...base(
        'p1-a-negative-too-soon-001',
        'pattern-1-a',
        'negative',
        'S1 at 55, then a second sweep of 102 at 59, only 4 candles later (the minimum is 5): no trigger. The second sweep becomes the new S1, and nothing follows within the window.',
        [
          ...RANGE,
          ...flat(7),
          bar(100, 102.5, 99.25, 100.25), // 55
          ...flat(3),
          bar(100, 102.3, 99.5, 100.5), // 59
          bar(100.5, 100.6, 97.4, 97.5), // 60: a displaced drop that would be an MSS
          ...flat(10, 98),
        ],
      ),
      expected: [forming],
      notExpected: [NO_P1_TRIGGER, NO_P1_CONFIRMATION],
    },
    {
      ...base(
        'p1-a-negative-too-late-001',
        'pattern-1-a',
        'negative',
        'S1 at 50, the second sweep of 102 at 111: 61 candles later, one past the 60-candle window, so S1 was dropped at 110 and the second sweep is only a new S1. No trigger.',
        [
          ...RANGE,
          ...flat(2),
          bar(100, 102.5, 99.25, 100.25), // 50
          ...flat(55), // 51-105
          bar(100, 100.75, 98.5, 100), // 106
          ...flat(4), // 107-110
          bar(100, 102.3, 99.5, 100.5), // 111
          bar(100.5, 100.6, 97.4, 97.5), // 112
          ...flat(6, 98),
        ],
      ),
      expected: [forming],
      notExpected: [NO_P1_TRIGGER, NO_P1_CONFIRMATION],
    },
    {
      ...base(
        'p1-a-negative-deep-001',
        'pattern-1-a',
        'negative',
        'The second sweep at 65 runs to 107.5 before closing back at 100.5: more than 2 ATR beyond 102 and beyond S1’s extreme 102.5, even with its own range in the ATR, so both sweeps are deep and do not qualify. No trigger, though a displaced drop follows.',
        [...RANGE, ...S1_AT_55, bar(100, 107.5, 99.5, 100.5), bar(100.5, 100.6, 97.4, 97.5), ...flat(8, 98)],
      ),
      expected: [
        forming,
        { type: 'sweep', at: 65, data: { levelPrice: '102', flags: ['deep', 'liquidity_unverified'] } },
      ],
      notExpected: [NO_P1_TRIGGER, NO_P1_CONFIRMATION],
    },
    {
      ...base(
        'p1-a-negative-no-displacement-001',
        'pattern-1-a',
        'negative',
        'After S2 at 65 price drifts down to 97.5 over 12 candles, closing below the anchor 98.5 from 69 on, but every candle’s body is a third of its range: no displacement in the leg, so no MSS (rulebook §6.1 with requireDisplacement). Expired at 78.',
        afterS2([...run(100.5, 97.5, 12), ...flat(2, 97.5)]),
      ),
      expected: [
        transition(P1_KEY, 65, { from: 'forming', to: 'triggered' }),
        transition(P1_KEY, 78, {
          from: 'triggered',
          to: 'resolved',
          resolution: 'expired',
          reason: 'no_mss',
        }),
      ],
      notExpected: [NO_P1_CONFIRMATION],
    },
    {
      ...base(
        'p1-a-negative-beyond-sweep-001',
        'pattern-1-a',
        'negative',
        'After S2 at 65 (extreme 102.3), candle 66 trades to 102.4, beyond the extreme but short of the invalidation, and closes back at 100.3. The sweep can no longer anchor an MSS; 67’s displaced break of 98.5 does not confirm. Expired at 78.',
        afterS2([bar(100.5, 102.4, 100.2, 100.3), bar(100.3, 100.4, 97.4, 97.5), ...flat(11, 97.5)]),
      ),
      expected: [
        transition(P1_KEY, 65, { from: 'forming', to: 'triggered' }),
        transition(P1_KEY, 78, {
          from: 'triggered',
          to: 'resolved',
          resolution: 'expired',
          reason: 'beyond_sweep',
          evidence: {
            window: { from: T.iso(65), to: T.iso(77) },
            beyond_extreme: { at: T.iso(66), price: '102.4' },
          },
        }),
      ],
      notExpected: [NO_P1_CONFIRMATION],
    },
  ];
}

// ── Pattern 1, variant B: S1 at the range low, S2 at the range high (bearish) ─────────────────

function p1bCase(
  n: string,
  description: string,
  bars: Bar[],
  s1: { level: string; at: number },
  s2At: number,
  confirmAt: number,
  levels: Record<string, unknown>,
  extra: Exp[] = [],
): Case {
  return {
    ...base(`p1-b-bearish-${n}`, 'pattern-1-b', 'bearish', description, bars),
    expected: [
      forming,
      transition(P1_KEY, s2At, {
        from: 'forming',
        to: 'triggered',
        variant: 'B',
        reason: 'sweeps_B',
        refs: { sweeps: [sweep(s1.level, s1.at), sweep(RANGE_HIGH, s2At)] },
      }),
      transition(P1_KEY, confirmAt, { from: 'triggered', to: 'confirmed', variant: 'B', levels }),
      ...extra,
    ],
    exhaustive: CONFIRMATIONS,
  };
}

/** S1 at 55 sweeps the range low (low 95.5, close 99.5); the anchor at 60 (98.5). */
const S1_LOW_AT_55: Bar[] = [
  ...flat(7),
  bar(100, 100.75, 95.5, 99.5),
  ...flat(4),
  bar(100, 100.75, 98.5, 100),
  ...flat(4),
];
const S1_LOW_EXTREME = keys.level('5m', 'sweep_extreme', 'sell_side', T.close(55));

function p1bPositives(): Case[] {
  const a1: Bar[] = [
    ...RANGE,
    ...S1_LOW_AT_55,
    bar(100, 102.3, 99.5, 100.5), // 65 S2 at the high
    bar(100.5, 100.6, 97.4, 97.5), // 66 MSS
    bar(97.5, 98.2, 96.9, 97.2), // 67 FVG [98.2, 99.5]
    bar(97.2, 98.3, 97, 98), // 68 entry
    bar(98, 98.1, 95.3, 95.4), // 69 through 96 and 95.5
  ];
  const at1 = atrs(a1);
  const inv1 = invalidation(102.3, at1[65]!);
  const a2: Bar[] = [
    ...RANGE,
    ...flat(3), // 48-50
    bar(100, 100.75, 96.3, 100), // 51: external swing low 96.3 (level at 56)
    ...flat(5), // 52-56
    bar(100, 100.75, 96.1, 99.6), // 57 S1: sweeps 96.3, not 96
    ...flat(4), // 58-61
    bar(100, 100.75, 98.6, 100), // 62 anchor
    ...flat(4), // 63-66
    bar(100, 102.3, 99.5, 100.5), // 67 S2
    bar(100.5, 100.6, 97.4, 97.5), // 68 MSS
    bar(97.5, 98.2, 96.9, 97.2), // 69 FVG
    ...flat(3, 97.5), // 70-72 no touch (highs 98.25 > 98.2: touch at 70)
  ];
  const a3: Bar[] = [
    ...RANGE,
    ...S1_LOW_AT_55,
    bar(100, 102.3, 99.5, 100.5), // 65 S2
    bar(100.5, 100.6, 98.3, 98.4), // 66 body 2.1: closes below 98.5, but no displacement yet
    bar(98.4, 98.5, 96.3, 96.4), // 67 body 2.0: the leg 66–67 is a displacement; FVG [98.5, 99.5]
    bar(96.4, 98.6, 96.35, 98.4), // 68 touches 98.5
    bar(98.4, 102.7, 98.3, 102.4), // 69 runs to the invalidation
  ];
  const at3 = atrs(a3);
  const inv3 = invalidation(102.3, at3[65]!);
  const a4: Bar[] = [
    ...RANGE,
    ...flat(7), // 48-54
    bar(100, 100.75, 95.5, 99.5), // 55 S1 low
    ...flat(4), // 56-59
    bar(100, 100.75, 98.5, 100), // 60 anchor
    ...flat(3), // 61-63
    bar(100, 101.6, 99.9, 101.5), // 64 order block
    bar(101.5, 102.3, 98, 98.1), // 65 S2 + MSS in one candle
    bar(98.1, 99.2, 97.6, 98.3), // 66 no FVG
    ...flat(24, 98.5, 0.6), // 67-90: highs 99.1, below 99.9
  ];
  const a5: Bar[] = [
    ...RANGE,
    ...flat(7), // 48-54
    bar(100, 100.75, 95.5, 99.5), // 55 S1 low (itself an internal swing low)
    ...flat(2), // 56-57
    bar(100, 100.75, 98.5, 100), // 58 anchor: lows of 56, 57 and 59 are 99.25
    ...flat(1), // 59
    bar(100, 102.3, 99.5, 100.5), // 60 S2: 5 after S1
    bar(100.5, 100.6, 97.4, 97.5), // 61 MSS
    bar(97.5, 98.2, 96.9, 97.2), // 62 FVG [98.2, 99.5]
    bar(97.2, 98.3, 97, 98), // 63 entry
    bar(98, 98.1, 95.4, 95.45), // 64 reaches T1
  ];
  const at5 = atrs(a5);
  const inv5 = invalidation(102.3, at5[60]!);
  return [
    p1bCase(
      '001',
      `Range [96, 102] from 47. S1 at 55 sweeps the range low (low 95.5, close 99.5); S2 at 65 sweeps the range high (102.3): false breakouts on both sides, variant B, bearish (opposite to S2). Invalidation ${inv1}. 66 breaks the anchor (60, 98.5) with displacement; 67 completes the FVG [98.2, 99.5]: confirmed at 67, entry 98.2. The range low (96) is still a level while the range lives, and S1 left a sell-side sweep extreme at 95.5: T1 96, T2 95.5. 68 touches the entry; 69 trades through both: target reached.`,
      a1,
      { level: RANGE_LOW, at: 55 },
      65,
      67,
      { entry: '98.2', invalidation: String(inv1), target1: '96', target2: '95.5' },
      [
        transition(P1_KEY, 67, {
          to: 'confirmed',
          targets: {
            target1: { kind: 'level', key: RANGE_LOW, price: '96' },
            target2: { kind: 'level', key: S1_LOW_EXTREME, price: '95.5' },
          },
        }),
        transition(P1_KEY, 69, { from: 'entry_active', to: 'resolved', resolution: 'target_reached' }),
      ],
    ),
    p1bCase(
      '002',
      'S1 at 57 takes an external swing low at 96.3 (a level from 56), 0.3 above the range low and within 0.5 ATR of it, without breaching 96 itself (low 96.1). S2 at 67 takes the range high: variant B. 68 breaks the anchor (62, 98.6) with displacement; 69 completes the FVG [98.2, 99.5]: confirmed at 69, entry 98.2. The nearest sell-side level at least 1 ATR below is S1’s own extreme, 96.1 (T1), then the range low 96 (T2). 70 touches the entry.',
      a2,
      { level: keys.level('5m', 'swing_low', 'sell_side', T.close(56)), at: 57 },
      67,
      69,
      { entry: '98.2', target1: '96.1', target2: '96' },
      [transition(P1_KEY, 70, { from: 'confirmed', to: 'entry_active' })],
    ),
    p1bCase(
      '003',
      `Variant B with a two-candle displacement leg. S1's long wick lifts ATR to ${at3[66]!.toFixed(4)} at 66, whose close 98.4 is below the anchor 98.5 but whose body 2.1 is under 1.2 ATR: a break without displacement, no MSS yet. 67 (body 2.0) completes a leg of 4.1 ≥ 2 × ATR ${at3[67]!.toFixed(4)}: MSS at 67, which also completes the FVG [98.5, 99.5]: confirmed at 67, entry 98.5. 68 touches it; 69 runs to ${inv3}: invalidated.`,
      a3,
      { level: RANGE_LOW, at: 55 },
      65,
      67,
      { entry: '98.5', invalidation: String(inv3) },
      [transition(P1_KEY, 69, { from: 'entry_active', to: 'resolved', resolution: 'invalidated' })],
    ),
    p1bCase(
      '004',
      'Variant B where S2 itself (65) closes below the anchor with displacement: MSS at 65. No FVG can complete by 66, so the entry is the leg’s order block (64, [99.9, 101.6]): confirmed at 66, entry 99.9. Price stays below it for 24 candles: expired_no_entry at 90.',
      a4,
      { level: RANGE_LOW, at: 55 },
      65,
      66,
      { entry: '99.9', target1: '96' },
      [
        transition(P1_KEY, 66, { to: 'confirmed', entryZone: ob('bearish', 64) }),
        transition(P1_KEY, 90, { from: 'confirmed', to: 'resolved', resolution: 'expired_no_entry' }),
      ],
    ),
    p1bCase(
      '005',
      `Variant B with S2 (60) exactly 5 candles after S1 (55). S1's candle is itself an internal swing low (95.5); the anchor is the more recent one at 58 (98.5), confirmed at 60. 61 breaks it with displacement; 62 completes the FVG [98.2, 99.5]: confirmed at 62 (invalidation ${inv5}). 63 touches 98.2; 64 reaches 96 and S1's extreme 95.5.`,
      a5,
      { level: RANGE_LOW, at: 55 },
      60,
      62,
      { entry: '98.2', invalidation: String(inv5), target1: '96', target2: '95.5' },
      [transition(P1_KEY, 64, { from: 'entry_active', to: 'resolved', resolution: 'target_reached' })],
    ),
  ];
}

function p1bNegatives(): Case[] {
  return [
    {
      ...base(
        'p1-b-negative-near-high-001',
        'pattern-1-b',
        'negative',
        'S1 takes the range low at 55; the second sweep, at 65, takes only an external swing high at 101.7 (a level from 56), not the range high. Variant B needs S2 at the range high itself, and variant A has no S1 at the high yet: no trigger. (The 101.7 sweep becomes a variant A S1.)',
        [
          ...RANGE,
          ...flat(3), // 48-50
          bar(100, 101.7, 99.25, 100), // 51
          ...flat(3), // 52-54
          bar(100, 100.75, 95.5, 99.5), // 55 S1 low
          bar(99.5, 100.75, 98.5, 100), // 56 anchor
          ...flat(8), // 57-64
          bar(100, 101.9, 99.5, 100.5), // 65 sweeps 101.7 only
          bar(100.5, 100.6, 97.4, 97.5), // 66 displaced drop
          ...flat(6, 98),
        ],
      ),
      expected: [forming],
      notExpected: [NO_P1_TRIGGER, NO_P1_CONFIRMATION],
    },
    {
      ...base(
        'p1-b-negative-too-soon-001',
        'pattern-1-b',
        'negative',
        'S1 at the range low (55), S2 at the range high 3 candles later (58): under the 5-candle minimum, no trigger.',
        [
          ...RANGE,
          ...flat(7),
          bar(100, 100.75, 95.5, 99.5), // 55
          ...flat(2),
          bar(100, 102.3, 99.5, 100.5), // 58
          bar(100.5, 100.6, 97.4, 97.5), // 59
          ...flat(6, 98),
        ],
      ),
      expected: [forming],
      notExpected: [NO_P1_TRIGGER, NO_P1_CONFIRMATION],
    },
    {
      ...base(
        'p1-b-negative-deep-first-001',
        'pattern-1-b',
        'negative',
        'The first sweep at 55 runs to 89 below the range low before closing back at 99.5: deep (more than 2 ATR, with its own range in the ATR), so it is no S1. S2 at the range high (65) then has nothing to pair with: no trigger.',
        [
          ...RANGE,
          ...flat(7),
          bar(100, 100.75, 89, 99.5), // 55 deep
          ...flat(4),
          bar(100, 100.75, 98.5, 100), // 60
          ...flat(4),
          bar(100, 102.3, 99.5, 100.5), // 65
          bar(100.5, 100.6, 97.4, 97.5), // 66
          ...flat(6, 98),
        ],
      ),
      expected: [forming],
      notExpected: [NO_P1_TRIGGER, NO_P1_CONFIRMATION],
    },
    {
      ...base(
        'p1-b-negative-no-mss-001',
        'pattern-1-b',
        'negative',
        'False breakouts at both ends (55 low, 65 high): triggered, variant B. Price then holds at 100 and never breaks the anchor: expired at 78, never confirmed.',
        [...RANGE, ...S1_LOW_AT_55, bar(100, 102.3, 99.5, 100.5), ...flat(14)],
      ),
      expected: [
        transition(P1_KEY, 65, { from: 'forming', to: 'triggered', variant: 'B' }),
        transition(P1_KEY, 78, {
          from: 'triggered',
          to: 'resolved',
          resolution: 'expired',
          reason: 'no_mss',
        }),
      ],
      notExpected: [NO_P1_CONFIRMATION],
    },
    {
      ...base(
        'p1-b-negative-range-ended-001',
        'pattern-1-b',
        'negative',
        'S1 at the range low (55), then two closes below 96 − 0.25 ATR (57, 58) break the range down: it ends at 58, its high is no longer a level, and the setup expires (range_ended). A later spike to 102.3 sweeps nothing in the range.',
        [
          ...RANGE,
          ...flat(7),
          bar(100, 100.75, 95.5, 99.5), // 55
          bar(99.5, 99.6, 96.5, 96.6), // 56
          bar(96.6, 96.7, 95.2, 95.3), // 57 close below 95.57
          bar(95.3, 95.4, 94.9, 95), // 58 second close: breakout down
          ...run(95, 100, 6),
          bar(100, 102.3, 99.5, 100.5), // 65
          ...flat(4),
        ],
      ),
      expected: [
        forming,
        transition(P1_KEY, 58, {
          from: 'forming',
          to: 'resolved',
          resolution: 'expired',
          reason: 'range_ended',
          evidence: { range: keys.range('5m', T.close(DETECTED)) },
        }),
      ],
      notExpected: [NO_P1_TRIGGER, NO_P1_CONFIRMATION],
    },
  ];
}

export const patternCases: Case[] = withMirrors([
  p1a001(),
  p1a002(),
  p1a003(),
  p1a004(),
  p1a005(),
  ...p1aNegatives(),
  ...p1bPositives(),
  ...p1bNegatives(),
]);
