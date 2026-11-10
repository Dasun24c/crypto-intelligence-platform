# 02 · Feasibility assessment

| | |
|---|---|
| Status | Approved 2026-11-10 (Phase 0 sign-off, recommended defaults) |
| Date | 2026-11-09 |
| Method | Official documentation, read on 2026-11-09, plus live probes of the public exchange APIs run the same day (around 16:50 UTC). Facts that couldn't be confirmed are listed in §11, not presented as fact. |

## 1. Verdict

**The platform is feasible with the specified stack.** No requirement depends on a capability that doesn't exist, and every external data source used at launch is free or low-cost.

These constraints shape the design:

1. **Hosting region.** Binance blocks some locations. The backend must run where Binance's public API is reachable. The probes ran from a non-restricted location and got normal responses.
2. **Coinbase.** The Exchange API's full `level2` order-book channel now requires authentication. The unauthenticated `level2_batch` channel (50 ms batches) is used instead, so no exchange key is needed.
3. **PAXG liquidity.** Measurements confirm Binance PAXG/USDT as the primary venue. Coinbase PAXG-USD had no trades in 37% of minutes.
4. **AI cost** is modest: about $19–86 a month with grok-4.3 at 100–300 calls a day.
5. **Economic calendar**: free from official sources. BLS blocks automated downloads, so release dates come from FRED and BEA, and FOMC dates are entered by an admin.
6. **Spot-gold (XAUUSD) feed**: no provider met every requirement at a reasonable price. It stays deferred.
7. **On-chain monitoring** is feasible for about $0–150 a month. Exchange-address labels cost $699+ a month, so curated labels are proposed first. The decision belongs to Phase 11.
8. **Stack**: all components are current. A few combinations need a short Phase 1 check (§7.3).

## 2. Requirement by requirement

| Area | Feasible? | Evidence and constraints |
|---|---|---|
| Live market data (MD) | Yes | Both venues' public WebSocket and REST APIs work without keys (§3) |
| Gap detection and recovery | Yes | Binance book update ids and trade ids; Coinbase per-product sequence and heartbeat `last_trade_id`; REST backfill on both (§3) |
| Candles 1m–1d | Yes | Binance: all intervals streamed and in REST. Coinbase: 1m built from trades; 4h must be aggregated (§3.2) |
| PAXG (GLD) | Yes, with care | Thin on Coinbase; behaves very differently while the gold market is closed (§4) |
| Technical analysis (TA) | Yes | TA-Lib 0.8.3 provides reference data, with binary wheels for every desktop OS (§7) |
| SMC engine | Yes. The main risk is agreement on definitions, not technology. | Deterministic rules in the [rulebook](07-smc-rulebook.md); labelled fixtures needed |
| AI (Grok) | Yes | Structured outputs with a schema guarantee; the OpenAI SDK works; rate limits far above our load (§5) |
| 3D visualization | Yes | Three.js 0.187 + React Three Fiber 9.8; WebView performance to verify in Phase 10 |
| Whale tracking | Exchange flow: yes. On-chain: yes, with a cost decision. | §9 |
| Web + desktop | Yes | Tauri 2.12; notification and updater plugins available; signing costs in §8 |
| Security | Yes | No exchange secrets needed at all; the AI key stays server-side |

## 3. Market data venues

### 3.1 Binance Spot

