/**
 * Rulebook §3.2 equal highs and lows (4h), §3.3 period levels (1d), session levels (1h) and
 * weekend levels (gold, 1h). Bullish cases are labelled from the sell side (EQL, lows); their
 * mirrors check the buy side. Period, session and weekend cases check both sides at once.
 */
import {
  bar,
  type Bar,
  type Case,
  type Exp,
  flat,
  fmt,
  keys,
  run,
  type Slot,
  timeline,
  withMirrors,
  zig,
} from './lib.ts';

// ── §3.2 Equal highs and lows (4h, drift zigzags, ATR 1.5, tolerance 0.15) ─────────────────────

const H4 = '4h';
const T4 = timeline(Date.UTC(2026, 0, 5), H4);
const EQ = [
  { type: 'level_created', data: { type: 'eql' } },
  { type: 'level_created', data: { type: 'eqh' } },
];
const low = (i: number) => keys.swing(H4, 'internal', 'low', T4.open(i));
const high = (i: number) => keys.swing(H4, 'internal', 'high', T4.open(i));
const eqBase = (id: string, cls: Case['class'], description: string, bars: Slot[]): Case => ({
  id,
  concept: 'equal-levels',
  class: cls,
  description,
  start: T4.open(0),
  main: { tf: H4, bars },
  expected: [],
  exhaustive: EQ,
});
const TWO_LOWS = [...flat(20), ...zig([100, 96, 99, 96, 99], [8, 6, 6, 6])];
const replace = (bars: Slot[], i: number, b: Bar): Slot[] => bars.map((x, j) => (j === i ? b : x));

const equalCases: Case[] = [
  {
    ...eqBase(
      'eql-two-touches-001',
      'bullish',
      'Two internal swing lows at 95.5 (candles 27 and 39), 12 candles apart, nothing lower in between: equal lows, known when the second is confirmed (41), priced at the lower of the two, 2 touches.',
      TWO_LOWS,
    ),
    expected: [
      {
        type: 'level_created',
        at: 41,
        key: keys.level(H4, 'eql', 'sell_side', T4.close(41)),
        data: {
          type: 'eql',
          side: 'sell_side',
          price: '95.5',
          touches: 2,
          sourceRefs: [low(27), low(39)],
          location: 'none',
        },
      },
    ],
  },
  {
    ...eqBase(
      'eql-within-tolerance-001',
      'bullish',
      'Lows of 95.5 and 95.6, 11 candles apart: 0.1 apart, within max(0.10 × ATR 1.53, one tick) = 0.153. Equal lows at the lower price, 95.5.',
      [
        ...flat(20),
        ...replace(zig([100, 96, 99, 96.5], [8, 6, 5]), 18, bar(97, 97.5, 95.6, 96.5)),
        ...run(96.5, 99, 5),
      ],
    ),
    expected: [
      {
        type: 'level_created',
        at: 40,
        data: { type: 'eql', price: '95.5', touches: 2, sourceRefs: [low(27), low(38)] },
      },
    ],
  },
  {
    ...eqBase(
      'eql-third-touch-001',
      'bullish',
      'The equal lows of eql-two-touches-001, then a third swing low at 95.48 (candle 50): within tolerance, and only 0.02 below the level, less than the 0.03 a sweep needs. A touch, which lowers the level to 95.48 (3 touches). The two tops at 99.5 (33, 45) make equal highs on the way.',
      [...TWO_LOWS, ...run(99, 96.5, 5).slice(0, 4), bar(97, 97.5, 95.48, 96.5), ...run(96.5, 99, 5)],
    ),
    expected: [
      { type: 'level_created', at: 41, data: { type: 'eql', price: '95.5', touches: 2 } },
      {
        type: 'level_created',
        at: 47,
        data: { type: 'eqh', side: 'buy_side', price: '99.5', touches: 2, sourceRefs: [high(33), high(45)] },
      },
      {
        type: 'level_status',
        at: 52,
        key: keys.level(H4, 'eql', 'sell_side', T4.close(41)),
        data: { status: 'active', reason: 'touch', touches: 3, price: '95.48' },
      },
    ],
  },
  {
    ...eqBase(
      'eql-too-far-apart-001',
      'negative',
      'Lows of 95.5 and 96.0: 0.5 apart, more than the 0.15 tolerance. No equal lows.',
      [...flat(20), ...zig([100, 96, 99, 96.5, 99], [8, 6, 5, 5])],
    ),
    expected: [],
  },
  {
    ...eqBase(
      'eql-too-close-001',
      'negative',
      'Two swing lows at 95.5 only 4 candles apart (27 and 31): fewer than 5. No equal lows.',
      [...flat(20), ...zig([100, 96, 97, 96, 99], [8, 2, 2, 6])],
    ),
    expected: [],
  },
  {
    ...eqBase(
      'eql-taken-between-001',
      'negative',
      'Two lows at 95.5 (27, 39), but candle 30 between them dips to 95.0, below 95.5 − 0.15: the liquidity was already taken. No equal lows.',
      replace(TWO_LOWS, 30, bar(97, 98, 95, 97.5)),
    ),
    expected: [],
  },
];

