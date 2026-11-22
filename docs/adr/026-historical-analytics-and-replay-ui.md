# ADR 026: Outcome statistics are read straight from the setup projections and labelled as historical observations; a replay may change a curated set of settings, kept on its own run; runs are compared by digest, settings and natural keys; CSV exports are generated on the server and audited

- Status: accepted (Phase 12)
- Date: 2026-11-22
- Context:
  - [REQUIREMENTS §3.9](../../REQUIREMENTS.md#39-historical-tracking-and-validation) (historical statistics, labelled as historical observations, never as expected performance; a replay / backtest mode on the live code path), SMC-08 and NFR-14;
  - [rulebook §8](../phase-0/07-smc-rulebook.md#8-outcomes) (outcomes, and statistics grouped by pattern, variant, direction, TF pair, instrument, session and ruleset/params version) and §3.3 (session windows);
  - [ADR 017](017-smc-runtime-boundaries-ids-digests-replays.md) (natural keys, derived ids, digests, replays in the analyzer);
  - [API contracts §3](../phase-0/06-api-contracts.md#setups-and-replays) (`GET /setups/stats?groupBy`, `POST /replays` with `profileVersion?`, both left for Phase 12) and [architecture §14](../phase-0/03-architecture.md) (exports are audited);
  - risk R31 (results taken as proof that a setup or a strategy works);
  - implementation plan Phase 12 (criteria 12.1–12.3); your choices of 2026-11-22: a replay may change settings for itself ("Yes, per replay"), and the statistics count the setups found on stored history as well as live ones, with a filter ("Count both, with a filter").

## Context

Phase 6 records every setup and the outcome of every setup that confirmed (`analysis.setups`, `analysis.setup_outcomes`); Phase 4 made replays reproduce a live run's digest, from the command line and through `POST /replays`. Nothing showed the outcomes together, started a replay from the app, or explained a difference between two runs. Phase 12 adds those, under two constraints: the numbers must be exactly what the database holds (12.1), and nothing may present them as a forecast (12.2).

Four questions were open: which setups the statistics count, and once each; what "session" and "found while warming up" mean for a setup; how a replay can run with other settings when profiles are immutable and admins have no profile editor; and how two runs are compared when their digests differ.

## Decision

### Outcome statistics

- **Endpoint** `GET /setups/stats?groupBy&from&to&instrumentId&found&runId` (`dashboards.view`). `groupBy` is any of `pattern`, `variant`, `direction`, `tfPair`, `instrument`, `session` and `rules`, in any combination (default `pattern`). The answer carries a row per group, most setups first, and the totals of every group together (one query, `GROUPING SETS`).
- **Read straight from the projections**: `analysis.setups` joined with its run and profile, and `analysis.setup_outcomes`. No new table and no cache, so the numbers are always the stored rows (criterion 12.1).
- **Which setups**: those of every live run (or of the one run `runId` names, for a replay) that **started forming** in (`from`, `to`], decision times as for digests. Replays are counted only when asked for by `runId`.
- **Once each**: two live runs of one instrument under the same rules version (the same `ruleset_version` and `params_hash`, as after a restart from an unusable checkpoint) compute the same setups; each counts once, from the newer run.
- **Found while warming up**: decided at or before its run's start (`created_candle_time <= from_time`), the rule the analyzer already flags warm-up detections by. `found=all` (default), `live` or `warmup` filters on it before duplicates are removed, so a setup an older run found live still counts as live.
- **Session**: the profile's session (whole UTC hours, rulebook §3.3; the first match in the profile's order) holding the candle the setup started forming on (its close minus 1 ms), else `outside`. It is the start that is used, so a group's later columns describe the same setups as its first.
- **Rules version**: the analysis code's version with the run's profile and params hash; a replay that changed settings shows as such.
- **The numbers** (rulebook §8): detected (and how many were found on history), confirmed (an outcome, or confirmed or entry active now), open, resolved, the resolved by result (target reached, invalidated, expired before entry, expired open, ambiguous), entry touched, and the mean MFE and MAE in R of the resolved setups whose entry was touched.

### Labels (criterion 12.2)

- The API answers with `label: "Historical observations"` and a fixed notice: *"Historical observations: how past setups found by these rules ended. They describe the past only and are not a forecast or a measure of future results."* The page shows both above the table and in the subtitle; CSV file names start `…-historical-observations-…`.
- The page never names a share a "win rate", "success rate", "accuracy", "edge" or "expected" anything: columns are outcomes, with their share **of the resolved setups** in brackets. A group with fewer than 20 resolved setups is marked "few observations". Unit and end-to-end tests fail on any such word on the page.

### Replays may change settings for themselves

- `POST /replays` takes an optional `settings`: the **patterns**, the **minimum reward-to-risk** (checklist item 7), the **mandatory checklist items**, whether an MSS **needs displacement**, the **entry window** and the **longest hold** (in setup candles), the **news blackout** before and after an event, and whether **low liquidity blocks confirmation**. Each is a rulebook §6–§7 setting under `smc.setups`; nothing else can be changed, and at least one must be named.
- The replay starts, as before, from the live run that covers the period (its profile and series origins, ADR 017), else the instrument's profile, and applies the changes to a copy of those settings (patterns and items in the rulebook's order). The API checks the result as the analyzer will (the profile schema and the engine's own validation) and answers 400 if it is not valid.
- **Profiles stay immutable and shared**: the run keeps what it ran with on its own row: `detection_runs.settings` (as requested) and `detection_runs.params` (the whole settings), with `params_hash` computed over them as for profiles (migration 0016; a check keeps both on replays only, and both or neither). The live analysis never sees them, and replay runs never publish detections, so no alert or automatic practice trade follows a replay.
- `GET /replays/settings?instrumentId` gives the instrument's profile and its values of these settings, which the form starts from; the form sends only what was changed.
- The CLI takes the same settings as a JSON argument: `cip-analyzer replay <instrument> <from> <to> '{"minRR":3}'`; with settings, a difference from the live run no longer exits 2.

### Comparing runs (criterion 12.3)

- `GET /replays/{runId}` compares a completed replay with the live run it started from, or with any other run of the instrument named by `compareWith`, over the period both cover (a replay's (`from`, `to`]; a live run from its first candle on).
- **Digests** as ADR 017 defines them, equal or not; **settings**: the rules version, the profile, then every setting that differs, by path (a deep comparison of the two runs' settings), so changed settings are listed whatever made them differ.
- **Detections**: events are matched by type, timeframe, natural key and decision time (the same in every run, ADR 017), and repeats of one event on one candle in order; each is in both runs with the same contents, in both with different contents, or in one only. Matching by key rather than by number explains a difference even between runs that started at different candles (and so number their events differently). The comparison counts the events per type and lists the setups whose transitions differ, as each run left them at the end of the period (the first 200; the CSV has all).
- A live run that has not yet analysed the whole period (its latest 1m candle is before the end) makes the comparison `incomplete`, so a lagging live run is never reported as a difference.
- The page states the result in words: matches the live run; settings differ (and whether the detections did); same detections numbered differently; or, with the same settings, a difference, shown as a fault to report.

### CSV exports

- `GET /exports/setup-stats.csv` (the statistics as shown, with an `all` line), `GET /exports/setups.csv` (one line per counted setup with its outcome; at most 100,000, else 400 asking to narrow the period) and `GET /exports/run-comparison.csv` (both runs, the settings that differ, the events per type, every differing setup), for every role (`dashboards.view`).
- Generated on the server from the same queries as the page, RFC 4180 (CRLF, a header row), numbers as numbers, and text a spreadsheet would read as a formula prefixed with an apostrophe.
- **Each export is audited** (`export.downloaded`, with the export, its query and the number of lines), as architecture §14 asks. The app fetches the file with the user's token and saves it through the browser; the API exposes `content-disposition` to the desktop client's origin.

### The page

**Historical Analytics** (`/history`, every role): an **Outcome statistics** tab (group-by choices, period, instrument, found; the notice; the table; the two CSV downloads) and a **Replays** tab (the start form for analysts and admins, with the settings behind a disclosure; the list of replays, polled while one runs; a replay's detail with its comparison, a choice of run to compare with, the comparison CSV, and a link to the replay's own statistics). The URL keeps the tab, the replay, the run compared with and the run whose statistics are shown.

## Consequences

- The statistics cost one query over the setups in the period, indexed by run and creation time (migration 0016); there is nothing to keep in step.
- Setups found while warming up count by default: on a fresh database almost every setup is one. They were computed by the same code on stored history (what a replay does), but not in real time; the filter shows either kind alone.
- A replay with changed settings is a what-if over stored history, not a backtest of trading: the outcomes are those of hypothetical levels, labelled as historical observations, and nothing is optimised or ranked (R31).
- Replays add rows (indicator values, events, projections) from the live run's origins to their end; there is no deletion yet.
- The comparison reads both runs' events in the period; a 31-day replay of a busy instrument reads tens of thousands of rows, which takes seconds.
- On the desktop app, saving relies on the webview's download handling (WebView2 on Windows); the macOS WKWebView is not verified (as for Phase 10).

## Alternatives considered

| Option | Why not chosen |
|---|---|
| Statistics kept in their own table, updated as setups resolve | Two copies to keep in step, and 12.1 would then check the copy, not the facts |
| Counting each setup of every live run | A restart under the same rules counts the same setups twice |
| The session a setup confirmed in | Unconfirmed setups have none, so the columns of one row would describe different setups |
| `profileVersion` on `POST /replays` (the Phase 0 contract) | Only version 4 of each profile can run setups, and admins cannot create profile versions: there would be nothing to choose |
| Any setting by path, or a JSON editor | Lets a replay change settings that need the engine's whole picture (timeframe pairs, ATR periods); a curated set is what can be explained on one form |
| A new profile row for each replay that changes settings | Fills the shared profiles table with one-off versions that instruments could be moved to |
| Comparing digests only | Says that two runs differ, not where or why |
| Comparing event by event number (`seq`) | Two runs that started at different candles number every event differently |
| Exports built in the browser from the page's data | Not audited (architecture §14), and the setups export would need every row in the browser |

## As built (Phase 12)

- **Contracts**: `packages/contracts/src/history.ts` (the statistics query and answer, the dimensions, sessions and found filter, the label and notice, the export queries and audit action) and the replay section of `packages/contracts/src/smc.ts` (`ReplaySettings`, `REPLAY_SETTING_PATHS`, `applyReplaySettings`, `replaySettingsOf`, the request, the run comparison, the replay list and status).
- **Database**: `packages/db/migrations/0016_replay_settings.sql` (`detection_runs.settings` and `params`, their check, and an index on setups by run and creation time).
- **The analyzer**: `apps/analyzer/src/analysis/replay.ts` and `repository.ts` (settings applied and checked, kept on the run, its params hash computed in the database); `apps/analyzer/src/cli.ts` (the settings argument).
- **The api**: `apps/api/src/history/` (`stats.repository.ts`, `comparison.service.ts`, `exports.controller.ts`, `csv.ts`); `GET /setups/stats` in `analysis/setups.controller.ts`; `analysis/replay.service.ts` and `replay.controller.ts` (`GET /replays`, `GET /replays/settings`, settings on `POST /replays`, `compareWith`).
- **The app**: `packages/app/src/pages/historical-analytics.tsx`, `lib/history.ts`, `lib/search.ts` (`/history?tab&replay&compare&run`), the navigation entry, and `ApiClient.file` for downloads. Test hooks: `data-stats-row`, `data-stats-totals` and their `data-*` numbers; `data-replay-id`, `data-replay-detail`, `data-status`, `data-comparison` (`data-equal`, `data-incomplete`), `data-run-side`, `data-digest`, `data-setting-path`, `data-differences`, `data-setup-difference`, `data-replay-changes`.
- **End to end**: `e2e/tests/phase12.spec.ts`, with `e2e/support/db.ts` for read-only queries of the stack's database (`docker compose exec db psql`).
