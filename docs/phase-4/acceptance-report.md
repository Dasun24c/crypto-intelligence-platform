# Phase 4 · SMC structure and liquidity: acceptance report

| | |
|---|---|
| Status | **Built; awaiting your acceptance.** All seven criteria are met; 4.1 with synthetic fixtures only, since recorded ones need a second person to review them. Not committed |
| Date | 2026-11-11 |
| Scope | [Implementation plan, Phase 4](../phase-0/08-implementation-plan.md#phase-4--smc-structure-and-liquidity) |
| Evidence | This machine (Windows 11, Docker Desktop, Node.js 26.13.0); the local Compose stack streaming live public data from Binance and Coinbase, 2026-11-11 07:14–08:32 UTC; nine new live runs (ruleset `indicators-1+smc-0.1.0`) |

## Summary

Phase 4 delivers the SMC engine for market structure and liquidity, and the runtime that makes its results reproducible:

- **The engine** (`packages/smc-engine`): the rulebook's §2 and §3 as a pure, deterministic reducer ([ADR 004](../adr/004-smc-engine-event-sourced-reducer.md)).
  - §2: swings (internal and external), BOS, CHOCH and MSS with displacement, and trading ranges.
  - §3: every liquidity level type, sweeps, false breakouts and breakouts, with the thin-book, liquidity-unverified and underlying-closed flags. Gap markers come from §9.
  - It takes one step per boundary, keeps prices as integers of 10⁻⁸, and has snapshots that continue exactly.
  - Where the rulebook is silent, the engine's choices are listed as implementation notes I1–I13 in [rulebook §14](../phase-0/07-smc-rulebook.md#14-implementation-notes-ruleset-010), for your review.
- **Golden fixtures and property tests**: 137 fixtures, covering 14 concepts and the gold profile. Each is checked for its labelled detections, the §13 invariants, and prefix and checkpoint stability at every cut point. fast-check runs 1,000 random markets on top.
- **The runtime** in the analyzer ([ADR 017](../adr/017-smc-runtime-boundaries-ids-digests-replays.md)):
  - one boundary loop for indicators and SMC per instrument;
  - checkpoints every 60 boundaries and on shutdown;
  - lease fencing epochs;
  - the event log and its digests;
  - ids derived from natural keys;
  - an outbox for publishing;
  - replays (`POST /replays`, the `replay` queue, and a CLI).
- **Storage**: migration 0007 adds profiles v2 (the `smc` settings), checkpoints, the `detection_events` hypertable, five projections and each replay's source run.
- **The API**:
  - `GET /smc/{id}/overlay`, `/swings`, `/structure`, `/ranges`, `/levels` and `/sweeps`;
  - `POST /replays` and `GET /replays/{runId}`, which compares digests;
  - the durable `smc:{id}` channel.
- **The labelling page** (development builds only, `/dev/labelling`). It labels stored candles, or loads a fixture, and downloads §12 fixture JSON.

Verification found six defects that the tests had not. Four were in Phase 4's runtime, two of those in lease handling; one was in the test run itself; one was in Phase 2's jobs health rule. All are fixed, with regression tests for the lease renewal and the health rule, and listed [below](#found-by-verification-and-fixed).

## Acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 4.1 | Golden fixtures for every concept in rulebook §2–§3 pass, at the minimum coverage in §12 | **Met, with synthetic fixtures**; no recorded fixture is reviewed yet (see below) | [4.1](#41-golden-fixtures) |
| 4.2 | The prefix-stability (no-repaint) property test passes for 1,000 random cut points per fixture | **Met**: every cut point of every fixture, plus 1,000 random markets | [4.2](#42-no-repainting) |
| 4.3 | Replaying a stored 7-day period reproduces the live run's digest exactly | **Met** on all nine instruments | [4.3](#43-replays) |
| 4.4 | Killing the active analyzer mid-run: a standby takes over the lease, and the final digest equals an uninterrupted run | **Met**: takeover 12.5 s after a SIGKILL; all nine digests equal a replay | [4.4](#44-takeover) |
| 4.5 | An injected data gap pauses analysis, the UI shows "paused: data gap", and analysis resumes after repair with no published detection changed | **Met**: a deleted minute paused BTCUSDT; the sweep and backfill repaired it within 8 minutes; the event log before the gap is unchanged | [4.5](#45-data-gap) |
| 4.6 | Engine step p95 ≤ 2 ms; candle close → detections published p95 ≤ 2 s | **Met**: step p95 0.17 ms live on a quiet machine, 1.49 ms under full CPU load; published p95 103–254 ms from the candle being final | [4.6](#46-speed) |
| 4.7 | Thin-book and underlying-closed flags behave as specified on PAXG fixtures | **Met** on the gold fixtures, and seen on live PAXG data | [4.7](#47-gold) |

### 4.1 Golden fixtures

Rulebook §12 asks, for every §2–§3 concept, for 3 bullish, 3 bearish and 3 negative cases, plus closure, reopening and thin-book cases for the gold profile. There are 137 fixtures in `packages/smc-engine/fixtures/`, and all pass in `golden.test.ts`:

| Concepts | Fixtures each |
|---|---|
| Swings; BOS; CHOCH; MSS; displacement; equal highs and lows; period levels; session levels; weekend levels; sweeps; false breakouts; breakouts; thin book | 9 (3 bullish, 3 bearish, 3 negative) |
| Ranges | 11 (the 9, plus an expired range and one ended by a data gap) |
| Gold profile | 9 (3 closure, 3 reopening, 3 thin-book) |

- **How they were made**: I designed each pattern by hand and worked out its expected detections from the rulebook. Each bearish case is the exact mirror image of a bullish one. `pnpm --filter @cip/smc-engine fixtures` rebuilds them from `scripts/fixtures/`, and the builder rejects inconsistent candles.
- **What each fixture checks**: the detections labelled in it (by type, timeframe, time, price and flags), that nothing unlabelled of an exhaustive type appears, and the §13 invariants.
- **What is missing**: §12 also asks for *recorded* fixtures from real candles, labelled by one person and reviewed by a second. None exist yet, because I cannot be the second person.
  - The labelling page is ready for it. It loads stored candles, shows the engine's candidates to accept or reject, and downloads the fixture.
  - On the live stack, signed in as the development analyst, it loaded 120 BTCUSDT 15m candles ending 2026-11-11 08:00 UTC with the live run's overlay. Swings, BOS and MSS breaks, levels and sweeps were drawn on the chart and listed for labelling as "must detect", "must not" or unlabelled.
  - Until recorded fixtures exist, the real-data test stands in: 34 days of Binance BTCUSDT, where every rule fires and every invariant holds.

### 4.2 No repainting

- **Golden fixtures**: for every fixture, at every cut point, the events emitted up to the cut are identical whether or not later candles exist. A checkpoint taken at every 7th cut, through JSON, also continues exactly. No fixture has more than 1,000 boundaries (the largest has 355 candles), so every possible cut point is tested. That covers more than 1,000 random cut points could.
- **Property test** (`property.test.ts`, fast-check, 1,000 runs): random walks with random ranges, missing and partial candles, aggregated as the platform builds them, with 1m profiles under part of the series. Each run checks no repainting and exact checkpoint continuation at a random cut, and the invariants.
- **Real data** (`realdata.test.ts`): on 34 days of BTCUSDT, a prefix gives exactly what the whole run gives for it, and a checkpoint continues exactly.

### 4.3 Replays

On the live stack, `cli.js replay <instrument> 2026-11-04T07:25Z 2026-11-11T07:25Z` replayed the 7 days up to 5 minutes before the check, for each of the nine instruments. Every replay reproduced its live run's digest exactly:

| Instrument | Events in the 7 days | Digest (sha256, first 16) | Equal |
|---|---|---|---|
| BTCUSDT (Binance) | 2,473 | `83a724f379b4a51d` | Yes |
| ETHUSDT (Binance) | 2,519 | `1a265592c16c7b4b` | Yes |
| SOLUSDT (Binance) | 2,445 | `bbce4a9ea1a8a8c0` | Yes |
| PAXGUSDT (Binance) | 2,408 | `98e4cdcac1e3b31c` | Yes |
| BTC-USD (Coinbase) | 2,399 | `c19f48b8c16f20f0` | Yes |
| ETH-USD (Coinbase) | 2,413 | `1bb1e528c2b053bb` | Yes |
| SOL-USD (Coinbase) | 2,357 | `93ccfd9d88871aff` | Yes |
| PAXG-USD (Coinbase) | 2,251 | `859f0475964e1d5e` | Yes |
| USDT-USD (Coinbase) | 1,871 | `9aff28cfa264f88b` | Yes |

- **How the live runs computed those 7 days**: the live runs started at 07:14–07:16 UTC. Most of the period was therefore computed by each run's warm-up on stored history, and the last minutes live. Both use the same processor and engine. A replay copies the live run's series origins and profile (ADR 017), so its state at every boundary is the live run's.
- **Live minutes**: the replays of [4.4](#44-takeover) cover 07:00–07:50 UTC, which is each run's live time up to then, across a restart and a takeover. They match too.
- **Integration tests** (`apps/analyzer/test/smc.int.test.ts`): a run killed mid-way and finished by a standby equals a replay over three periods, including one that starts inside the warm-up. A run paused at a gap and resumed after the repair equals a replay.
- **A 7-day comparison of purely live time** needs the stack to run for 7 days. The same command does it; I suggest running it once your staging host exists.

### 4.4 Takeover

On the live stack, with all nine instruments:

1. **A graceful restart** (07:45:22 UTC; new analyzer image). The old process wrote a checkpoint for every run at 07:45:00 and released its leases.
   - The new one took all nine leases within 12 ms, at the next epoch.
   - It restored every run from its checkpoint, about 40 ms each.
2. **A standby**: a second analyzer (`--scale analyzer=2`). Its heartbeat read "standby: no instrument leases held".
3. **The kill**: `docker kill cip-analyzer-1` (SIGKILL) at 07:47:56.7. Its last checkpoints were from 07:45:00, so the two boundaries it had stored since (07:46 and 07:47) were not in them.
4. **The takeover**:
   - At 07:48:09.25, 12.5 s after the kill and inside the 15 s lease TTL, the standby took all nine leases, each at the next epoch. That is 4 for the seven instruments whose first lease had lapsed during the first warm-up (defect 1), and 3 for the other two.
   - Within 0.4 s it restored every run from the 07:45:00 checkpoints and recomputed the boundaries the dead holder had already stored.
   - At 07:48:12 its heartbeat read "analysing 9 instruments".
5. **Afterwards**, for every run:
   - the event log is contiguous (seq 1…n, no duplicates);
   - every detection decided after the run's start was published exactly once, with none missing (`an:events` against the event log);
   - each checkpoint carries the new epoch.
6. **The final digest**: a replay of 07:00–07:50 UTC, a period spanning the warm-up, the restart and the takeover, reproduced every run's digest:

| Instrument | Events | Digest (first 16) | Equal |
|---|---|---|---|
| BTCUSDT | 19 | `f9ca9bdeb8995934` | Yes |
| ETHUSDT | 17 | `6bb44e518a69ba13` | Yes |
| SOLUSDT | 25 | `be442cbaa77825f0` | Yes |
| PAXGUSDT | 7 | `0aa63f7cc0f9eb2d` | Yes |
| BTC-USD | 24 | `fbbb6f25023f0acf` | Yes |
| ETH-USD | 19 | `308d8c52aca41409` | Yes |
| SOL-USD | 20 | `031776d1b429b20b` | Yes |
| PAXG-USD | 16 | `76450d4d1d5553f6` | Yes |
| USDT-USD | 10 | `64fc08da4584d895` | Yes |

A replay computes the period without interruption, so the run that was restarted and taken over equals an uninterrupted run. The integration test does the same with a killed analyzer and checks fencing: a former holder's write with an older epoch is refused. A new test checks that leases are renewed while an instrument is busy (defect 1 below).

At the end of verification (08:32 UTC), after one more graceful handover when I scaled the analyzer back to one instance, all nine runs were still consistent. Every event log was contiguous, and all 254 live detections had been published exactly once, none missing and none extra.

### 4.5 Data gap

On the live stack, on BTCUSDT (Binance):

1. **The gap**: at 07:54:14 UTC I paused the analyzer (`docker pause`). Once the ingestor had stored the 07:54 minute, I deleted that 1m candle from `market.candles`, then resumed the analyzer at 07:55:06. No gap was recorded: the minute was simply lost, as in Phase 3's defect 2. The 52-second pause also let the analyzer's leases lapse; with no standby running, it took them back at the next epoch when it resumed.
2. **The pause**: once the 07:55 minute arrived (07:56:00), the analyzer could tell that 07:54 was missing, not late. BTCUSDT stopped at that boundary.
   - Its state read `paused: true, pauseReason: data_gap, detail: "1m: missing 2026-11-11 07:54"`.
   - The analyzer's heartbeat read "1 paused on a data gap".
   - The other eight instruments carried on.
3. **The UI**:
   - System Health's Analysis card read "9 of 9 instruments analysed · 1 paused". BTC · Binance BTC/USDT showed a **Data gap** badge, "1m: missing 2026-11-11 07:54" and a lag of 2 min.
   - The Technical Analysis page for that instrument read "Paused: data gap — 1m: missing 2026-11-11 07:54. Analysis waits at the gap until the backfill repairs it; no candle is skipped."
4. **The repair**, untouched by me:
   - The jobs service's 10-minute sweep for holes found the missing minute at 08:03:36 and recorded the gap (`consistency_check`).
   - The backfill fetched the minute from Binance's REST candles and marked the gap repaired at 08:03:39.
   - The restored candle equals the deleted one (open 73956.01, high 73956.01, low 73934.99, close 73941.34, volume 78.82737; quality `repaired`).
   - BTCUSDT was analysing again, with no lag, at 08:03:46.
5. **Nothing published changed**:
   - The event log's 11,712 rows from before the gap are identical afterwards: same seq, type, timeframe, time and payload hash.
   - The 7 detections decided after the gap (at 07:55 and 08:00) were computed only after the repair. They were published then, once each, flagged `late_detection` because they came more than 120 s after their candle closed.
   - All 26 live detections of the run were published exactly once, with none missing.
   - A replay of 07:00–08:03 UTC, spanning the restart, the takeover and the gap, reproduces the run's digest (`626290d1f30e1cd5`, 26 events).
6. **The integration tests** do the same with a missing minute, and compare the resumed run with a replay. They also cover a gap given up as unrepairable: the analyzer steps over it with a gap marker and takes the partial candle.

The pause showed only once the next minute arrived (one minute after the lost minute closed). Until a later candle exists, a missing candle cannot be told from a late one, so the lag reads 0 until then.

### 4.6 Speed

- **Engine step**: the analyzer's heartbeat reports the p95 of the engine's time per boundary over its last 4,096 steps. `cip_smc_step_ms` records every step.
  - At 07:36 UTC, on a quiet machine, it read **0.17 ms** against a budget of 2 ms. Most of those steps were the warm-up's.
  - At 08:32, over only the 243 live steps since the last restart, it read **1.49 ms**. That was while a full `pnpm verify` kept all 14 of the machine's CPUs busy. Live steps come once a minute per instrument, so their code is never kept hot.
  - On 34 days of BTCUSDT, `realdata.test.ts` measures about 0.09 ms, and it fails above 2 ms.
  - All within the budget. The rulebook asks for it on the reference CI runner, which `realdata.test.ts` will measure once CI runs.
- **Publishing**: `node scripts/analysis-latency.mjs` now times SMC detections as well as indicator points. The table covers the 15 minutes from 07:21 to 07:36 UTC, after the live runs' warm-up, on all nine instruments:

| From | Indicator points (n = 169) | SMC detections (n = 67) |
|---|---|---|
| The candle being final (the ingestor's `md:candles` entry) | p50 35 ms, p95 207 ms | p50 51 ms, **p95 103 ms** |
| The venue's minute boundary | p95 3.1 s | p95 3.1 s |

- **Which row counts**: on 2026-11-11 (criterion 3.5) you decided to measure from the candle being final, so the first row is the one that counts. The second row includes Coinbase's 2 s late-trade grace. On Binance alone it is p95 0.4–0.7 s.
- **On the final analyzer image**, under the same full `pnpm verify` load: over 08:07–08:32 UTC, SMC detections were published p95 **254 ms** (n = 75) and indicator points p95 177 ms (n = 293) after the candle was final.
- **Start-up is slower**: when the stack first came up, all nine runs had to warm up. The analyzer read no wake-ups until its first pass had warmed up every run, which took 2.5 minutes. Points and detections of the minutes that closed meanwhile were published up to 106 s late, and anything over 120 s would carry `late_detection`. This happens once per deploy or rules change and grows with the number of instruments. Overlapping the first warm-ups with live work is a small change I have left for later (see Carried forward). A restart that resumes from checkpoints is not affected: after the 07:45 restart, every run was live again within 0.4 s.

### 4.7 Gold

- **Fixtures**: the gold profile's 9 fixtures pass.
  - Closures: a sweep and a BOS decided inside the weekend closure carry `underlying_closed`. A second BOS after it does not. Neither does a false breakout breached inside the closure but confirmed after the reopening: the deciding candle counts.
  - Reopening: weekend levels come at the first hour boundary after a reopening on the half hour; from the hours there are (flagged `data_gap`) when an hour inside the closure is missing; and a 1h sweep after the reopening leaves the level active, because its status is decided on 4h (I1).
  - Thin book: $38,200 traded beyond the level is thin for crypto but not for gold ($20,000); $9,550 is thin; a minute without its profile gives `liquidity_unverified`.
  - The 9 general thin-book fixtures cover wicks, false breakouts, thick books, missing minutes and missing profiles.
- **Live PAXG** (both venues):
  - The last weekend's levels were formed at the reopening, 2026-11-08 23:00 UTC, with origin 1d. PAXGUSDT's weekend high at 4071.69 was broken on 11-09 at 16:00, and its low at 4032.34 swept on 11-10 at 16:00.
  - `thin_book` follows the threshold. Sweeps with $26, $1,641 and $16,193 traded beyond the level are flagged; one with $79,809 is not.
  - Sweeps during closures carry `underlying_closed`: 50–112 per timeframe and venue over the warm-up period.
  - Sweeps without 1m micro profiles are `liquidity_unverified`: profiles exist only for minutes the ingestor streamed, not for history fetched over REST.
- **Weekend levels and the closure calendar**: weekend levels come from the closure calendar in the database. It holds closures from 2026-11-02 onwards, so warm-up produced no weekend levels for earlier weekends. Those levels would long since have been replaced; the next live ones are due at the reopening on 2026-11-15 23:00 UTC.
  - Like candles, the calendar is an input: a closure added later for a past period would make a replay of that period differ from the live run.

## Found by verification and fixed

| # | Defect | Effect | Fix |
|---|---|---|---|
| 1 | Leases were renewed only in the analyzer's 5 s tick, which waited for each instrument's analysis. The first tick took the leases one at a time and warmed each run up (20–33 s) before the next | On the first start, no lease was renewed for 2.5 minutes. Seven of nine expired under their own warm-up and were silently taken again at a new epoch. With a standby running, it would have started those instruments mid-warm-up: fencing keeps the data right, but two instances would have done the same work | Leases are renewed on their own timer, never behind analysis; each pass takes all free leases at once. A new integration test locks the checkpoint table under a busy actor and checks that the lease is still renewed at the same epoch |
| 2 | A write read the lease's epoch when it was made, and a write without an epoch skipped the fence | If a renewal found the lease lost while a step was running, the rest of that step's writes went out unfenced, exactly when fencing matters | Each step writes under the epoch it started with; a step never writes without one |
| 3 | A replay was compared only with a live run that had started before the replay's period, and the API chose that run again when the status was read | A 7-day replay on a new live run had nothing to compare with, though the run had computed the period during its warm-up; a run started later could have been compared instead of the one copied | A replay copies the newest live run whose series had started by the period's start, records it (`source_run_id`), and is compared with exactly it |
| 4 | The replay CLI left a failed replay `running`, and accepted a period ending in the future | One run stayed `running` after I asked for a period that was not over yet | Marked `failed` on any error, as the queue's worker does; a future end is refused, as the API does |
| 5 | `pnpm verify` runs every package's tests at once. The SMC engine's four test files are each CPU-bound for 20–30 s | Three times running, the web app's test workers could not start within Vitest's fixed 60 s, and verify failed; its tests pass on their own | The SMC engine's test files run one after another (`fileParallelism: false`). Verify now passes; CI runners, with fewer cores, would have hit this harder |
| 6 | The jobs service reported itself degraded while its maintenance queue held 10 or more failed jobs, however old (Phase 2). The queue keeps up to 500 for inspection | 118 `pair-status.refresh` jobs that failed with "fetch failed" between 2026-11-10 11:36 and 2026-11-11 04:34 UTC, before Phase 4, kept System Health "Degraded" for good. The Playwright smoke spec failed on it | Only failures in the last hour count (`Maintenance.failedSince`; the detail now says "N failed in the last hour"); old ones stay for inspection. The jobs integration test checks it, and the smoke spec passes |

## Tests and coverage

1,144 automated tests, all passing:

- `pnpm verify` passes: formatting, lint, typecheck, dependency rules, the no-trading check, unit tests with coverage gates, build and the artefact scan.
- The integration suites of all six packages that have them pass with coverage.
- Playwright passes 5 of 5 against the live stack.

| Package | Tests | Kind | Coverage gate | Measured (lines / branches) |
|---|---|---|---|---|
| smc-engine (new) | 443 | 412 golden-fixture checks over 137 fixtures (labelled detections, invariants, prefix and checkpoint stability at every cut); the fast-check property test (1,000 random markets); 34 days of BTCUSDT (7); units (23) | 90% | 99.7% / 98.2% |
| indicators | 73 | unit; Phase 3's, plus checkpoint and restore of every indicator (5) | 90% | 98.9% / 94.1% |
| contracts | 53 | unit, including the SMC, replay and profile schemas | 90% | 100% / 100% |
| domain | 23 | unit | 90% | 99.0% / 95.9% |
| market-data | 40 | unit | 90% | 98.1% / 90.4% |
| exchange-adapters | 25 | unit | 70% | 93.8% / 74.5% |
| observability | 15 | unit + Valkey integration | 70% | 94.7% / 83.0% |
| db | 22 | unit + TimescaleDB integration, including migration 0007 and profiles v2 | 70% | 98.4% / 81.3% |
| api | 253 | unit + integration: the SMC endpoints, replays and their digest comparison, the `smc` channel, and the RBAC matrix with the 8 new routes | 70% | 92.0% / 75.1% |
| ingestor | 20 | unit + integration | 70% | 92.4% / 80.6% |
| jobs | 31 | unit + integration, including recent failures for health (defect 6) | 70% | 96.6% / 86.0% |
| analyzer | 21 | unit + integration: Phase 3's eight, updated for one loop and gap markers, and eight for the SMC runtime. Those cover warm-up and projections, live publishing, a killed analyzer taken over and equal to replays, fencing, a gap and its repair, the outbox, gold closures, and lease renewal while busy | 70% | 90.2% / 79.4% |
| app, ui | 116 + 4 | unit (jsdom), including the labelling page and its fixture building | none yet | app 86.7% / 76.8% |
| End to end | 5 | Playwright against the live stack | — | — |

## Decisions made during Phase 4

| Decision | Why | Recorded in |
|---|---|---|
| One engine step per boundary, the 1m profiles first, then each timeframe from the longest down | The rulebook's order when several timeframes close at once, and the thin-book rule reads the 1m profiles of the candle being evaluated | [ADR 017](../adr/017-smc-runtime-boundaries-ids-digests-replays.md) |
| Indicators and SMC share one loop and one checkpoint; the rules version is now `indicators-1+smc-0.1.0` | One deterministic path for live runs, restarts, takeovers and replays; restarts resume from a checkpoint instead of recomputing the run | same |
| A gap holds the whole instrument (strictly in order), not one timeframe | ADR 005; the engine needs every timeframe in order | same |
| Natural keys for events; ids derived from (run, key) | A restart writes the same rows; a replay writes its own | same |
| Replays run in the analyzer, which takes the `replay` queue; each replay records the live run it copied (`source_run_id`) | The engine runtime lives in the analyzer; comparing against exactly that run | same; [architecture §6](../phase-0/03-architecture.md#6-event-backbone) note |
| The thirteen engine choices where the rulebook is silent (I1–I13) | Each is listed with its reason; changing one is a new ruleset version | [Rulebook §14](../phase-0/07-smc-rulebook.md#14-implementation-notes-ruleset-010) |
| Profiles v2 (`crypto-majors`, `gold`) add `smc`; gold's equal-level tolerance is 0.15 ATR and its thin-book threshold $20,000 | The rulebook §10 values for gold | Migration 0007 |
| The labelling page is in development builds only (`CIP_PUBLIC_DEV_TOOLS`: on in the local Compose stack, off in other image builds), for the `fixtures.label` capability (analysts and admins) | §12: development-only | [Architecture §14](../phase-0/03-architecture.md#14-security) roles table; `apps/web/src/main.tsx` |

## Carried forward

| Item | Plan |
|---|---|
| Recorded, reviewed fixtures (§12) | Need two people; the labelling page is ready |
| A 7-day replay of purely live time (4.3) | Run the same CLI command once a stack has run for 7 days (staging) |
| From Phase 3: the indicator trend rule and the volume-anomaly threshold | Still yours to decide; unchanged |
| From Phase 2: decision 1 (NFR-01 against the ticker rate), decision 2 (Coinbase candles for thin products); the chaos tests and the 24 h soak | Unchanged |
| The first CI run, and the nightly live run | Wait for the pull request (D7) |
| History is refetched at each start when the venue has less than 1,100 candles (PAXG-USD 1d) | Unchanged from Phase 3; the instrument waits two minutes per start |
| A first start (or a rules change) holds live work until every run has warmed up: 2.5 minutes for nine instruments, growing with each one (4.6) | Overlap the first warm-ups with live wake-ups: a small change to the analyzer's start |
| The jobs service's detail still lists "backfill: 9 failed": jobs from 02:36 and 03:30 UTC today, before Phase 4, timed out against the venues' REST API | The consistency check repaired those candles afterwards. A Binance trade gap at 02:22–02:23 stayed unrepairable, so those minutes have no micro profiles (their sweeps read `liquidity_unverified`). No gap is open now, and the service reports OK (defect 6). The failed set keeps the jobs for inspection |

## What I need from you

1. **Review the implementation notes I1–I13** ([rulebook §14](../phase-0/07-smc-rulebook.md#14-implementation-notes-ruleset-010)): approve them or change any. A change is a new ruleset version and a new run per instrument.
2. **Recorded fixtures (§12)**: label some with a colleague using `/dev/labelling` (one labels, the other reviews), or accept the synthetic fixtures for now.
3. **Still open**: the Phase 3 trend rule and volume threshold; Phase 2 decisions 1 and 2; D2 hosting; the pull request, which CI needs.
4. Your approval of this report, and whether to commit Phase 4 (and push it).
