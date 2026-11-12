/**
 * Rulebook §7 (the checklist and quality flags) and §8 (outcomes), and the gold-market cases of
 * criterion 6.6. They reuse the Pattern 1 and 2 designs (cases-patterns.ts, cases-setups.ts), whose
 * descriptions explain the setups; these cases change one input and say what it does.
 */
import { agg, atrs, bar, type Bar, type Case, flat, MONDAY, timeline, withMirrors } from './lib.ts';
import { checklist, invalidation, RANGE, ratio4, score, setupKey, transition } from './cases-patterns.ts';
import { P2_APPROACH, P2_CONFIRM, P2_SWEEP, SUPPLY_HISTORY } from './cases-setups.ts';

const T = timeline(MONDAY, '5m');
const HOUR = 3_600_000;
const P1 = 'double_liquidity_trap';
const KEY = setupKey(P1, 'bearish', 47);

/** p1-a-bearish-001 up to the entry touch at 68: triggered at 65, confirmed at 67 (entry 98.2, T1 96). */
const P1_TO_ENTRY: Bar[] = [
  ...RANGE,
  ...flat(7),
  bar(100, 102.5, 99.25, 100.25), // 55 S1
  ...flat(4),
  bar(100, 100.75, 98.5, 100), // 60 anchor
  ...flat(4),
  bar(100, 102.3, 99.5, 100.5), // 65 S2
  bar(100.5, 100.6, 97.4, 97.5), // 66 MSS
  bar(97.5, 98.2, 96.9, 97.2), // 67 FVG [98.2, 99.5]: confirmed
  bar(97.2, 98.3, 97, 98), // 68 entry
];
const INV = invalidation(102.3, atrs(P1_TO_ENTRY)[65]!);
const RISK = INV - 98.2;
const P1_STORY = `As p1-a-bearish-001: range [96, 102], S1 at 55, S2 at 65 (triggered, invalidation ${INV}), MSS at 66, confirmed at 67 (entry 98.2, T1 96), entry touched at 68.`;

function p1Case(
  id: string,
  concept: string,
  cls: Case['class'],
  description: string,
  bars: Bar[],
  expected: ReturnType<typeof transition>[],
  extra: Partial<Case> = {},
): Case {
  return {
    id,
    concept,
    class: cls,
    description,
    start: MONDAY,
    main: { tf: '5m', bars },
    expected,
    ...extra,
  };
}

// ── §7 checklist ──────────────────────────────────────────────────────────────────────────────

/**
 * A ranging 1h context: 48 flat hours at 100 with spikes to 104 (hours 6, 18, 30, 42) and to 94
 * (hours 12, 24, 36). Every close is 100, as are those of the 5m hours that follow, so 1h structure
 * never breaks (trend undefined) and the §2.4 range test fits the last 48 candles: [94, 104],
 * equilibrium 99, efficiency 0.
 */
function rangingHistory(): Bar[] {
  const out: Bar[] = [];
  for (let h = 0; h < 48; h++)
    out.push(
      h % 12 === 6
        ? bar(100, 104, 99.25, 100)
        : h % 12 === 0 && h > 0
          ? bar(100, 100.75, 94, 100)
          : bar(100, 100.75, 99.25, 100),
    );
  return out;
}

function htfHalf(): Case {
  const history = rangingHistory();
  const start = MONDAY + history.length * HOUR;
  const tl = timeline(start, '5m');
  const bars: Bar[] = [...P1_TO_ENTRY, bar(98, 98.1, 97, 97.1), bar(97.1, 97.2, 95.9, 95.95)];
  const credits = [0.5, 1, 0.5, 1, 1, 1, 0, 1];
  const key = setupKey(P1, 'bearish', 47, tl);
  return {
    id: 'checklist-htf-half-001',
    concept: 'checklist',
    class: 'bearish',
    description: `p1-a-bearish-001 after 48 hours of a ranging 1h market (flat at 100, spikes to 104 and 94, closes never moving: no 1h trend). Item 1, J8: the context is ranging (the §2.4 test fits its last 48 candles, [94, 104] even with the 5m hours added) and S2's extreme 102.3 lies in its premium, above the equilibrium 99: half credit for a bearish setup. Score ${score(credits)} at confirmation (67).`,
    start,
    main: { tf: '5m', bars },
    more: [{ tf: '1h', start: MONDAY, bars: [...history, ...agg(bars, 12)] }],
    expected: [
      transition(key, 67, {
        from: 'triggered',
        to: 'confirmed',
        checklist: [
          {
            item: 'htf_bias',
            credit: 0.5,
            evidence: { trend: 'undefined', ranging: true, equilibrium: '99' },
          },
          ...checklist(credits as never).slice(1),
        ],
        score: score(credits),
      }),
    ],
  };
}

