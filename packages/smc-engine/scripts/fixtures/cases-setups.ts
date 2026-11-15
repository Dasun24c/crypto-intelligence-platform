/**
 * Rulebook §6.3–§6.5 (Patterns 2–4), with the context timeframe where a pattern needs it. A 1h
 * history comes first; the 5m series starts when it ends, and from then on the 1h candles are the
 * 5m candles aggregated (as the platform builds them). `at` indices are 5m candles.
 */
import {
  agg,
  atrs,
  bar,
  type Bar,
  type Case,
  flat,
  keys,
  MONDAY,
  run,
  timeline,
  withMirrors,
} from './lib.ts';
import {
  CONFIRMATIONS,
  checklist,
  invalidation,
  RANGE as SHARED_RANGE,
  ratio4,
  score,
  setupKey,
  transition,
} from './cases-patterns.ts';

/** The shared range of the Pattern 1 cases (detected at 47), reused by Pattern 4. */
const patternRange = () => SHARED_RANGE;

const HOUR = 3_600_000;

/** A case whose 5m series starts after `history` 1h candles (from MONDAY). */
function withContext(
  id: string,
  concept: string,
  cls: Case['class'],
  description: string,
  history: Bar[],
  bars: Bar[],
): Case {
  const start = MONDAY + history.length * HOUR;
  return {
    id,
    concept,
    class: cls,
    description,
    start,
    main: { tf: '5m', bars },
    more: [{ tf: '1h', start: MONDAY, bars: [...history, ...agg(bars, 12)] }],
    expected: [],
  };
}

// ── Pattern 2: equal highs near a POI (bearish) ───────────────────────────────────────────────

/**
 * 1h history: 20 flat candles at 107 (the base), then a drop to 102.5 (body 4.5, 3.85 below the
 * base low, ≥ 2 ATR): a supply zone [107, 107.75] at 1h candle 20; flat at 102.5 after it. No
 * swings, so no structure and no order block: Pattern 3 has nothing to work on.
 */
export const SUPPLY_HISTORY: Bar[] = [...flat(20, 107), bar(107, 107.1, 102.4, 102.5), ...flat(4, 102.5)];
const P2_START = MONDAY + SUPPLY_HISTORY.length * HOUR;
const T2 = timeline(P2_START, '5m');
const SUPPLY = keys.zone('1h', 'supply', 'bearish', MONDAY + 16 * HOUR);

/**
 * The 5m approach: a base at 102.5, a rise with an external swing low at 28 (103.0, the target),
 * equal highs at 106.3 (34 and 46, 0.7 below the supply's bottom), and an internal swing low at 50
 * (104.9, the MSS anchor) confirmed by 52.
 */
export const P2_APPROACH: Bar[] = [
  ...flat(20, 102.5), // 0-19
  ...run(102.5, 104.3, 6), // 20-25
  bar(104.3, 104.4, 103.8, 103.9), // 26
  bar(103.9, 104, 103.4, 103.5), // 27
  bar(103.5, 103.6, 103, 103.2), // 28 swing low 103 (external: level at 33)
  bar(103.2, 103.8, 103.1, 103.7), // 29
  ...run(103.7, 105.5, 4), // 30-33
  bar(105.5, 106.3, 105.3, 105.8), // 34 swing high 106.3
  ...run(105.8, 104.8, 5), // 35-39
  bar(104.8, 105, 104.3, 104.5), // 40 swing low 104.3 between the highs
  ...run(104.5, 105.8, 5, 0.1), // 41-45
  bar(105.8, 106.3, 105.6, 105.9), // 46 swing high 106.3: equal highs at 48
  ...run(105.9, 105.3, 3, 0.1), // 47-49
  bar(105.3, 105.4, 104.9, 105), // 50 the anchor
  bar(105, 105.5, 104.95, 105.4), // 51
];
const P2 = 'eq_near_poi';
const EQH = keys.level('5m', 'eqh', 'buy_side', T2.close(48));

const P2_KEY = setupKey(P2, 'bearish', 48, T2);
export const P2_SWEEP: Bar = bar(105.4, 107.2, 105.3, 105.8); // 52 sweeps 106.3 into the supply (107)
export const P2_CONFIRM: Bar[] = [
  bar(105.8, 105.9, 103.7, 103.8), // 53 MSS: closes below the anchor 104.9, body 2.0
  bar(103.8, 104.9, 103.6, 104.2), // 54 completes the FVG [104.9, 105.3]
];
const P2_SETUP =
  '1h: a supply zone [107, 107.75] (base at 107, drop at 1h candle 20); the first candle of the plateau after the drop is a 1h swing low at 101.75 (a level), where a 1h sweep also left an extreme. 5m: equal highs at 106.3 (34 and 46, the level from 48) lie 0.7 below the supply, within 1.0 × the 1h ATR: the setup forms at 48.';