// ── §3.3 Period levels (1d) ───────────────────────────────────────────────────────────────────

const D = '1d';
const PERIOD = ['pdh', 'pdl', 'pwh', 'pwl', 'pmh', 'pml'].map((type) => ({
  type: 'level_created',
  data: { type },
}));

/** Daily candles with varied highs and lows; `skip` are missing days, `partial` partial ones. */
function days(n: number): Bar[] {
  return Array.from({ length: n }, (_, i) => {
    const h = 101 + 0.1 * ((i * 7) % 10);
    const l = 99 - 0.1 * ((i * 3) % 10);
    return [100, h, l, 100];
  });
}

interface PeriodSpec {
  start: number;
  bars: Slot[];
  partial?: number[];
}

/** The rulebook §3.3 answer, worked out from the candles: day, week and month highs and lows. */
function periodLevels(spec: PeriodSpec): Exp[] {
  const T = timeline(spec.start, D);
  const out: Exp[] = [];
  const level = (
    i: number,
    type: string,
    side: 'buy_side' | 'sell_side',
    price: number,
    gap: boolean,
  ): Exp => ({
    type: 'level_created',
    tf: D,
    at: i,
    key: keys.level(D, type, side, T.close(i)),
    data: { type, side, price: fmt(price), flags: gap ? ['data_gap'] : [] },
  });
  spec.bars.forEach((b, i) => {
    if (!b) return;
    const gap = spec.partial?.includes(i) ?? false;
    out.push(level(i, 'pdh', 'buy_side', b[1], gap), level(i, 'pdl', 'sell_side', b[2], gap));
  });
  // A period gives levels when its first day was seen; they are known at its end.
  const periods = (startOf: (t: number) => number, endOf: (t: number) => number, hi: string, lo: string) => {
    const groups = new Map<number, number[]>();
    spec.bars.forEach((_, i) => {
      const s = startOf(T.open(i));
      groups.set(s, [...(groups.get(s) ?? []), i]);
    });
    for (const [s, idx] of groups) {
      const last = idx.at(-1)!;
      if (T.open(idx[0]!) !== s || T.close(last) !== endOf(s)) continue;
      const present = idx.filter((i) => spec.bars[i]);
      if (!present.length) continue;
      const gap = present.length < idx.length || idx.some((i) => spec.partial?.includes(i));
      out.push(
        level(last, hi, 'buy_side', Math.max(...present.map((i) => spec.bars[i]![1])), gap),
        level(last, lo, 'sell_side', Math.min(...present.map((i) => spec.bars[i]![2])), gap),
      );
    }
  };
  const DAY = 86_400_000;
  const monday = (t: number) => {
    const d = Math.floor(t / DAY);
    return (d - ((d + 3) % 7)) * DAY;
  };
  periods(monday, (s) => s + 7 * DAY, 'pwh', 'pwl');
  const month = (t: number) => Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), 1);
  periods(
    month,
    (s) => Date.UTC(new Date(s).getUTCFullYear(), new Date(s).getUTCMonth() + 1, 1),
    'pmh',
    'pml',
  );
  return out;
}

function periodCase(
  id: string,
  cls: Case['class'],
  description: string,
  spec: PeriodSpec,
  more: Partial<Case> = {},
): Case {
  return {
    id,
    concept: 'period-levels',
    class: cls,
    description,
    start: spec.start,
    main: {
      tf: D,
      bars: spec.bars,
      extras: Object.fromEntries((spec.partial ?? []).map((i) => [i, { partial: true }])),
    },
    expected: [...periodLevels(spec), ...(more.expected ?? [])],
    notExpected: more.notExpected,
    exhaustive: PERIOD,
  };
}

