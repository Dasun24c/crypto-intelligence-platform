# Phase 12 · Historical analytics and replay UI: acceptance report

| | |
|---|---|
| Status | **Accepted 2026-11-22** (you answered "Accept Phase 12"). The three criteria are met on this machine: the statistics the page shows equal the API's, and the API's equal direct database queries, on seeded data with every awkward case and on the live stack (12.1); every label says "historical observations" and nothing presents the numbers as expected performance (12.2); a replay started from the page matched the live run's digest exactly, and one with changed settings listed the two settings and the 18 detections that differ (12.3). Committed on 2026-11-22 at your request, on the branch `phase-12/historical-analytics` (cut from `main` at `d3823eb`); not pushed |
| Date | 2026-11-22 |
| Scope | [Implementation plan, Phase 12](../phase-0/08-implementation-plan.md#phase-12--historical-analytics-and-replay-ui), REQUIREMENTS §3.9 (SMC-08), NFR-14, [rulebook §8](../phase-0/07-smc-rulebook.md#8-outcomes), [API contracts §3](../phase-0/06-api-contracts.md#setups-and-replays), [ADR 026](../adr/026-historical-analytics-and-replay-ui.md); your choices of 2026-11-22 (below) |
| Evidence | This machine (Dell Vostro 3500: Windows 11 Pro, Docker Desktop 4.99, Node.js 26.13); the local Compose stack streaming live public data from Binance and Coinbase (database fresh since 2026-11-21), redeployed with Phase 12 on 2026-11-21 at 19:27 UTC |

## Summary

**Historical Analytics** (`/history`, in the navigation for every role) has two tabs.

- **Outcome statistics**: how the setups the rules found have ended, grouped by any mix of pattern, variant, direction, timeframes, instrument, session and rules version, over the last 24 hours to everything stored, for one instrument or all. For each group: setups detected (and how many were found on stored history), confirmed, still open, resolved, and the resolved ones by outcome (target reached, invalidated, expired before entry, expired open, ambiguous, each with its share of the resolved), and the average maximum move for and against them after the entry (MFE and MAE, in R). A notice above the table says these are **historical observations**, not a forecast; a group with fewer than 20 resolved setups is marked "few observations". The numbers come straight from the stored setups, with nothing kept on the side.
- **Replays**: analysts and admins start a replay of a stored period (at most 31 days) for any instrument, and can change some settings for that one replay: which patterns count, the minimum reward-to-risk, the mandatory checklist items, whether a market structure shift needs displacement, the entry window, the longest hold, the news blackout, and whether low liquidity blocks confirmation. The live analysis never changes. Every role sees the list of replays and each replay's result: compared with the live run it started from (or any other run of the instrument), the page says whether the two decided exactly the same thing (equal digests), lists every setting that differs, counts the detections per type, and lists the setups that differ, as each run left them.
- **CSV downloads**: the statistics, the setups behind them (one line per setup, with its outcome), and a replay's comparison. Every download is recorded in the audit log.

Replays run in the analyzer, on the same code as the live analysis (ADR 017); they never publish detections, so no alert and no automatic practice trade follows one.

## Acceptance criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 12.1 | Displayed statistics reconcile with direct database queries (automated) | **Met** | On seeded rows covering every awkward case, the endpoint equals a direct query of the tables, for each of the seven dimensions alone and together, and equals totals worked out by hand. On the live stack, the page shows exactly the endpoint's numbers, and the endpoint equals a direct, read-only query of the stack's database for every dimension. [12.1](#121-the-statistics-are-the-databases) |
| 12.2 | Labels say "historical observations" and never imply expected performance | **Met** | The API's answer, the page's notice and subtitle, the table caption and the CSV file names carry it; tests fail on any word such as "win rate", "accuracy", "edge", "expected" or "predict" on the page, on both tabs; axe finds nothing serious. [12.2](#122-labelled-as-historical-observations) |
| 12.3 | A replay started from the UI matches the live digest for overlapping periods. When parameters differ, the differences are listed. | **Met** | On the live stack, a replay of Binance BTC/USDT, 21 Nov 13:20–19:20 UTC, started from the page: digest equal to the live run's (165 events, `a2de6307…`), and the analyzer's own command line gives the same digest for both. The same period with a minimum reward-to-risk of 3 and without pattern 4: both settings listed with their two values, and 18 detections that differ (15 only in the live run, 3 changed), in 10 setups. [12.3](#123-replays-from-the-page) |

### 12.1 The statistics are the database's

**Definitions** (ADR 026). A setup counts in the period if it **started forming** in it (decision times, as for digests). The statistics read every live run; a setup two live runs found under the same rules version counts once, from the newer run. "Found on stored history" means decided at or before its run went live. The **session** is the profile's (whole UTC hours: Asia 00–07, London 07–13, New York 13–21) holding the candle the setup started forming on; anything else is "outside the sessions". A setup is **confirmed** when it has an outcome (only confirmed setups get one) or is confirmed or entry-active now; the averages of MFE and MAE are over resolved setups whose entry was touched.

- **The api, on seeded rows** (`apps/api/test/history.int.test.ts`): three live runs and two replays on two Coinbase pairs in March 2025: two live runs of one pair under the same rules overlapping (one setup in both, with different states, so the test sees which copy counts), a third under other rules, setups found on history and live, setups in each session and outside them, one exactly at the start of the period and one after its end (neither counted), and every kind of outcome, with and without an entry. The test reads the stored rows with a plain query and works out the statistics in its own code (which runs, found when, the overlap, the session, the counts), then compares them with the endpoint **for each of the seven dimensions, for pattern and session together, and for all seven together**. Separately it checks the totals against numbers worked out by hand (10 setups, 4 found on history, 8 confirmed, 2 open, 6 resolved: 2 target reached, 1 each of the other outcomes; MFE 1.58 R, MAE 0.68 R; Asia 2, London 3, New York 4, outside 1), the three `found` choices (the live-only view counts the older run's copy, found live), one instrument, one replay's own setups, and the rules versions (8 and 2).
- **The page** (`pages/historical-analytics.test.tsx`): it shows the endpoint's rows and totals, with their numbers in the cells and in `data-*` attributes; grouping, period and filters change the request.
- **End to end on the live stack** (`e2e/tests/phase12.spec.ts`, 2026-11-21): the page asks for the last 30 days grouped by pattern; it shows one row per group with the endpoint's numbers and totals. Then, for each of the seven dimensions, the endpoint over the same period is compared with a direct query of the stack's database through `docker compose exec db psql` (read-only), written apart from the API's (the newer run found with `NOT EXISTS` rather than `DISTINCT ON`, the session from the hour), after checking that both profiles in use keep the default session hours. Live data can move between the two reads (a setup resolving), so a mismatch is read again, up to four times. At 19:30 UTC the period held **2,141 setups** on the nine pairs (2,079 found while the live runs warmed up on stored history from 11 November, 62 found live since 21 November 14:41): 1,648 pattern 4, 337 pattern 3, 125 pattern 1 and 31 pattern 2; 20 confirmed and resolved (5 invalidated, 15 expired before entry; none has reached its target yet).

### 12.2 Labelled as historical observations

- The API answers with `label: "Historical observations"` and the notice *"Historical observations: how past setups found by these rules ended. They describe the past only and are not a forecast or a measure of future results."* The contracts accept no other label.
- The page shows the notice above the table, says "Historical observations of how past setups ended" under its title, and names its table "Historical observations: setups by …". Shares appear only as a part **of the resolved setups**, beside the count, under the outcome's own name; there is no "win rate", ranking or score of a pattern.
- The CSV files are called `setup-statistics-historical-observations-<date>.csv` and `setups-historical-observations-<date>.csv`.
- **Tests**: the page test and the end-to-end test fail if the page contains "win rate", "success rate", "hit rate", "accura…", "profitab…", "expected", "expectancy", "probabilit…", "chance of", "edge", "guarantee", "predict" or "will reach/hit/win/work", on the statistics tab and on the replays tab, with a replay's comparison open. axe (WCAG 2.0 and 2.1, A and AA) finds nothing serious or critical on either tab. The end-to-end test also downloads the statistics CSV and finds the download in the audit log.

### 12.3 Replays from the page

**On the live stack** (`e2e/tests/phase12.spec.ts`, signed in as the test analyst):

| Replay | Settings | Digest over 13:20–19:20 UTC, 21 Nov | Events | Compared with the live run |
|---|---|---|---|---|
| Live run (`01a1fe8e-3230…`) | its profile, crypto-majors v4 | `a2de63073fbfce21…` | 165 | |
| `01a1ff96-82ad…` (7 s) | unchanged | `a2de63073fbfce21…` | 165 | **Matches**: equal digests; no setting and no detection differs |
| `01a1ff96-ab14…` (5 s) | minimum reward-to-risk 3; patterns 1–3 (without pattern 4) | `30a0e416559f5bd4…` | 150 | **Settings differ**: the two settings, with their values (2 → 3; P1, P2, P3, P4 → P1, P2, P3); 15 detections only in the live run (its 15 pattern 4 transitions), 3 with different contents (transitions of 2 pattern 3 setups, whose checklist now records the higher minimum; their score is unchanged); 10 setups differ (8 of pattern 4, 2 of pattern 3) |

- The page started both replays (the form starts from the instrument's own settings and sends only what was changed), followed each until it completed, and showed the comparison: "Matches the live run" with both digests, and for the second "Settings differ from the live run", the settings table and the differing detections. The API's comparison says the same.
- **Independently of the API**, the analyzer's command line (`cip-analyzer digest`) gives `a2de63073fbfce21…` with 165 events for both the live run and the unchanged replay, and `30a0e416…` with 150 for the changed one.
- The period starts before the live run went live (14:41 UTC): the replay reproduced what the live run computed while warming up on stored history and what it computed live (ADR 017).
- The comparison's CSV holds the settings (`setting,smc.setups.checklist.minRR,2,3`).

**The api** (`apps/api/test/history.int.test.ts`): a replay that changes settings is queued with them and audited; settings that change nothing, are out of range, repeat a pattern or name an unknown setting are refused; the base settings come from the instrument's profile; a replay compared with its live run lists the changed setting and exactly the differing events (one only in each run, one changed, and two setups, as each run left them), and repeats of one event on one candle are matched in order; an unchanged replay matches; any other run of the instrument can be compared, not a run of another instrument or the replay itself; a different rules version and profile are listed before the settings.

**The analyzer** (`apps/analyzer/test/smc.int.test.ts`): a replay that drops the pattern the live run found most often and raises the minimum reward-to-risk keeps both settings and the whole settings it ran with, its params hash is computed as the profiles' are, it finds no setup of the dropped pattern, and its digest differs from the live run's; the unchanged replays still reproduce the live digest (criterion 4.3).

## Your decisions

Asked on 2026-11-22:

1. **"Yes, per replay"**: a replay started from the page may change some settings for itself. The comparison with the live run then lists each changed setting and the detections that differ. The settings that can change are the eight above; everything else stays the live run's.
2. **"Count both, with a filter"**: the statistics count setups the live analysis found on stored history while warming up, as well as those found live; a filter shows either alone. On this fresh database almost all setups are of the first kind, and they were computed by the same code.

## Decisions made while building it

Recorded in [ADR 026](../adr/026-historical-analytics-and-replay-ui.md). The ones you may want to know about:

1. **No statistics table**: the endpoint reads the stored setups every time, so 12.1 checks the facts, not a copy.
2. **A setup counts once**, from the newer of two live runs under the same rules.
3. **The session is the one a setup started forming in**, so every column of a row describes the same setups.
4. **Changed settings live on the replay run, not in a new profile**: profiles stay shared and immutable, and admins have no profile editor yet. The Phase 0 idea of choosing a profile version (`profileVersion`) had nothing to choose from.
5. **Runs are compared by natural key**, not only by digest, so the page can say what differs and why, even for runs that started at different candles.
6. **Exports are made on the server and audited**, as the architecture asks of exports.

## Live

On the local stack (2026-11-21, UTC):

- **19:13–19:25**, before this phase was deployed and not from this session: the rules of your analyst's automatic practice trading were changed in its browser session, and at **19:24:34 it was stopped** there (audit log), so that the Phase 16 spec could run (according to the other session's notes); that session ran it at 19:25.
- **19:27**: the stack rebuilt with Phase 12 (`docker compose up --build --wait`, 49 s): migration `0016_replay_settings` applied at 19:27:35; all 8 services healthy. Your analyst's automatic practice trading was off (since 19:24:34, above); this session never signs in as your accounts and did not switch it on or off.
- **19:29**: the Phase 12 spec: 12.1 passed; 12.2 failed on the test's own audit check (finding 3); **19:30**, rerun: **3 of 3**.
- **19:31**: every end-to-end spec started. At 19:31:49 another session started a demonstration of automatic practice trading on the test analyst (the bot bought at 19:32:06). I stopped my run when I saw the overlap, but it had just reached the Phase 16 spec: at **19:33:23 it reset the test analyst's Binance practice account (cancelling the bot's open orders) and switched its automatic trading off**, which spoiled the end of that demonstration (its later sale was refused for lack of balance). Your own accounts were not involved.
- **19:37**: the demonstration ended; the web container rebuilt with the final page code (`docker compose up -d --build --no-deps --wait web`; no other service restarted).
- **19:37–19:48**: every end-to-end spec, all phases: **35 passed, 2 skipped** (the frame-rate measurements, which run only when asked for), Phase 11's 11.1 failed on the test's own read of the walls (finding 4) and its 11.3, which runs after it, did not run. Phase 16's five tests ran, because your analyst's automatic trading was off; they passed, signed in as the test analyst, and left its automatic trading off.
- **19:48**: the Phase 11 spec with the test fixed: **2 of 2**. So every spec passes: 37 tests, and 2 skipped by design.
- **19:48–19:59**: another demonstration, from the other session, on the test admin's own practice account; the remaining checks (below) waited for its first run, since they load the machine and start their own containers.

## Found by verification and fixed

| # | Found | Effect | Fix |
|---|---|---|---|
| 1 | The replay form's number fields could not be cleared: a cleared field went back to its old value, and typing then added to it (found by the page test) | Changing the minimum reward-to-risk from 2 to 3 typed "23" | Each number field keeps what is typed and reports only values that parse |
| 2 | A replay with changed settings that happened to change no detection would have said "Matches the live run" (found while writing the end-to-end test) | A what-if replay could look like a plain one | Changed settings are always stated first ("Settings differ from the live run"), with whether the detections differed |
| 3 | The end-to-end helper `userIdOf` read `id` from `GET /me`, which answers `{ user: { id } }`: it always returned nothing (found by the Phase 12 spec's audit check) | The Phase 16 spec could not tell its own account's switch from another account's, so a run interrupted with the test analyst's automatic trading on would make it skip later | It reads `user.id`, and fails if there is none |
| 4 | The Phase 11 end-to-end test counted a pair's walls with one call to Market Activity's walls endpoint, which lists the newest 1,000 of a window. With a day and a half of data, Coinbase BTC/USD had 1,341 walls in 24 hours, and the test failed (found by the full end-to-end run; it passed on 2026-11-21 with less data) | A false failure in the Phase 11 spec once a pair is busy; the Whale Tracker's own count (1,341) was right | The test counts a full answer again in two halves, until each part holds fewer than 1,000 |

My new tests needed two corrections, neither a product defect: the page test first matched two cells with the same text, and the history integration test's run ids overlapped the analysis suite's in the shared test database (the full integration run caught it; they now use a range of their own).

## Tests and coverage

2,442 automated tests: 1,712 unit, 691 integration and 39 end to end (Phase 11: 2,360). All pass, except the 2 end-to-end frame-rate measurements, which run only when asked for. Phase 12 added 82 of them: 39 unit, 40 integration and 3 end to end.

- `pnpm verify` passes on the final code (2026-11-21, 20:06–20:10 UTC): formatting, lint, typecheck, dependency rules (570 modules), the no-trading check (896 files), unit tests with coverage gates, the build (web and desktop bundles), and the artefact scan of the web app (39 files, 58 rules, 51 of them server setting names).
- The integration suites of all seven packages that have them pass with coverage: analyzer, jobs, db, observability and ingestor at 19:56–20:03 UTC; the api's run then found my new test's run ids overlapping another suite's (above), and the api and the broker passed at 20:04–20:06 with that fixed. 691 integration tests: api 519, db 50, jobs 59, ingestor 16, analyzer 26, broker 17, observability 4.
- Every end-to-end spec ran against the live stack (19:37–19:48 UTC, and the Phase 11 spec again at 19:48 with its test fixed): 37 passed, 2 skipped by design (the frame-rate measurements). The Phase 12 spec also passed on its own at 19:30.

As before, the integration figures count only integration tests: each package's integration run also repeats its unit tests.

| Package | Tests (unit + integration; Phase 11 in brackets) | What is new in Phase 12 | Coverage gate | Measured (lines / branches) |
|---|---|---|---|---|
| app | 219 (201) | The Historical Analytics page (6: the statistics as the API gives them, labelled; grouping, filters and the CSV; a refused download; a replay started with changed settings and its comparison; a matching replay and what a viewer may do; a failed replay); its helpers (11); downloads in the API client (1) | none yet | 82.1 % / 70.9 % (the page: 85.1 % / 66.8 %; its helpers: 100 % / 99.3 %) |
| api | 36 + 519 (27 + 481) | The CSV encoder (5) and the settings comparison (4); the statistics reconciled with the stored rows, replays with settings, comparisons and the exports (14); the access matrix's 6 new routes (24) | 70 % | 91.3 % / 78.1 % (`src/history`: 94.1 % / 84.0 %) |
| contracts | 103 (91) | The statistics, export and replay contracts, applying and reading replay settings (12) | 90 % | 100 % / 93.3 % |
| db | 2 + 50 (2 + 49) | Changed settings only on replays, always with what they ran with (1) | 70 % | 95.8 % / 80.6 % |
| analyzer | 5 + 26 (5 + 25) | A replay with changed settings (1) | 70 % | 90.8 % / 76.5 % |
| jobs, ingestor, broker, observability, ui | unchanged | None | | jobs 92.7 % / 80.4 %; ingestor 92.5 % / 81.1 %; broker 96.2 % / 78.4 %; observability 88.3 % / 73.0 % |
| End to end | 39 (36) | `phase12.spec.ts` (3: 12.1, 12.2 and 12.3 on the stack); fixes to `phase11.spec.ts` and the `userIdOf` helper (findings 3 and 4) | | |

## Not covered, and limits

- **12.3 runs only against the live stack**: CI's replay stack starts with no stored history, so a replay of a past period has nothing to read there; 12.1 and 12.2 run on both stacks.
- **Replays are kept**: each adds its rows (indicator values, events, projections) from the live run's first candles to its end; there is no deletion yet.
- **The desktop app** saves downloads through its webview; on Windows (WebView2) that is the same download as in a browser. The macOS WKWebView is not verified, as for Phase 10, and the desktop app was not rebuilt.
- **Outcomes are of hypothetical levels** (rulebook §8), not trades: no fees, no fills. On this database, five setups have reached an entry so far, so the averages say little; the page marks such groups.
- **Committed, not pushed**: on `phase-12/historical-analytics`, cut from `main` at `d3823eb` (Phase 11 merged through pull request #13).