function p2Case(
  n: string,
  description: string,
  tail: Bar[],
  extra: ReturnType<typeof transition>[],
  opts: { sweep?: Bar; economicEvents?: Case['economicEvents']; credits?: number[] } = {},
): Case {
  const bars: Bar[] = [...P2_APPROACH, opts.sweep ?? P2_SWEEP, ...P2_CONFIRM, ...tail];
  const a = atrs(bars);
  const extreme = bars[52]![1];
  const inv = invalidation(extreme, a[52]!);
  const credits = opts.credits ?? [0, 1, 1, 1, 1, 1, 0, 1];
  const rr = ratio4(104.9 - 103, inv - 104.9);
  return {
    ...withContext(
      `p2-bearish-${n}`,
      'pattern-2',
      'bearish',
      `${P2_SETUP} 52 sweeps them (high ${extreme}, close 105.8), its extreme reaching the supply: triggered, invalidation ${inv} (5m ATR ${a[52]!.toFixed(4)}). 53 closes at 103.8, below the anchor (the internal swing low at 50, 104.9), with displacement; 54 completes the FVG [104.9, 105.3]: confirmed at 54, entry 104.9. T1 is the external swing low at 28 (103), T2 the 1h levels at 101.75; R:R ${rr}. Score ${score(credits)}. ${description}`,
      SUPPLY_HISTORY,
      bars,
    ),
    ...(opts.economicEvents !== undefined ? { economicEvents: opts.economicEvents } : {}),
    expected: [
      transition(P2_KEY, 48, { from: null, to: 'forming', pattern: P2, direction: 'bearish' }),
      transition(P2_KEY, 52, {
        from: 'forming',
        to: 'triggered',
        refs: { poi: SUPPLY, sweeps: [keys.sweep('5m', EQH, T2.open(52))] },
        levels: { invalidation: String(inv) },
      }),
      transition(P2_KEY, 54, {
        from: 'triggered',
        to: 'confirmed',
        levels: { entry: '104.9', invalidation: String(inv), target1: '103', target2: '101.75', rr },
        entryZone: keys.zone('5m', 'fvg', 'bearish', T2.open(52)),
        checklist: checklist(credits as never),
        score: score(credits),
      }),
      ...extra,
    ],
    exhaustive: CONFIRMATIONS,
  };
}

function p2Positives(): Case[] {
  return [
    p2Case(
      '001',
      '55 touches the entry; 57 reaches 103: target reached.',
      [bar(104.2, 105, 104.1, 104.6), bar(104.6, 104.7, 103.5, 103.6), bar(103.6, 103.7, 102.9, 103)],
      [
        transition(P2_KEY, 55, { from: 'confirmed', to: 'entry_active' }),
        transition(P2_KEY, 57, { from: 'entry_active', to: 'resolved', resolution: 'target_reached' }),
      ],
    ),
    p2Case(
      '002',
      '55 touches the entry; 56 rallies through the invalidation: invalidated after entry.',
      [bar(104.2, 105, 104.1, 104.6), bar(104.6, 107.6, 104.5, 107.1)],
      [
        transition(P2_KEY, 55, { from: 'confirmed', to: 'entry_active' }),
        transition(P2_KEY, 56, { from: 'entry_active', to: 'resolved', resolution: 'invalidated' }),
      ],
    ),
    p2Case(
      '003',
      '55 falls to 102.95 with a high of 104.3, below the entry: the target came first, expired_no_entry.',
      [bar(104.2, 104.3, 102.95, 103.1)],
      [
        transition(P2_KEY, 55, {
          from: 'confirmed',
          to: 'resolved',
          resolution: 'expired_no_entry',
          reason: 'target_before_entry',
        }),
      ],
    ),
    p2Case(
      '004',
      'The next 24 candles hold between 103.35 and 104.65, never touching the entry nor T1: expired_no_entry at 78 (54 + 24).',
      flat(24, 104, 0.65),
      [
        transition(P2_KEY, 78, {
          from: 'confirmed',
          to: 'resolved',
          resolution: 'expired_no_entry',
          reason: 'entry_window_passed',
        }),
      ],
    ),
    p2Case(
      '005',
      'The economic calendar holds a high-impact USD release 2 hours after the confirmation and a medium-impact one 10 minutes before it: neither is a high-impact event inside the 30-minute blackout, so news is clear. 55 touches the entry; 57 reaches 103.',
      [bar(104.2, 105, 104.1, 104.6), bar(104.6, 104.7, 103.5, 103.6), bar(103.6, 103.7, 102.9, 103)],
      [transition(P2_KEY, 57, { from: 'entry_active', to: 'resolved', resolution: 'target_reached' })],
      {
        economicEvents: [
          { id: 'cpi', at: T2.close(54) + 2 * HOUR, currency: 'USD', impact: 'high' },
          { id: 'claims', at: T2.close(54) - 10 * 60_000, currency: 'USD', impact: 'medium' },
        ],
      },
    ),
  ];
}