const P2_HISTORY = SUPPLY_HISTORY;

function newsBlackout(blocked: boolean): Case {
  // p2-bearish-001 (cases-setups.ts), with an economic calendar around its confirmation at 54.
  const start = MONDAY + P2_HISTORY.length * HOUR;
  const tl = timeline(start, '5m');
  const bars: Bar[] = [...P2_APPROACH, P2_SWEEP, ...P2_CONFIRM, bar(104.2, 105, 104.1, 104.6)];
  const key = setupKey('eq_near_poi', 'bearish', 48, tl);
  const confirmedAt = tl.close(54);
  const credits = blocked ? [0, 1, 1, 1, 1, 1, 0, 0] : [0, 1, 1, 1, 1, 1, 0, 0];
  return {
    id: blocked ? 'checklist-news-blackout-001' : 'checklist-calendar-unavailable-001',
    concept: 'checklist',
    class: 'bearish',
    description: blocked
      ? `p2-bearish-001 with a high-impact USD release scheduled 20 minutes after its confirmation (54): inside the crypto profile's 30-minute blackout, item 8 fails (evidence: the event). News is not mandatory: the setup still confirms, scoring ${score(credits)} instead of ${score(credits) + 5}.`
      : `p2-bearish-001 with the economic calendar unavailable (null): item 8 fails with reason calendar_unavailable, as it does on the live stack until Phase 7 brings the calendar. Score ${score(credits)}.`,
    start,
    main: { tf: '5m', bars },
    more: [{ tf: '1h', start: MONDAY, bars: [...P2_HISTORY, ...agg(bars, 12)] }],
    economicEvents: blocked
      ? [{ id: 'fomc', at: confirmedAt + 20 * 60_000, currency: 'USD', impact: 'high' }]
      : null,
    expected: [
      transition(key, 54, {
        from: 'triggered',
        to: 'confirmed',
        checklist: [
          ...checklist(credits as never).slice(0, 7),
          {
            item: 'news_clear',
            credit: 0,
            evidence: blocked ? { events: ['fomc'] } : { reason: 'calendar_unavailable' },
          },
        ],
        score: score(credits),
      }),
    ],
  };
}

/**
 * Pattern 2 with a missing 5m candle at 53, just after the trigger: the setup's window holds an
 * unrepairable gap (`data_gap`, which blocks confirmation, §7).
 */
function dataGap(): Case {
  const start = MONDAY + P2_HISTORY.length * HOUR;
  const tl = timeline(start, '5m');
  const bars: (Bar | null)[] = [
    ...P2_APPROACH.slice(0, 49),
    null, // 49 missing for good
    ...P2_APPROACH.slice(50),
    P2_SWEEP, // 52 sweep: triggered
    ...P2_CONFIRM, // 53 MSS, 54 FVG
    ...flat(17, 104.2, 0.3), // 55-71: the hour after the gap completes, so the 1h hole is a hole
  ];
  const key = setupKey('eq_near_poi', 'bearish', 48, tl);
  return {
    id: 'checklist-data-gap-001',
    concept: 'checklist',
    class: 'negative',
    description:
      'p2-bearish-001 with the 5m candle 49 missing for good, just after the setup forms (48): a gap marker on 5m (and on 1h, whose hour holding it is missing too), and the setup gets data_gap. No swing window spans the gap, so 50 is no swing low and the MSS anchor is the earlier internal swing low at 40 (104.3). 52 sweeps the equal highs into the supply (triggered); 53 closes below 104.3 with displacement; 54 completes the FVG [104.9, 105.3]. Every mandatory item passes, but data_gap blocks confirmation: at 54 the setup stays triggered ("watching") with blocking [data_gap], and it expires at 65.',
    start,
    main: { tf: '5m', bars: bars },
    more: [{ tf: '1h', start: MONDAY, bars: [...P2_HISTORY, ...agg(bars, 12)] }],
    expected: [
      transition(key, 52, {
        from: 'forming',
        to: 'triggered',
        qualityFlags: ['data_gap', 'liquidity_unverified'],
      }),
      transition(key, 54, {
        from: 'triggered',
        to: 'triggered',
        reason: 'not_confirmed',
        mandatoryPassed: true,
        levels: { entry: '104.9', target1: '103' },
        evidence: { failed: [], blocking: ['data_gap'] },
      }),
      transition(key, 65, {
        from: 'triggered',
        to: 'resolved',
        resolution: 'expired',
        reason: 'not_confirmed',
      }),
    ],
    notExpected: [{ type: 'setup_transition', data: { to: 'confirmed' } }],
  };
}

