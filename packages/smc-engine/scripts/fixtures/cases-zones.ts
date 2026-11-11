/**
 * Rulebook §4 points of interest. Fair value gaps, order blocks, supply/demand zones and their fills
 * run on 4h candles (a structure and sweep timeframe without ranges, so order blocks are `htf` and
 * every location is `none`); internal/external location runs on 5m, where ranges are detected.
 *
 * As in the structure fixtures, flat candles (true range 1.5) and drift candles (step 0.5, wicks
 * 0.5) keep ATR(14) at 1.5 until a case's own candles move it; ATR values a case depends on are
 * worked out in its description. Neither flat nor drift candles ever form a gap between candle i−1
 * and i+1, so the zones a case lists are the only ones of its kind.
 */
import {
  bar,
  type Case,
  type Exp,
  flat,
  fmt,
  keys,
  MONDAY,
  run,
  type Slot,
  timeline,
  withMirrors,
  zig,
} from './lib.ts';

const TF = '4h';
const T = timeline(MONDAY, TF);
const START5 = Date.UTC(2026, 0, 6, 8); // Tuesday 08:00 UTC
const T5 = timeline(START5, '5m');

type Dir = 'bullish' | 'bearish';
type ZoneType = 'order_block' | 'fvg' | 'supply' | 'demand';

interface ZoneSpec {
  at: number;
  type: ZoneType;
  direction: Dir;
  top: number;
  bottom: number;
  from: number;
  to: number;
  htf?: boolean;
  location?: string;
  structureEvent?: string | null;
  linkedZone?: string | null;
  swept?: boolean;
  tl?: typeof T;
  tf?: '4h' | '5m';
}

const zoneKey = (z: Pick<ZoneSpec, 'type' | 'direction' | 'from' | 'tl' | 'tf'>) =>
  keys.zone(z.tf ?? TF, z.type, z.direction, (z.tl ?? T).open(z.from));

function created(z: ZoneSpec): Exp {
  const tl = z.tl ?? T;
  return {
    type: 'zone_created',
    at: z.at,
    key: zoneKey(z),
    data: {
      type: z.type,
      direction: z.direction,
      top: fmt(z.top),
      bottom: fmt(z.bottom),
      originFrom: tl.iso(z.from),
      originTo: tl.iso(z.to),
      knownAt: tl.isoClose(z.at),
      htf: z.htf ?? false,
      location: z.location ?? 'none',
      structureEvent: z.structureEvent ?? null,
      linkedZone: z.linkedZone ?? null,
      sweptLiquidityAtOrigin: z.swept ?? false,
      status: 'untouched',
      fillPct: 0,
      flags: [],
    },
  };
}

function status(
  key: string,
  at: number,
  s: string,
  fillPct: number,
  reason: string,
  firstTouch: number | null,
  changed: number | null,
): Exp {
  return {
    type: 'zone_status',
    at,
    key,
    data: {
      status: s,
      fillPct,
      reason,
      firstTouchAt: firstTouch === null ? null : T.isoClose(firstTouch),
      statusChangedAt: changed === null ? null : T.isoClose(changed),
    },
  };
}

const base = (id: string, concept: string, cls: Case['class'], description: string, bars: Slot[]): Case => ({
  id,
  concept,
  class: cls,
  description,
  start: MONDAY,
  main: { tf: TF, bars },
  expected: [],
});

const only = (type: ZoneType) => [{ type: 'zone_created', data: { type } }];

// ── §4.2 Fair value gaps ──────────────────────────────────────────────────────────────────────