function p2Negatives(): Case[] {
  const notConfirmed = { type: 'setup_transition', data: { pattern: P2, to: 'confirmed' } };
  const noTrigger = { type: 'setup_transition', key: P2_KEY, data: { to: 'triggered' } };
  const forming = transition(P2_KEY, 48, { from: null, to: 'forming' });
  return [
    {
      ...withContext(
        'p2-negative-eq-alone-001',
        'pattern-2',
        'negative',
        'The card’s warning: equal highs alone. The 1h history is flat at 102.5, so there is no supply or order block above the equal highs at 106.3. They are swept (52) and an MSS follows (53), but no Pattern 2 setup ever forms.',
        flat(25, 102.5),
        [...P2_APPROACH, P2_SWEEP, ...P2_CONFIRM, ...flat(4, 104)],
      ),
      expected: [],
      notExpected: [{ type: 'setup_transition', data: { pattern: P2 } }],
    },
    {
      ...withContext(
        'p2-negative-short-of-poi-001',
        'pattern-2',
        'negative',
        'The sweep at 52 reaches 106.8, short of the supply’s bottom 107: it does not reach the POI, so no trigger. The swept equal highs are no longer a candidate: the setup expires at 53.',
        SUPPLY_HISTORY,
        [...P2_APPROACH, bar(105.4, 106.8, 105.3, 105.8), ...P2_CONFIRM, ...flat(4, 104)],
      ),
      expected: [
        forming,
        transition(P2_KEY, 53, {
          from: 'forming',
          to: 'resolved',
          resolution: 'expired',
          reason: 'no_candidates',
        }),
      ],
      notExpected: [noTrigger, notConfirmed],
    },
    {
      ...withContext(
        'p2-negative-close-above-001',
        'pattern-2',
        'negative',
        'After the setup forms (48), candle 49 runs to 108 and closes at 107.9, above the supply’s top 107.75: the zone is ruled out, and with it the only candidate. The setup expires at 49; the equal highs were breached, not swept.',
        SUPPLY_HISTORY,
        [...P2_APPROACH.slice(0, 49), bar(105.9, 108, 105.8, 107.9), ...flat(6, 107.5)],
      ),
      expected: [
        forming,
        transition(P2_KEY, 49, {
          from: 'forming',
          to: 'resolved',
          resolution: 'expired',
          reason: 'no_candidates',
          evidence: { lost: [{ level: EQH, poi: SUPPLY }], excluded: [SUPPLY], close: '107.9' },
        }),
      ],
      notExpected: [noTrigger, notConfirmed],
    },
    {
      ...withContext(
        'p2-negative-deep-001',
        'pattern-2',
        'negative',
        'The sweep at 52 runs to 110 before closing back at 105.8: more than 2 ATR beyond the equal highs (with its own range in the ATR), so it is deep and does not qualify. No trigger; the swept level leaves no candidate and the setup expires.',
        SUPPLY_HISTORY,
        [...P2_APPROACH, bar(105.4, 110, 105.3, 105.8), ...P2_CONFIRM, ...flat(4, 104)],
      ),
      expected: [forming, transition(P2_KEY, 53, { from: 'forming', to: 'resolved', resolution: 'expired' })],
      notExpected: [noTrigger, notConfirmed],
    },
    {
      ...withContext(
        'p2-negative-no-mss-001',
        'pattern-2',
        'negative',
        'Triggered at 52 by the sweep into the supply; price then holds at 105.5 (lows 105.2, above the anchor 104.9): no MSS within 12 candles, expired at 65.',
        SUPPLY_HISTORY,
        [...P2_APPROACH, P2_SWEEP, ...flat(14, 105.5, 0.3)],
      ),
      expected: [
        forming,
        transition(P2_KEY, 52, { from: 'forming', to: 'triggered' }),
        transition(P2_KEY, 65, {
          from: 'triggered',
          to: 'resolved',
          resolution: 'expired',
          reason: 'no_mss',
        }),
      ],
      notExpected: [notConfirmed],
    },
  ];
}

// ── Pattern 3: a large 1h order block (bearish) ───────────────────────────────────────────────

/**
 * 1h history: flat at 105, a swing low at 21 (103), a rally of up-close candles to 107.6 (28), and
 * a drop at 29 that closes at 102.5, below the swing low, with displacement: an initial bearish
 * BOS whose leg starts at 28. Its order block is the up-close cluster 26–28: [105.1, 107.6], `htf`
 * on 1h. Flat at 102.5 after it until 21:00 UTC on Tuesday, so that no trading session ends while
 * the 5m series runs (session levels come from 1h candles).
 */
export const OB_HISTORY: Bar[] = [
  ...flat(20, 105), // 0-19
  bar(105, 105.1, 103.9, 104), // 20
  bar(104, 104.1, 103, 103.2), // 21 swing low 103
  bar(103.2, 104.2, 103.1, 104.1), // 22
  ...run(104.1, 106.6, 5), // 23-27
  bar(106.6, 107.6, 106.5, 107.5), // 28 the leg's start
  bar(107.5, 107.55, 102.4, 102.5), // 29 breaks 103 with displacement
  ...flat(15, 102.5), // 30-44
];
const P3_START = MONDAY + OB_HISTORY.length * HOUR;
const T3 = timeline(P3_START, '5m');
const P3 = 'htf_order_block';
const P3_KEY = setupKey(P3, 'bearish', 0, T3);
const HTF_OB = keys.zone('1h', 'order_block', 'bearish', MONDAY + 26 * HOUR);
const SWING_105 = keys.level('5m', 'swing_high', 'buy_side', T3.close(33));
const P3_SETUP =
  '1h: an initial bearish BOS at 1h candle 29 (close 102.5 under the swing low 103, with displacement) leaves the htf order block [105.1, 107.6] (the up-close cluster 26–28); the 1h trend is bearish. Flat 1h candles at 102.5 follow (low 101.75: the first of them is a swing low, and the sessions they span leave lows there too). The 5m series starts at 21:00 at 102.5, within 2 × the 1h ATR below the block: the setup forms at once (0).';