const JAN1 = Date.UTC(2026, 0, 1); // a Thursday
const JAN5 = Date.UTC(2026, 0, 5); // a Monday
const TD5 = timeline(JAN5, D);
const withHole = (bars: Bar[], i: number): Slot[] => bars.map((b, j) => (j === i ? null : b));

const periodCases: Case[] = [
  periodCase(
    'period-levels-january-001',
    'bullish',
    'Daily candles from Thursday 1 January to Sunday 8 February: a previous-day high and low at every midnight; previous-week levels each Monday from 12 January (the first week was not seen from its Monday); previous-month levels on 1 February for January.',
    { start: JAN1, bars: days(39) },
  ),
  periodCase(
    'period-levels-missing-day-001',
    'bullish',
    'Three weeks from Monday 5 January with Wednesday 14 January missing for good: no levels for that day, and the second week’s levels carry data_gap. January was not seen from the 1st: no monthly levels.',
    { start: JAN5, bars: withHole(days(21), 9) },
  ),
  periodCase(
    'period-levels-partial-day-001',
    'bullish',
    'Two weeks from Monday 5 January; Thursday 8 January is a partial candle (minutes missing for good). Its day levels and its week’s levels carry data_gap.',
    { start: JAN5, bars: days(14), partial: [3] },
  ),
  periodCase(
    'period-levels-midweek-start-001',
    'negative',
    'Wednesday 7 to Sunday 11 January: day levels every midnight, but the week was not seen from its Monday, so no weekly levels at Monday 12 January.',
    { start: Date.UTC(2026, 0, 7), bars: days(5) },
    {
      notExpected: [
        { type: 'level_created', data: { type: 'pwh' } },
        { type: 'level_created', data: { type: 'pwl' } },
      ],
    },
  ),
  periodCase(
    'period-levels-partial-month-001',
    'negative',
    '5 January to 3 February: January was not seen from the 1st, so 1 February brings no monthly levels.',
    { start: JAN5, bars: days(30) },
    {
      notExpected: [
        { type: 'level_created', data: { type: 'pmh' } },
        { type: 'level_created', data: { type: 'pml' } },
      ],
    },
  ),
  periodCase(
    'period-levels-no-day-for-gap-001',
    'negative',
    'One week from Monday 5 January with Friday 9 January missing: no previous-day levels at midnight on 10 January.',
    { start: JAN5, bars: withHole(days(7), 4) },
    {
      notExpected: [
        { type: 'level_created', at: 4, data: { type: 'pdh' } },
        { type: 'level_created', at: 4, data: { type: 'pdl' } },
      ],
      expected: [{ type: 'gap_marker', at: 4, data: { from: TD5.iso(4) } }],
    },
  ),
];

// ── §3.3 Session levels (1h; Asia 00–07, London 07–13, New York 13–21 UTC) ──────────────────────

const H1 = '1h';
const SESSIONS: [string, number, number][] = [
  ['asia', 0, 7],
  ['london', 7, 13],
  ['new_york', 13, 21],
];
const SESSION = ['session_high', 'session_low'].map((type) => ({ type: 'level_created', data: { type } }));

function hours(n: number, from = 0): Bar[] {
  return Array.from({ length: n }, (_, j) => {
    const i = j + from;
    return [100, 100.5 + 0.1 * (i % 5), 99.5 - 0.1 * (i % 4), 100];
  });
}

/** Session highs and lows: every session whose first and last hour are in the data. */
function sessionLevels(start: number, bars: Slot[]): Exp[] {
  const T = timeline(start, H1);
  const out: Exp[] = [];
  const DAY = 86_400_000;
  for (let day = Math.floor(start / DAY) * DAY; day < T.close(bars.length - 1); day += DAY)
    for (const [name, a, b] of SESSIONS) {
      const first = (day + a * 3_600_000 - start) / 3_600_000;
      const last = (day + b * 3_600_000 - start) / 3_600_000 - 1;
      if (first < 0 || last >= bars.length) continue;
      const idx = Array.from({ length: last - first + 1 }, (_, k) => first + k);
      const present = idx.filter((i) => bars[i]);
      if (!present.length) continue;
      const flags = present.length < idx.length ? ['data_gap'] : [];
      out.push(
        {
          type: 'level_created',
          at: last,
          key: keys.level(H1, 'session_high', 'buy_side', T.close(last)),
          data: {
            type: 'session_high',
            sessionName: name,
            price: fmt(Math.max(...present.map((i) => bars[i]![1]))),
            flags,
          },
        },
        {
          type: 'level_created',
          at: last,
          key: keys.level(H1, 'session_low', 'sell_side', T.close(last)),
          data: {
            type: 'session_low',
            sessionName: name,
            price: fmt(Math.min(...present.map((i) => bars[i]![2]))),
            flags,
          },
        },
      );
    }
  return out;
}

