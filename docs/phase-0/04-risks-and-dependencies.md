# 04 · Risks and third-party dependencies

| | |
|---|---|
| Status | Approved 2026-11-10 (Phase 0 sign-off, recommended defaults) |
| Date | 2026-11-09 |
| Review | At the end of every phase, as part of its acceptance report |

## 1. Risk register

Likelihood (L) and impact (I) are rated High, Medium or Low.

### Market data

| ID | Risk | L | I | Mitigation | Phase |
|---|---|---|---|---|---|
| R01 | The hosting region is blocked by Binance, or the venues' terms restrict our use | M | H | Probe the region before provisioning (D2). Legal read of the terms before production. Feed health alerts on HTTP 451/403. | 1, 13 |
| R02 | A venue changes or withdraws its API (Coinbase already moved `level2` behind authentication) | M | H | Adapters isolated behind normalised events; contract tests on recorded payloads; nightly live smoke tests; venue changelogs on the watch list | 2 onward |
| R03 | Rate limits or IP bans during backfills and book resyncs (a 5,000-level Binance snapshot costs 250 of the 6,000 weight per minute) | M | M | Token-bucket budgeter mirroring venue weights; `Retry-After` honoured; staggered resyncs; Binance market-data hosts | 2 |
| R04 | Coinbase data quality: `matches` can drop messages, and 37% of PAXG minutes have no trades | H | M | Gap detection from sequence and heartbeat `last_trade_id`, REST repair; empty minutes treated as no-trade candles; Binance primary for PAXG | 2 |
| R05 | Data gaps pause analysis for long periods | M | M | Fast backfill; gap declared unrepairable after a retry window; pause visible in the UI and on System Health | 2, 4 |
| R06 | Clock drift between our hosts and the venues distorts latency and delay detection | L | M | chrony on all hosts; offset checks against venue server time | 2 |

### SMC analysis

| ID | Risk | L | I | Mitigation | Phase |
|---|---|---|---|---|---|
| R07 | The exact rules don't match what analysts see on a chart (SMC is normally discretionary) | H | H | Rulebook approval; two-reviewer labelled fixtures; calibration in Phases 4–6; explicit judgement calls (J1–J10) | 0, 4–6 |
| R08 | Repainting or look-ahead bugs | M | H | Pure reducer on closed candles; prefix-stability property tests; replay digests in CI | 4–6 |
| R09 | Parameters overfit to recent history | M | M | Versioned, immutable profiles; no automatic tuning; statistics per version; review on periods not used for calibration | 6, 12 |
| R10 | Many false positives in ranging or thin markets (PAXG weekends) | H | M | Mandatory checklist items; quality flags; no confirmations during gold-market closures; thin-book sweeps don't count | 4–6 |
| R11 | Computation cost grows with instruments × timeframes | L | M | Incremental engine; benchmarks with a p95 budget; analyzer partitioning by instrument | 4, 13 |
| R12 | Users treat setups or AI output as trading advice | M | H | "Educational analysis — not financial advice" on every setup; hypothetical levels labelled as such; no execution features; AI policy lint; legal review before access widens beyond the organisation | 6–9 |
| R13 | PAXG-specific issues: premium or discount to spot gold, USDT de-pegging, delisting, weekend behaviour | M | M | USDT-USD conversion; cross-venue spread monitoring and alerts; delisting handling; gold profile; spot-gold feed available as a later option | 2, 6 |

### AI

| ID | Risk | L | I | Mitigation | Phase |
|---|---|---|---|---|---|
| R14 | The model invents levels or numbers | M | H | Context items carry ids; responses must cite them; numeric grounding check; rejected responses stored and shown as unavailable | 9 |
| R15 | Spending overruns | L | M | Daily and monthly hard caps; aggregation; caching; low reasoning effort | 9 |
| R16 | A model is retired at short notice, or the API is down | M | M | Model ids in settings; availability check at startup; configured fallback model; "AI unavailable" state; provider interface allows another vendor | 9 |
| R17 | Data handling at the AI provider (30-day retention) | L | L | Only market data is sent, never personal data; zero-retention option available | 9 |

### Platform and delivery