/**
 * The 5m approach: a base at 102.5, a rise to an external swing high at 28 (105, a level from 33)
 * and an internal swing low at 33 (103.7, the MSS anchor).
 */
const P3_APPROACH: Bar[] = [
  ...flat(20, 102.5), // 0-19
  ...run(102.5, 104.4, 8), // 20-27
  bar(104.4, 105, 104.2, 104.5), // 28 swing high 105
  ...run(104.5, 104, 4, 0.1), // 29-32
  bar(104, 104.1, 103.7, 103.8), // 33 the anchor 103.7
  ...run(103.8, 104.6, 4, 0.1), // 34-37
];
const P3_TRIGGER: Bar[] = [
  bar(104.6, 105.6, 104.5, 104.7), // 38 touches the block (105.1) and sweeps 105
  bar(104.7, 104.8, 102.6, 102.7), // 39 MSS
  bar(102.7, 103.9, 102.5, 103), // 40 FVG [103.9, 104.5]
];

function p3Case(
  n: string,
  description: string,
  bars: Bar[],
  expected: ReturnType<typeof transition>[],
  opts: Partial<Case> = {},
): Case {
  return {
    ...withContext(`p3-bearish-${n}`, 'pattern-3', 'bearish', `${P3_SETUP} ${description}`, OB_HISTORY, bars),
    ...opts,
    expected: [
      transition(P3_KEY, 0, { from: null, to: 'forming', pattern: P3, direction: 'bearish' }),
      ...expected,
    ],
    exhaustive: CONFIRMATIONS,
  };
}

function p3Positives(): Case[] {
  const base = [...P3_APPROACH, ...P3_TRIGGER];
  const a = atrs(base);
  const inv = invalidation(105.6, a[38]!);
  const rr = ratio4(103.9 - 101.75, inv - 103.9);
  const credits = [1, 0.5, 1, 1, 1, 1, 0, 1];
  const triggered = transition(P3_KEY, 38, {
    from: 'forming',
    to: 'triggered',
    refs: { poi: HTF_OB, sweeps: [keys.sweep('5m', SWING_105, T3.open(38))] },
    levels: { invalidation: String(inv) },
  });
  const confirmed = transition(P3_KEY, 40, {
    from: 'triggered',
    to: 'confirmed',
    levels: { entry: '103.9', invalidation: String(inv), target1: '101.75', target2: null, rr },
    entryZone: keys.zone('5m', 'fvg', 'bearish', T3.open(38)),
    checklist: checklist(credits as never),
    score: score(credits),
  });
  const story = `38 trades to 105.6: it touches the block (105.1) and sweeps the swing high 105, closing back at 104.7: touch and sweep in one candle, triggered (invalidation ${inv}). 39 closes at 102.7 below the anchor (33, 103.7) with displacement; 40 completes the FVG [103.9, 104.5]: confirmed at 40, entry 103.9. T1 is the 1h level 101.75; R:R ${rr}. Score ${score(credits)}: the 1h trend is bearish (15), a plain swing high (5), the sweep reached the block (15), sweep, MSS, levels (40), R:R (0), news (5).`;

  // 004: the liquidity is taken 5 candles before the touch, at a level below the block.
  const early: Bar[] = [
    ...flat(20, 102.5), // 0-19
    ...run(102.5, 104.4, 8), // 20-27
    bar(104.4, 104.8, 104.2, 104.5), // 28 swing high 104.8 (0.3 below the block; level at 33)
    ...run(104.5, 104.3, 2, 0.1), // 29-30
    bar(104.3, 104.4, 103.9, 104), // 31 the anchor 103.9
    ...run(104, 104.6, 3, 0.1), // 32-34
    bar(104.6, 105.09, 104.35, 104.4), // 35 sweeps 104.8, short of the block (105.1)
    ...run(104.4, 104.8, 4, 0.1), // 36-39
    bar(104.8, 105.3, 104.7, 105.2), // 40 touches the block; closes above 105.09 (a breach, not a sweep)
    bar(105.2, 105.25, 102.6, 102.7), // 41 MSS
    bar(102.7, 103.9, 102.5, 103), // 42 FVG [103.9, 104.7]
  ];
  const ea = atrs(early);
  return [
    p3Case(
      '001',
      `${story} 41 touches the entry; 43 reaches 101.75: target reached.`,
      [
        ...base,
        bar(103, 104, 102.9, 103.8), // 41 entry
        bar(103.8, 103.9, 102.4, 102.5), // 42
        bar(102.5, 102.6, 101.7, 101.8), // 43 target
      ],
      [
        triggered,
        confirmed,
        transition(P3_KEY, 41, { to: 'entry_active' }),
        transition(P3_KEY, 43, { to: 'resolved', resolution: 'target_reached' }),
      ],
    ),
    p3Case(
      '002',
      `${story} 41 touches the entry; 42 rallies to 105.8: invalidated.`,
      [...base, bar(103, 104, 102.9, 103.8), bar(103.8, 105.8, 103.7, 105.5)],
      [triggered, confirmed, transition(P3_KEY, 42, { to: 'resolved', resolution: 'invalidated' })],
    ),
    p3Case(
      '003',
      `${story} The next 24 candles stay between 102.6 and 103.4: expired_no_entry at 64.`,
      [...base, ...flat(24, 103, 0.4)],
      [
        triggered,
        confirmed,
        transition(P3_KEY, 64, {
          to: 'resolved',
          resolution: 'expired_no_entry',
          reason: 'entry_window_passed',
        }),
      ],
    ),
    p3Case(
      '004',
      `Here the liquidity is taken before the touch: the external swing high at 28 (104.8, 0.3 under the block, a level from 33) is swept at 35 (high 105.09, close 104.4), short of the block. 40 touches the block (105.3) 5 candles later, within the 12-candle window, and closes above 105.09 (a breach of the sweep's extreme, not a new sweep): triggered at 40 with the earlier sweep. The setup measures from the highest high since the sweep, 105.3 at 40 (rulebook §14): invalidation ${invalidation(105.3, ea[40]!)} (ATR ${ea[40]!.toFixed(4)} at 40), MSS window from 40. 41 closes at 102.7 below the anchor (31, 103.9) with displacement; 42 completes the FVG [103.9, 104.7]: confirmed at 42. The sweep itself (105.09) never reached the block, so poi_present scores 0; a plain swing high gives half for liquidity.`,
      early,
      [
        transition(P3_KEY, 40, {
          from: 'forming',
          to: 'triggered',
          refs: {
            sweeps: [keys.sweep('5m', keys.level('5m', 'swing_high', 'buy_side', T3.close(33)), T3.open(35))],
          },
          levels: { invalidation: String(invalidation(105.3, ea[40]!)) },
        }),
        transition(P3_KEY, 42, {
          from: 'triggered',
          to: 'confirmed',
          levels: { entry: '103.9', target1: '101.75' },
          checklist: checklist([1, 0.5, 0, 1, 1, 1, 0, 1] as never),
          score: score([1, 0.5, 0, 1, 1, 1, 0, 1]),
        }),
      ],
    ),
    p3Case(
      '005',
      `${story} 41 falls to 101.7 with a high of 103.5: the target before the entry, expired_no_entry.`,
      [...base, bar(103, 103.5, 101.7, 101.8)],
      [
        triggered,
        confirmed,
        transition(P3_KEY, 41, {
          to: 'resolved',
          resolution: 'expired_no_entry',
          reason: 'target_before_entry',
        }),
      ],
    ),
  ];
}