function sessionCase(
  id: string,
  cls: Case['class'],
  description: string,
  start: number,
  bars: Slot[],
  more: Partial<Case> = {},
): Case {
  return {
    id,
    concept: 'session-levels',
    class: cls,
    description,
    start,
    main: { tf: H1, bars },
    expected: [...sessionLevels(start, bars), ...(more.expected ?? [])],
    notExpected: more.notExpected,
    exhaustive: SESSION,
  };
}

const MON = Date.UTC(2026, 0, 5);
const sessionCases: Case[] = [
  sessionCase(
    'session-levels-two-days-001',
    'bullish',
    'Two days of hourly candles from Monday 00:00: each session’s high and low become levels when it ends (07:00, 13:00, 21:00).',
    MON,
    hours(48),
  ),
  sessionCase(
    'session-levels-late-start-001',
    'bullish',
    'Hourly candles from Monday 03:00: the first Asia session was not seen from its start, so it gives no levels; every later session does.',
    MON + 3 * 3_600_000,
    hours(45, 3),
  ),
  sessionCase(
    'session-levels-missing-hour-001',
    'bullish',
    'The 09:00 candle is missing for good: London’s levels come from the hours it has, flagged data_gap.',
    MON,
    hours(30).map((b, i) => (i === 9 ? null : b)),
  ),
  sessionCase(
    'session-levels-ends-early-001',
    'negative',
    'The data stops at 20:00, an hour before New York closes: no New York levels.',
    MON,
    hours(20),
    { notExpected: [{ type: 'level_created', data: { sessionName: 'new_york' } }] },
  ),
  sessionCase(
    'session-levels-outside-sessions-001',
    'negative',
    'Only 21:00–24:00, between New York’s close and Asia’s open: no session levels.',
    MON + 21 * 3_600_000,
    hours(3, 21),
    { notExpected: [{ type: 'level_created' }] },
  ),
  sessionCase(
    'session-levels-start-at-london-001',
    'negative',
    'Hourly candles from 07:00: that day’s Asia session is not in the data, so it has no levels (London and New York do).',
    MON + 7 * 3_600_000,
    hours(14, 7),
    { notExpected: [{ type: 'level_created', data: { sessionName: 'asia' } }] },
  ),
];

// ── §3.3 Weekend levels (gold profile, 1h) ──────────────────────────────────────────────────────

const WEEKEND = ['weekend_high', 'weekend_low'].map((type) => ({ type: 'level_created', data: { type } }));
const FRI_NOON = Date.UTC(2026, 0, 9, 12);
const H = 3_600_000;
/** New York 17:00 Friday to 18:00 Sunday, in winter UTC. */
const weekendClosure = (friday: number) => ({
  from: friday + 10 * H,
  to: friday + 59 * H,
  reason: 'weekend' as const,
});

function goldHours(n: number): Bar[] {
  return Array.from({ length: n }, (_, i) => [2650, 2650.5 + 0.2 * (i % 7), 2649.5 - 0.3 * (i % 4), 2650]);
}

/** Weekend levels for a closure [from, to): the hours overlapping it, known at the first hour boundary at or after `to`. */
function weekendLevels(start: number, bars: Bar[], from: number, to: number): Exp[] {
  const T = timeline(start, H1);
  const idx = bars.map((_, i) => i).filter((i) => T.open(i) < to && T.close(i) > from);
  const last = idx.at(-1)!;
  return [
    {
      type: 'level_created',
      tf: D,
      at: undefined,
      key: keys.level(D, 'weekend_high', 'buy_side', T.close(last)),
      data: {
        type: 'weekend_high',
        price: fmt(Math.max(...idx.map((i) => bars[i]![1]))),
        knownAt: T.isoClose(last),
        flags: [],
      },
    },
    {
      type: 'level_created',
      tf: D,
      key: keys.level(D, 'weekend_low', 'sell_side', T.close(last)),
      data: {
        type: 'weekend_low',
        price: fmt(Math.min(...idx.map((i) => bars[i]![2]))),
        knownAt: T.isoClose(last),
        flags: [],
      },
    },
  ];
}

