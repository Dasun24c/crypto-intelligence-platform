# Phase 8 · Alerts and notifications: acceptance report

| | |
|---|---|
| Status | **Accepted 2026-11-14**, when you asked to go on to the next phase. Criterion 8.2 is accepted in part: met on Windows, where every step of the [manual checklist](desktop-notifications-checklist.md) passed on the installed build in a run with screenshots (2026-11-13 and 14); its macOS half is carried forward. Everything else is met. Not committed yet |
| Date | 2026-11-12; criterion 8.2 on Windows and the desktop fix on 2026-11-13 and 14 |
| Scope | [Implementation plan, Phase 8](../phase-0/08-implementation-plan.md#phase-8--alerts-and-notifications) |
| Evidence | This machine (Windows 11, Docker Desktop, Node.js 26.13.0); the local Compose stack streaming live public data from Binance and Coinbase, redeployed with Phase 8 at 10:45 UTC; checks to 11:18 UTC. The installed Windows desktop build, against that stack on `https://localhost:8443` (2026-11-13 and 14) |

## Summary

Every user keeps their own alert rules, and the platform tells them when one matches: in the in-app inbox always, and as a desktop or browser notification while the app is open. An alert states what the platform recorded; it never predicts anything, and setup alerts say their levels are hypothetical.

- **Rules** (the Alert Center, `/alerts`): twelve condition kinds, from the API contracts.

  | Kind | Fires when |
  |---|---|
  | Price crosses a level | The ticker crosses the price |
  | Price moves by a percentage | The price moves that far within N minutes |
  | Indicator threshold | RSI, MACD histogram, volume z-score or ATR is above or below a value, or crosses it |
  | Volume anomaly | A candle's volume z-score reaches the threshold |
  | SMC event | A sweep, false breakout, BOS, CHOCH, MSS or POI entry is detected |
  | Setup state change | A setup reaches a state (with pattern, direction and minimum-score filters) |
  | PAXG cross-venue spread | The spread passes the threshold |
  | Economic release approaching | A high- or medium-impact release is that close |
  | Gold market opens or closes | It opens or closes |
  | Large trade | One is detected |
  | Order-book wall | One appears, is pulled or is filled |
  | Data feed health | A gap, delay, halt, delisting or disconnection is reported |

  Each rule has:
  - a scope (instruments, venues);
  - a severity;
  - a cooldown;
  - the native notifications it wants (desktop, browser);
  - optional quiet hours in its own time zone.

  Rules can be paused, edited (with a version check), tested and removed. Rule changes are audited.
- **Evaluation** ([ADR 020](../adr/020-alerts-evaluation-and-delivery.md)): one pure evaluator, `packages/alerts`, decides which rules match a source event, with the occurrence's de-duplication key and cooldown subject. Live, the analyzer runs it:
  - on its own published analysis (indicator points, SMC detections, setup transitions) and on each held instrument's ticker, once a second;
  - and, in the one instance holding `lease:analyzer:alerts`, on `md:events` (gaps, feed status, large trades, walls), the stored PAXG spread, upcoming releases and gold-market sessions.
- **De-duplication and rate limits**:
  - an occurrence fires once per rule (`UNIQUE (rule_id, dedupe_key)`);
  - a cooldown per rule and subject is kept in Redis, so it holds across instances and restarts;
  - level conditions fire on their rising edge;
  - each user gets at most 20 native notifications a minute; beyond that, alerts reach the inbox only.
- **Delivery**:
  1. The analyzer records the alert (`alerts.events`) and adds a job to the BullMQ `notifications` queue.
  2. The jobs service writes the inbox (`alerts.notifications`), decides whether the alert is quiet (quiet hours or the rate limit), and appends `alert.fired` to `alerts:events`.
  3. Every API instance pushes it to the owner's `alerts` channel, a per-user durable channel that replays what a reconnecting client missed.
- **Late**: an alert from catch-up processing (decided more than 120 s before it was processed) carries `late` and shows the label.
- **The app**:
  - a bell in the header with the unread count and the latest alerts;
  - the Alert Center: rules, a 24-hour test of each, the inbox and the fired-alert history.
  - A live alert becomes a native notification through the platform's `notify()`: the Tauri notification plugin on desktop, the browser Notification API on the web.
  - Alerts missed while away are not shown one by one: the desktop app shows one "N alerts while you were away", after a reconnect or when it starts.
- **The rule test** (`POST /alerts/rules/{id}/test?hours=24`) runs the same evaluator and cooldown over stored history, and lists what the rule would have fired.

Verification found eight defects, all fixed and listed [below](#found-by-verification-and-fixed). The eighth came from the Windows run of criterion 8.2: a forced stop could make the desktop app forget its server.

## Acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 8.1 | Every condition type has unit tests and an end-to-end test from source event to delivered notification | **Met**: unit tests for every kind; on the live stack, every kind went from its source event to the inbox and the open app | [8.1](#81-every-condition-type) |
| 8.2 | Native notifications appear on the Windows and macOS builds (manual checklist with a recording) | **Met on Windows; macOS open**: all ten steps passed on the installed Windows build, with screenshots in place of a recording. The macOS run needs a Mac | [8.2](#82-native-notifications-on-the-desktop-builds) |
| 8.3 | 100 identical triggers inside the cooldown produce exactly one notification | **Met**: unit, integration and end to end | [8.3](#83-cooldown) |
| 8.4 | Alerts fired while a client is offline appear in its inbox after reconnecting; the desktop app shows one summary notification | **Met**: the inbox after coming back, end to end. On the installed Windows build, one summary after a 3-minute outage and one when the app started again (8.2, steps 7 and 8) | [8.4](#84-offline-clients) |
| 8.5 | Alerts from catch-up processing are labelled "late" | **Met**: integration, and live after a restart | [8.5](#85-late-alerts) |
| 8.6 | The rule test endpoint correctly lists what would have fired over the last 24 h | **Met**: integration, and end to end against the live rule | [8.6](#86-the-rule-test) |

### 8.1 Every condition type

- **Unit** (`packages/alerts`, 20 tests): every kind matching and not matching; scope by instrument and venue; crossings never on the first value; level conditions on their rising edge only; the `late` label; quiet hours across midnight and daylight saving; messages.
- **Integration** (the analyzer's alert service against PostgreSQL and Valkey, 5 tests):
  - prices from the ticker key;
  - halts, gaps, large trades and walls from `md:events`, with the shared cursor;
  - the spread, upcoming releases and gold-market closures on the clock;
  - indicator points, structure breaks and setup transitions as the actor publishes them.

  Each writes an `alerts.events` row and a delivery job. Delivery is tested in the jobs service (3 tests), and the API pushes to the owner only (`alerts.int.test.ts`).
- **End to end** (`e2e/tests/phase8.spec.ts`, on the live stack): one rule per kind for the viewer. Each kind's first alert must reach the inbox (`GET /notifications`) and the open app (pushed to the page's Alert Center). The sources:
  - **market-driven**: prices, indicators, volume, SMC events, setups and the spread, from live data;
  - **through the admin API**: an upcoming release and a gold-market closure;
  - **injected into `md:events`**: a halt, a large trade and a wall, on a reference instrument nobody watches; they go through the real analyzer, jobs service and API.

| Kind | Source on the live stack | First alert, seconds after the rules were created |
|---|---|---|
| Price crosses a level | BTC's ticker; thresholds half a tick either side of the price, set again every 30 s until one fires | 1: "BTC · Binance BTC/USDT crossed below 73435.995" |
| Price moves by a percentage | Every ticker; 0.0001 % in 1 minute | 1: "SOL · Binance SOL/USDT down 0.01% in 1 min" |
| Indicator threshold | BTC, 1m RSI above 0 | 41: "BTC · Binance BTC/USDT 1m: RSI above 0" |
| Volume anomaly | 1m volume z-score at least 0.01 | 41: "USDT · Coinbase USDT/USD 1m: volume anomaly (z 0.67)" |
| SMC event | Every SMC event, 5m to 1d | 101: "SOL · Coinbase SOL/USD 5m: false breakout of the swing low" |
| Setup state change | Any state | 101: "SOL · Coinbase SOL/USD 5m: Pattern 4, sweep outside, fill inside, bullish, triggered" |
| PAXG cross-venue spread | The stored spread beyond 0.01 bps | 1: "PAXG spread 0.3 bps" |
| Economic release approaching | An admin's entry 10 minutes ahead | 6: "e2e release … in 10 min" |
| Gold market opens or closes | An admin's gold closure starting 90 s later | 94: "Gold market closed" |
| Large trade | Injected on `md:events` | 7: "USDT · Coinbase USDT/USD: large buy $5M" |
| Order-book wall | Injected | 7: "USDT · Coinbase USDT/USD: bid wall appeared $3M" |
| Data feed health | An injected halt | 7: "USDT · Coinbase USDT/USD: feed halted" |

Each first alert was then found in the viewer's inbox (`GET /notifications`) and on the open Alert Center page, pushed over the `alerts` channel. The test passed in 1.7 minutes.

The first run failed on two mistakes in the test, now fixed (no product change):
- the crossing thresholds were set once, and the price moved $10 away before the analyzer read the rules;
- the run outlasted the 15-minute access tokens, which also stopped its clean-up. The rules, calendar entry and closure it left were removed through the API.

### 8.2 Native notifications on the desktop builds

- The desktop app's `notify()` uses the Tauri notification plugin, already in its capabilities. The Alert Center asks for permission from a click, and the web app does the same for the browser's Notification API.
- **Windows build, made here** (2026-11-13): you approved installing Rust (stable 1.99.1, through rustup; the installer's SHA-256 matched rust-lang.org's).
  - The same steps as the `Desktop` workflow built the frontend, passed the artefact scan, and produced the NSIS installer `Crypto Intelligence Platform_0.1.0_x64-setup.exe` (2.97 MiB, unsigned).
  - Its app starts and opens its window. Its notifications were checked in the run below.
- **macOS build**: the `Desktop` workflow builds it on a macOS runner once the branch is pushed.
- **An installed build needs an `https://` server**: release builds refuse plain HTTP, and their content security policy allows only `https:` and `wss:`.
  - The local stack now also serves `https://localhost:8443` (`scripts/dev-tls.mjs`; root README, "HTTPS for the desktop app").
  - Its certificate comes from an authority that can sign only for `localhost` and `127.0.0.1`, and whose key was deleted after signing.
  - Over HTTPS, checked with `curl`: the page loads (200); the API is reached, including the sign-in endpoint with the desktop app's origin; WebSocket upgrades succeed (101); no HSTS header is sent.
  - You trusted the authority for your Windows user, and the installed app connects to `https://localhost:8443`.
- The [manual checklist](desktop-notifications-checklist.md) covers a live alert, the background, quiet hours, a reconnect and a restart (the summary of 8.4), and reading.

**Windows, 2026-11-13 and 14: all ten steps passed** ([evidence](evidence/8.2-windows/README.md)).

- **How it was run.** You asked me to run it, and left the computer alone. A script drove the installed app (signed in as the viewer, on `https://localhost:8443`) through Windows UI Automation, and changed the rule through the API where the app's window could not be reached. Instead of a screen recording, it captured the notification corner after each alert and the app's own window. Captures that caught other apps' notifications were deleted.
- **Results:**

  | Step | Result |
  |---|---|
  | 4 | A live alert became a Windows notification, the bell went up by one, and the alert was first in the inbox |
  | 5 | With the app minimised, the next alert still appeared |
  | 6 | Inside quiet hours, the server marked the alert quiet: inbox only, no notification |
  | 7 | The web server was stopped for 3 minutes, so the app lost its connection. One alert fired meanwhile; after reconnecting, one "1 alert while you were away", not a burst |
  | 8 | The app was closed through its window (it quits in 287 ms) and opened 3 minutes later. It restored the session itself and showed one "2 alerts while you were away" |
  | 9 | A click on an alert in the bell's panel took the count down by one; **Mark all read** cleared it |
  | 10 | After **Pause**, no more alerts |
- **Step 7 used a stopped web server, not Wi-Fi off.** The app talks to `localhost`, which Wi-Fi does not cut, and turning Wi-Fi off would also have stopped the market data. The checklist now says so.
- **Step 8 needed a second run.** In the first, the script sent its close message to a hidden helper window of the app, then forced the app to stop. Opened again, the app had lost its saved server address, so it showed no summary.
  - The script was corrected, and steps 8–10 passed on 2026-11-14 with a normal quit.
  - The forced stop showed a real weakness, below.
- **macOS**: still open. The `Desktop` workflow builds the app after a push; the run needs a Mac.

**Found in the 8.2 run and fixed: a forced stop could make the desktop app forget its server.**
- **What happened.** The app kept the server address only in its web view's local storage. After the forced stop, the web view's storage database recovered without its newest files, and the address was gone. The app opened at "Connect to your server".
  - The saved sign-in in Windows' credential store survived: once the address was entered again, the session came back without a password.
  - A normal quit kept both, as the second run showed. So a crash, "End task" or power loss could make a user re-enter the address.
- **The fix** (2026-11-14, your go-ahead). The address now lives in `settings.json` in the app's config folder (`%APPDATA%\org.cip.desktop` on Windows), written by two new Rust commands (`settings.rs`).
  - Each save goes to a temporary file, flushed to disk, then renamed over the old one, so a crash leaves the old settings or the new, never half of either.
  - The Rust side checks the address again: HTTPS origins only, or plain HTTP to this machine in development builds.
  - An address saved by an earlier version is copied from the web view on the first start. The old key is still written too, so going back to an older installer keeps working.
  - Six new Rust tests cover the address rules, a missing or damaged file, and atomic replacement. The crate's 11 tests pass. `cargo fmt` and `cargo clippy` were not run: those Rust components are not installed here.
- **Checked on the new build** (installer rebuilt 2026-11-14 02:52 UTC, 2.99 MiB, SHA-256 `F2654260…69A0052`):
  - It started signed in and copied the address to `settings.json`.
  - With the web view's storage moved aside, so the old copy was gone, it still started signed in. That is the failure from the 8.2 run, now harmless.
  - After a forced stop, it started signed in again.
  - The web view's storage was put back afterwards.
  - At your request, the rebuilt installer was then installed over the old app, silently (`/S`, exit code 0). Opened from the Start menu, the app read its settings file and started signed in.

### 8.3 Cooldown

- **Unit**: 100 identical triggers within the cooldown, through the evaluator and `decide()`: one fires, 99 are dropped.
- **Integration**: 100 identical halts on `md:events`, read by the analyzer's alert service against Valkey, give one `alerts.events` row and one delivery job. A second instance, as after a restart, keeps the cooldown: the 101st does not fire either.
- **End to end**: 100 halts injected for one instrument, inside a 10-minute cooldown: one alert and one inbox item (18 s).

### 8.4 Offline clients

- **Web, end to end**: the viewer's page left the app (`about:blank`) while three gaps were announced. Back on the Alert Center, the three alerts were in the inbox, from `GET /notifications` (9.5 s).
- **Reconnect** (app tests):
  - after a dropped connection, three missed alerts are replayed on the `alerts` channel, and the desktop app shows one "3 alerts while you were away", not three notifications;
  - when the stream no longer holds them, the snapshot's unread count gives the summary;
  - a desktop app that was closed summarises, when it starts, the unread alerts that arrived since it last ran.
- **Desktop builds**: steps 7 and 8 of the manual checklist, passed on the installed Windows build: "1 alert while you were away" after a 3-minute outage, and "2 alerts while you were away" when the app started again ([8.2](#82-native-notifications-on-the-desktop-builds)).

### 8.5 Late alerts

- **Integration**: entries on `md:events` read three minutes after they were written are fired as late, and a setup transition processed ten minutes after it was decided fires late.
- **Live**: the analyzer was stopped at 11:15:20, and a gap on USDT-USD was announced on `md:events` at 11:15:20.924. The analyzer started again 159 s later. Its alert evaluator caught up from its stored cursor:
  - the alert "USDT · Coinbase USDT/USD: feed data gap" was recorded at the gap's time (11:15:20.924) with `late: true`;
  - it was in the viewer's inbox at 11:17:59.9, 3 s after the restart.

### 8.6 The rule test

- The dry run is the live evaluator and cooldown over stored history: detections, transitions, indicator values, gaps, halts, large trades, walls, the stored spread, the calendar and the closures.
  - Prices come from 1m candle closes (the live rule reads the ticker every second).
  - Feed delays and disconnections are not stored. The result's `note` says so.
- **Integration** (API): four stored gaps (one inside another's cooldown, one older than the window) give `evaluated: 3`, `suppressed: 1`, and the two that fire, in order.
- **End to end**: a 1m RSI rule on BTC, live for six minutes. Its live alerts, from a minute after it was created to two minutes before the test, were 3; the rule test listed the same 3 (instrument and candle).

## Live

On the local stack (2026-11-12, UTC):

- **Deploy**:
  - 10:41: migration 0011 was applied, but the API, analyzer and jobs services crash-looped. The image lacked the new `packages/alerts` (defect 5).
  - 10:45: redeployed with the fix; every service healthy since.
  - The analysis carried on: Phase 8 did not change the ruleset, so the nine live runs started at 06:03–06:07 kept running, through both deploys and the analyzer's stop below.
- **End to end, first run** (10:46–11:03): 10 passed, including every earlier phase's tests.
  - 11 of the 12 kinds were delivered within about four minutes.
  - 8.1 failed on the two test mistakes described under [8.1](#81-every-condition-type), and 8.3, 8.4 and 8.6 did not run.
  - Its leftovers (13 rules, a calendar entry, a closure) were removed through the API, audited.
- **End to end, second run** (11:07–11:14): 14 of 14, the four Phase 8 tests included. The run removed its own rules and entries.
- **Late alerts** (11:15–11:18, the 8.5 check below): the analyzer was stopped for 159 s.

## Found by verification and fixed

| # | Found | Effect | Fix |
|---|---|---|---|
| 1 | The PAXG spread's message had its sign backwards (found while reading the ingestor) | It would have said "Binance above Coinbase" when Coinbase was higher | The stored spread is (Coinbase − Binance) / Binance; the message reads it that way, and says so in the source |
| 2 | A circular import in `packages/alerts`: `messages.ts` took two types from `evaluate.ts`, which imports it (verify, dependency rules) | Verify failed | The shared types live in `types.ts` |
| 3 | The database package's table check read only the `app`, `market` and `analysis` schemas (integration) | The `alerts` tables were not compared with the migration, and the test failed | It reads `alerts` too; the column lists match the migration |
| 4 | The alert queries in `packages/db` were tested only by other packages (integration coverage) | Branch coverage of the database package fell to 76.9 % | `alerts.int.test.ts` in the package: the queries, de-duplication and every service's grants (98.9 % / 88.5 %) |
| 5 | The server image neither built nor copied `packages/alerts` (the first deploy) | The API, analyzer and jobs services crash-looped on start, for about three minutes | The Dockerfile builds and copies it |
| 6 | Two app tests on lazy pages failed when the whole suite ran, though not alone | Verify could fail on a busy machine | The tests' async wait is 5 s (`src/test/setup.ts`) |
| 7 | The row mapping in `packages/alerts` had no unit tests (verify, coverage gate) | The package's branches and functions fell under the 90 % gate (88.1 % and 89.7 %) | Tests of stored rules and events, valid and not (94.2 % of branches, 100 % of functions) |
| 8 | The desktop app kept its server address only in its web view's storage (the 8.2 run, after a forced stop) | After a crash or "End task", the app could ask for its server again | `settings.json` in the app's config folder, written atomically by Rust commands; the old value is copied over. Checked on the rebuilt installer ([8.2](#82-native-notifications-on-the-desktop-builds)) |

The test harness needed four corrections. None is a product defect:
- The end-to-end crossing thresholds were set once, so a moving price could leave them behind; they are now set again every 30 s until one fires.
- The end-to-end run outlasted the 15-minute access tokens; the tokens are now renewed after 12 minutes.
- Prettier formatted one statement of the Phase 8 spec differently on a second pass.
- One verify run could not start a test worker in time while the end-to-end run loaded the machine; on a quiet machine it does.

## Tests and coverage

1,897 automated tests, all passing: 1,457 unit, 426 integration and 14 end to end (Phase 7: 1,801).

- `pnpm verify` passes on the final code (2026-11-14, 03:05–03:11 UTC, after the desktop fix; before it, 2026-11-12, 11:18–11:27 UTC): formatting, lint, typecheck, dependency rules, the no-trading check, unit tests with coverage gates, the build and the artefact scan.
- The desktop crate's Rust tests pass with `cargo test`: 11, six of them new for the settings file. They are not part of `pnpm verify` or CI, and not counted above.
- The integration suites of all six packages that have them pass with coverage (11:27–11:37).
- Playwright passes 14 of 14 against the live Phase 8 stack.

As in Phase 7, the integration figures count only integration tests: each package's integration run also repeats its unit tests.

| Package | Tests (unit + integration) | What is new in Phase 8 | Coverage gate | Measured (lines / branches) |
|---|---|---|---|---|
| alerts (new) | 24 | The evaluator for all twelve kinds, scope, edges, `late`, quiet hours, cooldown and de-duplication, the dry run, stored rows | 90% | 98.6% / 94.2% |
| contracts | 66 (Phase 7: 60) | The alert schemas, the `alerts` channel | 90% | 100% / 100% |
| analyzer | 5 + 23 (5 + 18) | The alert service: tickers, `md:events` with its cursor, the clock sources, published analysis, the cooldown across instances, `late` | 70% | 90.6% / 75.7% |
| jobs | 19 + 31 (19 + 28) | Delivery: inbox rows per channel, the push, retries, quiet hours, the rate limit | 70% | 97.6% / 88.0% |
| api | 19 + 326 (19 + 281) | Rules (ownership, versions, audit), the rule test, the inbox, the per-user channel with its replay, ten routes in the RBAC matrix | 70% | 88.4% / 71.6% |
| db | 2 + 28 (2 + 25) | Migration 0011: the alert queries, de-duplication, each service's grants, the table check | 70% | 98.9% / 88.5% |
| app | 150 (144) | The bell, the Alert Center, native notifications, the summary after a reconnect or a restart, read sync | none yet | 77.9% / 67.5% |
| smc-engine, domain, indicators, market-data, exchange-adapters, observability, ingestor, ui | 982, 31, 73, 40, 25, 11 + 4, 6 + 14, 4 | Unchanged | as before | as before |
| End to end | 14 (10) | 8.1, 8.3, 8.4, 8.6 | — | — |

The API's branch coverage fell from 76.3 % to 71.6 %, still above its gate. The rule test's history builder has a branch for each kind, and the API's integration test runs it for gaps only. The evaluation behind every kind is unit-tested in `packages/alerts`, and the end-to-end 8.6 test runs the rule test on an indicator rule. The app's coverage fell a little too (79.2 % to 77.9 % of lines), mostly in the Alert Center's condition fields.

## Decisions made during Phase 8

| Decision | Why | Recorded in |
|---|---|---|
| One pure evaluator shared by the live analyzer and the rule test | The test then lists what the live rule fires, by construction | ADR 020 |
| Per-instrument sources are evaluated by the instrument's lease holder; global sources by the holder of `lease:analyzer:alerts` | Each source is evaluated once, without a new service | ADR 020 |
| Prices are read from the `ticker:{id}` key once a second; the spread from its stored rows | No pub/sub subscription in the analyzer. The spread rule's dry run reads the same rows | ADR 020 |
| The analyzer hands alerts to the jobs service through the `notifications` queue, and the jobs service writes `alerts:events` | Delivery gets retries, and the push carries the inbox item that already exists | ADR 020; architecture §9 note |
| Level conditions (% change, spread) fire on their rising edge; crossings need a previous value | "Passing a threshold" means crossing it; a rule must not fire for a state that has held for hours | ADR 020 |
| Quiet hours and a 20-a-minute rate limit make an alert quiet (inbox only), never drop it | The inbox is the record; only the interruption is limited | ADR 020 |
| Removing a rule keeps its row (`deleted_at`) | Its alerts stay in the inbox, with its name | Data model §7 note |
| The `alerts` channel is per user, implicit in its name | One subscription per user; nobody can subscribe to another's | API contracts §5.3 note |
| Browser notifications are asked for from a click in the Alert Center | Browsers ignore permission requests made without one | `platform-web.ts` |
| The desktop summary covers a reconnect (replayed or snapshot) and a restart (unread alerts since the app last ran) | Criterion 8.4: one summary, not a burst | ADR 020 |

## Carried forward

| Item | Plan |
|---|---|
| Criterion 8.2 on macOS: the checklist on the macOS build | Yours: the `Desktop` workflow builds it after a push; the run needs a Mac. Windows passed on 2026-11-13 and 14 |
| The desktop crate's `cargo fmt` and `cargo clippy` checks | Not run here (the components are not installed; `rustup component add rustfmt clippy` adds them). CI does not run them either |
| A FRED API key on the computer that runs the stack (7.3) | Yours, from Phase 7 |
| Review of rulebook §14 notes I1–I38; recorded fixtures reviewed by a second person; a 7-day run of purely live time | Unchanged |
| The 1m warm-up for old ambiguous candles; whether MAE stops at the deciding minute | Your choices, from Phase 6 |
| From Phases 2–5: the trend rule and volume threshold; decisions 1 and 2; D2 hosting | Unchanged |

## What I need from you

1. **Criterion 8.2 on macOS**: Windows passed (see [8.2](#82-native-notifications-on-the-desktop-builds)). For macOS, the `Desktop` workflow builds the app after a push, which is yours to ask for, and the [checklist](desktop-notifications-checklist.md) needs a Mac. Or accept 8.2 with its macOS half carried forward, as 7.3 was.
2. Your approval of this report.
3. **Commits**: Phases 7 and 8 are not committed. When you ask, I would commit Phase 7 first, from its recorded state (git tree `6a88c16f`), then Phase 8 on top, each as its own commit and pull request.