function p3Negatives(): Case[] {
  const neg = (
    n: string,
    description: string,
    bars: Bar[],
    expected: ReturnType<typeof transition>[],
  ): Case => ({
    ...withContext(
      `p3-negative-${n}`,
      'pattern-3',
      'negative',
      `${P3_SETUP} ${description}`,
      OB_HISTORY,
      bars,
    ),
    expected: [transition(P3_KEY, 0, { from: null, to: 'forming' }), ...expected],
    notExpected: [
      { type: 'setup_transition', data: { pattern: P3, to: 'confirmed' } },
      ...(expected.some((e) => (e.data as { to?: string }).to === 'triggered')
        ? []
        : [{ type: 'setup_transition', key: P3_KEY, data: { to: 'triggered' } }]),
    ],
  });
  return [
    neg(
      'touch-alone-001',
      'The card’s warning: a steady climb (no swing high, so no buy-side level near the block) touches the block at 38 (105.3) and drops with displacement. Nothing was swept: a touch alone is no trigger.',
      [
        ...flat(20, 102.5),
        ...run(102.5, 104.6, 18, 0.1), // 20-37 a steady climb: no swing high
        bar(104.6, 105.3, 104.5, 104.7), // 38 touches the block
        bar(104.7, 104.8, 102.6, 102.7), // 39
        ...flat(6, 102.8),
      ],
      [],
    ),
    neg(
      'sweep-too-early-001',
      'The swing high at 28 (104.8, a level from 33) is swept at 34 (high 105, close 104.3). The touch of the block comes at 47, 13 candles later: outside the 12-candle window. 47 closes at 105.2 above the sweep’s extreme 105 and the next three candles stay above it, so that level is broken, not swept. No trigger.',
      [
        ...flat(20, 102.5),
        ...run(102.5, 104.4, 8), // 20-27
        bar(104.4, 104.8, 104.2, 104.5), // 28
        ...run(104.5, 104.2, 5, 0.1), // 29-33
        bar(104.2, 105, 104.1, 104.3), // 34 sweeps 104.8
        ...run(104.3, 104.8, 12, 0.05), // 35-46
        bar(104.8, 105.3, 104.75, 105.2), // 47 touches
        ...flat(3, 105.2, 0.1), // 48-50 above 105
        bar(105.2, 105.25, 102.6, 102.7), // 51
        ...flat(4, 102.8),
      ],
      [],
    ),
    neg(
      'level-too-low-001',
      'The swept level is an external swing high at 103 (28, a level from 33), more than 1.0 × the 1h ATR under the block’s bottom 105.1: not "liquidity before or inside the OB". It is swept at 34 (high 103.4); the climb that follows closes above 103.4 (that level breaks) and touches the block at 39, but the only sweep does not count: no trigger.',
      [
        ...flat(20, 102.5),
        ...run(102.5, 102.6, 8, 0.1), // 20-27
        bar(102.6, 103, 102.5, 102.7), // 28 swing high 103
        ...flat(5, 102.6, 0.15), // 29-33
        bar(102.6, 103.4, 102.5, 102.8), // 34 sweeps 103
        ...run(102.8, 104.6, 4, 0.1), // 35-38
        bar(104.6, 105.3, 104.5, 104.7), // 39 touches the block
        bar(104.7, 104.8, 102.6, 102.7), // 40
        ...flat(4, 102.8),
      ],
      [],
    ),
    neg(
      'runs-through-001',
      'Triggered at 38 (touch and sweep, as in p3-bearish-001); 39 then runs to 107.7, through the invalidation, before any MSS: invalidated while still watching.',
      [...P3_APPROACH, P3_TRIGGER[0]!, bar(104.7, 107.7, 104.6, 107.65), ...flat(12, 107, 0.3)],
      [
        transition(P3_KEY, 38, { from: 'forming', to: 'triggered' }),
        transition(P3_KEY, 39, {
          from: 'triggered',
          to: 'resolved',
          resolution: 'invalidated',
          reason: 'invalidation_price',
        }),
      ],
    ),
    neg(
      'no-mss-001',
      'Triggered at 38 (touch and sweep); price then holds at 104.5 (lows 104.2, above the anchor 103.7): no MSS within 12 candles, expired at 51.',
      [...P3_APPROACH, P3_TRIGGER[0]!, ...flat(14, 104.5, 0.3)],
      [
        transition(P3_KEY, 38, { from: 'forming', to: 'triggered' }),
        transition(P3_KEY, 51, {
          from: 'triggered',
          to: 'resolved',
          resolution: 'expired',
          reason: 'no_mss',
        }),
      ],
    ),
  ];
}