// ── §8 outcomes ───────────────────────────────────────────────────────────────────────────────

/** 1m candles for 5m candle `i`, from [open, high, low, close] rows. */
const minutes = (i: number, rows: Bar[]) => ({ tf: '1m' as const, start: T.open(i), bars: rows });

function outcomeCases(): Case[] {
  // A candle that trades through both T1 (96) and the invalidation.
  const both = bar(98, 102.6, 95.9, 97);
  const lo = 95.9;
  const hi = 102.6;
  return [
    p1Case(
      'outcome-expired-open-001',
      'outcomes',
      'bearish',
      `${P1_STORY} Then 288 candles hold between 98.25 and 99.75: neither T1 (96) nor the invalidation. expired_open at 356 (68 + 288). MFE (98.2 − 97)/R from 68's low, MAE (99.75 − 98.2)/R, 289 bars held.`,
      [...P1_TO_ENTRY, ...flat(288, 99)],
      [
        transition(KEY, 356, {
          from: 'entry_active',
          to: 'resolved',
          resolution: 'expired_open',
          reason: 'hold_window_passed',
          evidence: { window: { from: T.iso(68), to: T.iso(356) } },
          outcome: {
            result: 'expired_open',
            entryTouchedAt: T.isoClose(68),
            mfeR: ratio4(98.2 - 97, RISK),
            maeR: ratio4(99.75 - 98.2, RISK),
            barsHeld: 289,
            resolvedWithTf: null,
          },
        }),
      ],
    ),
    p1Case(
      'outcome-ambiguous-1m-target-001',
      'outcomes',
      'bearish',
      `${P1_STORY} Candle 69 trades through both T1 (low 95.9) and the invalidation (high 102.6). Its 1m candles decide: the first minute falls to 95.9 before any minute reaches ${INV}: target reached, resolved with 1m.`,
      [...P1_TO_ENTRY, both],
      [
        transition(KEY, 69, {
          from: 'entry_active',
          to: 'resolved',
          resolution: 'target_reached',
          evidence: { minute: T.open(69) },
          outcome: {
            result: 'target_reached',
            resolvedWithTf: '1m',
            mfeR: ratio4(98.2 - lo, RISK),
            maeR: ratio4(hi - 98.2, RISK),
            barsHeld: 2,
          },
        }),
      ],
      {
        more: [
          minutes(69, [
            bar(98, 98.1, 95.9, 96.2),
            bar(96.2, 99, 96.1, 98.9),
            bar(98.9, 101, 98.8, 100.9),
            bar(100.9, 102.6, 100.8, 101),
            bar(101, 101.1, 96.9, 97),
          ]),
        ],
      },
    ),
    p1Case(
      'outcome-ambiguous-1m-invalidated-001',
      'outcomes',
      'bearish',
      `${P1_STORY} Candle 69 trades through both T1 and the invalidation; its 1m candles show the rally to 102.6 first (minute 2) and the fall to 95.9 last: invalidated, resolved with 1m.`,
      [...P1_TO_ENTRY, both],
      [
        transition(KEY, 69, {
          from: 'entry_active',
          to: 'resolved',
          resolution: 'invalidated',
          evidence: { minute: T.open(69) + 60_000 },
          outcome: { result: 'invalidated', resolvedWithTf: '1m' },
        }),
      ],
      {
        more: [
          minutes(69, [
            bar(98, 99.9, 97.9, 99.8),
            bar(99.8, 102.6, 99.7, 102.4),
            bar(102.4, 102.5, 99, 99.1),
            bar(99.1, 99.2, 95.9, 96.1),
            bar(96.1, 97.1, 96, 97),
          ]),
        ],
      },
    ),
    p1Case(
      'outcome-ambiguous-same-minute-001',
      'outcomes',
      'bearish',
      `${P1_STORY} Candle 69 trades through both T1 and the invalidation, and so does its first 1m candle: the order cannot be known. Resolved ambiguous (rulebook §6.1), with 1m.`,
      [...P1_TO_ENTRY, both],
      [
        transition(KEY, 69, {
          from: 'entry_active',
          to: 'resolved',
          resolution: 'ambiguous',
          reason: 'same_1m_candle',
          outcome: { result: 'ambiguous', resolvedWithTf: '1m' },
        }),
      ],
      { more: [minutes(69, [bar(98, 102.6, 95.9, 97), ...flat(4, 97, 0.2)])] },
    ),
    p1Case(
      'outcome-ambiguous-no-1m-001',
      'outcomes',
      'bearish',
      `${P1_STORY} Candle 69 trades through both T1 and the invalidation, and there are no 1m candles to order them: ambiguous, reason no_1m_data, resolvedWithTf null.`,
      [...P1_TO_ENTRY, both],
      [
        transition(KEY, 69, {
          from: 'entry_active',
          to: 'resolved',
          resolution: 'ambiguous',
          reason: 'no_1m_data',
          outcome: { result: 'ambiguous', resolvedWithTf: null },
        }),
      ],
    ),
    p1Case(
      'outcome-entry-and-target-001',
      'outcomes',
      'bearish',
      `${P1_STORY.replace(', entry touched at 68', '')} Candle 68 instead touches the entry and T1 together (high 98.3, low 95.9). Its 1m candles: the second minute reaches 98.3 (entry), the fourth falls to 95.9 (T1). Entry and target in one candle: entry_active then target_reached at 68, one bar held.`,
      [...P1_TO_ENTRY.slice(0, 68), bar(97.2, 98.3, 95.9, 96.5)],
      [
        transition(KEY, 68, {
          from: 'confirmed',
          to: 'entry_active',
          evidence: { minute: T.open(68) + 60_000, entry: '98.2' },
        }),
        transition(KEY, 68, {
          from: 'entry_active',
          to: 'resolved',
          resolution: 'target_reached',
          outcome: {
            result: 'target_reached',
            resolvedWithTf: '1m',
            barsHeld: 1,
            entryTouchedAt: T.isoClose(68),
          },
        }),
      ],
      {
        more: [
          minutes(68, [
            bar(97.2, 97.5, 97.1, 97.4),
            bar(97.4, 98.3, 97.3, 98.1),
            bar(98.1, 98.2, 97, 97.1),
            bar(97.1, 97.2, 95.9, 96),
            bar(96, 96.6, 95.95, 96.5),
          ]),
        ],
      },
    ),
  ];
}

