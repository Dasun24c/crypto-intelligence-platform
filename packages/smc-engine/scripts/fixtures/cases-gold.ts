/**
 * Gold-profile cases (rulebook §12: closure, reopening and thin-book), on PAXG-like patterns with
 * the gold-market calendar in the context. Winter New York 17:00–18:00 is 22:00–23:00 UTC; the
 * weekend closure runs from Friday 22:00 to Sunday 23:00 UTC. Candles overlapping a closure are
 * `underlyingClosed`, and a sweep or structure event decided on such a candle inherits the flag
 * (§3.6). The gold thin-book threshold is 20,000 USD.
 */
import {
  BASE,
  minutes,
  M32,
  M33,
  M34,
  M35,
  profile,
  sweep5,
  sweepMinutes,
  T4,
  thin,
  WICK5,
} from './cases-sweeps.ts';
import { bar, type Bar, type Case, type Exp, flat, keys, run, timeline, zig } from './lib.ts';

const H = 3_600_000;
const FRI = Date.UTC(2026, 0, 9);
const WEEKEND = { from: FRI + 22 * H, to: FRI + 71 * H, reason: 'weekend' as const };
const DAILY = [12, 13, 14, 15].map((d) => ({
  from: Date.UTC(2026, 0, d, 22),
  to: Date.UTC(2026, 0, d, 23),
  reason: 'daily_break' as const,
}));
const CLOSURES = [WEEKEND, ...DAILY];
const SWING_LOW = keys.level('4h', 'swing_low', 'sell_side', T4.close(32));

const closure = (
  id: string,
  description: string,
  bars: Case['main']['bars'],
  expected: Exp[],
  notExpected: Exp[] = [],
): Case => ({
  id,
  concept: 'gold',
  class: 'closure',
  description,
  profile: 'gold',
  start: T4.open(0),
  main: { tf: '4h', bars },
  closures: CLOSURES,
  expected,
  notExpected,
});

const st = (
  at: number,
  level: 'internal' | 'external',
  price: string,
  swing: number,
  flags: string[],
): Exp => ({
  type: 'structure',
  at,
  key: `st:4h:${level === 'internal' ? 'int' : 'ext'}:bos:${T4.open(at)}`,
  data: {
    level,
    type: 'bos',
    direction: 'bullish',
    breakPrice: price,
    brokenSwing: keys.swing('4h', level, 'high', T4.open(swing)),
    flags,
  },
});

const closureCases: Case[] = [
  closure(
    'gold-closure-sweep-001',
    'The wick sweep of sweep-wick-001, with candle 38 (Sunday 08:00–12:00 UTC) inside the weekend closure: the sweep carries underlying_closed (with the gold profile, a setup built on it cannot confirm).',
    [...BASE, bar(97, 97.2, 95, 96.2), ...run(96.2, 98, 3)],
    [
      {
        type: 'sweep',
        at: 38,
        key: `sp:4h:${SWING_LOW}:${T4.open(38)}`,
        data: { kind: 'wick', levelType: 'swing_low', flags: ['liquidity_unverified', 'underlying_closed'] },
      },
    ],
  ),
  closure(
    'gold-closure-structure-001',
    'The two bullish BOS of bos-two-higher-highs-001: the first (candle 37, Sunday 04:00–08:00 UTC) falls inside the weekend closure and carries underlying_closed; the second (49, Tuesday 04:00) does not.',
    [...flat(20), ...zig([100, 104, 102, 106, 104, 108], [8, 4, 8, 4, 8])],
    [
      st(37, 'internal', '104.5', 27, ['underlying_closed']),
      st(37, 'external', '104.5', 27, ['underlying_closed']),
      st(49, 'internal', '106.5', 39, []),
      st(49, 'external', '106.5', 39, []),
    ],
  ),
  closure(
    'gold-closure-decided-after-reopen-001',
    'A false breakout breached inside the closure (candle 41, Sunday 20:00–24:00, overlapping it until 23:00) and confirmed after the market reopened (42, Monday 00:00): the deciding candle is 42, so no underlying_closed.',
    [...BASE, ...run(97, 97.6, 3), bar(97.6, 97.7, 95, 95.3), bar(95.3, 96.2, 95.1, 96), ...run(96, 97, 2)],
    [
      {
        type: 'sweep',
        at: 42,
        key: `sp:4h:${SWING_LOW}:${T4.open(41)}`,
        data: { kind: 'false_breakout', flags: ['liquidity_unverified'] },
      },
    ],
  ),
];