// ── Pattern 4: sweep outside, fill inside (bearish) ───────────────────────────────────────────

const T4 = timeline(MONDAY, '5m');
const P4 = 'sweep_outside_fill_inside';
const P4_RANGE_HIGH = keys.level('5m', 'range_high', 'buy_side', T4.close(47));

/**
 * After the shared range (detected at 47): a drop to 96.7 (51) and a jump back (53–54) leave a
 * bullish FVG [96.9, 97.6] inside the range at 54 (52's high 96.9, 54's low 97.6); the setup forms
 * there. An internal swing low at 60 (98.9) is the MSS anchor.
 */
const P4_INSIDE: Bar[] = [
  ...flat(3), // 48-50
  bar(100, 100.1, 96.6, 96.7), // 51
  bar(96.7, 96.9, 96.3, 96.8), // 52
  bar(96.8, 99.3, 96.7, 99.2), // 53
  bar(99.2, 100.2, 97.6, 100), // 54 completes the FVG [96.9, 97.6]
  ...flat(5), // 55-59
  bar(100, 100.75, 98.9, 100), // 60 the anchor
  ...flat(1), // 61
];
const P4_SWEEP: Bar = bar(100, 102.3, 99.5, 100.5); // 62 sweeps 102, closes inside
const P4_CONFIRM: Bar[] = [
  bar(100.5, 100.6, 97.9, 98), // 63 MSS
  bar(98, 99, 97.9, 98.2), // 64 FVG [99, 99.5]
];

function p4Case(
  n: string,
  description: string,
  tail: Bar[],
  extra: ReturnType<typeof transition>[],
  inside: Bar[] = P4_INSIDE,
): Case {
  const { RANGE } = PATTERN_BASE;
  const bars: Bar[] = [...RANGE, ...inside, P4_SWEEP, ...P4_CONFIRM, ...tail];
  const a = atrs(bars);
  const inv = invalidation(102.3, a[62]!);
  const key = setupKey(P4, 'bearish', 54);
  const fvgIn = keys.zone('5m', 'fvg', 'bullish', T4.open(52));
  const credits = [0, 1, 0.5, 1, 1, 1, 0, 1];
  return {
    id: `p4-bearish-${n}`,
    concept: 'pattern-4',
    class: 'bearish',
    description: `Range [96, 102] from 47. A drop and a jump leave the bullish FVG [96.9, 97.6] inside the range at 54, below price: the setup forms. 62 sweeps the range high (102.3) and closes inside at 100.5: triggered, invalidation ${inv}. 63 closes at 98 below the anchor (60, 98.9) with displacement (body 2.5); 64 completes the FVG [99, 99.5]: confirmed at 64, entry 99. The targets are the internal FVG's edges (rulebook §6.5): T1 its top 97.6, T2 its bottom 96.9 (nearer than the range low 96); R:R ${ratio4(99 - 97.6, inv - 99)}. Score ${score(credits)}. ${description}`,
    start: MONDAY,
    main: { tf: '5m', bars },
    expected: [
      transition(key, 54, { from: null, to: 'forming', pattern: P4, direction: 'bearish' }),
      transition(key, 62, {
        from: 'forming',
        to: 'triggered',
        refs: { sweeps: [keys.sweep('5m', P4_RANGE_HIGH, T4.open(62))] },
        levels: { invalidation: String(inv) },
      }),
      transition(key, 64, {
        from: 'triggered',
        to: 'confirmed',
        levels: {
          entry: '99',
          invalidation: String(inv),
          target1: '97.6',
          target2: '96.9',
          rr: ratio4(99 - 97.6, inv - 99),
        },
        targets: {
          target1: { kind: 'zone', key: fvgIn, price: '97.6' },
          target2: { kind: 'zone', key: fvgIn, price: '96.9' },
        },
        checklist: checklist(credits as never),
        score: score(credits),
      }),
      ...extra.map((e) => ({ ...e, key })),
    ],
    exhaustive: CONFIRMATIONS,
  };
}