const fvgCases: Case[] = [
  {
    ...base(
      'fvg-bullish-001',
      'fair-value-gaps',
      'bullish',
      'After 20 flat candles (high 100.75), a large bullish candle (20) and a pause (21, low 101.6): 101.6 is above the flat high 100.75 by 0.85, at least 0.2 × ATR (1.537 at 21): a bullish FVG [100.75, 101.6] from candles 19–21, created at the close of 21. The pause that follows stays above it.',
      [...flat(20), bar(100, 102.5, 99.9, 102.4), bar(102.4, 102.6, 101.6, 101.9), ...flat(10, 102.2, 0.4)],
    ),
    expected: [
      created({ at: 21, type: 'fvg', direction: 'bullish', top: 101.6, bottom: 100.75, from: 19, to: 21 }),
    ],
    exhaustive: only('fvg'),
  },
  {
    ...base(
      'fvg-bullish-minimum-001',
      'fair-value-gaps',
      'bullish',
      'Every candle has a true range of exactly 1.5, so ATR stays 1.5: the gap between the flat high (100.75) and candle 21’s low (101.05) is 0.30, exactly 0.2 × ATR. It counts: FVG [100.75, 101.05] at 21.',
      [...flat(20), bar(100, 101.5, 100, 101.5), bar(101.5, 102.55, 101.05, 102.4), ...flat(10, 102, 0.75)],
    ),
    expected: [
      created({ at: 21, type: 'fvg', direction: 'bullish', top: 101.05, bottom: 100.75, from: 19, to: 21 }),
    ],
    exhaustive: only('fvg'),
  },
  {
    ...base(
      'fvg-two-in-a-row-001',
      'fair-value-gaps',
      'bullish',
      'Two strong bullish candles (20, 21) and a pullback (22): 21’s low (101.2) is above 19’s high (100.75) and 22’s low (102.2) above 20’s high (101.7), both at least 0.2 ATR (0.313, 0.309): two FVGs, at 21 and at 22.',
      [
        ...flat(20),
        bar(100, 101.7, 99.9, 101.6),
        bar(101.6, 103.3, 101.2, 103.2),
        bar(103.2, 103.5, 102.2, 102.4),
        ...flat(10, 102.8, 0.5),
      ],
    ),
    expected: [
      created({ at: 21, type: 'fvg', direction: 'bullish', top: 101.2, bottom: 100.75, from: 19, to: 21 }),
      created({ at: 22, type: 'fvg', direction: 'bullish', top: 102.2, bottom: 101.7, from: 20, to: 22 }),
    ],
    exhaustive: only('fvg'),
  },
  {
    ...base(
      'fvg-too-small-001',
      'fair-value-gaps',
      'negative',
      'As fvg-bullish-minimum-001 with candle 21’s low one cent lower (101.04): a gap of 0.29, below 0.2 × ATR (0.30). No FVG.',
      [...flat(20), bar(100, 101.5, 100, 101.5), bar(101.5, 102.54, 101.04, 102.4), ...flat(10, 102, 0.75)],
    ),
    expected: [],
    exhaustive: only('fvg'),
  },
  {
    ...base(
      'fvg-touching-001',
      'fair-value-gaps',
      'negative',
      'Candle 21’s low (100.75) equals 19’s high: the candles touch, so there is no gap (the rule needs L(i+1) > H(i−1)).',
      [...flat(20), bar(100, 101.5, 100, 101.5), bar(101.5, 102.25, 100.75, 102.2), ...flat(10, 102, 0.75)],
    ),
    expected: [],
    exhaustive: only('fvg'),
  },
  {
    ...base(
      'fvg-gap-candle-001',
      'fair-value-gaps',
      'negative',
      'Candle 20 is missing for good. Candle 21’s low (101.5) is above 19’s high, but the three candles are not contiguous: no FVG (§9).',
      [...flat(20), null, bar(101.5, 103, 101.5, 102.9), ...flat(10, 102.5, 0.75)],
    ),
    expected: [{ type: 'gap_marker', at: 20, data: { from: T.iso(20) } }],
    exhaustive: only('fvg'),
  },
];

// ── §4.1 Order blocks ─────────────────────────────────────────────────────────────────────────

/** Flat to 100, up to 104 (swing high 104.5 at 27), back to 102 (low 101.5 at 31). */
const BASE_UP: Slot[] = [...flat(20), ...zig([100, 104, 102], [8, 4])];
/** Two higher highs (BOS at 37 and 49), as in the structure fixtures. */
const UP: Slot[] = [...flat(20), ...zig([100, 104, 102, 106, 104, 108], [8, 4, 8, 4, 8])];
const OB_BOS: Slot[] = [
  ...BASE_UP,
  bar(102, 102.4, 101.8, 101.9),
  bar(101.9, 105.3, 101.8, 105.2),
  ...run(105.2, 106, 2),
];
const OB_BOS_ZONE: ZoneSpec = {
  at: 33,
  type: 'order_block',
  direction: 'bullish',
  top: 104,
  bottom: 101.5,
  from: 29,
  to: 31,
  htf: true,
  structureEvent: keys.structure(TF, 'internal', 'bos', T.open(33)),
};

