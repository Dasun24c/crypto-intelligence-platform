# 08 · Implementation plan and acceptance criteria

| | |
|---|---|
| Status | Approved 2026-11-10 (Phase 0 sign-off, recommended defaults) |
| Date | 2026-11-09 |
| Rule | One phase at a time. A phase starts only after the previous phase's acceptance report is approved. |

Requirement IDs (MD-, GLD-, TA-, SMC-, AI-, VIZ-, UI-, WH-, AL-, WD-, SEC-, ENG-, NFR-) refer to the [requirements analysis](01-requirements-analysis.md).

## How every phase is accepted

**Definition of done (applies to every phase)**

- Work is merged to `main` through reviewed pull requests. CI is green and coverage gates are met.
- Documentation is updated: ADRs, the rulebook if any rule changed, the API contracts if any endpoint changed.
- Migrations are forward-only and have been run against a copy of staging data.
- There are no open critical or high-severity bugs.

**Acceptance report.** Each phase ends with a report listing every criterion below, with its evidence: test run links, logs, recordings or screenshots. A demo follows, then your approval.

## Overview

| Phase | Name | Relative size | Main outcome |
|---|---|---|---|
| 0 | Analysis and design | — | These documents, approved |
| 1 | Foundations | L | Monorepo, CI, Docker stack, authentication, RBAC, audit log, web and desktop shells |
| 2 | Market data | XL | Live, gap-free data from both venues, including PAXG specifics |
| 3 | Technical analysis | M | Validated indicators |
| 4 | SMC structure and liquidity | L | Swings, structure, ranges, liquidity, sweeps; deterministic engine runtime |
| 5 | SMC points of interest | M | Order blocks, FVGs, supply/demand, fill tracking |
| 6 | Patterns, checklist and outcomes | L | The four pattern state machines, scoring, outcome tracking |
| 7 | Charts, Setup Scanner and calendar | L | Liquidity Map, Setup Scanner, economic calendar, blackout windows |
| 8 | Alerts and notifications | M | Rules, inbox, web and desktop notifications |
| 9 | AI intelligence | M | Grok analysis with grounding validation and budget control |
| 10 | 3D visualization | M | Brain driven by real system activity |
| 11 | Whale Tracker | M | Exchange-flow view and on-chain monitoring |
| 12 | Historical analytics and replay UI | M | Outcome statistics, replay comparison, exports |
| 13 | Hardening and release | L | Security review, load and soak tests, signed desktop builds, operations docs |

Sizes are relative (M ≈ 1×, L ≈ 1.5–2×, XL ≈ 2.5–3×). Calendar estimates come with the Phase 1 plan, once team size is known.

---

## Phase 0 — Analysis and design

