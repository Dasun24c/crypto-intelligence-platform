# Phase 16 · Automatic practice trading: acceptance report

| | |
|---|---|
| Status | **Built; waiting for your acceptance.** All nine criteria are met. Committed on 2026-11-15 at your request, on the branch `phase-16/automatic-practice-trading`; not pushed |
| Date | 2026-11-15 |
| Scope | [Implementation plan, Phase 16](../phase-0/08-implementation-plan.md#phase-16--automatic-practice-trading), [proposal 002](../proposals/002-automatic-practice-trading.md) (approved 2026-11-15), [ADR 022](../adr/022-automatic-practice-trading.md), REQUIREMENTS §11 revision 5 |
| Evidence | This machine (Windows 11, Docker Desktop, Node.js 26.13.0); the local Compose stack streaming live public data from Binance and Coinbase, redeployed with Phase 16 at 11:42 UTC on 2026-11-15; checks to 13:24 UTC |

## Summary

A user can switch on **automatic practice trading** for their own practice account. On each confirmed bullish setup that matches their rules, the platform places a practice limit buy for them, with a protective stop and a target, within their limits. **Practice balances only: no real money, nothing reaches an exchange, and the AI never decides an order.** Nothing is placed for anyone who has not switched it on.

- **The rules** (per user, on one practice account; the recommended defaults in brackets):
  - the pairs (every practice pair on the account), the patterns (all four), the lowest checklist score (70) and the lowest reward for the risk at target 1 (2);
  - the risk per trade, as a share of the free balance (1 %, at most 2 %);
  - the limits: open automatic trades (3, and one per pair), automatic orders a day (10), and the daily loss limit (3 % of the starting balance).
- **What it does** on a confirmed bullish setup that passes every check (ADR 022, checked in order): a practice limit buy at the setup's entry, with a stop at its invalidation and a target at its first target, sized by the position-size calculator and capped at what the free balance buys. The order goes through the same checks and the same fills as one placed by hand. If the setup ends before the buy fills (invalidated, expired), the buy is cancelled. Bearish setups place nothing (spot only).
- **Where**: inside the broker (ADR 021's service), which now reads the analysis's setup transitions (`an:events`) as a third input, in order with the commands and the live trades. The decisions come from `AutoTrader`, a pure decider beside the fill engine in `packages/paper-engine`.
- **Every decision is logged**: placed; skipped, with the reason (paused, pair, pattern, not a live decision, data gap, score, reward, open trades, orders today, size, balance); refused by the order checks, with their reason; or cancelled, with why.
- **Every automatic order** is labelled "Automatic" in the orders and the history, audited with its setup, rules version and analysis run, and can raise an alert (two new kinds: "automatic practice order placed" and "automatic practice trading paused").
- **The daily loss limit**: when the day's closed automatic trades lose the limit, it pauses until 00:00 UTC.
- **The stop button** switches it off and cancels every working automatic order. What it bought stays in the practice balance.
- **Replays**: the journal now carries the setups and rule changes the broker read and the decisions it made, so `cip-broker replay` checks decisions as well as fills.
- **The card** "Automatic trading (simulated)" on the Practice Trading page: the switch with its confirmation, the rules, today's figures, the pause, the decision log and the stop button, under the practice banner.

## Acceptance criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 16.1 | With automatic trading on, a confirmed bullish setup that matches the rules becomes a practice limit buy with its stop and target, sized by the calculator; one that doesn't is logged as skipped with the reason (end to end, on live or replayed data) | **Met**: end to end on the live stack, the broker's integration tests, and the decider's unit and property tests | [16.1](#161-placing-and-skipping) |
| 16.2 | The limits hold: open trades, one per pair, orders per day, and the daily loss pause (unit and property tests) | **Met**: unit and property tests, and the broker's integration tests (a real pause after a stopped-out trade) | [16.2](#162-the-limits) |
| 16.3 | The stop button switches it off and cancels every open automatic order within 5 s | **Met**: end to end, cancelled 96 ms after the api recorded the stop; the broker's integration test under 5 s; the api and the app | [16.3](#163-the-stop-button) |
| 16.4 | Nothing is placed for a user who hasn't switched it on, and nothing but the broker can place an automatic order (database policy and dependency rule) | **Met**: the database's policies (integration), the decider and the broker (switched off, never set up, rules that no longer validate) | [16.4](#164-only-when-switched-on-only-the-broker) |
| 16.5 | A buy is cancelled when its setup expires or is invalidated before it fills | **Met**: end to end, the broker (also after a restart, with a partly filled buy), unit | [16.5](#165-cancelled-when-the-setup-ends) |
| 16.6 | Replaying recorded setups and market data gives the same decisions and fills (digest) | **Met**: unit, property, the broker's journal across a restart and a failed write, and the live journal (79 entries, 67 decisions, identical) | [16.6](#166-replays) |
| 16.7 | Every automatic order is labelled "Automatic", audited with its setup and rules version, and raises an alert; rule changes are audited | **Met**: end to end (the label and the alert), integration (audit, alerts) and unit | [16.7](#167-labelled-audited-alerted) |
| 16.8 | NFR-17 is measured and met (an automatic order p95 ≤ 2 s after its setup is confirmed) | **Met**: p95 291 ms over 33 orders on the live stack | [16.8](#168-latency-nfr-17) |
| 16.9 | The new card carries the practice banner, axe finds no serious violations, and it works from the keyboard, the switch's confirmation included | **Met**: end to end on the live stack, and unit | [16.9](#169-the-card) |

### How the end-to-end runs get confirmed setups

Real confirmed bullish setups are rare (48 in the first half of November across the pairs, about three a day), and none can be made to happen during a test. So the end-to-end spec (`e2e/tests/phase16.spec.ts`) and the latency script append **setup transitions to the stack's `an:events` themselves**, in the analyzer's exact message shape (validated by the broker with the same contract), for Binance BTC/USDT, with an entry at half the market price so the buy rests. Everything after that is the stack's own: the broker's decision, the order through the practice engine, the decision log, the audit, the alert and the page. How setups are found and published is covered by Phases 5–7. These synthetic transitions exist only in the local stack.

### 16.1 Placing and skipping

- **End to end** (the live stack, the development analyst): with automatic trading on for BTC/USDT, a confirmed setup became a limit buy at its entry, labelled "Automatic", with its stop and target waiting for it ("Waits for its buy"), and the decision log showed "Placed: Matched your rules." A setup with a checklist score of 40 was logged "Skipped: Its checklist score is below your minimum.", and nothing was placed.
- **Integration** (the broker): the buy, stop and target stored as `auto` orders with the setup and the deterministic ids; the quantity equal to the position-size calculator's (1 % of the free balance over the stop distance, rounded down to the step); the decision row; the day's figures; the journal entry with its decision lines; the `practice.automatic` message with the order's size and prices. Skips for `open_limit` (one per pair) and `score`; refusals by the order checks (`data_delayed`) for two users at once.
- **Unit** (`packages/paper-engine/src/auto.test.ts`): every skip reason, each with the first check that fails in ADR 022's order; the levels rounded to the price step; the size capped at the balance; the setup message read.
- **Property test**: over random levels, scores, rules and balances, every order placed has stop < entry < target 1, a quantity on the step and worth the minimum, a risk no larger than the rule's share of the free balance, a cost with fees no larger than the free balance, and a reward at least the rule's minimum.

### 16.2 The limits

- **Unit**: one trade per pair; at most the open-trade limit; at most the orders a day (a refused order counts), counted again from 00:00 UTC; the result of each closed trade (a winning one, a stopped one, and a trade closed after selling only part of what it bought); the pause at the limit until the next 00:00 UTC, then trading again the next day; a late venue timestamp counted on the day already started.
- **Property test**: over random sequences of setups, fills and setup ends, the open trades never exceed the limit or hold two on one pair, and the same sequence always gives the same decisions and fills.
- **Integration** (the broker, on the database): a buy filled by a live trade and stopped out into a falling book; the day's result past a 1 % limit paused the strategy until 00:00 UTC (stored, audited as `practice_auto.paused`, published, and the next setup skipped as `paused`).

### 16.3 The stop button

- **End to end**: with a working automatic buy, "Stop and cancel its orders", then "Stop it" in the confirmation: the buy and its stop and target were gone from the open orders well within the test's 5 s (the audit log: the api recorded the stop at 11:46:31.711 and the broker cancelled the three orders at 11:46:31.807), the card showed "Off", and the log "Cancelled: You stopped automatic trading."
- **Integration**: the broker cancelled the buy and its legs within 5 s of the command (the test asserts it), logged the cancellation, and published `stopped` with the count. The api answers `202` while automatic orders are still working, `200` once none are, and audits each stop with the number of working orders.
- **Unit** (the app): the confirmation names how many orders it cancels; nothing is sent before "Stop it"; `202` shows "Stopping".

### 16.4 Only when switched on, only the broker

- **Database** (migration 0013, `trading.int.test.ts`): `svc_broker` may insert orders only with `source = 'auto'`, as submitted (nothing filled or held), and only for users with a strategy; it cannot insert one for a user who never set up automatic trading, nor a manual order. `svc_api` can no longer insert `auto` orders. The broker may change only a strategy's pause; the analyzer and jobs services have no access to strategies, decisions or day figures.
- **The broker**: a strategy switched off decides nothing, not even a log row; a stored strategy whose rules no longer validate is loaded switched off (integration, after a restart).
- **The api** refuses order keys starting `auto:`, which automatic orders use.
- **The dependency rule** is unchanged: setups, alerts, the AI and jobs cannot reach the order commands (`depcruise` passes); automatic orders are placed only inside the broker.

### 16.5 Cancelled when the setup ends

- **End to end**: the placed buy's setup was then invalidated: the buy and its stop and target were cancelled and the log said "The setup was invalidated before the buy filled."
- **Integration**: an unfilled buy cancelled with its legs on `invalidated`; after a restart, a partly filled buy's setup expired: what was left of the buy was cancelled, and its stop and target kept protecting what it bought, until the target sold it (a gain counted for the day).
- **Unit**: both cases, and a setup end for which nothing is working journals nothing.

### 16.6 Replays

- **Unit**: a session of strategy changes, setups, trades, a cancel and a stop replays with every fill and every order, decision and pause line equal; a changed decision line is found.
- **Property test**: the same random session gives the same decisions and fills every time.
- **Integration** (the broker): every run of its journal, across lease handovers, a restart with open automatic trades, and a write that failed until a conflicting row was removed (the broker reloaded, read the setup again, and decided it once), replays with every fill and every decision identical.
- **Live**: `docker compose exec broker node apps/broker/dist/cli.js replay` on the stack: the Phase 16 run (79 entries, 67 decisions) and the two Phase 14 runs before it replay identically. The very first run (entries 1–78) still differs at entry 3, as found in Phase 14 (it was journalled before the broker recorded its rules and fees).

### 16.7 Labelled, audited, alerted

- **Labelled**: "Automatic" on automatic orders in the open orders and the history (end to end and unit).
- **Audited**: the broker audits each automatic order as `practice_order.placed` (actor `system`, with the strategy, its version, the setup, the analysis run and the three prices) and each pause as `practice_auto.paused`; the api audits `practice_auto.rules_changed` (the rules before and after), `.switched_on`, `.switched_off` and `.stopped`. After the practice tests the audit chain verifies through the api.
- **Alerted**: end to end, a "practice_auto_order" rule fired "BTC · Binance BTC/USDT: automatic practice buy placed". The analyzer's integration test fires both new kinds for the owner's rules only, once per order or pause, and nothing for skips, stops, other users or a malformed message; the alerts package's unit tests cover the titles, bodies, owners and lateness.

### 16.8 Latency (NFR-17)

`node scripts/practice-latency.mjs --auto 30 15` on the stack: as the development viewer, it switched automatic trading on for BTC/USDT, appended 30 confirmed setups to `an:events` one at a time (each ended after its decision, so the next was not held back by the one-per-pair limit), and switched it off. All 30 were placed. From each setup's `an:events` entry to its buy's `practice:events` entry, on the Redis clock, over the 33 automatic orders in the window (30, and 3 from the end-to-end run): **p50 114 ms, p95 291 ms, max 397 ms** (target p95 ≤ 2 s). The broker also records it as `cip_practice_auto_latency_ms`.

### 16.9 The card

End to end, on the live stack: the card carries the practice banner; axe (WCAG 2 A and AA) found no serious or critical violation, before and during the switch's confirmation. By keyboard alone: Space on the switch opened the confirmation, which says what it will do (the pairs, patterns, score, reward, risk per trade and limits) without switching on; Tab reached "Switch on", and Enter switched it on. The app's unit tests check the confirmation, "Keep it off", the field errors (with `aria-invalid` and their messages), that a form with unsaved changes cannot be switched on, the `409` reload, and the decision log's pages.

## Decisions made while building it

These are recorded in [ADR 022, "As built"](../adr/022-automatic-practice-trading.md#as-built-phase-16). Two change what the approved proposal described:

1. **The size is capped at the free balance** instead of skipping the setup. With 1 % at risk, a setup whose stop is within 1 % of its entry would need more than the whole balance; the proposal's rule would have skipped it as "balance". Capping keeps the risk at or below the rule's, and only skips when even the capped order is below the pair's minimum.
2. **The stop button cancels the stops and targets too**, as ADR 022 says, so what was bought stays in the balance without protection; switching off (not stopping) leaves them working. If you would rather the stop button left the protective orders in place, that is a small change.

## Live

On the local stack (2026-11-15, UTC):

- **11:42**: redeployed with Phase 16. Migration 0013 was applied; the broker took the lease (epoch 4) and started reading `an:events` at its end.
- **11:45**, end to end: the first run passed 16.9, placed its automatic buy, then failed on a mistake in the test (its row filter for "Buy" also matched the legs' status "Waits for its buy"). **11:46**: the second run passed 3 of 3.
- **11:47–11:48**: NFR-17, 30 setups, all placed (above).
- **11:50**: the live replay (above).
- **11:49–11:59**: `pnpm verify` twice: the first stopped at formatting (one file), the second at the contracts test that counts the alert kinds (still 14; now 16).
- **11:57–12:06**: every end-to-end spec, all phases: 19 passed, 1 failed and 2 did not run after it. The failure was Phase 14's check for the page's practice banner, which now found two: the page's and the new card's.
- **12:07–12:08**: the Phase 14 spec again, with that check fixed: 5 of 5, its axe scan now covering the page with the new card.
- **12:09–12:26**: `pnpm verify`: every step passed but the app's tests. Their 123 tests that ran passed, but four test files never started: their workers timed out while every package's suite ran at once, as on this machine in Phase 14.
- **12:27–12:37**: `pnpm verify` on the final code: **passed** (the app's 24 files and 164 tests ran; Turbo reused the other packages' results from the run before).
- **12:37–13:01**: the integration suites of all seven packages that have them, with coverage, one at a time: the database, the broker, the analyzer, the jobs service and observability passed; one ingestor test and one api test failed (below).
- **13:01–13:10**: the ingestor's failure, a known-answer test unchanged since Phase 2, failed again alone, and passed with its logging on: it read the large trade while its write, queued after the walls', was still going. The test now waits for it; the ingestor's suite passed 20 of 20 with coverage.
- **13:10–13:24**: the api's failure, its positions test (Phase 14's, unchanged, like the code it tests): it passed alone (25 of 25), and the whole api suite then passed without coverage and with it (434 of 434). It had failed in two runs with coverage, both of which also logged a Redis connection timeout (`ETIMEDOUT`); its cause is not pinned down.

## Found by verification and fixed

| # | Found | Effect | Fix |
|---|---|---|---|
| 1 | Saving the rules or pressing stop re-created the card's form (it is keyed by the rules' version), losing the message saying what happened (the app's unit test of the stop) | After a stop, "Stopping" or "Stopped" was never shown | The card keeps the message above the form; the unit test passes |

The tests needed these corrections; none is a product defect:
- Three test expectations in the decider's tests were wrong (each next trade risks 1 % of what is left, so it is smaller; a partly filled buy; a timestamp outside the live window), as was the balance-cap case (the size check comes before the balance check, as ADR 022 orders them).
- The broker's test lifted a pause by hand while the day's loss was still past the limit, so the next closed trade paused it again, which is right; the test now also raises the limit.
- The api answers `400` (not `422`) to rules out of bounds and reserved order keys; the test clock moves 100 ms per call; the audit-trail test now expects the four new actions.
- The end-to-end spec's row filter, above.
- Phase 14's end-to-end check of the page's banner expected one; the new card carries its own, as 16.9 asks. The check now takes the page's (the first), and checks the confirmation step's banner inside that step.
- The contracts test that counts the alert kinds now expects 16.
- An ingestor test from Phase 2 checked a large trade, and the events announcing it, as soon as the walls were stored, though the large trade is written after the walls (its own comment says so); it now waits for them. It had passed by timing until now.
- Some test titles named the wrong criteria; they now match the implementation plan.

## Tests and coverage

2,107 automated tests, all passing: 1,540 unit, 545 integration and 22 end to end (Phase 14: 2,034).

- `pnpm verify` passes on the final code (2026-11-15, 12:27–12:37 UTC): formatting, lint, typecheck, dependency rules, the no-trading check, unit tests with coverage gates, the build and the artefact scan.
- The integration suites of all seven packages that have them pass with coverage (12:37–13:24, as above; the ingestor after its test's fix, the api on its third run).
- Every end-to-end spec passed on the Phase 16 build (11:57–12:08, as above).

As before, the integration figures count only integration tests: each package's integration run also repeats its unit tests.

| Package | Tests (unit + integration) | What is new in Phase 16 | Coverage gate | Measured (lines / branches) |
|---|---|---|---|---|
| paper-engine | 52 (Phase 14: 34) | `AutoTrader`: every skip reason in order, the rounded levels, the size and the balance cap, refusals, cancelling when a setup ends, the stop, the day's result and the pause, restarting from its snapshot; property tests; journal replay with decisions | 90% | 99.6% / 91.3% |
| broker | 3 + 17 (3 + 11) | Placing, skipping and cancelling on setups from `an:events`, the stop within 5 s, the daily loss pause, a write that failed then went through, a restart with open automatic trades, two users at once, journal replay with decisions | 70% | 96.2% / 78.4% |
| db | 2 + 39 (2 + 33) | Migration 0013: who may write strategies, decisions and days; the policies on automatic orders; the journal's decisions and the broker's place in `an:events` | 70% | 99.1% / 85.7% |
| api | 19 + 415 (19 + 386) | The `/practice/automatic` routes: defaults, saving against a version, switching on with the confirmed rules, off, the stop and its `202`, the decision log's pages and its owner, today's figures, the reserved order keys, the channel; six routes in the RBAC matrix | 70% | 90.2% / 74.6% |
| analyzer | 5 + 25 (5 + 24) | The two automatic alert kinds from `practice:events` | 70% | 90.7% / 76.1% |
| contracts | 75 (72) | The automatic trading schemas and messages, the reserved order keys, the sixteen alert kinds | 90% | 100% / 100% |
| alerts | 29 (27) | The two automatic kinds, the owner-only match | 90% | 98.7% / 94.3% |
| app | 164 (159) | The card: the switch's confirmation, the rules' checks, the `409` reload, the stop and its `202`, today's figures, the pause, the decision log's pages, the channel; the "Automatic" label | none yet | 79.2% / 68.1% |
| ingestor | 6 + 14 (6 + 14) | None; one Phase 2 test now waits for what it checks | 70% | 92.3% / 80.7% |
| jobs | 19 + 31 (19 + 31) | None | 70% | 97.6% / 88.1% |
| observability | 11 + 4 (11 + 4) | None | 70% | 85.5% / 72.1% |
| End to end | 22 (19) | `phase16.spec.ts`: 16.1, 16.3, 16.5, 16.7 and 16.9 on the live stack | | |

The other packages (domain, indicators, market-data, exchange-adapters, smc-engine, ui) are unchanged, with the same tests as in Phase 14.

## Not covered, and limits

- **An intermittent api test**: Phase 14's positions test failed in two of four full api runs with coverage, each time beside a Redis connection timeout in the same run; it passed alone and in the other two runs. Neither the test nor the positions code changed in Phase 16; the cause is not pinned down.

- **Synthetic setups end to end** (above): the analysis's own confirmed setups reach the broker the same way, but none was waited for.
- **A setup that never ends**: if the analysis stops following a setup without resolving it (for example a new ruleset starting a new run), its automatic buy keeps working until the user cancels it or presses stop.
- **The desktop app** was not rebuilt for this phase; the card is in `packages/app`, so the desktop build gets it with the next build.
- **Committed, not pushed**: Phase 16 is on the branch `phase-16/automatic-practice-trading`, after Phase 14's commit.