// ── Reopening: weekend levels and what follows ────────────────────────────────────────────────

const H1 = timeline(FRI + 12 * H, '1h');
const goldHours = (n: number): Bar[] =>
  Array.from({ length: n }, (_, i) => [2650, 2650.5 + 0.2 * (i % 7), 2649.5 - 0.3 * (i % 4), 2650]);

function reopening(
  id: string,
  description: string,
  bars: Case['main']['bars'],
  closures: Case['closures'],
  expected: Exp[],
): Case {
  return {
    id,
    concept: 'gold',
    class: 'reopening',
    description,
    profile: 'gold',
    start: H1.open(0),
    main: { tf: '1h', bars },
    closures,
    expected,
  };
}

const weekendLow = (knownAtIndex: number) =>
  keys.level('1d', 'weekend_low', 'sell_side', H1.close(knownAtIndex));

const reopeningCases: Case[] = [
  reopening(
    'gold-reopening-half-hour-001',
    'A manually entered closure that ends at 22:30 instead of on the hour: the hour that contains the reopening still overlaps the closure, so the weekend levels come at the first hour boundary after it (23:00), from hours 10–58.',
    goldHours(66),
    [{ ...WEEKEND, to: WEEKEND.to - H / 2 }],
    [
      {
        type: 'level_created',
        tf: '1d',
        key: keys.level('1d', 'weekend_high', 'buy_side', H1.close(58)),
        data: { type: 'weekend_high', price: '2651.7' },
      },
      {
        type: 'level_created',
        tf: '1d',
        key: weekendLow(58),
        data: { type: 'weekend_low', price: '2648.6' },
      },
    ],
  ),
  reopening(
    'gold-reopening-weekend-low-swept-001',
    'After the reopening, the Monday 00:00 hour wicks to 2647 below the weekend low (2648.6) and closes back above: a 1h sweep of it. The weekend level comes from 1d, so its status is decided on 4h: on 1h it is swept for 1h only, and stays active.',
    [...goldHours(60), bar(2650, 2650.5, 2647, 2649.8), ...goldHours(5)],
    [WEEKEND],
    [
      {
        type: 'sweep',
        tf: '1h',
        at: 60,
        data: {
          kind: 'wick',
          level: weekendLow(58),
          levelType: 'weekend_low',
          levelPrice: '2648.6',
          levelStatus: 'active',
          levelSweepCount: 1,
        },
      },
    ],
  ),
  reopening(
    'gold-reopening-missing-hour-001',
    'One hour inside the closure (Saturday 06:00) is missing for good: the weekend levels come from the hours there are, flagged data_gap.',
    goldHours(66).map((b, i) => (i === 30 ? null : b)),
    [WEEKEND],
    [
      { type: 'level_created', tf: '1d', data: { type: 'weekend_high', flags: ['data_gap'] } },
      {
        type: 'level_created',
        tf: '1d',
        key: weekendLow(58),
        data: { type: 'weekend_low', flags: ['data_gap'] },
      },
    ],
  ),
];

// ── Thin book with the gold threshold (20,000 USD) ──────────────────────────────────────────────

const goldThin = (id: string, description: string, m: ReturnType<typeof minutes>, expected: Exp[]): Case => ({
  ...thin(id, 'thin_book', description, WICK5, m, expected, 'gold'),
  concept: 'gold',
});

const thinCases: Case[] = [
  goldThin(
    'gold-thin-book-above-threshold-001',
    '400 units traded beyond the level: 38,200 USD. Thin under the crypto threshold (100,000), but not under gold’s (20,000).',
    sweepMinutes(100),
    [sweep5(33, 33, 'wick', { notionalBeyondUsd: '38200.00', flags: [] })],
  ),
  goldThin(
    'gold-thin-book-below-threshold-001',
    '100 units beyond the level: 9,550 USD, under gold’s 20,000: thin_book.',
    sweepMinutes(25),
    [sweep5(33, 33, 'wick', { notionalBeyondUsd: '9550.00', flags: ['thin_book'] })],
  ),
  goldThin(
    'gold-thin-book-unverified-001',
    'A minute of the sweep window lacks its micro profile: liquidity_unverified, whatever the threshold.',
    minutes([...M32, ...M33, ...M34, ...M35], { 6: profile({ 0: 25 }), 7: null }),
    [sweep5(33, 33, 'wick', { notionalBeyondUsd: null, flags: ['liquidity_unverified'] })],
  ),
];

export const goldCases: Case[] = [...closureCases, ...reopeningCases, ...thinCases];