const obCases: Case[] = [
  {
    ...base(
      'ob-bullish-bos-001',
      'order-blocks',
      'bullish',
      'The initial BOS at 33 breaks the swing high 104.5 with a displacement candle; its leg starts at the low of 31 (101.5). The last down-close candle at or before 31 is 31 itself, and 30 and 29 close down too: a cluster of 3 (the maximum), zone [101.5, 104] (lowest low, highest high). The break comes 2 candles after the leg start (≤ 10). It is created once, for the internal BOS; the external BOS finds the same candles. 4h: htf.',
      OB_BOS,
    ),
    expected: [
      created(OB_BOS_ZONE),
      {
        type: 'structure',
        at: 33,
        key: OB_BOS_ZONE.structureEvent!,
        data: { type: 'bos', direction: 'bullish' },
      },
    ],
    exhaustive: only('order_block'),
  },
  {
    ...base(
      'ob-bearish-mss-001',
      'order-blocks',
      'bearish',
      'After two bullish BOS, a decline whose candle 58 falls from 105 to 102.5: an MSS (CHOCH with displacement). Its leg starts at the highest high since the protected low was set: 108.5, last reached at 52. 52 closes down; 51 closes up and so do 50 and 49: bearish order block [106, 108.5] from candles 49–51, 6 candles before the break.',
      [...UP, ...run(108, 105, 6), bar(105, 105.1, 102.4, 102.5), ...run(102.5, 101, 3)],
    ),
    expected: [
      created({
        at: 58,
        type: 'order_block',
        direction: 'bearish',
        top: 108.5,
        bottom: 106,
        from: 49,
        to: 51,
        htf: true,
        structureEvent: keys.structure(TF, 'internal', 'mss', T.open(58)),
      }),
    ],
    exhaustive: only('order_block'),
  },
  {
    ...base(
      'ob-bullish-swept-001',
      'order-blocks',
      'bullish',
      'A swing low at 97.5 (23) becomes a sell-side level. Candle 34 wicks to 97.2 and closes back at 98.2: a wick sweep. Candle 35 (98.2 → 101.8, a displacement) closes above the swing high 101.5 (29): initial BOS whose leg starts at 34. Order block: 34 and the down-close 33 and 32, zone [97.2, 100.5]. The sweep breached at the leg start, within the 10 candles before it: sweptLiquidityAtOrigin.',
      [
        ...flat(20),
        ...zig([100, 98, 101, 99], [4, 6, 4]),
        bar(99, 99.2, 97.2, 98.2),
        bar(98.2, 101.9, 98.1, 101.8),
        ...run(101.8, 103, 3),
      ],
    ),
    expected: [
      created({
        at: 35,
        type: 'order_block',
        direction: 'bullish',
        top: 100.5,
        bottom: 97.2,
        from: 32,
        to: 34,
        htf: true,
        swept: true,
        structureEvent: keys.structure(TF, 'internal', 'bos', T.open(35)),
      }),
      {
        type: 'sweep',
        at: 34,
        data: {
          kind: 'wick',
          side: 'sell_side',
          levelType: 'swing_low',
          levelPrice: '97.5',
          extremePrice: '97.2',
        },
      },
    ],
    exhaustive: only('order_block'),
  },
  {
    ...base(
      'ob-no-displacement-001',
      'order-blocks',
      'negative',
      'Two bullish BOS (37 and 49) made of drift candles: their legs contain no displacement, so neither leaves an order block.',
      UP,
    ),
    expected: [
      { type: 'structure', at: 37, data: { type: 'bos', displacement: null } },
      { type: 'structure', at: 49, data: { type: 'bos', displacement: null } },
    ],
    exhaustive: only('order_block'),
  },
  {
    ...base(
      'ob-break-too-late-001',
      'order-blocks',
      'negative',
      'The leg starts at the low of 31 (101.5); price idles above it for 11 candles, then candle 43 breaks 104.5 with a displacement. The BOS has displacement, but it comes 12 candles after the leg start, more than 10: no order block.',
      [...BASE_UP, ...flat(11, 102.5, 0.75), bar(102.5, 105.3, 102.4, 105.2), ...run(105.2, 106, 2)],
    ),
    expected: [
      {
        type: 'structure',
        at: 43,
        key: keys.structure(TF, 'internal', 'bos', T.open(43)),
        data: { type: 'bos', displacement: { from: T.iso(43), to: T.iso(43) } },
      },
    ],
    exhaustive: only('order_block'),
  },
  {
    ...base(
      'ob-no-opposite-candle-001',
      'order-blocks',
      'negative',
      'The fall from the swing high is five up-close candles that each open lower (28–32); candle 33 breaks 104.5 with a displacement. Among the leg-start candle (32) and the four before it there is no down-close candle: no order block.',
      [
        ...flat(20),
        ...run(100, 104, 8),
        bar(103.4, 103.8, 103.2, 103.6),
        bar(102.9, 103.3, 102.7, 103.1),
        bar(102.4, 102.8, 102.2, 102.6),
        bar(101.9, 102.3, 101.7, 102.1),
        bar(101.4, 101.8, 101.2, 101.6),
        bar(101.6, 105.3, 101.5, 105.2),
        ...run(105.2, 106, 2),
      ],
    ),
    expected: [
      {
        type: 'structure',
        at: 33,
        key: keys.structure(TF, 'internal', 'bos', T.open(33)),
        data: { type: 'bos', displacement: { from: T.iso(33), to: T.iso(33) } },
      },
    ],
    exhaustive: only('order_block'),
  },
];

