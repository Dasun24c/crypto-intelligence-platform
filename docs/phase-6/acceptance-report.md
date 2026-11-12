# Phase 6 · Patterns, checklist and outcomes: acceptance report

| | |
|---|---|
| Status | **Built; awaiting your approval** |
| Date | 2026-11-11 |
| Scope | [Implementation plan, Phase 6](../phase-0/08-implementation-plan.md#phase-6--patterns-checklist-and-outcomes) |
| Evidence | This machine (Windows 11, Docker Desktop, Node.js 26.13.0); the local Compose stack streaming live public data from Binance and Coinbase; nine live runs (ruleset `indicators-1+smc-0.3.0`, profiles version 4), live from 13:46 UTC (PAXG-USD from 13:48); checks to 14:12 UTC |

## Summary

Phase 6 turns the detections of Phases 4 and 5 into setups (rulebook §6–§8). A setup is hypothetical analysis: nothing places an order, and every setup the API returns carries "Educational analysis — not financial advice".

- **The engine** (`packages/smc-engine`, ruleset 0.3.0):
  - four patterns: 1, the double liquidity trap (variants A and B); 2, equal highs or lows near a point of interest; 3, the higher-timeframe order block; 4, sweep outside, fill inside. They run on the (4h, 15m) and (1h, 5m) pairs;
  - one state machine for all of them: `forming` ("Watching"), `triggered`, `confirmed`, `entry_active`, `resolved`. It uses the sweep-anchored MSS, an entry zone, and hypothetical levels: entry, invalidation, T1, T2 and R:R;
  - the eight-item checklist and its score, three items mandatory, and the quality flags `underlying_closed`, `data_gap`, `low_liquidity` and `liquidity_unverified`;
  - outcomes: target, invalidation or expiry, with MFE and MAE in R and bars held. When one setup candle trades through two outcomes, its 1m candles decide the order.
  - Every transition is an event with its candle, reason and evidence. Where §6–§8 leave a choice open, the engine's answer is listed as notes I25–I37 in [rulebook §14](../phase-0/07-smc-rulebook.md#setups-patterns-checklist-and-outcomes-ruleset-030), for your review.
- **The position-size calculator** (`packages/domain`): the amount at risk, the quantity rounded down to the venue's step, notional, leverage and R:R, all in exact decimals.
- **Fixtures and tests**:
  - 104 new golden fixtures (286 in all), with 5 positive cases in each direction and 5 near misses for every pattern and variant;
  - setup invariants in every fixture, the property test and the real-data test;
  - the property test must now reach every setup state, so its setup checks cannot pass by default.
- **Storage**: migration 0009 adds the `setups`, `setup_transitions`, `setup_checklist_results` and `setup_outcomes` tables, the `setup_transition` event type, and profiles version 4 with the setup settings (crypto and gold).
- **Runtime and API**:
  - the analyzer projects setups and publishes each transition;
  - `GET /setups` (filters and a cursor) and `GET /setups/{id}`: transitions, the checklist at each state, the outcome, and everything the setup refers to;
  - setups in the chart overlay;
  - the `setups` and `setups:{instrumentId}` channels, with their snapshots.
- **The labelling page** offers setups as candidates and adds "Pattern N confirmed bullish/bearish" labels.

Verification found three defects, all fixed and listed [below](#found-by-verification-and-fixed).

- Two were in my pattern logic, caught by the fixtures.
- The third was found on the live stack: 37 % of transitions were stored with an empty evidence object. The fix needed a new checkpoint format and a redeploy. Every live figure in this report comes from the redeployed stack.

## Acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 6.1 | Every pattern and variant passes ≥ 5 positive fixtures per direction and 5 near misses, including the cards' warnings as negative cases | **Met, with synthetic fixtures** (as 4.1 and 5.1) | [6.1](#61-patterns) |
| 6.2 | Every transition is stored with its candle, reason and evidence. No transition leaves `resolved` (property test) | **Met** | [6.2](#62-transitions) |
| 6.3 | Checklist credits and scores match fixtures. A setup failing a mandatory item never reaches `confirmed` | **Met** | [6.3](#63-checklist-and-score) |
| 6.4 | R:R and position-size results match hand-computed examples, including decimal edge cases | **Met** | [6.4](#64-rr-and-position-size) |
| 6.5 | MFE/MAE in R are correct on fixtures, and ambiguous candles are resolved with 1m data | **Met** | [6.5](#65-outcomes) |
| 6.6 | PAXG setups that form during a gold-market closure stay "Watching" with default settings | **Met**: fixtures, and 29 PAXG setups on the live stack | [6.6](#66-gold-closures) |
| 6.7 | Over a 7-day staging run, every setup can be traced through the API from its transitions down to its candles | **Met over 7 days of stored history** (as 4.3 and 5.3): all 4,349 setups of 18 runs, no failures. A 7-day run of purely live time is carried forward | [6.7](#67-traceability) |

### 6.1 Patterns

The golden test requires 5 positive fixtures in each direction and 5 near misses for every pattern and variant. Each bearish case has an exact mirror image as its bullish twin.

| Pattern | Positive cases (bearish; each also mirrored) | Near misses |
|---|---|---|
| 1, variant A | Target reached; S2 5 candles after S1 (the minimum), invalidated after the entry; S1 at a level just below the range high and an S2 that sweeps two levels at once, T1 before the entry; a two-candle displacement leg, no entry within 24 candles; S2 exactly 60 candles after S1 breaking the anchor itself, with the order block as entry zone | **Two sweeps and no MSS (the card's warning)**; S2 4 candles after S1 (5 needed); 61 candles after (60 allowed); a deep second sweep; a break without displacement; price beyond the sweep's extreme before the break |
| 1, variant B | Target reached, with T2 at S1's extreme; S1 at a swing low near the range low, entry still open; a two-candle leg, invalidated; S2 itself breaks the anchor and the entry zone is an order block; S2 exactly 5 candles after S1 | **Sweeps at both ends and no MSS**; a deep first sweep; S2 at a swing high near the range high instead of at it; S2 too soon; the range ends after S1 |
| 2 | Target reached; invalidated after the entry; T1 before the entry; no entry within 24 candles; target reached with economic events outside the blackout (news clear) | **Equal highs alone (the card's warning)**: no zone above them, so no setup forms; a sweep short of the zone; a close above the zone rules it out; a deep sweep; no MSS |
| 3 | Target reached; invalidated after the entry; two that expire without an entry; one still confirmed at the end, where the liquidity was taken before the block was touched | **A higher-timeframe order-block touch alone (the card's warning)**: no liquidity near the block; the swept level too far below it; the sweep 13 candles before the touch (12 allowed); price runs through the invalidation; no MSS |
| 4 | Target reached; invalidated; two that expire without an entry; a swing structure instead of a range, with an FVG's top as T1 | A deep sweep; the FVG filled beyond half before the sweep; filled beyond half before the confirmation, so no target and `levels_defined` fails; the FVG above price; no MSS |

- **How they were made**: as in Phases 4 and 5. I designed each case and worked out every expected value from the rulebook before running it.
- **First runs**: not all matched first time, unlike Phase 5.
  - Most mismatches were my own expectations: a nearer level I had missed as a target, a candle body short of displacement, or a level swept by the candle whose close created it (rulebook I13). I re-derived each one from the rulebook before changing it.
  - Two were engine defects (1 and 2 [below](#found-by-verification-and-fixed)).
- **Whether the checks bite**:
  - every case lists all its confirmations, so any other setup that confirms fails the case;
  - blanking the evidence of one resolution reason fails 17 fixtures (the check in [6.2](#62-transitions)).
- **Real data**: every pattern forms and triggers on 34.7 days of BTCUSDT, and Patterns 1, 3 and 4 confirm. See [Real data](#real-data).
- **Not yet**: recorded fixtures reviewed by a second person (§12), as for Phases 4 and 5. The labelling page now covers setups.

### 6.2 Transitions

- **Stored**: each transition is a `setup_transition` event in the run's log, so replay digests include it. The projection `analysis.setup_transitions` holds:
  - the deciding candle (`candle_time`, its open);
  - `decided_at` (its close) and `processed_at`;
  - the reason and the evidence;
  - the event's `seq`.

  `GET /setups/{id}` returns the transitions in order.
- **Evidence** (rulebook I37): every transition names what decided it.

| Transition | Evidence |
|---|---|
| `forming` | The range, or the swing structure and its FVGs, or the Pattern 2 and 3 candidates |
| `triggered` | The sweep; also S1 (Pattern 1) or the touch (Pattern 3) |
| `confirmed` | The entry zone (the MSS is in the setup's references) |
| `triggered` → `triggered` | The failed mandatory items and the blocking flags |
| `entry_active` | The entry, and the candle's high and low |
| `resolved` | What ended it: the range or structure; the candidates last watched; the MSS window and what closed it; the level crossed with the candle's (or minute's) high and low; or the entry or hold window |

- **The defect**: on the first deploy, 3,634 of 9,874 stored transitions (37 %) had an empty evidence object (defect 3). After the fix, none of the redeployed runs' 9,861 transitions does. An invariant now fails any transition without evidence, in every fixture, the property test and the real-data test.
- **No transition leaves `resolved`**: the invariants check the state machine in every fixture, the property test and the real-data test. A setup starts `forming`, moves only forward, and never leaves `resolved`; the one self-transition, `triggered` → `triggered`, is a failed confirmation.
  - **The property test**: 1,000 random markets with gaps and partial candles. With its seed, about 11,600 setups form, 2,500 trigger, 17 confirm, 4 reach their entry and 10,600 resolve, across Patterns 1, 3 and 4.
  - Until now the test did not check that setups appeared at all. It now fails unless every state is reached.
- **On the live stack** (the 18 runs of [6.7](#67-traceability)): 9,861 transitions, every move in the state machine, all with evidence:

| From → to | Reasons (count) |
|---|---|
| — → `forming` | preconditions (4,349) |
| `forming` → `resolved` | no_fvg (2,270), no_candidates (472), structure_ended (260), range_ended (244) |
| `forming` → `triggered` | sweep (1,009), sweeps_A (22), sweeps_B (14) |
| `triggered` → `resolved` | invalidation_price (646), no_mss (218), not_confirmed (84), beyond_sweep (28) |
| `triggered` → `triggered` | not_confirmed (100) |
| `triggered` → `confirmed` | mss_confirmed (64) |
| `confirmed` → … | entry_touched (22), target_before_entry (40), no_1m_data (2) |
| `entry_active` → `resolved` | target1_reached (16), invalidation_price (6) |

### 6.3 Checklist and score

- **Credits and scores**: every confirming fixture states all eight credits and the score. For example, `p1-a-bearish-001` scores 62.5:
  - 0 for the context (no 1h trend);
  - 10 for marked liquidity;
  - 7.5 for an entry zone without a context POI;
  - 15, 20 and 5 for the sweep, the MSS and the levels;
  - 0 for R:R 0.514, under 2;
  - 5 for news.
- **The checklist fixtures** (each with its mirror):

| Fixture | What it shows |
|---|---|
| `checklist-htf-half` | A ranging 1h context: item 1 earns half, by premium and discount |
| `checklist-news-blackout` | A high-impact USD release 20 minutes after the confirmation, inside the 30-minute blackout: item 8 fails |
| `checklist-calendar-unavailable` | No calendar: item 8 fails with `calendar_unavailable`, as on the live stack until Phase 7 |
| `checklist-data-gap` | A gap on 5m while the setup lives: every mandatory item passes, but `data_gap` blocks confirmation. It stays "Watching" and expires |

- **A failing mandatory item never confirms**:
  - The invariants check it in every fixture, the property test and the real-data test. A setup that confirms has passed every mandatory item at full credit, has its levels in order and has no data gap.
  - The near misses exercise it: `p4-negative-filled-before-confirmation` loses its only target, so `levels_defined` fails and the setup stays triggered until it expires.
  - **On the live stack** (18 runs):
    - 64 confirmations, none with a mandatory item short of full credit.
    - 100 confirmations were refused and stayed "Watching". 98 failed `levels_defined`: 90 had no target at least 1 ATR away, and 8 had no entry zone either. 10 of those also traded in a closure. The other 2 were held by a closure alone ([6.6](#66-gold-closures)).

### 6.4 R:R and position size

`positionSize` and `riskReward` (`packages/domain`) use exact decimals (big.js). The tests check them against examples whose arithmetic is written out in each test:

| Example | Inputs | Result |
|---|---|---|
| A BTC long | 10,000 at 1 %; entry 65,000, invalidation 64,500, step 0.00001, target 66,500 | 100 at risk; 0.2 BTC; notional 13,000 (1.3×); R:R 3; reward 300 |
| The p1-a-bearish-001 short | 2,500 at 0.5 %; entry 98.2, invalidation 102.48, step 0.001, T1 96 | 12.5 / 4.28 = 2.92056… → 2.92; risks 12.4976; notional 286.744; R:R 0.514 |
| Exact decimals | 0.3 − 0.1 | 0.2 exactly (a float gives 0.19999999999999998): quantity 100 |
| A one-satoshi stop | entry 0.00012345, invalidation 0.00012344 | 1,000,000,000 units, notional 123,450 |
| Gold (PAXG) | 5,000 at 0.75 %; entry 2,650.37, invalidation 2,655.12, step 0.0001 | 7.8947 (from 7.894736…); risk 37.499825, never above 37.5 |
| Default step | 100 at 1 %; entry 10, invalidation 7 | 1 / 3 → 0.33333333 (8 decimals), risking 0.99999999 |
| R:R alone | 100 / 98 / 106; 100 / 102 / 97; 100.3 / 102.34 / 96 (entry / invalidation / target) | 3; 1.5; 4.3 / 2.04 = 2.10784… → 2.1078 |
| Wrong side | a target on the invalidation's side, or at the entry | no R:R |
| Nonsense | equal prices, risk 0 % or 101 %, a negative account, text, step 0 | refused |

- **In the engine**, R:R on T1 is floored to 4 decimals with integer arithmetic and compared with the minimum exactly. Fixtures state it: 2.2 / 4.28 = 0.51401… reads 0.514, and item 7 fails.
- **The calculator's screen** comes with the Setup Scanner (Phase 7). Phase 6 provides the function.

### 6.5 Outcomes

- **MFE and MAE in R** use whole setup candles from the entry candle to the resolving one, floored to 4 decimals; bars held counts both. For example:
  - `p1-a-bearish-001` holds 3 bars, from the entry candle to the one that reaches T1: MFE (98.2 − 95.9) / R = 0.5373 and MAE (98.3 − 98.2) / R = 0.0233, with R = 4.28;
  - `outcome-expired-open` holds 289 bars without either outcome and expires.
  - Whole candles also mean that a candle the 1m data resolves as a target still counts its move toward the invalidation. In `outcome-ambiguous-1m-target` the MAE is 1.028 R although T1 came first. That is I36 as written; say if you want the resolving candle cut at the deciding minute.
- **Ambiguous candles** (each case with its mirror):

| Fixture | The setup candle | Decided by | Result |
|---|---|---|---|
| `outcome-ambiguous-1m-target` | Reaches T1 and the invalidation | The 1m candles: T1 first | `target_reached`, resolved with `1m` |
| `outcome-ambiguous-1m-invalidated` | The same | The 1m candles: the invalidation first | `invalidated`, with `1m` |
| `outcome-ambiguous-same-minute` | The same | One minute holds both | `ambiguous` (`same_1m_candle`) |
| `outcome-ambiguous-no-1m` | The same | Its 1m candles are missing | `ambiguous` (`no_1m_data`) |
| `outcome-entry-and-target` | Touches the entry and reaches T1 | The 1m candles | entry, then `target_reached` |

- **On the live stack**: 32 of the 2,176 setups held by the nine live runs confirmed. All of them resolved:
  - 8 reached T1, 3 were invalidated after the entry, and 20 met T1 before the entry;
  - 1 was ambiguous.

  The ambiguous one is a PAXGUSDT setup on 5 November whose 15m candle traded through two outcomes. A run warms up only 1,000 1m candles (about 17 hours), so warm-up history older than that has no 1m data, and such a candle stays `no_1m_data`, as I36 says. Live candles always have their 1m candles. Warming up 1m over the setup timeframes' whole history is [carried forward](#carried-forward).

### 6.6 Gold closures

The gold profile blocks confirmation while the underlying market is closed (`blockConfirmWhenUnderlyingClosed`, on by default). A setup gets `underlying_closed` when its trigger sweep, its MSS candle or its confirmation candle trades in a closure (I35).

| Fixture | Closure | Result |
|---|---|---|
| `gold-setup-closure` | The second sweep, the MSS and the FVG candle | Every mandatory item passes; it stays "Watching" (`blocking: [underlying_closed]`) and expires |
| `gold-setup-closure-early` | The second sweep only | Stays "Watching" (`blocking: [underlying_closed]`) after its MSS, and expires |
| `gold-setup-closure-mss` | The MSS candle only | The same: one deciding candle in a closure is enough |
| `gold-setup-reopening` | The first sweep only | Confirms: the first sweep does not decide anything |
| `gold-setup-reopening-late` | Ends as the range is detected | Confirms |
| `gold-setup-reopening-target` | After the confirmation | Reaches T1: a closure does not stop a confirmed setup |
| `gold-setup-thin-book`, `-thin-book-s1`, `-thin-book-deep-liquidity` | — | A sweep through a thin book does not trigger; the control with deep liquidity does |

**On the live stack**:

- 29 setups of the two PAXG runs carry `underlying_closed` (16 on PAXG-USD, 13 on PAXGUSDT); none confirmed.
- Six of them reached a confirmation attempt and stayed "Watching".
- One had every mandatory item passed, so only the closure held it: PAXGUSDT setup `01a1b8e2-4900-7445-a93c-95b0dd3e9ffe` (Pattern 4, bullish, 4h/15m). Through `GET /setups/{id}`:

| Candle (UTC) | Transition | Evidence |
|---|---|---|
| Sat 8 Nov 01:45 | → `forming` | an FVG and a swing structure |
| 09:15 | → `triggered` | a sweep of a 15m swing low |
| 10:15 | `triggered` → `triggered` (`not_confirmed`) | `failed: []`, `blocking: [underlying_closed]` |
| 11:15 | → `resolved` (`invalidated`) | low 4,056.25 through the invalidation 4,058.15 |

  Its score is 75 and its label stays "Watching" until it resolves. Item 8 fails because the calendar is not available yet.

### 6.7 Traceability

- **The staging run**: the local stack stands in for staging (D2, the hosting, is still open).
  - A 7-day replay of each instrument (4 to 11 November, 13:40 UTC) reproduced its live run's digest. That digest now includes every setup transition.
  - As in Phases 4 and 5, the live runs computed those 7 days while warming up.

| Instrument | Events in the 7 days | Digest (first 16) | Equal |
|---|---|---|---|
| BTCUSDT | 4,646 | `dea90611dbd14904` | Yes |
| ETHUSDT | 4,463 | `25f8d3c9aff7b2f4` | Yes |
| SOLUSDT | 4,350 | `d2e004da4f7a737d` | Yes |
| PAXGUSDT | 4,966 | `af38dba0d8c3b2f3` | Yes |
| BTC-USD | 4,095 | `5a120c7d613478ed` | Yes |
| ETH-USD | 3,944 | `6602f21ef510aca4` | Yes |
| SOL-USD | 4,040 | `9ee8dfed60bc1110` | Yes |
| PAXG-USD | 4,617 | `e0e9c293dbdc6b7d` | Yes |
| USDT-USD | 3,216 | `1698f7c0d25a718c` | Yes |

- **The trace**: a one-off check script signs in as the seeded viewer and traces every setup of the 18 runs (nine live, nine replays) through the API alone:
  - `GET /setups?runId=…`, every page, and `GET /setups/{id}` for each setup;
  - each transition: the state machine, a reason, evidence, decided at its candle's close, and that candle through `GET /market/{id}/candles`;
  - the references, down to their candles: each sweep's breach and confirming candles and its level; the MSS anchor swing (through `GET /smc/{id}/swings`, at its price), the break and the displacement candles; the entry zone's and POI's origin candles; the range's window; and T1 and T2 (levels among the setup's references, FVGs through `GET /smc/{id}/zones`);
  - the summary against its transitions (state, times, resolution), the checklist, the outcome's candles and the disclaimer;
  - against the database: the API lists every stored setup and drops none of its stored transitions or references.
- **Result**: 4,349 setups (2,175 live, 2,174 replayed), 9,866 transitions, 3,382 references and 14,170 candle lookups, in 4,510 API calls: **no failures**. The first version of the script reported two, both in the script (it fetched candles before it knew where the MSS anchors were).
- **Not yet**: a 7-day run of purely live time, once a stack has run that long.

## Real data

On 34.7 days of Binance BTCUSDT (5m, aggregated to 15m–1d; no 1m candles, no calendar), the engine forms 1,842 setups, about 53 a day:

| Pattern | Setups (5m / 15m) | Triggered | Confirmed | Outcomes |
|---|---|---|---|---|
| 1 | 80 / 19 | 13 | 5 | 2 invalidated, 3 T1 before entry |
| 2 | 35 / 3 | 2 | 0 | — |
| 3 | 277 / 46 | 165 | 13 | 3 target, 2 invalidated, 7 T1 before entry, 1 ambiguous |
| 4 | 1,045 / 337 | 394 | 23 | 4 target, 5 invalidated, 13 T1 before entry, 1 ambiguous |

- Most setups never trigger. Pattern 4's FVG is filled or left behind (910 expiries); Pattern 1's range ends (86); Pattern 2's and 3's candidates go (194).
- 41 confirmation attempts failed `levels_defined`: no entry zone, or no target at least 1 ATR away.
- Pattern 2 is rare: its equal highs must sit within 1 ATR below a context supply zone or order block that is less than half filled. It is covered by fixtures only.
- Setup transitions are 12 % of all events. The engine's step stays inside its budget (`realdata.test.ts` fails above 2 ms).

## Live

On the local stack, after the redeploy (2026-11-11 13:46 to 14:12 UTC):

- **Setups per run**: each run holds 180 to 269 setups from its warm-up, from 1 November on (the 15m series' 1,000 candles):

| Instrument | Setups (P1 / P2 / P3 / P4) | Triggered | Confirmed | Outcomes after confirming |
|---|---|---|---|---|
| BTCUSDT | 269 (6 / 2 / 44 / 217) | 67 | 0 | — |
| ETHUSDT | 250 (18 / 5 / 32 / 195) | 63 | 9 | 1 target, 1 invalidated, 7 T1 before entry |
| SOLUSDT | 258 (15 / 3 / 31 / 209) | 59 | 3 | 1 target, 2 T1 before entry |
| PAXGUSDT | 269 (12 / 4 / 56 / 197) | 72 | 4 | 3 T1 before entry, 1 ambiguous |
| BTC-USD | 257 (20 / 9 / 39 / 189) | 47 | 1 | 1 target |
| ETH-USD | 229 (25 / 8 / 32 / 164) | 70 | 6 | 2 target, 1 invalidated, 3 T1 before entry |
| SOL-USD | 240 (19 / 3 / 29 / 189) | 53 | 2 | 2 T1 before entry |
| PAXG-USD | 224 (9 / 3 / 37 / 175) | 63 | 6 | 2 target, 1 invalidated, 3 T1 before entry |
| USDT-USD | 180 (18 / 3 / 14 / 145) | 29 | 1 | 1 target |

- **Live setup transitions**: in their first 20 minutes of live time the runs decided 18 setup transitions (8 formed, 4 triggered, 6 resolved), none late.
- **Consistency**: every run's event log is contiguous. Every detection and setup transition decided live was published exactly once, 7 to 33 per run.
- **Speed**, over the 20 minutes 13:50 to 14:10 UTC. The integration suites, the 6.7 trace and Playwright were running on the same machine at the time, so these figures are higher than Phase 5's quiet ones:
  - after the candle was final, SMC detections were published **p95 282 ms** (n = 124) and setup transitions **p95 293 ms** (n = 17), within the 2 s budget, and indicator points p95 150 ms. Phase 5 measured 77 ms and 59 ms.
  - From the venue's boundary, the p95 was 0.3 to 0.7 s on Binance and 3.0 s on Coinbase (its 2 s late-trade grace).
  - The engine's step p95 was **0.64 ms** over the last 4,096 steps (Phase 5: 0.19 ms), inside the 2 ms budget.
- **Live time**: a replay of 13:50 to 14:08 UTC reproduced all nine digests: 3 to 25 events per run, with 15 setup transitions across six runs.
- **Start-up**: at 13:45:46 the analyzer refused the nine format-3 checkpoints and superseded their runs. The new runs warmed up in 17 to 23 s each.
  - PAXG-USD took 2 min 12 s, as on the first deploy (2 min 18 s). Its 7-day replay takes 7 to 9 s, so that time is not spent in the engine.
  - Phase 5 had the same delay on PAXG-USD. I have not found its cause.

## Found by verification and fixed

| # | Defect | Effect | Fix |
|---|---|---|---|
| 1 | Pattern 1: when one candle swept several levels, its sweeps replaced S1 before the range-high sweep among them could count as S2 | A second sweep that also took another level never triggered (`p1-a-bearish-003` now covers it) | A candle's sweeps are checked as S2 first, the range edge preferred; only otherwise do they become S1 (I27) |
| 2 | Pattern 3: when the liquidity was taken before the block was touched, reaching the block took price above the sweep's extreme | Such a setup could never confirm, since §6.1 forbids trading beyond the extreme before the MSS (`p3-bearish-004` now covers it) | The setup measures from the highest high since the sweep, up to the trigger candle, and the MSS window starts at the trigger (I29) |
| 3 | Transitions that resolved a setup without a price event, and the outcome resolutions, stored `{}` as evidence | 37 % of stored transitions said why but not what decided it (found on the live stack, by querying the transitions) | Every transition records its evidence (I37), and an invariant enforces it. The setup state changed, so the checkpoint format is now 4; the analyzer superseded the nine format-3 runs by itself and warmed up new ones |

Two smaller changes came out of the same checks:

- the property test now fails unless the random markets reach every setup state;
- `scripts/analysis-latency.mjs` now also times setup transitions.

## Tests and coverage

1,687 automated tests, all passing: 1,303 unit, 379 integration and 5 end to end.

- `pnpm verify` passes, before and after the evidence fix: formatting, lint, typecheck, dependency rules, the no-trading check, unit tests with coverage gates, the build and the artefact scan.
- The integration suites of all six packages that have them pass with coverage, rerun after the evidence fix.
- Playwright passes 5 of 5 against the live Phase 6 stack.

| Package | Tests (unit + integration) | What is new in Phase 6 | Coverage gate | Measured (lines / branches) |
|---|---|---|---|---|
| smc-engine | 906 (Phase 5: 593) | 104 golden fixtures, each with 3 checks; setup invariants (state machine, evidence, checklist, levels) in the golden, property and real-data tests; every pattern on real data; checkpoints of formats 1–3 refused | 90% | 99.0% / 96.2% |
| domain | 31 (23) | The position-size calculator: 8 tests of hand-computed examples | 90% | 99.2% / 95.8% |
| contracts | 55 (54) | The setup schemas and channels, and the profile's setup settings | 90% | 100% / 100% |
| db | 2 + 22 | Migration 0009, profiles version 4 equal to the engine's defaults | 70% | 98.4% / 81.3% |
| analyzer | 5 + 21 | Setup projections equal to the event log (transitions, checklist by state, outcome); setup entries published on `an:events` | 70% | 90.9% / 80.4% |
| api | 19 + 270 (Phase 5: 258) | `GET /setups` and `GET /setups/{id}`, setups in the overlay, the setups channels and their snapshots, the new routes in the RBAC matrix | 70% | 92.5% / 76.7% |
| app | 118 (117) | Setups on the labelling page | none yet | 86.6% / 76.3% |
| indicators, market-data, exchange-adapters, observability, ingestor, jobs, ui | 73, 40, 25, 11 + 15, 6 + 20, 8 + 31, 4 | Unchanged | as before | as before |
| End to end | 5 | Unchanged | — | — |

## Decisions made during Phase 6

| Decision | Why | Recorded in |
|---|---|---|
| The thirteen engine choices where §6–§8 are silent (I25–I37) | Each is listed with its reason; changing one is a new ruleset version | [Rulebook §14](../phase-0/07-smc-rulebook.md#setups-patterns-checklist-and-outcomes-ruleset-030) |
| Ruleset 0.3.0 and profiles version 4; the analyzer's rules version becomes `indicators-1+smc-0.3.0`; checkpoint format 4 | A new event type changes every digest, so the Phase 5 runs are superseded | Migration 0009; [architecture §7](../phase-0/03-architecture.md#7-analysis-pipeline) note |
| A new resolution, `expired`, for setups that never confirmed | §6.1's five resolutions describe confirmed setups; reusing `expired_no_entry` would mix setups that never confirmed into outcome statistics (I26) | [Data model](../phase-0/05-data-model.md) note |
| Item 8 fails with `calendar_unavailable` until the economic calendar exists | The live stack has no calendar before Phase 7; failing is honest, and the item is not mandatory | I34 |
| `low_liquidity` judges volume only | The engine has no order-book data; the spread part of §7 is not evaluated | I35 |
| `GET /setups` and `GET /setups/{id}` return each setup's run and flags; transitions carry `decidedAt`, `processedAt` and `late` | Tracing a setup, and telling a live decision from a warm-up one | [API contracts](../phase-0/06-api-contracts.md) note |

## Carried forward

| Item | Plan |
|---|---|
| Review of rulebook §14 notes I25–I37 (and I1–I24) | Yours to decide |
| Recorded fixtures reviewed by a second person (§12), now also for setups | Needs two people; the labelling page is ready |
| A 7-day run of purely live time (6.7, as 4.3 and 5.3) | Once a stack has run for 7 days |
| The economic calendar for checklist item 8, and the calculator's screen | Phase 7 (Setup Scanner and calendar) |
| Ambiguous outcomes in warm-up history older than the 1m series (about 17 hours) stay `no_1m_data` | A choice for you: warm the 1m series up over the setup timeframes' history (about 15,000 more 1m candles per instrument at start), or accept it for history |
| From Phases 2–5: the trend rule and volume threshold; decisions 1 and 2; D2 hosting; pull requests for Phases 2–4 | Unchanged |

## What I need from you

1. **Review the implementation notes I25–I37** ([rulebook §14](../phase-0/07-smc-rulebook.md#setups-patterns-checklist-and-outcomes-ruleset-030)), along with I1–I24.
2. **Recorded fixtures (§12)**: label some with a colleague using `/dev/labelling`, or accept the synthetic fixtures for now.
3. **The 1m warm-up for old ambiguous candles**: extend it, or accept `no_1m_data` for history.
4. **Still open**: the Phase 3 trend rule and volume threshold; Phase 2 decisions 1 and 2; D2 hosting.
5. Your approval of this report, and whether to commit Phase 6 (and push it).