/** Pattern 4 without a range: a swing high and the swing low below it frame the structure. */
function p4Swing(): Case {
  const bars: Bar[] = [
    ...flat(20, 100), // 0-19
    bar(100, 100.1, 98, 98.2), // 20
    bar(98.2, 98.3, 97.5, 97.8), // 21 swing low 97.5 (external: level at 26)
    bar(97.8, 99.5, 97.7, 99.4), // 22
    bar(99.4, 100.5, 98.9, 100.3), // 23 completes the bullish FVG [98.3, 98.9]
    ...run(100.3, 102.5, 6), // 24-29
    bar(102.5, 103.2, 102.3, 102.6), // 30 swing high 103.2 (external: level at 35)
    ...run(102.6, 101.6, 4, 0.1), // 31-34
    bar(101.6, 101.7, 101.2, 101.3), // 35 the anchor 101.2
    ...run(101.3, 102.2, 2, 0.1), // 36-37
    bar(102.2, 103.5, 102.1, 102.6), // 38 sweeps 103.2, closes back inside
    bar(102.6, 102.7, 100.4, 100.5), // 39 MSS
    bar(100.5, 101.6, 100.3, 100.8), // 40 FVG [101.6, 102.1]
    bar(100.8, 101.7, 100.7, 101.4), // 41 entry
    bar(101.4, 101.5, 99.6, 99.7), // 42
    bar(99.7, 99.8, 98.8, 98.9), // 43 reaches 98.9
  ];
  const a = atrs(bars);
  const inv = invalidation(103.5, a[38]!);
  const key = setupKey(P4, 'bearish', 35);
  const high = keys.level('5m', 'swing_high', 'buy_side', T4.close(35));
  return {
    id: 'p4-bearish-swing-001',
    concept: 'pattern-4',
    class: 'bearish',
    description: `No range (the window never has two separate touches of its low): Pattern 4's structure is the unswept external swing high at 30 (103.2, a level from 35) over the swing low at 21 (97.5, a level from 26). Inside it, below price, are two bullish FVGs: [98.3, 98.9] (21's high, 23's low) and [99.5, 99.93] (22's high, 24's low, where the drift starts): the setup forms at 35. 38 sweeps 103.2 (high 103.5) and closes back inside at 102.6: triggered, invalidation ${inv}. 39 closes at 100.5 below the anchor (35, 101.2) with displacement; 40 completes the FVG [101.6, 102.1]: confirmed at 40, entry 101.6. The nearest internal FVG gives the targets: T1 its top 99.93, T2 its bottom 99.5 (nearer than 97.5). 41 touches 101.6; 42 reaches 99.93.`,
    start: MONDAY,
    main: { tf: '5m', bars },
    expected: [
      transition(key, 35, { from: null, to: 'forming', pattern: P4, direction: 'bearish' }),
      transition(key, 38, {
        from: 'forming',
        to: 'triggered',
        refs: { sweeps: [keys.sweep('5m', high, T4.open(38))], range: null },
        levels: { invalidation: String(inv) },
      }),
      transition(key, 40, {
        from: 'triggered',
        to: 'confirmed',
        levels: { entry: '101.6', target1: '99.93', target2: '99.5' },
        targets: {
          target1: { kind: 'zone', key: keys.zone('5m', 'fvg', 'bullish', T4.open(22)), price: '99.93' },
        },
      }),
      transition(key, 41, { from: 'confirmed', to: 'entry_active' }),
      transition(key, 42, { from: 'entry_active', to: 'resolved', resolution: 'target_reached' }),
    ],
    notExpected: [{ type: 'range_detected' }],
    exhaustive: CONFIRMATIONS,
  };
}

function p4Positives(): Case[] {
  return [
    p4Case(
      '001',
      '65 touches the entry; 67 reaches 97.6: target reached (the start of the fill inside).',
      [
        bar(98.2, 99.1, 98.1, 98.9), // 65 entry
        bar(98.9, 99, 97.8, 97.9), // 66
        bar(97.9, 98, 97.5, 97.7), // 67 target
      ],
      [
        transition('', 65, { from: 'confirmed', to: 'entry_active' }),
        transition('', 67, { from: 'entry_active', to: 'resolved', resolution: 'target_reached' }),
      ],
    ),
    p4Case(
      '002',
      '65 touches the entry; 66 rallies to 102.6: invalidated.',
      [bar(98.2, 99.1, 98.1, 98.9), bar(98.9, 102.6, 98.8, 102.2)],
      [transition('', 66, { from: 'entry_active', to: 'resolved', resolution: 'invalidated' })],
    ),
    p4Swing(),
    p4Case(
      '003',
      'The next 24 candles hold between 97.7 and 98.9: neither the entry nor T1, expired_no_entry at 88.',
      flat(24, 98.3, 0.6),
      [transition('', 88, { from: 'confirmed', to: 'resolved', resolution: 'expired_no_entry' })],
    ),
    p4Case(
      '004',
      '65 falls to 97.55 with a high of 98.5: T1 before the entry, expired_no_entry.',
      [bar(98.2, 98.5, 97.55, 97.7)],
      [
        transition('', 65, {
          from: 'confirmed',
          to: 'resolved',
          resolution: 'expired_no_entry',
          reason: 'target_before_entry',
        }),
      ],
    ),
  ];
}