| Fact | Value |
|---|---|
| WebSocket hosts | `wss://stream.binance.com:9443` (or `:443`); market-data-only `wss://data-stream.binance.vision` (live-tested) |
| Connection limits | 1,024 streams per connection; 300 new connections per 5 min per IP; 5 incoming messages/s per connection (pings and control messages count) |
| Connection lifetime | 24 h, with a `serverShutdown` warning. The server pings every 20 s; no pong within 1 min means disconnect. |
| Kline intervals | 1s, 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 1d, 3d, 1w, 1M: all six required timeframes are native |
| Empty minutes | Klines are published for minutes with no trades: OHLC carried forward, 0 trades |
| Order book | `@depth@100ms` diff stream plus the documented snapshot procedure (buffer, fetch `/api/v3/depth`, apply where `U ≤ lastUpdateId+1 ≤ u`, restart on gaps) |
| aggTrade | Aggregates fills of one taker order **at one price**. A taker crossing several price levels produces several aggTrades. |
| REST limits | 6,000 weight per minute per IP. `klines`: weight 2, max 1,000; `aggTrades`: 4, max 1,000; `depth`: 5–250 depending on size (5,000 levels = 250) |
| Rate-limit behaviour | 429 means back off; continuing leads to a 418 IP ban (2 minutes up to 3 days). `Retry-After` is sent with both. |
| Market-data REST host | `data-api.binance.vision` (live-tested) |

Sources: [WebSocket streams](https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams), [market-data endpoints](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints), [general API information](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/general-api-information).

### 3.2 Coinbase

Coinbase has two public APIs. The platform uses the **Exchange API** because its trade messages carry order ids and per-product sequence numbers, which large-trade grouping and gap detection need.

| Fact | Exchange API (chosen) | Advanced Trade API (fallback) |
|---|---|---|
| Unauthenticated channels (live-tested) | `ticker`, `matches`, `heartbeat`, `status`, `level2_batch` | `level2`, `market_trades`, `ticker`, `candles`, `heartbeats`, `status` |
| Full order book | `level2` **requires authentication**. `level2_batch` (aliased `level2_50`, 50 ms batches) works without. | `level2` worked without auth in the probe, but the docs don't promise that |
| Trades | `matches` includes `trade_id`, `maker_order_id`, `taker_order_id` and `sequence`. The docs warn messages can be dropped. | `market_trades`: no order ids |
| Gap detection | Per-product `sequence` (+1 per message), plus a 1/s heartbeat carrying `last_trade_id` | Per-connection `sequence_num`, plus heartbeats |
| REST candles | Granularity 60, 300, 900, 3600, 21600 or 86400 s only; **4h returns 400 "Unsupported granularity"**; max 300 per request | Includes `FOUR_HOUR`; max 350 per request |
| Empty intervals | **Omitted**: no candle is returned for minutes without trades | Same |
| Rate limits | REST 10 requests/s per IP (burst 15). WebSocket: 8 requests/s per IP (burst 20), 100 messages/s. 10 subscriptions per product per channel. | Not documented on the pages read |