const weekendCase = (
  id: string,
  cls: Case['class'],
  description: string,
  start: number,
  bars: Bar[],
  closures: Case['closures'],
  expected: Exp[],
  more: Partial<Case> = {},
): Case => ({
  id,
  concept: 'weekend-levels',
  class: cls,
  description,
  profile: 'gold',
  start,
  main: { tf: H1, bars },
  closures,
  expected,
  notExpected: more.notExpected,
  exhaustive: WEEKEND,
});

const W1 = weekendClosure(FRI_NOON);
const W2 = weekendClosure(FRI_NOON + 7 * 86_400_000);
const weekendCases: Case[] = [
  weekendCase(
    'weekend-levels-reopen-001',
    'bullish',
    'PAXG trades through the gold-market weekend (Friday 22:00 to Sunday 23:00 UTC): the high and low of the hours inside the closure become weekend levels when the market reopens.',
    FRI_NOON,
    goldHours(66),
    [W1],
    weekendLevels(FRI_NOON, goldHours(66), W1.from, W1.to),
  ),
  weekendCase(
    'weekend-levels-holiday-001',
    'bullish',
    'A Monday holiday closure follows the weekend directly: the two merge, and the levels come at Monday 23:00 from the whole span.',
    FRI_NOON,
    goldHours(90),
    [W1, { from: W1.to, to: W1.to + 24 * H, reason: 'holiday' }],
    weekendLevels(FRI_NOON, goldHours(90), W1.from, W1.to + 24 * H),
  ),
  weekendCase(
    'weekend-levels-next-weekend-001',
    'bullish',
    'Two weekends: the first weekend’s levels are replaced (expired, superseded) when the second weekend’s are created. Daily one-hour breaks in between make none.',
    FRI_NOON,
    goldHours(234),
    [
      W1,
      ...[3, 4, 5, 6].map((d) => ({
        from: FRI_NOON + d * 86_400_000 + 10 * H,
        to: FRI_NOON + d * 86_400_000 + 11 * H,
        reason: 'daily_break' as const,
      })),
      W2,
    ],
    [
      ...weekendLevels(FRI_NOON, goldHours(234), W1.from, W1.to),
      ...weekendLevels(FRI_NOON, goldHours(234), W2.from, W2.to),
      {
        type: 'level_status',
        tf: D,
        key: keys.level(D, 'weekend_high', 'buy_side', W1.to),
        data: { status: 'expired', reason: 'superseded' },
      },
      {
        type: 'level_status',
        tf: D,
        key: keys.level(D, 'weekend_low', 'sell_side', W1.to),
        data: { status: 'expired', reason: 'superseded' },
      },
    ],
  ),
  weekendCase(
    'weekend-levels-late-start-001',
    'negative',
    'The data starts on Saturday 06:00, after the closure began: its high and low cannot be known, so no weekend levels.',
    FRI_NOON + 18 * H,
    goldHours(48),
    [W1],
    [],
  ),
  weekendCase(
    'weekend-levels-daily-break-only-001',
    'negative',
    'Only a daily one-hour break (Tuesday 22:00–23:00 UTC) in the closures: not a weekend, no weekend levels.',
    Date.UTC(2026, 0, 6, 12),
    goldHours(24),
    [{ from: Date.UTC(2026, 0, 6, 22), to: Date.UTC(2026, 0, 6, 23), reason: 'daily_break' }],
    [],
  ),
  weekendCase(
    'weekend-levels-before-reopen-001',
    'negative',
    'The data ends on Sunday 20:00, before the market reopens: the weekend levels are not known yet.',
    FRI_NOON,
    goldHours(56),
    [W1],
    [],
  ),
];

export const levelCases: Case[] = withMirrors([
  ...equalCases,
  ...periodCases,
  ...sessionCases,
  ...weekendCases,
]);