| # | Criterion |
|---|---|
| 0.1 | Requirements analysis, feasibility, architecture, risks and dependencies, data model, API contracts, SMC rulebook and this plan are delivered |
| 0.2 | The decisions in the [index](README.md#decisions-needed) are answered or explicitly deferred |
| 0.3 | You approve Phase 0 |

## Phase 1 — Foundations

**Scope**

- Monorepo, tooling, CI pipeline and Docker Compose (TimescaleDB, Valkey, Caddy).
- Config validation; logging, metrics and tracing skeleton.
- Migration framework and the `app` schema.
- Authentication (login, MFA, refresh rotation), RBAC, audit log with hash chain, minimal user administration.
- Web and desktop shells sharing `packages/app`, the dark design system base, a System Health skeleton and ADRs 001–012.
- Toolchain spikes: TypeScript 7 with NestJS decorators, Valkey with BullMQ, native modules on Node 26.

| # | Criterion | Covers |
|---|---|---|
| 1.1 | From a fresh clone, one documented command starts the dev stack, and every service reports healthy within 3 minutes | ENG-01 |
| 1.2 | CI runs lint, typecheck, dependency rules, tests, build and a Playwright smoke test on every pull request. A deliberate violation of each check fails the pipeline. | ENG-01 |
| 1.3 | Login works in the web app and in desktop development builds on Windows and macOS. Admins can't log in without MFA. Reusing a rotated refresh token revokes its whole family (integration test). | SEC-02 |
| 1.4 | An automated test calls every endpoint with every role, and the results match the RBAC matrix | SEC-02 |
| 1.5 | Logins (success and failure) and user changes are audited. The hash chain verifies, and the application role can't update or delete audit rows (test). | SEC-02 |
| 1.6 | A CI scan of the built web and desktop artefacts finds no secrets or server environment names | SEC-01 |
| 1.7 | Toolchain pins are confirmed and recorded in ADRs: Node version, TypeScript version (NestJS decorators verified), Valkey passing the BullMQ integration tests (or Redis chosen instead) | ENG-01 |
| 1.8 | Unsigned Tauri bundles build in CI for Windows x64 and macOS universal | WD-01 |

## Phase 2 — Market data

**Scope**

- Binance and Coinbase adapters, plus the replay venue and the message recorder.
- Candle builder (1m to 1d) with micro volume profiles.
- Order books, depth metrics and snapshots.
- Gap and delay detection, backfill, pair-status polling, instrument administration.
- Gold closure calendar, cross-venue spread, large-trade and wall detection.
- Retention policies; market WebSocket channels.
- Basic Command Center, Market Activity and System Health feed views.

| # | Criterion | Covers |
|---|---|---|
| 2.1 | All 9 pairs stream trades, books and tickers. Live prices update in the UI at least once per second. | MD-01 |
| 2.2 | Over 24 h, Binance 1m, 1h, 4h and 1d candles exactly equal the venue's REST klines. Coinbase 1m, 1h and 1d candles match REST candles for every interval with trades, and flat zero-volume candles exist for the rest. | MD-03 |
| 2.3 | Book sequence validation is active. An injected sequence gap triggers a resync within 5 s. Depth metrics are stored every second. | MD-01, MD-08 |
| 2.4 | Chaos tests with 30 s and 10 min network cuts: reconnect ≤ 10 s after the network returns, gap recorded, backfill ≤ 60 s, and no duplicate or missing 1m candles afterwards | MD-04–06, NFR-03 |
| 2.5 | A silent stream is detected within the NFR-04 bound. An injected 3 s latency raises "delayed". | MD-05 |
| 2.6 | 24 h staging soak: no unrepaired gaps, except venue outages recorded as unrepairable with evidence | MD-05, MD-06 |
| 2.7 | An instrument added through the admin API streams without a restart and backfills its history. Disabling it stops its feed. A delisting simulated on the replay venue stops the feed and raises a health alert. | MD-02, MD-07 |
| 2.8 | PAXG candles inside closures are flagged, checked against the generated closure table for a full week. The cross-venue spread uses the USDT-USD conversion and is visible in the UI. | GLD-01, GLD-02, GLD-04 |
| 2.9 | Large trades (merged per taker order) and walls are detected and stored correctly on replay fixtures with known answers | WH-01 |
| 2.10 | NFR-01 latency is measured and met | NFR-01 |
| 2.11 | End-to-end tests in CI use only the replay venue. The nightly live smoke test passes. | ENG-01 |

## Phase 3 — Technical analysis

**Scope**

- The `indicators` package, with streaming and batch versions of each indicator.
- The TA-Lib reference-data tool.
- Indicators running inside analyzer runs, with their API and WebSocket channels.
- The Technical Analysis page.

| # | Criterion | Covers |
|---|---|---|
| 3.1 | RSI, MACD, EMA and ATR match TA-Lib reference output within 1e-9 relative error after the documented warm-up, on 3 instruments × 3 timeframes × 10,000 candles | TA-01, TA-04 |
| 3.2 | VWAP matches hand-verified fixtures exactly, including the 00:00 UTC anchor reset | TA-01 |
| 3.3 | Volume-anomaly and trend detection pass labelled positive and negative fixtures | TA-02, TA-03 |
| 3.4 | Streaming and batch implementations give identical results on the same data (property test) | TA-04 |
| 3.5 | Indicator values are published ≤ 1 s (p95) after candle close. A script confirms the values shown in the UI equal the API's. | NFR-02 |

> **Decided 2026-11-11.** For 3.5 and NFR-02, "candle close" is the moment the candle is final in the platform: the ingestor's `md:candles` entry announcing it. The venue's minute boundary is not the starting point. Coinbase candles, built from trades, become final 2 s after the boundary (the late-trade grace, architecture §5.4), and that grace stays. Measured in Phase 3: p95 114 ms from final candle to published indicators ([Phase 3 report](../phase-3/acceptance-report.md#35-publishing-and-the-ui)).

## Phase 4 — SMC structure and liquidity

**Scope**

- Engine runtime: actors, leases, checkpoints, gap pause, warm-up, runs, event log, digests.
- Swings, BOS/CHOCH/MSS, displacement, ranges and all liquidity level types.
- Sweeps, false breakouts and breakouts, with thin-book and underlying-closed flags.
- Development-only labelling page and labelled fixtures.

| # | Criterion | Covers |
|---|---|---|
| 4.1 | Golden fixtures for every concept in rulebook §2–§3 pass, at the minimum coverage in rulebook §12 | SMC-01, SMC-02 |
| 4.2 | The prefix-stability (no-repaint) property test passes for 1,000 random cut points per fixture | SMC-09 |
| 4.3 | Replaying a stored 7-day period reproduces the live run's digest exactly | NFR-14 |
| 4.4 | Killing the active analyzer mid-run: a standby takes over the lease, and the final digest equals an uninterrupted run | SMC-09 |
| 4.5 | An injected data gap pauses analysis, the UI shows "paused: data gap", and analysis resumes after repair with no published detection changed | MD-06 |
| 4.6 | Engine step p95 ≤ 2 ms; candle close → detections published p95 ≤ 2 s | NFR-02 |
| 4.7 | Thin-book and underlying-closed flags behave as specified on PAXG fixtures | GLD-02, GLD-03 |

## Phase 5 — SMC points of interest

**Scope**: order blocks, FVGs, supply/demand zones, touches, fill percentage, invalidation, internal/external labels.

| # | Criterion | Covers |
|---|---|---|
| 5.1 | Golden fixtures for rulebook §4 pass | SMC-03 |
| 5.2 | Fill percentages and status transitions match fixture expectations | SMC-03 |
| 5.3 | Prefix stability and replay digests still pass with POIs enabled | SMC-09, NFR-14 |

## Phase 6 — Patterns, checklist and outcomes

**Scope**

- Pattern state machines 1–4 with their variants; sweep-anchored MSS.
- Entry zones, hypothetical levels, checklist and score, quality flags.
- Outcome tracking (MFE/MAE, 1m ambiguity resolution).
- Setups API and WebSocket channel; the position-size calculator in `domain`.

| # | Criterion | Covers |
|---|---|---|
| 6.1 | Every pattern and variant passes ≥ 5 positive fixtures per direction and 5 near-misses, including the cards' warnings as negative cases: equal highs alone, an HTF order-block touch alone, a double sweep without MSS | SMC-04 |
| 6.2 | Every transition is stored with its candle, reason and evidence. No transition leaves `resolved` (property test). | SMC-04 |
| 6.3 | Checklist credits and scores match fixtures. A setup failing a mandatory item never reaches `confirmed`. | SMC-05 |
| 6.4 | R:R and position-size results match hand-computed examples, including decimal edge cases | SMC-06 |
| 6.5 | MFE/MAE in R are correct on fixtures, and ambiguous candles are resolved with 1m data | SMC-08 |
| 6.6 | PAXG setups that form during a gold-market closure stay "Watching" with default settings | GLD-03 |
| 6.7 | Over a 7-day staging run, every setup can be traced through the API from its transitions down to its candles | SMC-04 |

## Phase 7 — Charts, Setup Scanner and calendar

**Scope**

- Liquidity Map: charts with SMC overlays, closure shading and the chart library's attribution.
- Setup Scanner and setup detail, including the checklist, R:R and the position-size calculator.
- Technical Analysis charts.
- Economic calendar: FRED and BEA sync, manual FOMC entries, standard release times, blackout windows feeding checklist item 8.

| # | Criterion | Covers |
|---|---|---|
| 7.1 | Overlay parity: an automated test compares what the chart drew (via a test hook) with the overlay API for the same window, and they match 100% | UI-01 |
| 7.2 | The Setup Scanner filters and sorts correctly. Each setup shows its checklist, score, hypothetical levels, R:R and the disclaimer. | SMC-05, SMC-06 |
| 7.3 | The next 60 days of CPI, Employment Situation, GDP, PCE and FOMC events are present with times. The sync is idempotent. Fixtures show the blackout window changing checklist item 8. | SMC-07 |
| 7.4 | An automated text scan finds no "XAUUSD" label anywhere in the UI. Closures are shaded on PAXG charts. | GLD-02, GLD-05 |
| 7.5 | axe checks find no serious violations on the new pages, and keyboard navigation works | NFR-10 |

## Phase 8 — Alerts and notifications

**Scope**: the rule engine for every condition type, de-duplication, cooldowns, quiet hours, the notifications queue, in-app inbox, web and desktop notifications, Alert Center, and the summary of missed alerts.

| # | Criterion | Covers |
|---|---|---|
| 8.1 | Every condition type has unit tests and an end-to-end test from source event to delivered notification | AL-01 |
| 8.2 | Native notifications appear on the Windows and macOS builds (manual checklist with a recording) | WD-01 |
| 8.3 | 100 identical triggers inside the cooldown produce exactly one notification | AL-01 |
| 8.4 | Alerts fired while a client is offline appear in its inbox after reconnecting. The desktop app shows one summary notification. | WD-01 |
| 8.5 | Alerts from catch-up processing are labelled "late" | SMC-09 |
| 8.6 | The rule test endpoint correctly lists what would have fired over the last 24 h | AL-01 |

## Phase 9 — AI intelligence

**Scope**

- The provider interface and the Grok provider (structured outputs).
- Context builder, significance scoring and aggregation, cache, budget guard.
- Validation pipeline and storage of every analysis.
- On-demand requests, the AI Intelligence Center and the usage view.

| # | Criterion | Covers |
|---|---|---|
| 9.1 | In staging, a real Grok call on real context produces an accepted, stored analysis | AI-01, AI-02 |
| 9.2 | A suite of 50+ crafted bad responses is all rejected: invented levels, unknown ids, guarantee language, "XAUUSD", a missing gold note while closed. Valid responses are accepted. | AI-04, SEC-03 |
| 9.3 | With a test cap, calls stop exactly at the cap, the UI shows "AI budget reached", and calls resume the next day | AI-03, NFR-08 |
| 9.4 | A burst of 20 related events produces one call. An identical context within 30 min is served from cache. | AI-03 |
| 9.5 | The Grok key exists only in the jobs service environment. Bundle and image scans find no key. | SEC-01 |
| 9.6 | Every analysis, accepted or rejected, appears in history with its context, response, validation result, tokens and cost | AI-05 |

## Phase 10 — 3D visualization

**Scope**: the brain scene, the activity-feed integration, the state machine and pulses, region mapping, adaptive quality, reduced motion and the 2D fallback.

| # | Criterion | Covers |
|---|---|---|
| 10.1 | Injected activity sequences drive the expected states: idle, receiving, analysing, completion, pattern pulse, error, disconnected | VIZ-01 |
| 10.2 | With zero activity the scene settles at idle parameters. Unit tests on the mapping functions show no state or rate depends on randomness. | VIZ-01 |
| 10.3 | ≥ 50 fps at default quality on Apple M1 and Intel Iris Xe class hardware. Adaptive quality engages below 45 fps. | NFR-12 |
| 10.4 | Rendering pauses when hidden, reduced motion is respected, and the text status is always visible | NFR-10 |

## Phase 11 — Whale Tracker

**Scope**

- The Exchange flow tab (large trades and walls).
- On-chain monitoring with the chosen providers: BTC, ETH and SOL large transfers; PAXG large transfers and supply events.
- Exchange-address labels, either curated by hand or from a provider.

| # | Criterion | Covers |
|---|---|---|
| 11.1 | The Exchange flow tab matches stored large trades and walls | WH-01 |
| 11.2 | On-chain events arrive by push within the provider's documented latency and are de-duplicated. A known historical PAXG mint and burn are captured correctly. | WH-02 |
| 11.3 | Exchange and on-chain data never appear in the same list or chart | WH-01, WH-02 |
| 11.4 | Each provider's terms of use are reviewed and recorded before go-live | WH-02 |

## Phase 12 — Historical analytics and replay UI

**Scope**

- Outcome statistics by pattern, variant, TF pair, instrument, session and rules version.
- The replay UI, including run comparison.
- CSV exports.

| # | Criterion | Covers |
|---|---|---|
| 12.1 | Displayed statistics reconcile with direct database queries (automated) | SMC-08 |
| 12.2 | Labels say "historical observations" and never imply expected performance | SMC-08 |
| 12.3 | A replay started from the UI matches the live digest for overlapping periods. When parameters differ, the differences are listed. | SMC-08, NFR-14 |

## Phase 13 — Hardening and release

**Scope**

- Security review against ASVS Level 2, dependency and image audits.
- Load test, 72 h soak test, backup and restore drill.
- Signed and notarized desktop builds with auto-update.
- Deployment guide, runbooks, and final acceptance against the requirements.

| # | Criterion | Covers |
|---|---|---|
| 13.1 | The ASVS Level 2 checklist is complete with no open high-severity findings | NFR-09 |
| 13.2 | 50 concurrent clients and 50 instrument pairs (replay venue at real-time speed) meet NFR-01 and NFR-02 | NFR-07 |
| 13.3 | 72 h soak on live data: ≥ 99.5% availability, all recoveries automatic | NFR-05 |
| 13.4 | A backup restores into a fresh environment, and a replay digest there matches production for a sample period | NFR-14 |
| 13.5 | The signed Windows installer and notarized macOS app install cleanly, and auto-update from the previous version works | WD-01 |
| 13.6 | Someone who didn't build the system follows the deployment guide and gets a running stack | ENG-01 |
| 13.7 | Every item in the requirements' final acceptance criteria is demonstrated with evidence | All |

## Mapping to the final acceptance criteria

| Final criterion (REQUIREMENTS.md) | Proven in |
|---|---|
| Genuine live data for crypto and PAXG | 2.1, 2.6, 2.8 |
| Validated technical indicators | 3.1–3.4 |
| Deterministic SMC detection without repainting, validated against labelled data | 4.1–4.4, 5.1–5.3, 6.1–6.3 |
| Checklist, hypothetical levels and R:R per setup, labelled educational | 6.3–6.4, 7.2 |
| PAXG flagged during closures and never presented as XAUUSD | 2.8, 6.6, 7.4, 9.2 |
| AI analysis from real input data | 9.1, 9.6 |
| 3D visualization shows actual processing states | 10.1, 10.2 |
| History of analyses, signals, setup states and outcomes | 6.2, 6.5, 9.6, 12.1 |
| Configurable alerts | 8.1–8.6 |
| Web and desktop | 1.3, 1.8, 8.2, 13.5 |
| Recovery from network interruptions | 2.4, 2.6, 8.4 |
| Automated tests and deployment documentation | 1.2, 13.6 |