Sources: [channels](https://docs.cdp.coinbase.com/exchange/websocket-feed/channels.md), [WebSocket overview](https://docs.cdp.coinbase.com/exchange/websocket-feed/overview.md), [REST rate limits](https://docs.cdp.coinbase.com/exchange/rest-api/rate-limits.md), [WebSocket rate limits](https://docs.cdp.coinbase.com/exchange/websocket-feed/rate-limits.md), [candles](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles.md).

**Design consequences** (already reflected in the architecture):

- Coinbase 1m candles are built from `matches`. 4h is aggregated from 1h.
- Missing Coinbase candles mean "no trades", not missing data. The builder writes flat zero-volume candles so both venues have every minute.
- Dropped `matches` messages are detected by sequence and heartbeat `last_trade_id`, then repaired from REST.

### 3.3 Measured liquidity (2026-11-09, ~16:52 UTC)

Depth is the USD notional resting within the given distance of mid, as bid / ask. Values are from the first of two snapshots taken a few seconds apart.

| Pair | Spread | ±0.1% | ±0.5% | ±1% | 24h volume |
|---|---|---|---|---|---|
| Binance PAXG/USDT | 0.02 bps (one tick) | $172k / $232k | $683k / $681k | $835k / $1.20M | $14.8M (64.9k trades) |
| Coinbase PAXG-USD | 2.0–2.7 bps | $40k / $57k | $1.24M / $341k | $1.67M / $452k | ~$1.8M |
| Binance BTC/USDT | ~0 bps | $5.4M / $4.0M | $9.4M / $8.5M | $10.6M / $10.7M | $1.41B |
| Coinbase BTC-USD | ~0 bps | $2.9M / $2.8M | $9.1M / $13.1M | $13.9M / $14.0M | ~$735M |

- Near the price (±0.1%), Binance PAXG has about 4× the depth of Coinbase and 8× the volume. A single $100k market order on Coinbase PAXG would move the price more than 0.1%.
- Coinbase's deeper PAXG levels include far-away resting orders, so ±0.1–0.5% is the meaningful measure.
- A 5,000-level Binance snapshot covers about ±1.5% for BTC but much more for PAXG, so ±1% metrics are fully covered for both.

### 3.4 Thinness and gold-market hours

| Measure | Result |
|---|---|
| Binance PAXG/USDT, last 1,000 1m candles | 12 (1.2%) had no trades |
| Coinbase PAXG-USD, last 300 minutes | 112 minutes (37%) had no candle at all. BTC-USD had none missing over the same window. |
| Binance PAXG/USDT 1h candles inside the gold-market weekend closure (295 hours) vs other hours (705) | Volume 54 vs 155 PAXG/h (35%); average range 6.7 vs 32.5 bps (21%); trades 679 vs 1,724 per hour |

PAXG keeps trading while the gold market is closed, but on about a third of the volume and a fifth of the price range. This supports the rulebook's defaults: the closure flag, separate gold parameters, and no confirmed setups during closures.

### 3.5 Hosting region and terms

- The probes got normal responses (no HTTP 451), so the current location can reach Binance. The production hosting region must be checked the same way before provisioning (decision D2).
- The Binance and Coinbase terms on restricted jurisdictions and on displaying market data weren't readable through the documentation sites. They need a legal read before production use. This is low risk for an internal deployment (assumption A1), but required before anything wider.

## 4. Gold via PAXG

| Question | Finding | Design response |
|---|---|---|
| Which venue leads? | Binance: 8× the volume, about 4× the near-price depth, one-tick spread | Binance primary for detection; Coinbase for cross-checks |
| How does it behave while gold is closed? | It trades on, with about 35% of the volume and 21% of the range | `underlying_closed` flag; gold profile blocks confirmations during closures |
| Is Coinbase usable for SMC? | 37% of minutes empty | Coinbase runs its own detections, but the UI defaults to Binance |
| USDT vs USD | Coinbase USDT-USD read live at 0.99883 | Spread computed in USD through USDT-USD |
| Premium to spot gold | Not measurable without a spot-gold feed | Deferred (§6.2) |

## 5. AI (Grok)

### 5.1 Facts

| Fact | Value |
|---|---|
| API | `https://api.x.ai/v1`, bearer key. OpenAI-compatible Chat Completions and Responses APIs. The JavaScript structured-output example uses the official `openai` npm SDK with `baseURL` pointed at xAI. |
| Structured outputs | JSON Schema with a stated guarantee ("the response is guaranteed to match your schema") for supported features: string, number, integer, boolean, null, enum, const, array, object, `anyOf`/`oneOf`, `$ref`. Best-effort only: `not`, `if/then/else`, strings over 2,048 characters, arrays over 256 items, objects over 64 properties. |
| Rate limits | Per model, by spend tier. A new account (Tier 0) gets 37 requests/s and 10M tokens/min on grok-4.3, far above this platform's needs. 429 on excess; exponential backoff recommended. |
| Data handling | Requests and responses are kept encrypted for 30 days for abuse auditing, then deleted. No training on API data without explicit permission. A team-wide zero-retention option exists, but it disables batch and stateful features. |
| Prompt caching | Cached input is billed at a lower rate. Hits improve with a stable prefix and a conversation key (`x-grok-conv-id` / `prompt_cache_key`). Hits are not guaranteed. |
| Model lifecycle | No published deprecation policy was found. One migration guide gave 60 days' notice; third parties report a retirement with about 9 days' notice (unverified). |

Sources: [models](https://docs.x.ai/docs/models), [structured outputs](https://docs.x.ai/docs/guides/structured-outputs), [rate limits](https://docs.x.ai/docs/key-information/consumption-and-rate-limits), [security FAQ](https://docs.x.ai/developers/faq/security), [prompt caching](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing).

### 5.2 Models and cost

| Model | Context | Input / cached input / output (per 1M tokens) | Notes |
|---|---|---|---|
| **grok-4.3** (recommended default) | 1M | $1.25 / $0.20 / $2.50 | Structured outputs, function calling, reasoning effort none–xhigh (default low) |
| grok-4.7 (flagship) | 500k | $2.00 / $0.50 / $6.00 | For optional deep reviews |
| grok-4.20-0309-non-reasoning | 1M | $1.25 / $0.20 / $2.50 | The only date-pinned ids found |

Estimate: 6,000 input tokens (half cached) and 800 output tokens per call, 30 days a month, excluding reasoning tokens (so reasoning effort stays low).

| Volume | grok-4.3 | grok-4.7 |
|---|---|---|
| 100 calls/day | $19–29/month | $37–50/month |
| 300 calls/day | $57–86/month | $111–151/month |

**Recommendation**:

- Default to grok-4.3 at low reasoning effort, with model ids stored in settings.
- The jobs service checks at startup that the configured model is available, and switches to a configured fallback if not.
- Proposed caps: **$5/day and $100/month** (decision D5).

## 6. Economic calendar and spot gold

### 6.1 Economic calendar

| Source | What it gives | Access | Cost |
|---|---|---|---|
| FRED API `releases/dates` | Future release **dates** for CPI, Employment Situation, GDP, PCE and others (no times) | Free API key | $0 |
| BEA release schedule | GDP and Personal Income & Outlays (PCE) **with times** (zone to confirm) | JSON and ICS, fetchable by scripts | $0 |
| BLS release calendar | CPI and Employment Situation with times (08:30 ET) | ICS exists, but **bls.gov returned 403 to automated clients**. Not used; the block must not be evaded. | $0 |
| Federal Reserve FOMC calendar | 2026–2027 meeting dates (no machine-readable feed; statement time not on the page) | HTML, entered by an admin | $0 |
| Paid APIs (Trading Economics, FMP, Finnhub) | Global coverage, impact ratings, forecasts and actuals | Pricing and display rights couldn't be verified | Unknown |
| Forex Factory, Investing.com | No official API. Scraping would breach their terms. | Not used | — |

**Recommendation**:

- FRED (dates) + BEA (dates and times) + admin-entered FOMC dates.
- Standard release times kept in configuration (BLS releases 08:30 New York time; FOMC statements 14:00 New York time, to confirm). Events whose time is a standard default carry `time_confirmed = false` until checked.
- Impact levels assigned by the platform: CPI, Employment Situation and FOMC are high.
- Forecast and actual values aren't available for free and are optional. A paid vendor can be evaluated later with written display rights.

### 6.2 Spot-gold (XAUUSD) reference feed

| Provider | Closest fit | Gap |
|---|---|---|
| Twelve Data | Grow, $79/month, "internal display" | XAU/USD coverage and 1m history unconfirmed; WebSocket only on Pro ($229) |
| GoldAPI.io | Business, $169/month, with WebSocket | Daily history only |
| TraderMade | £599/month | Display rights only on Enterprise |
| Metals-API | $40–999/month tiers | 1m granularity and terms unconfirmed |
| Massive (formerly Polygon.io) | REST, WebSocket, flat files | Listed plans are for individual use |
| OANDA v20 | Streaming prices | Needs a trading account; terms unread |

**Recommendation: keep it deferred** (decision D8). If it becomes a priority, run a short trial with Twelve Data to confirm coverage and display terms before buying.

## 7. Stack versions and licences

### 7.1 Node.js

| Line | Status on 2026-11-09 | Latest | End of life |
|---|---|---|---|
| **v26 "Lithium"** | Active LTS since 2026-10-28 | **26.13.0** | 2029-04-30 |
| v24 "Krypton" | Maintenance LTS since 2026-10-20 | 24.22.2 | 2028-04-30 |
| v22 "Jod" | Maintenance LTS | 22.23.4 | 2027-04-30 |

**Pin: Node.js 26.13.0** in `.nvmrc`, `package.json` engines (`>=26.13.0 <27`) and `FROM node:26.13.0-bookworm-slim` (tag confirmed on Docker Hub).

- It has the longest support window, and every chosen tool supports it (Vite 8 needs ≥ 22.12; Vitest 5.1 supports ≥ 26).
- Fallback: 24.22.2, if a native dependency fails on 26 during Phase 1.
- From v27 Node.js moves to a new release schedule; v26 is the last line on the old one.
- This machine currently has Node 24.22.1, so developers need a version manager (fnm, Volta or nvm-windows).

### 7.2 Pinned versions

| Component | Version | Notes |
|---|---|---|
| pnpm / Turborepo | 12.18.0 / 2.11.10 | |
| TypeScript | 7.0.2 if the Phase 1 check passes, otherwise latest 6.x | TS 7 is the new native compiler; NestJS decorator support is unverified |
| NestJS (`@nestjs/*`) | 12.4.2 | Requires Node ≥ 20 |
| React / React DOM | 19.3.1 | |
| Vite / Vitest / Playwright | 8.3.7 / 5.1.0 / 1.65.0 | |
| Tailwind CSS | 4.3.5 | shadcn/ui's Tailwind 4 support to confirm in Phase 1 |
| three / @react-three/fiber / drei | 0.187.0 / 9.8.2 / 10.7.9 | R3F supports React ≥ 19 < 19.4 |
| Socket.IO server / client | 4.8.4 | |
| @socket.io/redis-adapter / redis-emitter | 8.3.0 / 5.1.0 | Last published 2024 and 2023: test with ioredis 6 in Phase 1 |
| BullMQ / ioredis | 6.7.2 / 6.0.0 | |
| Kysely / zod / pino | 0.29.8 / 4.6.7 / 10.4.0 | |
| lightweight-charts | 5.2.1 | |
| Tauri (core / CLI and API) | 2.12.5 / 2.12.4 | plugin-notification 2.8.0, plugin-updater 2.14.1. Avoid the v3 alpha. |
| TimescaleDB | 2.31.0 on PostgreSQL 18 | Image `timescale/timescaledb:2.31.0-pg18` (not `-oss`) |
| Valkey (or Redis) | 9.1.3 (or 8.10.3) | Decision D4 |
| TA-Lib (dev tool only) | 0.8.3 | Python wheels for Windows, macOS and Linux |

Versions were read from the npm registry, GitHub releases and Docker Hub on 2026-11-09. The lockfile created in Phase 1 is the final record.

### 7.3 Licences and checks for Phase 1

| Item | Finding | Action |
|---|---|---|
| TimescaleDB | Core is Apache-2.0. Columnstore (compression), continuous aggregates and retention policies are under the Timescale License, which allows free self-hosted use but not offering TimescaleDB as a service. The compression API has been renamed to "columnstore". | Use the Community image; confirm function names in the first migration |
| Redis vs Valkey | Redis 8.x is licensed RSALv2 / SSPLv1 / AGPLv3. Valkey is BSD-3. BullMQ documents support for Redis ≥ 6.2 but doesn't list Valkey. | Prefer Valkey if BullMQ's integration tests pass on it (D4) |
| Lightweight Charts | Apache-2.0. Requires the NOTICE text and a visible link to tradingview.com (the `attributionLogo` option satisfies the link). | Keep the attribution; prototype zone drawing with the v5 primitives API. Fallbacks: Apache ECharts 6.1 or KLineCharts 10.1 (both Apache-2.0). |
| TypeScript 7 + NestJS | Decorator metadata support unverified | Build spike; fall back to TS 6.x |
| Socket.IO Redis adapter/emitter | Old releases | Test with ioredis 6 |
| TA-Lib | BSD. EMA seeding convention to confirm. | Match the seeding in Phase 3 |

## 8. Desktop distribution

| Item | Finding |
|---|---|
| macOS | Apple Developer Program, $99/year. Signed and notarized builds are needed for normal installation outside the App Store (confirm current Apple requirements in Phase 13). |
| Windows | OV/EV certificate or Azure Artifact Signing (formerly Trusted Signing). EV certificates no longer give instant SmartScreen reputation. Prices weren't published on the pages read, so a quote is needed. |
| Updater | Tauri's updater signature can't be disabled. Losing the private key means existing installs can't be updated, so it goes into a secrets manager with an offline backup. |
| WebView | WebView2 (Chromium) on Windows, WKWebView on macOS. WebGL2 performance in WKWebView is checked in Phase 10. |

## 9. On-chain providers (decision in Phase 11)

- **PAXG contract**: Ethereum proxy `0x45804880De22913dAFE09f4980848ECE6EcbAf78` (18 decimals). Supply changes emit `SupplyIncreased` and `SupplyDecreased`. Whether mint and burn also emit `Transfer` to or from the zero address is to be confirmed. Bridged PAXG on other chains wouldn't be covered by Ethereum events.

| Option | What | Approximate cost |
|---|---|---|
| Minimum | Bitcoin: mempool.space WebSocket (or self-hosted). Ethereum and PAXG: Alchemy webhooks (free or pay-as-you-go). Solana: Helius free tier. Exchange labels: a curated address list. | $0–10/month |
| Better | Alchemy pay-as-you-go + Helius Developer ($49) + self-hosted mempool.space, optionally QuickNode Build ($49) as a second source | $100–150/month |
| Labels add-on | Whale Alert Enterprise ($699, BTC/ETH/SOL with owner labels) or Etherscan Pro Plus ($899, EVM only) | +$699–899/month |

Free and low tiers often limit commercial use (Etherscan's lower tiers and Whale Alert Developer say personal use only), so terms must be read before go-live.

## 10. Indicative monthly running costs

| Item | Estimate |
|---|---|
| Hosting VM (4 vCPU, 16 GB, 200 GB SSD) plus backup storage | To be quoted in Phase 1 (decision D2) |
| Grok (grok-4.3, 100–300 calls/day) | $19–86, capped at $100 |
| Economic calendar | $0 |
| On-chain (from Phase 11) | $0–150, plus $699–899 if paid labels are wanted |
| Spot-gold feed | $0 (deferred) |
| Apple Developer Program | $99 per year |
| Windows code signing | Quote needed before Phase 13 |

## 11. Not verified, carried forward

| Item | Resolve by |
|---|---|
| Binance and Coinbase terms on restricted locations and data display | Before production (legal read) |
| xAI acceptable-use clauses on financial content (page returned 403) | Before Phase 9 |
| Whether xAI prompt caching is automatic; model retirement notice periods | Phase 9 |
| TypeScript 7 + NestJS; Valkey + BullMQ; Socket.IO adapters with ioredis 6; shadcn/ui on Tailwind 4; TimescaleDB columnstore function names; Node 26 native modules | Phase 1 |
| Lightweight Charts primitives for zones | Phase 1 spike, Phase 7 build |
| TA-Lib EMA seeding convention | Phase 3 |
| FOMC statement time; BEA time zone | Phase 7 |
| PAXG mint/burn `Transfer` events; provider terms and prices | Phase 11 |
| WKWebView WebGL2 performance | Phase 10 |
| Windows signing prices; Apple notarization details | Phase 13 |
