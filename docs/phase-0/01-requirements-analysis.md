# 01 · Requirements analysis

| | |
|---|---|
| Status | Approved 2026-11-10 (Phase 0 sign-off, recommended defaults) |
| Phase | 0 — Analysis and design |
| Date | 2026-11-09 |
| Source | [REQUIREMENTS.md](../../REQUIREMENTS.md), revision 3 |

## 1. What we are building

A self-hosted platform that watches live public market data from Binance and Coinbase for BTC, ETH, SOL and gold (through the PAXG token). It calculates technical indicators, detects Smart Money Concepts (SMC) structure and four liquidity-trap patterns, asks Grok to explain significant events, and presents everything in a web app and a Windows/macOS desktop app. It never trades. Every visual state (charts, overlays, the 3D "brain") must come from real backend data and real processing.

## 2. Working assumptions

These assumptions shape the design. Each one lists what changes if it turns out to be wrong. The decisions that need your answer are collected in the [Phase 0 index](README.md#decisions-needed).

| ID | Assumption | Impact if wrong |
|---|---|---|
| A1 | One organisation self-hosts the platform for a small number of named users (up to about 50). It is not a public SaaS product. | A public service would need multi-tenancy, a market-data redistribution licence review, stronger abuse controls and a larger scaling plan. |
| A2 | Three roles: **admin**, **analyst**, **viewer**. | The RBAC matrix in the architecture needs changing. |
| A3 | Only public market data is used. The initial release stores **no exchange API keys**, so no exchange secret can leak to a client. | If an exchange channel needs authentication (see feasibility), a read-only key is stored on the server only. |
| A4 | The backend runs in a hosting region where Binance's public API is reachable. | Binance blocks some locations. The wrong region means no Binance data at all. |
| A5 | 9 instrument–venue pairs at launch: 8 monitored pairs plus Coinbase USDT-USD as a reference for currency conversion. The design ceiling is 50 pairs. | More pairs need more analyzer instances (horizontal scaling is designed in). |
| A6 | The desktop app is a client of the same backend. It runs no backend services and no analysis locally. | An offline-capable desktop app would need a local database and engine: a much larger project. |
| A7 | Data is stored in UTC. Users choose their display time zone. The UI is in English. | Localisation would add an i18n layer to Phase 1. |
| A8 | Notifications reach users while the web tab or desktop app is running. Alerts that fire while a user is offline wait in their in-app inbox. | Email, mobile push or chat delivery (Telegram, Slack) would add channels in Phase 8. |

## 3. Functional requirements catalogue

Each requirement gets a stable ID. Tests and acceptance reports reference these IDs. Phase numbers refer to the [implementation plan](08-implementation-plan.md).

### Market data

| ID | Requirement | Spec | Phase |
|---|---|---|---|
| MD-01 | Binance and Coinbase public connectors: trades, candles, L2 order book and ticker | §1 | 2 |
| MD-02 | Instruments can be added, enabled and disabled at runtime without a code change | §1 | 2 |
| MD-03 | Candles for 1m, 5m, 15m, 1h, 4h and 1d, with a history backfill at startup | §1 | 2 |
| MD-04 | Reconnect with backoff, resubscribe, and resynchronise order books | §1 | 2 |
| MD-05 | Detect missing data (sequence gaps, silent streams, missing candle closes) and delayed data (exchange-time lag) | §1 | 2 |
| MD-06 | Backfill gaps through REST. Analysis that depends on the gap waits for the repair (see §6) | §1, §3.1 | 2, 4 |
| MD-07 | Poll trading-pair status and handle halts and delistings without crashing | §1 | 2 |
| MD-08 | Order-book imbalance and depth metrics | §2 | 2 |

### Gold (PAXG)

| ID | Requirement | Spec | Phase |
|---|---|---|---|
| GLD-01 | PAXG on Binance (primary) and Coinbase (secondary), with detection run separately per venue | §1.1 | 2 |
| GLD-02 | Gold-market closure calendar, "underlying closed" candle flags, chart shading | §1.1 | 2 (flags), 7 (shading) |
| GLD-03 | Thin-book wick detection and liquidity minimums for setups | §1.1 | 4, 6 |
| GLD-04 | Cross-venue price difference (USDT converted with Coinbase USDT-USD) with an alert | §1.1 | 2, 8 |
| GLD-05 | Labelling: always "PAXG (gold-backed token)", never "XAUUSD", in the UI and in AI output | §1.1 | 7, 9 |
| GLD-06 | Optional spot-gold (XAUUSD) reference feed | §1.1 | Deferred (decision) |

### Technical analysis

| ID | Requirement | Spec | Phase |
|---|---|---|---|
| TA-01 | RSI, MACD, EMA, VWAP and ATR | §2 | 3 |
| TA-02 | Volume anomaly detection | §2 | 3 |
| TA-03 | Market trend detection (indicator-based; separate from SMC structure trend) | §2 | 3 |
| TA-04 | Validation against reference datasets | §2 | 3 |

### Smart Money Concepts

| ID | Requirement | Spec | Phase |
|---|---|---|---|
| SMC-01 | Swings, trend, BOS, CHOCH/MSS, displacement, trading ranges | §3.2 | 4 |
| SMC-02 | Liquidity levels (EQH/EQL, previous day/week/month, sessions, weekend, range) plus sweeps and false breakouts | §3.3 | 4 |
| SMC-03 | Order blocks, FVGs, supply/demand zones, fill tracking, internal/external labels | §3.4 | 5 |
| SMC-04 | Pattern state machines for patterns 1–4, bullish and bearish | §3.5 | 6 |
| SMC-05 | Confluence checklist and score | §3.6 | 6 |
| SMC-06 | Risk reference: R:R and the position-size calculator | §3.7 | 6 (calculation), 7 (UI) |
| SMC-07 | Session volatility, economic calendar and blackout windows | §3.8 | 7 |
| SMC-08 | Outcome tracking, statistics, replay mode, labelled golden fixtures | §3.9 | 6 (tracking), 12 (stats and replay UI) |
| SMC-09 | No look-ahead, closed candles only, versioned rules and parameters | §3.1 | 4–6 |

### AI, visualization, UI, alerts, platform

| ID | Requirement | Spec | Phase |
|---|---|---|---|
| AI-01 | Grok called from the backend only | §4 | 9 |
| AI-02 | Structured responses: stance, observations, indicators, risks, invalidation, competing scenario | §4 | 9 |
| AI-03 | Event-driven triggers (including SMC events), aggregation, caching, budget control | §4 | 9 |
| AI-04 | Grounding validation: no price level that the engine didn't produce | §4 | 9 |
| AI-05 | Stored history of every analysis, including rejected ones | §4 | 9 |
| VIZ-01 | 3D brain driven only by real system activity (idle, receiving, analysing, pattern detected, completed, error) | §5 | 10 |
| UI-01 | Pages: Command Center, AI Intelligence Center, Technical Analysis, Liquidity Map, Setup Scanner, Economic Calendar, Market Activity, Whale Tracker, Alert Center, Historical Analytics, System Health | §6 | 2–12 |
| WH-01 | Exchange large-trade and order-book wall detection | §7 | 2 (detection), 11 (UI) |
| WH-02 | On-chain wallet monitoring, after the provider evaluation | §7 | 11 |
| AL-01 | Configurable alerts of every listed type, with de-duplication, rate limits, and in-app, web and desktop delivery | §8 | 8 |
| WD-01 | Shared components, same backend, desktop notifications, Windows and macOS packages, resync after reconnect | §9 | 1 (shells), 8 (notifications), 13 (signed builds) |
| SEC-01 | Credentials protected; the AI key stays on the backend; no exchange secrets in clients | §10 | 1 onward |
| SEC-02 | Authentication, RBAC authorization, audit logging | §10 | 1 |
| SEC-03 | AI output validation | §10 | 9 |
| SEC-04 | No trading and no order placement anywhere | §10 | All |
| ENG-01 | Monorepo, clean architecture, typed contracts, migrations, environment configuration, structured logging, automated tests, Docker, CI/CD, documentation including the SMC rulebook | Engineering | 1 onward |

## 4. Non-functional requirements (proposed targets)

The spec asks for "maintainable, secure, scalable and reliable" without numbers. These targets make that testable. They are proposals for approval.

| ID | Quality | Target | How it's measured |
|---|---|---|---|
| NFR-01 | Market data latency | Exchange message received → emitted on our WebSocket: p95 ≤ 100 ms. To a browser in the same region: p95 ≤ 500 ms. | Timestamps in every message; latency histogram |
| NFR-02 | Analysis latency | Candle close → indicators and SMC detections published: p95 ≤ 2 s for 9 pairs × 6 timeframes | Engine metrics |
| NFR-03 | Recovery | Reconnect begins ≤ 1 s after a disconnect is detected; feed restored ≤ 10 s after the network returns; a gap of up to 15 min backfilled ≤ 60 s after reconnecting | Chaos tests (network cut with a proxy) |
| NFR-04 | Silent-stream detection | A silent stream is detected within max(30 s, 3 × its expected heartbeat interval) | Chaos tests |
| NFR-05 | Availability | API and real-time gateway available 99.5% per month, single region, excluding announced maintenance | Uptime probe |
| NFR-06 | Retention | Candles, detections, setups and AI analyses kept indefinitely; raw trades 14 days; order-book snapshots 14 days; order-book metrics 90 days; audit log at least 1 year | Retention policies plus a monthly check |
| NFR-07 | Capacity | 9 pairs at launch; 50 pairs by adding analyzer instances; 50 concurrent client sessions | Load test in Phase 13 |
| NFR-08 | AI cost | Hard daily and monthly spending caps; the system stops calling the AI at the cap | Budget tests |
| NFR-09 | Security | OWASP ASVS (current version) Level 2 as the baseline | Phase 13 security review |
| NFR-10 | Accessibility | WCAG 2.2 AA for the 2D interface; reduced-motion respected; the 3D view always has a text status next to it | Automated axe checks plus a manual review |
| NFR-11 | Desktop platforms | Windows 10/11 x64; macOS on Apple silicon and Intel (minimum version fixed in Phase 1) | CI build matrix |
| NFR-12 | 3D performance | ≥ 50 fps at default quality on an integrated GPU (e.g., Apple M1, Intel Iris Xe); quality drops automatically below 45 fps | In-app frame-time telemetry |
| NFR-13 | Observability | JSON logs with correlation IDs; metrics for every feed, queue and worker; traces for API and AI calls | Present in Phase 1 skeleton |
| NFR-14 | Determinism | Replaying stored candles produces exactly the same detection digest as live processing | Replay tests in CI |
| NFR-15 | Test coverage | ≥ 90% line coverage for the domain packages (indicators, SMC engine, contracts, AI validation); ≥ 70% for services | CI coverage gates |

## 5. Out of scope for the initial release

- Placing orders, exchange accounts, portfolios or anything that moves money.
- Strategy backtesting with profit and loss, fees or slippage. Setup outcomes are tracked in R multiples only.
- Mobile apps.
- A public, multi-tenant service.
- The XAUUSD reference feed (optional; see decisions).
- Notifications when the app is closed (email, mobile push, chat).
- Automatic tuning of SMC parameters from outcomes.
- News or social-media sentiment. The AI sees only the data the platform gives it.

## 6. Conflicts and ambiguities found, with proposed resolutions

| # | Finding | Proposed resolution |
|---|---|---|
| C1 | §1 says to recompute SMC state after a gap is backfilled. §3.1 says detections must never repaint. | Analysis for an instrument **pauses at a data gap** and resumes once the gap is repaired, so nothing published ever has to be recomputed. If a gap can't be repaired, the engine processes a gap marker and flags affected setups `data_gap` (rulebook §9). |
| C2 | "Never expose exchange secrets" assumes there are secrets. | None are needed for public data (A3). The rule still applies to the Grok key and any future provider keys. |
| C3 | "Market trend detection" (§2) and SMC trend (§3.2) are different signals. | Keep both, clearly labelled: the indicator trend (EMA alignment and slope) and the structure trend (swing-based). |
| C4 | The Pattern 4 summary card shows a continuation ("sweep, fill, then expand"). The detailed card shows a reversal toward an internal FVG. | Implement the detailed card's reversal definition first. The continuation variant is a separate judgement call (rulebook J7). |
| C5 | Checklist item 1 asks for higher-timeframe trend alignment, but patterns 1, 2 and 4 are usually reversals. | Full credit when aligned. Half credit when the higher timeframe is ranging and the sweep happened in its premium zone (bearish) or discount zone (bullish). Otherwise no credit (rulebook §7). |
| C6 | "Desktop notifications" doesn't say whether they're needed while the app is closed. | Only while the app is running (A8). A tray option keeps the app running in the background. |
| C7 | "Configurable cryptocurrencies" doesn't say which symbols. | Any spot pair the venue lists. Adding one triggers a history backfill and requires an instrument profile. |
| C8 | The 3D "receiving data" state has no definition. | Defined from measured message rates and job counts (architecture §12). |
| C9 | "Whale Tracker" covers two different things. | Two tabs: **Exchange flow** (large trades, order-book walls) and **On-chain** (wallet transfers). They are never mixed. |

## 7. Traceability

- Every acceptance criterion in the [implementation plan](08-implementation-plan.md) cites the requirement IDs it covers.
- Test names carry the requirement ID (for example `MD-05: detects Binance depth sequence gap`), so a coverage report can list untested requirements.
- Each phase ends with an acceptance report that lists every criterion with its evidence (test run, log excerpt, recording).
