# Phase 7 · Charts, Setup Scanner and calendar: acceptance report

| | |
|---|---|
| Status | **Accepted 2026-11-12** (you asked to start Phase 8), with these items carried forward: the FRED API key on the computer that runs the stack (7.3, accepted in part); the review of rulebook note I38 (and I1–I37); recorded fixtures reviewed by a second person; a 7-day run of purely live time; the 1m warm-up for old ambiguous candles and whether MAE stops at the deciding minute (Phase 6); and the Phase 2–5 items. Not committed yet |
| Date | 2026-11-12 |
| Scope | [Implementation plan, Phase 7](../phase-0/08-implementation-plan.md#phase-7--charts-setup-scanner-and-calendar) |
| Evidence | This machine (Windows 11, Docker Desktop, Node.js 26.13.0); the local Compose stack streaming live public data from Binance and Coinbase; nine live runs (ruleset `indicators-1+smc-0.3.1`, profiles version 4), live from 06:07 UTC; the calendar from BEA's published schedule and two FOMC entries (no FRED key yet); checks to 06:58 UTC |

## Summary

Phase 7 puts the analysis on screen and brings the economic calendar into the checklist. Everything shown is hypothetical analysis: nothing places an order, and every setup carries "Educational analysis — not financial advice".

- **Charts** ([ADR 018](../adr/018-charts-on-lightweight-charts.md)): TradingView Lightweight Charts 5.2.1, the library the feasibility study chose.
  - One drawing primitive of ours draws the whole SMC overlay. After every paint it records exactly what it drew: the test hook of criterion 7.1.
  - Under every chart: the library's NOTICE text and a link to tradingview.com.
  - The chart pages load on demand, so the library is not in the initial bundle (its chunk is 62 KB gzipped; the initial bundle stays about 230 KB).
- **Liquidity Map** (`/liquidity`): one instrument on a structure timeframe (5m to 1d), its latest 300 closed candles, and on them:
  - swing points, BOS/CHOCH/MSS and ranges;
  - liquidity levels (equal highs and lows, session, previous-period, weekend, range and swing levels) with their status;
  - order blocks, FVGs and supply/demand zones with their fill;
  - sweeps, with thin-book wicks marked;
  - setups with their hypothetical levels;
  - on PAXG, the gold-market closures, shaded.

  Every layer can be turned off. A table under the chart lists every drawn item; it is the chart's text alternative.
- **Technical Analysis charts**: the Phase 3 SVG charts are now one chart on the same library. Candles with the EMAs and VWAP, volume with its anomalies, RSI and MACD share one time axis, with the run's warm-up shaded. Their text summaries stay as the caption.
- **Setup Scanner** (`/setups`): the setups of the live runs across instruments and timeframes.
  - Each row: state, score, hypothetical entry, invalidation and T1, R:R, quality flags. The disclaimer heads the page.
  - Filters (instrument, pattern, direction, state, minimum score) are sent to `GET /setups`. Sorting (latest change, score, R:R, instrument) applies to the loaded rows.
  - Each row opens its checklist, item by item.
- **Setup detail** (`/setups/{id}`): the levels; the **position-size calculator** (account size and risk %, 1 % by default, 0.5–1 % suggested; the Phase 6 calculator in exact decimals); the checklist at each state; the transitions with their evidence; the outcome; and the setup on its own chart.
- **Economic calendar** ([ADR 019](../adr/019-economic-calendar-as-known.md)):
  - migration 0010: `market.economic_events`, every version of an event in `economic_event_revisions` (append-only, written only by a trigger), and `calendar_syncs`;
  - the jobs service syncs BEA's schedule (GDP and Personal Income and Outlays, with their times) and FRED's release dates (CPI, Employment Situation, GDP, PCE, at the standard 08:30 New York time) every 6 hours and at start-up. A BEA entry supersedes FRED's for the same release and day;
  - admins enter FOMC statements, and other releases no source publishes, on the calendar page. Entries are audited; removing one cancels it;
  - `GET /calendar/events`, `GET /calendar/status`, the admin endpoints, `POST /calendar/sync`, the `calendar` channel, and the calendar in System Health;
  - the **Economic Calendar page** (`/calendar`), and **upcoming US events** in the Command Center's gold panel. Each high-impact event shows its blackout window per profile.
- **Checklist item 8** now reads the calendar **as the platform knew it at the decision** ([rulebook I38](../phase-0/07-smc-rulebook.md#the-economic-calendar-as-known-ruleset-031), ruleset 0.3.1).
  - Each version of an event counts from the second whole minute after it was recorded.
  - The calendar is unavailable before the first complete FRED sync.
  - Live runs and replays therefore decide the item the same way, however the calendar has changed since.
  - 24 new fixtures show the blackout window changing the item (310 in all).

Verification found nine defects, all fixed and listed [below](#found-by-verification-and-fixed). Two were found only by the end-to-end tests in a real browser: a colour contrast failure, and a chart crash when the instrument or timeframe changes.

## Acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 7.1 | Overlay parity: what the chart draws matches the overlay API 100 %, checked through a test hook | **Met** | [7.1](#71-overlay-parity) |
| 7.2 | The scanner filters and sorts correctly; each setup shows its checklist, score, levels, R:R and the disclaimer | **Met** | [7.2](#72-setup-scanner) |
| 7.3 | The next 60 days of CPI, Employment Situation, GDP, PCE and FOMC are present with times; the sync is idempotent; fixtures show the blackout window changing item 8 | **Met in part, accepted by you on 2026-11-12**: GDP, PCE and FOMC are present with times, the sync is idempotent, and the fixtures pass. CPI and the Employment Situation need a FRED API key on the computer that runs the stack; it is carried forward | [7.3](#73-calendar) |
| 7.4 | No "XAUUSD" label in the UI; closures shaded on PAXG charts | **Met** | [7.4](#74-no-xauusd-label-closures-shaded) |
| 7.5 | axe finds no serious violations on the new pages, and keyboard navigation works | **Met** | [7.5](#75-accessibility) |

### 7.1 Overlay parity

- **How**: after every paint, the chart records each item it actually drew (`data-drawn`), with the window it shows (`data-from`, `data-to`).
  - The end-to-end test asks `GET /smc/{id}/overlay` for that window and builds the expected records from the API's JSON on its own, without the app's code.
  - It requires the two to be equal. A detection can land between the two reads, so it polls until both sides have it.
- **Live**, on BTC · Binance BTC/USDT, every item equal to the API's:
  - 1h: 641 items (288 levels, 18 structure breaks, 133 sweeps, 123 swings, 79 zones);
  - then 5m, chosen on the page: 680 items (238 levels, 1 range, 31 setups, 40 structure breaks, 85 sweeps, 125 swings, 160 zones);
  - the PAXG closures are checked under [7.4](#74-no-xauusd-label-closures-shaded).
- **Unit** (`overlay-items.test.ts`): one item per detection, clamping to the window, the labels, and the time index across gaps.

### 7.2 Setup Scanner

- **End to end**, against the live stack's 36 open setups:
  - the page lists exactly the open setups the API returns;
  - sorted by score, the scores never increase;
  - filtered by a pattern (4 of Pattern 1), the list equals the API's list for that filter, and the URL keeps the filter;
  - a row's checklist shows its 8 items with the disclaimer, and the row shows its R:R.
- **Unit** (`setup-scanner.test.tsx`, `setups.test.ts`): the default view (open states), the filters sent to the API, the three sorts, the checklist panel, and reloading on `setup.transition`.
- **Setup detail** (`setup-detail.test.tsx`): the levels; the calculator for 10,000 USDT at 1 % (100 USDT at risk, 23.36448 BTC rounded down to the step, notional 2,294.391936, leverage 0.2294×, R:R 1 : 0.514); a 0 % risk refused; the checklist with its evidence; the outcome.

### 7.3 Calendar

**The next 60 days on the live stack** (12 November 2026 to 11 January 2027), from `GET /calendar/events`:

| Release | Source | When (UTC) | New York | Time |
|---|---|---|---|---|
| GDP (Second Estimate), 3rd Quarter 2026 | BEA | 2026-11-25 13:30 | Wed 25 Nov, 08:30 | confirmed |
| Personal Income and Outlays, October 2026 (PCE) | BEA | 2026-11-25 13:30 | Wed 25 Nov, 08:30 | confirmed |
| FOMC statement | Admin entry | 2026-12-09 19:00 | Wed 9 Dec, 14:00 | confirmed |
| GDP (Third Estimate), 3rd Quarter 2026 | BEA | 2026-12-23 13:30 | Wed 23 Dec, 08:30 | confirmed |
| Personal Income and Outlays, November 2026 (PCE) | BEA | 2026-12-23 13:30 | Wed 23 Dec, 08:30 | confirmed |
| Employment Situation | FRED | — | — | **missing: no FRED key** |
| CPI | FRED | — | — | **missing: no FRED key** |

- **What is missing**: CPI and the Employment Situation come only from FRED, because BLS blocks automated access (feasibility §6.1). FRED needs a free API key, which only you can create.
  - Without it, the calendar stays **unavailable**, and item 8 fails with `calendar_unavailable` (fail safe, I38). It does not pass at the two highest-impact releases.
  - System Health shows the calendar as down: "FRED: no API key configured".
  - With a key, the next sync adds the Employment Situation on 4 December and CPI on 10 December 2026 (both 08:30 New York, checked against BLS's published schedule), and those after them.
- **The FRED path is tested without a key**:
  - unit tests parse FRED's responses, add the standard 08:30 New York time (EST and EDT), and keep the key out of every error;
  - the jobs integration test syncs FRED and BEA together into a database. GDP and PCE from FRED are superseded by BEA's entries; CPI and the Employment Situation stay scheduled; a second run changes nothing; a failed FRED request leaves its events untouched.
- **Idempotent**:
  - live, the first sync (06:03:30) inserted BEA's 28 entries, and the scheduler's run straight after it changed nothing (28 unchanged, no new revision).
  - The integration test runs every sync twice, and checks that events are never deleted and revisions never change.
- **Fixtures**: 24 news-window cases (12 and their mirror images) in `fixtures/checklist/`:
  - the bounds: 30 minutes before or after a release fails, 31 passes;
  - medium impact, or another currency, passes;
  - a release known only after the decision passes;
  - a release rescheduled into, or away from, the window;
  - the calendar available only after the decision;
  - the gold window (60 minutes) against the crypto one (30 minutes).
- **Blackouts on screen**: the end-to-end test adds an FOMC entry 20 days ahead as the admin. It appears with a blackout window for each profile (crypto ±30 minutes, gold ±60 minutes), and is then removed. Before that, the page lists exactly the events the API returns for its window: 5 on this stack.

### 7.4 No "XAUUSD" label; closures shaded

- **No label**: the end-to-end test scans 10 pages, including PAXG's Liquidity Map and Technical Analysis. It checks the text, and the `title`, `aria-label`, `alt`, `placeholder` and `value` attributes. "XAUUSD" appears only inside the PAXG disclaimer (`[data-paxg-disclaimer]`), which explains how PAXG differs from it.
- **Closures**: on PAXG's Liquidity Map (1h), every gold-market closure in the window is shaded, as many as the overlay API returns: 8 closures.

### 7.5 Accessibility

- **axe** (WCAG 2.0, 2.1 and 2.2, A and AA) on the Liquidity Map, the Setup Scanner, a setup's page and the Economic Calendar: no serious or critical violation.
- **Keyboard**:
  - Tab reaches the layer toggles, and Space switches one;
  - Tab reaches the scanner's sort, and the arrow keys change it;
  - Enter opens a row's checklist;
  - Tab reaches the calculator's risk field and the calendar's filters.
- The chart canvas takes no focus. Each chart has a text alternative: its caption and the table of drawn items.
- The end-to-end runs found small text below the required contrast (defect 7 below); it is fixed on every page, the older ones included.

## Live

On the local stack (2026-11-12):

- **Deploy**, 06:01 to 06:07 UTC:
  - migration 0010 was applied at 06:03:20;
  - the analyzer superseded the nine Phase 6 runs ("profile or rules change", ruleset 0.3.1) and warmed up new ones, in 14 to 62 s each;
  - every service was healthy at 06:07:33.
  - During the serial warm-up, Docker reported the analyzer unhealthy for about two minutes, because its ops server starts after the first pass. This is the first start's serial warm-up, carried forward since Phase 5.
- **Calendar**:
  - first sync at 06:03:30: BEA, 28 entries inserted (GDP and Personal Income and Outlays through 2027); FRED skipped (no key);
  - the scheduler's run straight after changed nothing;
  - the FOMC statements of 9 December 2026 and 27 January 2027 were entered as the seeded admin, at 14:00 New York (the Federal Reserve's statements are "for release at 2:00 p.m.").
- **The web app** was rebuilt with the fixes found end to end: at 06:18 UTC (with the API) for the attribution's contrast, at 06:42 for the chart crash (defect 8), and at 06:52 for the table headers' contrast.
- **End to end**: Playwright passed 10 of 10 on the final code, 06:56 to 06:58 UTC: the five Phase 7 tests and the five earlier ones.

## Found by verification and fixed

| # | Found | Effect | Fix |
|---|---|---|---|
| 1 | The sync wrote FRED's GDP and PCE dates as scheduled, and only then did the reconciliation supersede them (jobs integration test) | When a sync straddled a minute boundary, the engine could, for a minute, have seen a FRED version of a release that BEA lists with its own time | BEA syncs first. FRED dates that BEA covers are written as superseded from the start. A version replaced within its own minute is dropped |
| 2 | Sweep markers sat on the breach candle (found while writing the parity test) | A sweep whose breach candle precedes the window, but whose confirming candle is inside it (how the API windows sweeps), could not be drawn | Markers on the confirming candle |
| 3 | The price scale followed the candles only | Levels and zones far from the candles were "drawn" off screen | The overlay widens the auto-scaled range |
| 4 | `SystemHealth.calendar` was required (contracts test) | A server from before Phase 7 would not parse | Optional; the System Health page reads it with `?.` |
| 5 | The engine's property test passed in 60 s alone, but exceeded 120 s beside every other suite (verify) | `pnpm verify` could fail on a busy machine | Its timeout is now 240 s; the test is unchanged |
| 6 | The calendar contracts were below the 90 % branch gate (verify) | Verify failed | `calendar.test.ts` (100 %) |
| 7 | axe: small text in `text-fg-subtle` (#6b7486) failed colour contrast. The first run found it in the attribution line under the charts; a later run, in the shared table headers on the Setup Scanner. The same colour was used for small text on the older admin, profile and System Health pages, and for input placeholders (end to end) | Serious (WCAG 1.4.3): 3.3:1 to 3.9:1 on the panels, where small text needs 4.5:1 | That text, the table headers and the placeholders now use `text-fg-muted` (#9aa4b5, 6.2:1 to 7.3:1). `fg-subtle` is left for the charts' warm-up shading |
| 8 | Choosing another instrument or timeframe on the Technical Analysis page showed the error screen, "Something went wrong!" (end to end, the Phase 3 test) | While the new data loads, a spinner replaces the chart. On unmount, React detaches the chart's ref (which removes the chart) before it runs the effect cleanups, so removing the series from the removed chart threw. The Liquidity Map had the same code | `useChart` records the charts it removes, and the series cleanups skip a removed chart. A unit test covers the order (it fails without the fix), and 7.1 now switches the Liquidity Map's timeframe in the page |
| 9 | The database package's integration run fell below its 70 % branch gate (56.5 %; integration coverage) | `calendar.ts` was exercised only by the jobs and analyzer suites, and each package's gate counts only its own tests | `calendar.int.test.ts` in the database package: availability from the first complete FRED sync, each version's period, a cancellation ending the version before it, the same-minute rule, and the append-only history (now 98.7 % / 87.0 %) |

## Tests and coverage

1,801 automated tests, all passing: 1,421 unit, 370 integration and 10 end to end.

- `pnpm verify` passes on the final code: formatting, lint, typecheck, dependency rules, the no-trading check, unit tests with coverage gates, the build and the artefact scan.
- The integration suites of all six packages that have them pass with coverage: five in the full run, and the database suite in a rerun after defect 9 was fixed.
- Playwright passes 10 of 10 against the live Phase 7 stack. The Phase 7 tests sign the viewer in once for the file, because sign-in is limited to five a minute per address and per account.

Each package's integration run also repeats its unit tests, because that run is the package's coverage gate. The integration figures below count only the integration tests. The Phase 6 report added the runs' totals instead, so it counted 51 unit tests twice: its 1,687 tests should have read 1,636 (328 integration). The Phase 6 figures in brackets below are the corrected ones.

| Package | Tests (unit + integration) | What is new in Phase 7 | Coverage gate | Measured (lines / branches) |
|---|---|---|---|---|
| smc-engine | 982 (Phase 6: 906) | 24 news-window fixtures, each with 3 checks; `calendarAt` | 90% | 99.0% / 96.2% |
| contracts | 60 (55) | The calendar schemas, the `calendar` channel, `SystemHealth.calendar` | 90% | 100% / 100% |
| jobs | 19 + 28 (8 + 23) | BEA parsing on the recorded feed; FRED parsing, with the key kept out of errors; the sync plan; the sync against a database (idempotent, superseding, versions, failures, append-only) | 70% | 97.5% / 87.8% |
| db | 2 + 25 (2 + 20) | Migration 0010: the calendar as the engine reads it (availability, each version's period, the same-minute rule) and the append-only history (defect 9) | 70% | 98.7% / 87.0% |
| analyzer | 5 + 18 (5 + 16) | The calendar as the engine reads it in a live run: versions by when they were known; unavailable before FRED | 70% | 91.0% / 80.7% |
| api | 19 + 281 (19 + 251) | The calendar endpoints, their audit and revisions, the channel, the new routes in the RBAC matrix | 70% | 92.5% / 76.3% |
| app | 144 (118) | Overlay items and the time index, scanner order and search, the four new pages, the calendar in System Health and the Command Center; the chart's removal order (defect 8) | none yet | 79.2% / 70.0% |
| domain, indicators, market-data, exchange-adapters, observability, ingestor, ui | 31, 73, 40, 25, 11 + 4, 6 + 14, 4 | Unchanged (the table headers' colour, defect 7, in ui) | as before | as before |
| End to end | 10 (5) | 7.1–7.5; 7.1 also switches the timeframe in the page and checks the overlay again | — | — |

The app's coverage fell from 86.6 % / 76.3 %. The new canvas code (the overlay primitive's drawing and the indicator chart) runs only in a browser, and jsdom cannot run the chart library. That code is checked end to end: 7.1 compares what it drew with the API.

## Decisions made during Phase 7

| Decision | Why | Recorded in |
|---|---|---|
| Item 8 reads the calendar as known at the decision; ruleset 0.3.1 (I38) | Rulebook §1: the context holds only what is known at a candle's close. Without this, a calendar change after the fact would make replays differ from the live run | [Rulebook §14, I38](../phase-0/07-smc-rulebook.md#the-economic-calendar-as-known-ruleset-031), [ADR 019](../adr/019-economic-calendar-as-known.md) |
| The calendar becomes available at the first complete FRED sync, not BEA's | Only FRED gives CPI and the Employment Situation (BLS blocks automated access, feasibility §6.1). Available without them, item 8 would pass at the two highest-impact releases | ADR 019 |
| Impact levels: CPI, Employment Situation and FOMC high; GDP and Personal Income and Outlays medium | Feasibility §6.1 names the first three as high. The platform assigns impact, and only high-impact events open a blackout | `apps/jobs/src/calendar-sync.ts` (`RELEASES`); for your review below |
| BEA's iCalendar feed, not its JSON | Same dates and times. The feed has the release titles (advance, second, third estimate) and a UID that stays when a release is rescheduled; the JSON lagged the feed by one release on 12 November | ADR 019 |
| FRED's GDP and PCE dates are kept as a fallback, superseded by BEA's on the same day | If BEA's feed is unavailable, those releases still appear (at the standard time, unconfirmed) | ADR 019 |
| FOMC statements are entries an admin makes, at 2:00 p.m. New York | The Fed publishes no machine-readable calendar (feasibility §6.1); its statements say "For release at 2:00 p.m." | Calendar page; API contracts note |
| Synced entries cannot be edited; removing an admin's entry cancels it | Synced entries follow their source; rows are kept for the engine's history | API contracts note |
| The `calendar` channel is not durable | A change only means "reload"; the latest change is its own snapshot | API contracts §5.3 note |
| The calendar shows in System Health, but does not change the overall status | A missing FRED key would otherwise keep a healthy stack "degraded"; item 8 already fails safe | API contracts note |
| The library's logo is off; the attribution line under every chart has the NOTICE text and the link | The logo is a link inside the canvas, which the desktop app could not open through its host | ADR 018 |
| Sweeps are drawn on their confirming candle | The overlay API windows sweeps by that candle; a breach just before the window could not be drawn otherwise | ADR 018 |
| The overlay widens the chart's price scale | Everything drawn is on screen (and the parity check counts only what is) | ADR 018 |
| The Technical Analysis SVG charts were replaced by the library | One chart system, interactive, as the architecture planned; the text summaries were kept | ADR 018 |
| AI commentary is not shown in the Setup Scanner | It arrives with Phase 9 (AI intelligence) | — |

## Carried forward

| Item | Plan |
|---|---|
| A FRED API key on the computer that runs the stack: CPI and Employment Situation dates, and the calendar's availability (7.3, accepted in part) | Yours to add; then I re-check 7.3. See below |
| Review of rulebook §14 notes I1–I38 | Yours to decide |
| Recorded fixtures reviewed by a second person (§12) | Needs two people; the labelling page is ready |
| A 7-day run of purely live time (4.3, 5.3, 6.7) | Once a stack has run for 7 days |
| The 1m warm-up for old ambiguous candles; whether MAE stops at the deciding minute | Your choices, from Phase 6 |
| From Phases 2–5: the trend rule and volume threshold; decisions 1 and 2; D2 hosting | Unchanged |

## What I need from you

1. **The FRED API key**, when you are at the computer that runs the stack: save it, alone on one line, in `.secrets/fred-api-key` there, as the README describes. Please don't paste it in the chat. The jobs service reads the file at every sync, so an admin's **Sync now** on the calendar page (or `POST /calendar/sync`) then brings in CPI and the Employment Situation, and I can re-check 7.3.
2. **Review the impact levels** (CPI, Employment Situation and FOMC high; GDP and PCE medium) and **note I38**, along with I1–I37 ([rulebook §14](../phase-0/07-smc-rulebook.md#14-implementation-notes-ruleset-010)).
3. **Recorded fixtures (§12)**: label some with a colleague using `/dev/labelling`, or accept the synthetic fixtures for now.
4. **Still open**: the 1m warm-up for old ambiguous candles; the Phase 3 trend rule and volume threshold; Phase 2 decisions 1 and 2; D2 hosting.
5. Your approval of this report, and whether to commit Phase 7 (and push it).