// ── §4.3 Supply and demand ────────────────────────────────────────────────────────────────────

const SD = [
  { type: 'zone_created', data: { type: 'demand' } },
  { type: 'zone_created', data: { type: 'supply' } },
];

const sdCases: Case[] = [
  {
    ...base(
      'demand-single-candle-001',
      'supply-demand',
      'bullish',
      'Flat candles (bodies 0) form the base; candle 20 (100 → 104.5, body 4.5, ATR 1.729) is a displacement that starts right after it and reaches 104.6, 3.85 above the base high, at least 2.0 ATR (3.457). Demand: the last 4 base candles (16–19), proximal edge 100 (highest body top), distal edge 99.25 (lowest low).',
      [...flat(20), bar(100, 104.6, 99.9, 104.5), ...flat(10, 104.5, 0.75)],
    ),
    expected: [
      created({ at: 20, type: 'demand', direction: 'bullish', top: 100, bottom: 99.25, from: 16, to: 19 }),
    ],
    exhaustive: SD,
  },
  {
    ...base(
      'demand-leg-001',
      'supply-demand',
      'bullish',
      'A bearish candle with a 1.0 body (18, more than 0.5 ATR) ends the flat; two small candles (19, 20) form the base; a two-candle leg (21–22, bodies 1.6 and 1.8, together 3.4 ≥ 2 ATR = 2.866) departs and reaches 103.1, 3.1 above the base high 100. Demand [99.3, 99.7] at 22. At 21 the leg was not yet a displacement.',
      [
        ...flat(18),
        bar(100.5, 100.6, 99.4, 99.5),
        bar(99.5, 99.9, 99.3, 99.7),
        bar(99.7, 100, 99.4, 99.6),
        bar(99.6, 101.3, 99.5, 101.2),
        bar(101.2, 103.1, 101.1, 103),
        ...flat(10, 103, 0.75),
      ],
    ),
    expected: [
      created({ at: 22, type: 'demand', direction: 'bullish', top: 99.7, bottom: 99.3, from: 19, to: 20 }),
    ],
    exhaustive: SD,
  },
  {
    ...base(
      'demand-gap-candle-001',
      'supply-demand',
      'bullish',
      'Between the flat base and the departure (21) stands one bearish candle with a 0.9 body (20, more than 0.5 ATR = 0.743): the base may end one candle before the departure. 21 travels to 104.6, 3.85 above the base, ≥ 2 ATR (3.559): demand [99.25, 100] from 16–19, at 21.',
      [...flat(20), bar(100, 100.2, 98.9, 99.1), bar(99.1, 104.6, 99, 104.5), ...flat(10, 104.5, 0.75)],
    ),
    expected: [
      created({ at: 21, type: 'demand', direction: 'bullish', top: 100, bottom: 99.25, from: 16, to: 19 }),
    ],
    exhaustive: SD,
  },
  {
    ...base(
      'sd-short-travel-001',
      'supply-demand',
      'negative',
      'The same base, and candle 20 is a displacement, but it reaches only 103.6: 2.85 above the base high, less than 2 ATR (3.314). No demand zone.',
      [...flat(20), bar(100, 103.6, 99.9, 103.5), ...flat(10, 103.5, 0.75)],
    ),
    expected: [],
    exhaustive: SD,
  },
  {
    ...base(
      'sd-big-base-001',
      'supply-demand',
      'negative',
      'Before the departure (20), six alternating candles with bodies of 1.0, each more than 0.5 ATR (at most 0.74): no base, so no demand zone, though the departure travels far.',
      [
        ...flat(14),
        ...[0, 1, 2].flatMap(() => [bar(100, 100.1, 98.9, 99), bar(99, 100.1, 98.9, 100)]),
        bar(100, 104.6, 99.9, 104.5),
        ...flat(10, 104.5, 0.75),
      ],
    ),
    expected: [],
    exhaustive: SD,
  },
  {
    ...base(
      'sd-far-base-001',
      'supply-demand',
      'negative',
      'Two candles that are not small (20, 21: bodies 0.9 and 1.1) separate the flat base from the departure (22): the base must end at most one candle before it. No demand zone.',
      [
        ...flat(20),
        bar(100, 100.2, 98.9, 99.1),
        bar(99.1, 99.2, 97.9, 98),
        bar(98, 104.6, 97.9, 104.5),
        ...flat(10, 104.5, 0.75),
      ],
    ),
    expected: [],
    exhaustive: SD,
  },
];