// ── Criterion 6.6: gold-market closures ───────────────────────────────────────────────────────

function goldCases(): Case[] {
  const bars: Bar[] = [...P1_TO_ENTRY.slice(0, 68), ...flat(12, 98)];
  const closure = (from: number, to: number) => [
    { from: T.open(from), to: T.open(to), reason: 'weekend' as const },
  ];
  // The thin-book case: 1m candles from 65 on, with micro profiles (base volume per price bucket,
  // low to high). S2's minute above 102 trades 2 units in its top bucket: about 204 USD beyond 102.
  // 1m candles run from 65 to the end (79): a started timeframe must continue to the last boundary.
  const thinMinutes: Bar[] = [
    bar(100, 100.6, 99.5, 100.5),
    bar(100.5, 102.3, 100.4, 101.2),
    bar(101.2, 101.3, 100.4, 100.6),
    bar(100.6, 100.7, 100.4, 100.5),
    bar(100.5, 100.6, 100.4, 100.5),
    ...flat(70, 98, 0.2),
  ];
  const profiles: Record<number, { profile: number[] }> = {};
  thinMinutes.forEach(
    (_, i) => (profiles[i] = { profile: i === 1 ? [40, 40, 30, 20, 10, 2] : [50, 50, 50, 50, 50, 50] }),
  );
  return [
    {
      ...p1Case(
        'gold-setup-closure-001',
        'gold-setups',
        'closure',
        'Gold profile. p1-a-bearish-001’s candles, with a gold-market closure from 60 to 72: S2 (65), the MSS (66) and the FVG candle (67) all trade while the underlying market is closed. The setup triggers (flag underlying_closed), every mandatory item passes, but with blockConfirmWhenUnderlyingClosed (gold default, J9) it cannot confirm: at 67 it stays triggered ("Watching") with blocking [underlying_closed]; it expires at 78.',
        bars,
        [
          transition(KEY, 65, {
            from: 'forming',
            to: 'triggered',
            qualityFlags: ['liquidity_unverified', 'underlying_closed'],
          }),
          transition(KEY, 67, {
            from: 'triggered',
            to: 'triggered',
            reason: 'not_confirmed',
            mandatoryPassed: true,
            evidence: { failed: [], blocking: ['underlying_closed'] },
          }),
          transition(KEY, 78, {
            from: 'triggered',
            to: 'resolved',
            resolution: 'expired',
            reason: 'not_confirmed',
          }),
        ],
        {
          profile: 'gold',
          closures: closure(60, 72),
          notExpected: [{ type: 'setup_transition', data: { to: 'confirmed' } }],
        },
      ),
    },
    {
      ...p1Case(
        'gold-setup-closure-early-001',
        'gold-setups',
        'closure',
        'Gold profile, closure from 64 to 66: only S2 (65) trades while the market is closed. Its sweep carries underlying_closed, so the setup does too, and cannot confirm after the MSS: watching, then expired at 78.',
        bars,
        [
          transition(KEY, 67, {
            from: 'triggered',
            to: 'triggered',
            reason: 'not_confirmed',
            evidence: { blocking: ['underlying_closed'] },
          }),
        ],
        {
          profile: 'gold',
          closures: closure(64, 66),
          notExpected: [{ type: 'setup_transition', data: { to: 'confirmed' } }],
        },
      ),
    },
    {
      ...p1Case(
        'gold-setup-closure-mss-001',
        'gold-setups',
        'closure',
        'Gold profile, closure from 66 to 67: the market reopens after S2, but the MSS candle (66) traded while closed. A deciding candle in the closure is enough: blocked, watching, expired at 78.',
        bars,
        [
          transition(KEY, 67, {
            from: 'triggered',
            to: 'triggered',
            reason: 'not_confirmed',
            evidence: { blocking: ['underlying_closed'] },
          }),
        ],
        {
          profile: 'gold',
          closures: closure(66, 67),
          notExpected: [{ type: 'setup_transition', data: { to: 'confirmed' } }],
        },
      ),
    },
    {
      ...p1Case(
        'gold-setup-reopening-001',
        'gold-setups',
        'reopening',
        'Gold profile, closure from 50 to 60: S1 (55) sweeps while the market is closed, and the market has reopened by S2 (65). S1 is only the first sweep; S2, the MSS and the FVG candle trade with the market open: the setup confirms at 67, with no underlying_closed flag.',
        bars,
        [transition(KEY, 67, { from: 'triggered', to: 'confirmed', qualityFlags: ['liquidity_unverified'] })],
        { profile: 'gold', closures: closure(50, 60) },
      ),
    },
    {
      ...p1Case(
        'gold-setup-reopening-late-001',
        'gold-setups',
        'reopening',
        'Gold profile, closure from 30 to 47, ending as the range is detected: every candle of the pattern trades with the market open, so the setup confirms at 67 as for crypto.',
        bars,
        [transition(KEY, 67, { from: 'triggered', to: 'confirmed', qualityFlags: ['liquidity_unverified'] })],
        { profile: 'gold', closures: closure(30, 47) },
      ),
    },
    {
      ...p1Case(
        'gold-setup-reopening-target-001',
        'gold-setups',
        'reopening',
        'Gold profile, closure from 69 to 75, after the confirmation: a closure does not stop a confirmed setup. The entry is touched at 68 and T1 at 70, inside the closure: target reached.',
        [...P1_TO_ENTRY, bar(98, 98.1, 97, 97.1), bar(97.1, 97.2, 95.9, 95.95), ...flat(3, 95.5)],
        [transition(KEY, 70, { from: 'entry_active', to: 'resolved', resolution: 'target_reached' })],
        { profile: 'gold', closures: closure(69, 75) },
      ),
    },
    {
      ...p1Case(
        'gold-setup-thin-book-001',
        'gold-setups',
        'thin_book',
        'Gold profile with 1m micro profiles from 65 on. S2’s wick above 102 (65’s second minute) trades 2 units in its top bucket, about 200 USD beyond the level against the gold threshold of 20,000: the sweep is thin_book and does not qualify. A thin-book wick must not trigger a pattern: no trigger.',
        bars,
        [{ type: 'sweep', at: 65, data: { levelPrice: '102', flags: ['thin_book'] } }],
        {
          profile: 'gold',
          more: [{ tf: '1m', start: T.open(65), bars: thinMinutes, extras: profiles }],
          notExpected: [{ type: 'setup_transition', key: KEY, data: { to: 'triggered' } }],
        },
      ),
    },
    {
      ...p1Case(
        'gold-setup-thin-book-s1-001',
        'gold-setups',
        'thin_book',
        'Gold profile with 1m micro profiles from 55 to the end. S1’s wick above 102 (55’s second minute) is thin: S1 is thin_book and does not count. S2’s wick (65’s second minute) trades 500 units in its top bucket and qualifies, but it has no first sweep to pair with: it becomes the first sweep itself. No trigger.',
        bars,
        [
          { type: 'sweep', at: 55, data: { levelPrice: '102', flags: ['thin_book'] } },
          { type: 'sweep', at: 65, data: { levelPrice: '102', flags: [] } },
        ],
        {
          profile: 'gold',
          more: [
            {
              tf: '1m',
              start: T.open(55),
              bars: [
                bar(100, 100.6, 99.5, 100.5),
                bar(100.5, 102.5, 100.4, 100.6), // 55's spike: thin
                ...flat(48, 100, 0.3), // 55-64
                bar(100, 100.6, 99.5, 100.5),
                bar(100.5, 102.3, 100.4, 101.2), // 65's spike: deep liquidity
                ...flat(73, 98, 0.2), // 65-79
              ],
              extras: Object.fromEntries(
                Array.from({ length: 125 }, (_, i) => [
                  i,
                  {
                    profile:
                      i === 1
                        ? [40, 40, 30, 20, 10, 2]
                        : i === 51
                          ? [40, 40, 30, 20, 10, 500]
                          : [50, 50, 50, 50, 50, 50],
                  },
                ]),
              ),
            },
          ],
          notExpected: [{ type: 'setup_transition', key: KEY, data: { to: 'triggered' } }],
        },
      ),
    },
    {
      ...p1Case(
        'gold-setup-thin-book-deep-liquidity-001',
        'gold-setups',
        'thin_book',
        'The control for the thin-book cases: the same 1m candles with plenty traded above 102 (500 units in S2’s top bucket, about 51,000 USD) make S2 a qualifying sweep: triggered at 65.',
        bars,
        [transition(KEY, 65, { from: 'forming', to: 'triggered' })],
        {
          profile: 'gold',
          more: [
            {
              tf: '1m',
              start: T.open(65),
              bars: thinMinutes,
              extras: Object.fromEntries(
                thinMinutes.map((_, i) => [
                  i,
                  { profile: i === 1 ? [40, 40, 30, 20, 10, 500] : [50, 50, 50, 50, 50, 50] },
                ]),
              ),
            },
          ],
        },
      ),
    },
  ];
}

export const checklistCases: Case[] = withMirrors([
  htfHalf(),
  newsBlackout(true),
  newsBlackout(false),
  dataGap(),
  ...outcomeCases(),
  ...goldCases(),
]);