function p4Negatives(): Case[] {
  const { RANGE } = PATTERN_BASE;
  const key = setupKey(P4, 'bearish', 54);
  const neg = (
    n: string,
    description: string,
    bars: Bar[],
    expected: ReturnType<typeof transition>[],
    noTrigger = true,
  ): Case => ({
    id: `p4-negative-${n}`,
    concept: 'pattern-4',
    class: 'negative',
    description,
    start: MONDAY,
    main: { tf: '5m', bars },
    expected,
    notExpected: [
      { type: 'setup_transition', data: { pattern: P4, to: 'confirmed' } },
      ...(noTrigger ? [{ type: 'setup_transition', key, data: { to: 'triggered' } }] : []),
    ],
  });
  const forming = transition(key, 54, { from: null, to: 'forming' });
  return [
    neg(
      'filled-001',
      'The internal FVG is filled beyond half before the sweep: 58 trades down to 97.2 (57 % of [96.9, 97.6]), so it no longer qualifies and the setup expires at 58 (no_fvg). The sweep of the range high at 62 finds no setup.',
      [
        ...RANGE,
        ...P4_INSIDE.slice(0, 10),
        bar(100, 100.1, 97.2, 99.8),
        ...P4_INSIDE.slice(11),
        P4_SWEEP,
        ...P4_CONFIRM,
        ...flat(4, 98.5),
      ],
      [
        forming,
        transition(key, 58, {
          from: 'forming',
          to: 'resolved',
          resolution: 'expired',
          reason: 'no_fvg',
          evidence: {
            range: keys.range('5m', T4.close(47)),
            lost: [keys.zone('5m', 'fvg', 'bullish', T4.open(52))],
            close: '99.8',
          },
        }),
      ],
    ),
    neg(
      'filled-before-confirmation-001',
      'Triggered at 62; the MSS candle 63 trades down to 97.2, filling the FVG beyond half. At the confirmation (64) Pattern 4 has no target: levels_defined, a mandatory item, fails. The setup stays triggered ("watching") with that reason, and expires at 75.',
      [
        ...RANGE,
        ...P4_INSIDE,
        P4_SWEEP,
        bar(100.5, 100.6, 97.2, 97.9),
        bar(97.9, 99, 97.8, 98.2),
        ...flat(12, 98.4, 0.5),
      ],
      [
        forming,
        transition(key, 62, { from: 'forming', to: 'triggered' }),
        transition(key, 64, {
          from: 'triggered',
          to: 'triggered',
          reason: 'not_confirmed',
          mandatoryPassed: false,
          evidence: { failed: ['levels_defined'], blocking: [] },
        }),
        transition(key, 75, {
          from: 'triggered',
          to: 'resolved',
          resolution: 'expired',
          reason: 'not_confirmed',
        }),
      ],
      false,
    ),
    neg(
      'fvg-above-001',
      'The FVG inside the range sits above price: price fell below it before the sweep (55–61 at 96.8, under its bottom 96.9), so it is not a target for a fill inside, and the setup that formed at 54 expires at 55 (no_fvg). A spike to 102.3 later sweeps the range high with no setup to trigger.',
      [
        ...RANGE,
        ...P4_INSIDE.slice(0, 7),
        ...flat(7, 96.8, 0.4), // 55-61
        bar(96.8, 102.3, 96.7, 100.5), // 62
        ...flat(4, 100),
      ],
      [
        forming,
        transition(key, 55, { from: 'forming', to: 'resolved', resolution: 'expired', reason: 'no_fvg' }),
      ],
    ),
    neg(
      'deep-001',
      'The sweep at 62 runs to 107.5 before closing back inside at 100.5: deep (more than 2 ATR with its own range included), so it does not qualify. No trigger.',
      [...RANGE, ...P4_INSIDE, bar(100, 107.5, 99.5, 100.5), ...P4_CONFIRM, ...flat(4, 98.5)],
      [forming],
    ),
    neg(
      'no-mss-001',
      'Triggered at 62; price holds at 100 (lows 99.25, above the anchor 98.9) for 13 candles: no MSS, expired at 75.',
      [...RANGE, ...P4_INSIDE, P4_SWEEP, ...flat(14)],
      [
        forming,
        transition(key, 62, { from: 'forming', to: 'triggered' }),
        transition(key, 75, { from: 'triggered', to: 'resolved', resolution: 'expired', reason: 'no_mss' }),
      ],
      false,
    ),
  ];
}

const PATTERN_BASE = { RANGE: patternRange() };

export const setupCases: Case[] = withMirrors([
  ...p2Positives(),
  ...p2Negatives(),
  ...p3Positives(),
  ...p3Negatives(),
  ...p4Positives(),
  ...p4Negatives(),
]);