// ── §4.4 Touches, fills and invalidation ──────────────────────────────────────────────────────

/** A bullish FVG [100.75, 101.75] (height 1.0) created at 21, then 5 candles above it (low 101.8). */
const FILL_BASE: Slot[] = [
  ...flat(20),
  bar(100, 102.9, 99.9, 102.8),
  bar(102.8, 103, 101.75, 102.1),
  ...flat(5, 102.3, 0.5),
];
const FILL_ZONE: ZoneSpec = {
  at: 21,
  type: 'fvg',
  direction: 'bullish',
  top: 101.75,
  bottom: 100.75,
  from: 19,
  to: 21,
};
const FZ = zoneKey(FILL_ZONE);
const FILL_STATUS = [{ type: 'zone_status', key: FZ }];

const fillCases: Case[] = [
  {
    ...base(
      'zone-fill-stepwise-001',
      'zone-fills',
      'bullish',
      'The FVG [100.75, 101.75] is entered from its top: 27 dips to 101.45 (touch, 30 % filled), 28 only to 101.55 (no change), 29 to 101.0 (75 %), 30 to the bottom, 100.75 (filled, 100 %, closing inside), and 31 closes at 100.7, below the bottom: invalidated.',
      [
        ...FILL_BASE,
        bar(102.3, 102.4, 101.45, 101.6),
        bar(101.6, 102, 101.55, 101.9),
        bar(101.9, 102, 101, 101.2),
        bar(101.2, 101.4, 100.75, 101.1),
        bar(101.1, 101.2, 100.5, 100.7),
        ...flat(3, 100.7, 0.3),
      ],
    ),
    expected: [
      created(FILL_ZONE),
      status(FZ, 27, 'partially_filled', 30, 'touch', 27, 27),
      status(FZ, 29, 'partially_filled', 75, 'fill', 27, 27),
      status(FZ, 30, 'filled', 100, 'fill', 27, 30),
      status(FZ, 31, 'invalidated', 100, 'invalidated', 27, 31),
    ],
    exhaustive: FILL_STATUS,
  },
  {
    ...base(
      'zone-fill-edge-touch-001',
      'zone-fills',
      'bullish',
      'Candle 27’s low is exactly the top, 101.75: a touch at the proximal edge, 0 % filled. Candle 28 reaches exactly the bottom and closes on it (100.75): filled, but a close at the distal edge is not beyond it, so not invalidated. 29 dips to the bottom again: nothing new.',
      [
        ...FILL_BASE,
        bar(102.3, 102.4, 101.75, 102),
        bar(102, 102.1, 100.75, 100.75),
        bar(100.75, 101.6, 100.75, 101.5),
        ...flat(3, 101.5, 0.3),
      ],
    ),
    expected: [
      created(FILL_ZONE),
      status(FZ, 27, 'partially_filled', 0, 'touch', 27, 27),
      status(FZ, 28, 'filled', 100, 'fill', 27, 28),
    ],
    exhaustive: FILL_STATUS,
  },
  {
    ...base(
      'zone-expired-001',
      'zone-fills',
      'bullish',
      'Touched once (27, 30 %), then never again: 200 candles after it was created (at 21) the FVG expires, at the close of candle 221, keeping its fill.',
      [...FILL_BASE, bar(102.3, 102.4, 101.45, 101.6), ...flat(200, 102.3, 0.5)],
    ),
    expected: [
      created(FILL_ZONE),
      status(FZ, 27, 'partially_filled', 30, 'touch', 27, 27),
      status(FZ, 221, 'expired', 30, 'expired', 27, 221),
    ],
    exhaustive: FILL_STATUS,
  },
  {
    ...base(
      'zone-near-miss-001',
      'zone-fills',
      'negative',
      'Candle 27 comes down to 101.76, one cent above the FVG’s top: no touch, and the zone stays untouched.',
      [...FILL_BASE, bar(102.3, 102.4, 101.76, 102), ...flat(5, 102.3, 0.5)],
    ),
    expected: [created(FILL_ZONE)],
    exhaustive: FILL_STATUS,
  },
  {
    ...base(
      'zone-wick-through-001',
      'zone-fills',
      'negative',
      'Candle 27 wicks through the whole FVG to 100.2 and closes back inside (101.2): touched and filled at once, but not invalidated, since only a close beyond the distal edge invalidates. Later candles trade inside it and close above the bottom.',
      [...FILL_BASE, bar(102.3, 102.4, 100.2, 101.2), ...flat(5, 101.5, 0.3)],
    ),
    expected: [created(FILL_ZONE), status(FZ, 27, 'filled', 100, 'touch', 27, 27)],
    notExpected: [{ type: 'zone_status', key: FZ, data: { status: 'invalidated' } }],
    exhaustive: FILL_STATUS,
  },
  {
    ...base(
      'zone-creation-candle-001',
      'zone-fills',
      'negative',
      'The order block of ob-bullish-bos-001, [101.5, 104], is created by the break candle 33, whose low (101.8) lies inside it, as does 32’s. A zone is evaluated from the candle after it is created; 34 and 35 stay above it. No touch.',
      OB_BOS,
    ),
    expected: [created(OB_BOS_ZONE)],
    exhaustive: [{ type: 'zone_status', key: zoneKey(OB_BOS_ZONE) }],
  },
];