| ID | Risk | L | I | Mitigation | Phase |
|---|---|---|---|---|---|
| R18 | 3D performance on weak GPUs or in WKWebView | M | M | Adaptive quality; 2D fallback; performance tests on reference hardware | 10 |
| R19 | Desktop signing cost and process; loss of the updater signing key | M | H | Budget early; key in a secrets manager with an offline backup; documented rotation | 13 |
| R20 | Market-data licensing if the platform is shared outside the organisation | L | H | Stay internal (A1); legal review before any wider distribution | 13 |
| R21 | On-chain provider cost, terms or coverage (labels are expensive; free tiers may forbid commercial use) | M | M | Decide in Phase 11; curated labels first; provider abstraction | 11 |
| R22 | Economic calendar: BLS blocks automated access; FOMC times aren't machine-readable | H | L | FRED + BEA + admin-entered FOMC dates; `time_confirmed` flag; checklist item fails safe as `calendar_unavailable` | 7 |
| R23 | BullMQ doesn't list Valkey as supported; Redis 8 is AGPL-licensed | M | M | Compatibility gate in Phase 1; fall back to unmodified Redis 8 for internal use | 1 |
| R24 | TimescaleDB licence (no database-as-a-service) and renamed columnstore API | L | M | Self-hosted use only; confirm function names in the first migration; use the Community image | 1 |
| R25 | Toolchain freshness: Node 26 LTS is two weeks old; TypeScript 7 + NestJS decorators unproven; Socket.IO Redis packages last released 2023–24 | M | M | Phase 1 spikes with fallbacks: Node 24, TypeScript 6, alternative adapter | 1 |
| R26 | Security: stolen credentials, token leakage, XSS in the desktop WebView, supply-chain compromise | M | H | Controls in architecture §14; ASVS Level 2 review; SBOM and image scanning | 1, 13 |
| R27 | Scope and schedule: 13 gated phases | H | M | Relative sizing; risky items tackled early as spikes; acceptance reports keep scope visible | All |
| R28 | Data growth (trades, book metrics) | M | L | Retention and columnstore policies; per-instrument raw-trade storage flag; capacity monitoring | 2 |
| R29 | A single VM is a single point of failure | M | M | Fits the 99.5% target; backups and restore drills; documented rebuild; scaling path | 13 |
| R30 | Labelling SMC fixtures by hand takes real analyst time | H | M | Labelling page in Phase 4; synthetic fixtures for edge cases; two-reviewer rule only for recorded fixtures | 4–6 |

## 2. Third-party dependency register

| Dependency | Used for | Access | Cost | Licence / terms | Key limits | Fallback | Status (2026-11-09) |
|---|---|---|---|---|---|---|---|
| Binance Spot public API | Market data; PAXG primary | Public, no key | Free | Binance terms (legal read pending) | 6,000 weight/min/IP; WS 1,024 streams/connection, 300 connections/5 min, 5 messages/s, 24 h lifetime | `data-stream` / `data-api` hosts; replay venue in tests | Verified by live probe |
| Coinbase Exchange public API | Market data; PAXG secondary; USDT-USD | Public, no key (`matches`, `level2_batch`, `ticker`, `heartbeat`, `status`) | Free | Coinbase terms (legal read pending) | REST 10 req/s; WS 8 req/s per IP, 100 messages/s, 10 subscriptions per product per channel | Advanced Trade public channels | Verified by live probe |
| xAI Grok API | AI analysis | API key, jobs service only | ~$19–86/month (grok-4.3) | xAI terms; 30-day retention; no training without permission | Tier 0: 37 req/s, 10M tokens/min (grok-4.3) | Fallback model; provider interface | Verified (acceptable-use page unread) |
| FRED API | Release dates | Free key | Free | FRED terms (unread) | — | Manual entries | Verified (docs) |
| BEA release schedule | GDP and PCE dates and times | Public JSON / ICS | Free | — | — | FRED dates + standard times | Verified (fetchable) |
| Federal Reserve FOMC calendar | FOMC meeting dates | Manual entry from HTML | Free | — | — | — | Verified (page) |
| On-chain providers | Whale Tracker on-chain tab | API keys / webhooks | $0–150/month (+ labels) | Varies; free tiers often personal-use only | Varies | Curated labels; second provider | Decision in Phase 11 |
| Spot-gold feed | PAXG premium vs spot | API key | $79–229/month if adopted | Display rights vary by plan | — | None needed | Deferred (D8) |
| TimescaleDB | Time-series storage | Docker image | Free | Apache-2.0 core + Timescale License features | Not offerable as a service | Plain PostgreSQL partitioning | Verified |
| Valkey (or Redis 8) | Streams, queues, caches, leases | Docker image | Free | BSD-3 (Valkey) / RSALv2, SSPLv1 or AGPLv3 (Redis) | — | Redis 8 | Verified licences |
| TradingView Lightweight Charts | Candlestick charts with overlays | npm | Free | Apache-2.0 + visible attribution | — | Apache ECharts, KLineCharts | Licence verified; primitives to prototype |
| Tauri 2 + plugins | Desktop app | npm / cargo | Free | MIT or Apache-2.0 | — | — | Verified version |
| TA-Lib | Indicator reference data (dev only) | pip | Free | BSD | — | Hand-verified fixtures | Verified |
| Apple Developer Program | macOS signing and notarization | Paid account | $99/year | Apple terms | — | Unsigned dev builds only | Price verified |
| Windows code signing | Signed installer | Certificate or Azure Artifact Signing | Quote needed | — | — | Unsigned (SmartScreen warnings) | Pending |
| GitHub (Actions, Container Registry) | CI/CD and images | Organisation account | Depends on plan | GitHub terms | Runner minutes | GitLab CI | Assumed (D7) |
| Hosting provider | Production and staging VMs | Account | Quote needed | — | Must be a Binance-accessible region | Another provider | Pending (D2) |
| Let's Encrypt (through Caddy) | TLS certificates | Automatic | Free | — | Issuance rate limits | Commercial certificate | Standard |

## 3. Watch list

- Binance Spot API and Coinbase Exchange changelogs: API changes and deprecations.
- xAI model pages and migration guides: model retirements.
- Node.js 26 patch releases (security fixes).
- Tauri 2.x releases (stay off the v3 alpha until it's stable).
- TimescaleDB release notes: API renames.
- BullMQ release notes: Valkey support.