// ── §4.5 Internal and external (5m, where ranges are detected) ────────────────────────────────

/** 48 flat candles 99–101 (ATR 2): a range at 47, high 101, low 99. */
const RANGE: Slot[] = flat(48, 100, 1);
const loc = (z: Omit<ZoneSpec, 'tl' | 'tf' | 'type'>): ZoneSpec => ({ ...z, type: 'fvg', tl: T5, tf: '5m' });
const range47: Exp = { type: 'range_detected', at: 47, data: { high: '101', low: '99' } };

function locCase(id: string, cls: Case['class'], description: string, bars: Slot[], expected: Exp[]): Case {
  return {
    id,
    concept: 'zone-location',
    class: cls,
    description,
    start: START5,
    main: { tf: '5m', bars },
    expected,
    exhaustive: only('fvg'),
  };
}

const locationCases: Case[] = [
  locCase(
    'zone-location-internal-001',
    'bullish',
    'A range 99–101 is active from 47. Candles 48–50 leave a bullish FVG [99.7, 100.1] (gap 0.4 ≥ 0.2 ATR = 0.348), entirely inside the range: internal.',
    [
      ...RANGE,
      bar(99.6, 99.7, 99.3, 99.65),
      bar(99.65, 100.5, 99.6, 100.45),
      bar(100.45, 100.6, 100.1, 100.5),
      ...flat(5, 100.4, 0.2),
    ],
    [
      range47,
      created(
        loc({
          at: 50,
          direction: 'bullish',
          top: 100.1,
          bottom: 99.7,
          from: 48,
          to: 50,
          location: 'internal',
        }),
      ),
    ],
  ),
  locCase(
    'zone-location-external-001',
    'bullish',
    'From the range 99–101, candle 49 falls to 97.7 (one close beyond the low) and 50 closes at 98.6, beyond it by only 0.4 (< 0.25 ATR = 0.464), so the range is still active. 48’s low (99) and 50’s high (98.6) leave a bearish FVG [98.6, 99], entirely at or below the range low: external.',
    [
      ...RANGE,
      bar(99.4, 99.6, 99, 99.2),
      bar(99.2, 99.3, 97.6, 97.7),
      bar(97.7, 98.6, 97.5, 98.6),
      ...flat(5, 98.2, 0.3),
    ],
    [
      range47,
      created(
        loc({ at: 50, direction: 'bearish', top: 99, bottom: 98.6, from: 48, to: 50, location: 'external' }),
      ),
    ],
  ),
  locCase(
    'zone-location-straddling-001',
    'bullish',
    'Candle 49 closes above the range high (101.9) and 50 closes 0.4 above it (< 0.25 ATR = 0.450), so the range is still active. 48’s high (100.7) and 50’s low (101.1) leave a bullish FVG [100.7, 101.1] across the range high: straddling.',
    [
      ...RANGE,
      bar(100.4, 100.7, 100.2, 100.6),
      bar(100.6, 102, 100.5, 101.9),
      bar(101.6, 101.7, 101.1, 101.4),
      ...flat(5, 101.4, 0.2),
    ],
    [
      range47,
      created(
        loc({
          at: 50,
          direction: 'bullish',
          top: 101.1,
          bottom: 100.7,
          from: 48,
          to: 50,
          location: 'straddling',
        }),
      ),
    ],
  ),
  locCase(
    'zone-location-no-range-001',
    'negative',
    'The FVG of zone-location-internal-001, made at 22 before 48 candles exist: no active range, so its location is none.',
    [
      ...flat(20, 100, 1),
      bar(99.6, 99.7, 99.3, 99.65),
      bar(99.65, 100.5, 99.6, 100.45),
      bar(100.45, 100.6, 100.1, 100.5),
      ...flat(30, 100.4, 0.2),
    ],
    [
      created(
        loc({ at: 22, direction: 'bullish', top: 100.1, bottom: 99.7, from: 20, to: 22, location: 'none' }),
      ),
    ],
  ),
  locCase(
    'zone-location-range-ended-001',
    'negative',
    'Candles 49 and 50 both close more than 0.25 ATR above the range high: the range ends with a breakout at 50, before the points of interest of that candle are evaluated. The FVG [100.7, 101.5] it completes has no active range: none.',
    [
      ...RANGE,
      bar(100.4, 100.7, 100.2, 100.6),
      bar(100.6, 102, 100.5, 101.9),
      bar(101.9, 102.3, 101.5, 102.2),
      ...flat(5, 102.2, 0.3),
    ],
    [
      range47,
      { type: 'range_ended', at: 50, data: { reason: 'breakout_up' } },
      created(
        loc({ at: 50, direction: 'bullish', top: 101.5, bottom: 100.7, from: 48, to: 50, location: 'none' }),
      ),
    ],
  ),
  {
    ...base(
      'zone-location-4h-001',
      'zone-location',
      'negative',
      'The FVG of fvg-bullish-001 on 4h, where no range is ever detected (ranges run on the setup timeframes): location none.',
      [...flat(20), bar(100, 102.5, 99.9, 102.4), bar(102.4, 102.6, 101.6, 101.9), ...flat(10, 102.2, 0.4)],
    ),
    expected: [
      created({ at: 21, type: 'fvg', direction: 'bullish', top: 101.6, bottom: 100.75, from: 19, to: 21 }),
    ],
    exhaustive: only('fvg'),
  },
];

export const zoneCases: Case[] = withMirrors([
  ...fvgCases,
  ...obCases,
  ...sdCases,
  ...fillCases,
  ...locationCases,
]);
