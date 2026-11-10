# Project: AI-Powered Cryptocurrency Intelligence & Monitoring Platform

> Revision 3 — adds gold through PAX Gold (PAXG): new section 1.1, plus changes to the main objective, sections 1, 3, 4, 6, 7 and 8, the data model, the development approach and the acceptance criteria.
>
> Revision 2 — adds Smart Money Concepts (SMC) and liquidity-trap pattern analysis (new section 3, plus changes to sections 4–9, the engineering requirements and the final acceptance criteria).

Act as a senior software architect and full-stack engineering team.

Build a production-oriented AI-powered cryptocurrency monitoring platform inspired by a futuristic financial intelligence dashboard.

## Main objective

Develop a real-time cryptocurrency monitoring system with:

- Web application
- Windows and macOS desktop applications
- Real-time exchange data for cryptocurrencies, and for gold through the gold-backed PAXG token
- Technical analysis
- **Smart Money Concepts (SMC) market-structure and liquidity analysis, including detection of four liquidity-trap patterns**
- AI-powered market intelligence using Grok
- Interactive 3D neural network visualization
- Notifications and historical analytics

This must be a real working system, not a static dashboard or simulated demonstration.

## Technology stack

- Frontend: React + TypeScript
- Backend: Node.js + NestJS
- Desktop: Tauri 2
- Database: PostgreSQL + TimescaleDB
- Cache and queues: Redis + BullMQ
- Real-time communication: WebSockets / Socket.IO
- AI: Grok API
- 3D visualization: Three.js + React Three Fiber
- Price charts with SMC overlays: a candlestick charting library that supports custom drawing of zones, levels and markers (evaluate TradingView Lightweight Charts and its licence/attribution terms against alternatives)
- Styling: Tailwind CSS + shadcn/ui
- Testing: Vitest + Playwright
- Infrastructure: Docker + CI/CD

Evaluate the current supported Node.js LTS version and pin the chosen version.

## Functional requirements

### 1. Market monitoring

- Integrate Binance and Coinbase public market data.
- Monitor BTC, ETH, SOL, PAXG (gold, see 1.1) and configurable cryptocurrencies.
- Implement live price, volume, candles and order book monitoring.
- Collect candles on all timeframes the SMC engine uses: **M1, M5, M15, H1, H4 and D1**. Backfill enough history at startup for swing and level detection on every timeframe.
- Implement robust reconnection and error handling.
- Detect missing or delayed market data. After a gap is backfilled, recompute any SMC state that depends on it.
- Poll each venue's trading-pair status (Binance `exchangeInfo`, Coinbase `products`). When a pair is halted or delisted, stop its feed without crashing, keep its history, and raise a System Health alert. Binance already shows retired PAXG pairs, such as PAXG/BUSD, in `BREAK` status.

#### 1.1 Gold via PAX Gold (PAXG)

The reference SMC material targets gold (XAUUSD). The platform covers gold through **PAX Gold (PAXG)**, an ERC-20 token issued by Paxos where each token represents one fine troy ounce of gold. PAXG is priced per ounce and tracks spot gold, but **it is not XAUUSD**. It trades on crypto exchanges around the clock, with its own liquidity and its own premium or discount to spot gold.

**Markets**

| Venue | Pair | Role |
|---|---|---|
| Binance (spot) | PAXG/USDT | Primary venue: SMC detection and the default chart |
| Coinbase | PAXG-USD | Secondary venue: cross-venue checks and spread monitoring |

- Both pairs were confirmed live through the public APIs on 2026-11-09. Over the previous 24 hours, Binance PAXG/USDT traded about $14.8M (about 65,000 trades) and Coinbase PAXG-USD about 427 PAXG (about $1.75M). Re-measure volume, spread and order-book depth during the feasibility assessment before fixing the primary venue.
- Binance also lists other PAXG pairs, such as PAXG/USDC and PAXG/BTC. They are out of scope by default but can be turned on in configuration.
- Run SMC detection **per venue, on that venue's own candles**. Never merge candles from different venues into one series.

**Gold-market hours**

- PAXG trades 24/7, but the gold market it tracks closes from Friday evening to Sunday evening (New York time) and has a short daily break. Keep a configurable closure schedule for the underlying market: weekly close and open, the daily break, and holiday dates.
- Mark every PAXG candle that falls inside a closure as **underlying closed**, and shade those periods on charts.
- By default, liquidity sweeps, structure breaks and setups that form while the gold market is closed are marked low-confidence and cannot reach the "confirmed" state. This is configurable.
- Keep the weekend high and low as a liquidity level (see 3.3), and record when the gold market reopens.

**Thin liquidity**

- PAXG trades far less than BTC or ETH, so its order books are thinner and a single trade can print a long wick. PAXG uses its own gold instrument profile for SMC parameters (see 3.1).
- Flag a sweep as a **thin-book wick** when the trades beyond the liquidity level add up to less than a configurable notional. A thin-book wick cannot trigger a pattern on its own.
- A setup needs a minimum volume and a maximum spread at the moment it triggers. Otherwise it is marked "low liquidity".

**Price comparisons**

- Monitor the PAXG price difference between Binance and Coinbase. Convert USDT to USD with Coinbase USDT-USD before comparing, and alert when the difference passes a configurable threshold.
- Without a spot-gold feed, the platform can't measure PAXG's premium or discount to XAUUSD. A licensed spot-gold (XAUUSD) reference feed is optional: evaluate its coverage, licence and cost during feasibility, and add premium/discount monitoring only if it is approved.
- Always label the instrument "PAXG (gold-backed token)", never "XAUUSD". Wherever PAXG levels appear, state that they can differ from spot gold and from a broker's XAUUSD quotes, so they can't be copied one-to-one onto an XAUUSD chart.
- Gold also reacts to US dollar strength and interest-rate expectations. The economic calendar (3.8) covers scheduled news. Data for the US dollar index or bond yields needs licensed sources and is out of scope for the initial release.

### 2. Technical analysis

Implement:

- RSI
- MACD
- EMA
- VWAP
- ATR (also used to normalise SMC tolerances and displacement thresholds)
- Volume anomaly detection
- Market trend detection
- Order book imbalance

Validate all calculations against reference datasets.

### 3. Smart Money Concepts (SMC) and liquidity analysis (new)

#### 3.1 Principles

- Every SMC concept must be **deterministic and parameterised**. SMC is usually applied by eye, so each definition below must become a documented algorithm with explicit, configurable parameters. Store the version of the rules and parameters used with every detection.
- **No look-ahead bias.** A swing point is confirmed only after its right-hand confirmation bars have closed. Detections must never repaint history. Live, unconfirmed state must be labelled *provisional*.
- **Closed candles only** for structure decisions (BOS, MSS/CHOCH, sweep confirmation). Intra-candle events may raise provisional alerts but must not change the confirmed state.
- **Multi-timeframe model:** H4 and H1 provide context (trend, POIs, liquidity pools). M15 and M5 provide confirmation (sweep, MSS, entry zone). Which timeframes play each role must be configurable per instrument.
- **Instrument profiles:** SMC and indicator parameters belong to an instrument profile. Ship at least two default profiles, **crypto majors** (BTC, ETH, SOL) and **gold** (PAXG). Calibrate each one against its own labelled data rather than copying values from the other.
- The output is **analysis and education, not trading signals.** The system must never place orders. Entry, stop-loss and take-profit levels are hypothetical reference levels used to evaluate setups.

#### 3.2 Market structure

| Concept | Required behaviour |
|---|---|
| Swing high / swing low | Fractal pivot with configurable left/right bar counts per timeframe. Classify each as internal or external structure. |
| Trend | HH/HL = bullish, LH/LL = bearish, otherwise ranging. Detect per timeframe. |
| Break of Structure (BOS) | A candle closes beyond the last swing point in the direction of the trend (continuation). |
| Market Structure Shift / Change of Character (MSS / CHOCH) | A candle closes beyond the last opposing swing point against the prevailing trend (potential reversal). |
| Displacement | A strong impulsive move: candle body ≥ k × ATR and/or consecutive same-direction candles, with configurable k. Displacement is what qualifies an Order Block or MSS as significant. |
| Trading range | A bounded, consolidating region with a defined high, low and equilibrium (50%), detected from swing clustering and low directional movement. |

#### 3.3 Liquidity

| Concept | Required behaviour |
|---|---|
| Equal Highs / Equal Lows (EQH / EQL) | Two or more swing highs (or lows) within a tolerance of x × ATR or y %. Store the level, how many times it was touched, and its age. |
| Previous highs and lows | Previous day, week and month high and low. |
| Session highs and lows | High and low of the Asia, London and New York sessions, with configurable UTC windows. Crypto trades 24/7, but liquidity and volatility still cluster around these sessions. For PAXG, London and New York matter most because they are the main gold-trading sessions. |
| Weekend high / low (PAXG) | High and low traded while the gold market was closed, kept as a liquidity level after it reopens. |
| Range extremes | The high and low of any detected trading range, treated as external liquidity. |
| Liquidity sweep | Price trades beyond a liquidity level by at least a minimum tolerance, then **closes back inside** within N candles. Record the sweep extreme, how far price went beyond the level, and the candle count. |
| False breakout | A close beyond support or resistance that is followed by a close back inside within N candles. Distinguish it from a genuine breakout that keeps going. |
| Swept / unswept state | Each liquidity level is tracked as active, swept or expired. |

#### 3.4 Points of Interest (POIs)

| Concept | Required behaviour |
|---|---|
| Order Block (OB) | The last opposing candle (or candle cluster) before a displacement that produces a BOS or MSS. Bullish or bearish. Record the timeframe (H4/H1 OBs are flagged "higher-timeframe"). |
| Fair Value Gap (FVG) | A three-candle imbalance where the high of candle 1 and the low of candle 3 don't overlap (bullish), or the reverse (bearish). Minimum size relative to ATR. |
| Supply / Demand zone | A base-and-departure zone defined by displacement away from a consolidation. |
| Mitigation / fill tracking | Each POI is tracked as untouched, partially filled (with fill %), fully filled or invalidated. |
| Internal vs external | Each POI and liquidity level is labelled as inside or outside the current trading range (required by Pattern 4). |

#### 3.5 Pattern detection

Implement each pattern as an explicit **state machine** with these states:

`forming → triggered (sweep) → confirmed (MSS) → entry-zone active → resolved (target reached / invalidated / expired)`

Persist every state transition with a timestamp and the candle that caused it. Each pattern has a bullish and a bearish variant.

**Pattern 1: Double Liquidity Trap**
- Conditions: a clear trading range with liquidity at its high and/or low.
- Sequence: first sweep of a level → return into the range → second sweep (the trap) → strong displacement → MSS.
- Entry zone: the FVG or OB created by the displacement, available only after the MSS is confirmed.
- Invalidation (hypothetical SL): beyond the extreme of the final sweep, plus a configurable buffer (ATR-based).
- Note: not every double sweep produces a reversal. Unconfirmed double sweeps must be shown as "watching", not as setups.

**Pattern 2: Equal Highs / Lows near a POI**
- Conditions: EQH forms just below a supply zone or bearish OB, or EQL forms just above a demand zone or bullish OB. "Just below/above" is a configurable distance in ATR.
- Sequence: price approaches the EQH/EQL → sweeps it into the POI → rejection → MSS on M5/M15.
- Entry zone: the retracement after the MSS (FVG/OB).
- Invalidation: beyond the sweep extreme.
- Note: equal highs or lows alone must never generate a setup. They are only a liquidity pool, and price can break through and keep going.

**Pattern 3: Large H4/H1 Order Block**
- Conditions: a valid H4 or H1 OB with strong displacement and a significant structural break, with liquidity resting near or just before the OB.
- Sequence: price approaches the HTF OB → liquidity is swept before or inside the OB → lower timeframe (M5/M15) shows rejection and an MSS.
- Entry zone: the lower-timeframe FVG/OB inside or next to the HTF OB.
- Invalidation: beyond the setup's invalidation level, normally outside the sweep extreme.
- Note: touching an HTF OB is not a setup. Lower-timeframe confirmation is required.

**Pattern 4: Sweep Outside, Fill Inside**
- Conditions: liquidity outside a trading range or structural high/low, and an unfilled FVG or imbalance inside that structure.
- Sequence: price breaks beyond the range to sweep external liquidity → quickly returns inside the range → MSS → moves towards the internal FVG.
- Entry zone: the retracement into a suitable FVG/OB after the MSS.
- Invalidation: beyond the sweep extreme.
- Target: an unfilled FVG or opposing liquidity zone, provided the risk-to-reward ratio meets the configured minimum.

#### 3.6 Confluence checklist and setup scoring

Turn the trading checklist from the reference material into an automated, explainable checklist that is evaluated for every setup and shown item by item in the UI:

1. Higher-timeframe (H1/H4) trend identified and aligned with the setup direction.
2. EQH, EQL and key liquidity zones marked.
3. Relevant POI (OB, FVG or supply/demand) present.
4. Clear liquidity sweep detected.
5. MSS/CHOCH confirmed on the lower timeframe.
6. Entry zone, invalidation level and target defined.
7. Risk-to-reward of the hypothetical levels ≥ the configured minimum (default **1 : 2**).
8. No high-impact economic event inside the configured blackout window.

- Produce a **confluence score** from configurable weights, and a pass/fail result for mandatory items (by default items 4, 5 and 6 are mandatory).
- A setup that fails a mandatory item is never shown as "confirmed". Present it as "watching" with the reasons it doesn't qualify.

#### 3.7 Risk-management reference (informational only)

- Calculate the hypothetical risk-to-reward for each setup from its entry zone, invalidation level and target.
- Provide a position-size calculator that takes a user-entered account size and risk % (default range 0.5–1%) and shows the size implied by the distance to the invalidation level. Calculation only: nothing is linked to an exchange account and no orders are placed.
- Show the disclaimer *"Educational analysis — not financial advice"* wherever setup levels appear.

#### 3.8 Volatility, sessions and news awareness

- Track volatility (ATR, realised volatility) per session and flag unusual expansion.
- Integrate an **economic calendar** data source for high-impact events (for example CPI, NFP and FOMC). Evaluate providers for API access, pricing, coverage and licence before choosing one.
- Show upcoming events in the dashboard, and apply a configurable blackout window around high-impact events in the checklist.
- For PAXG, US releases such as CPI, NFP and FOMC decisions are the main scheduled drivers. The blackout window is set per instrument profile.

#### 3.9 Historical tracking and validation

- Record the outcome of every confirmed setup: hypothetical target reached, invalidation reached or expired, plus the maximum favourable and adverse excursion (MFE/MAE) measured in R.
- Provide historical statistics per pattern, timeframe, instrument and session (counts, outcome distribution, average MFE/MAE). Label these as historical observations, never as expected performance.
- Provide a **replay / backtest mode** that runs the detection engine over stored candles candle by candle, using exactly the same code path as live detection, so results can be reproduced.
- Validate the detectors with hand-labelled reference datasets: annotated candle fixtures for every concept in 3.2–3.4 and every pattern in 3.5, including bullish, bearish and negative cases. These fixtures are golden tests in CI.
- Include PAXG fixtures for a gold-market weekend closure and reopening, and for a thin-book wick that must not trigger a pattern.

### 4. AI intelligence

- Integrate Grok API through the backend.
- Create structured AI analysis responses.
- Analyse significant market events. **SMC events are first-class triggers:** confirmed sweeps, MSS/CHOCH, setups reaching "confirmed", and setup resolution.
- Generate bullish/bearish/neutral observations.
- Explain supporting indicators and associated risks.
- Give the AI the **structured SMC context** (structure per timeframe, active liquidity levels, POIs, active setups with their checklist results, upcoming news) and require it to:
  - reference only levels and zones that exist in the provided context, never invent prices;
  - state what would invalidate its observation;
  - name the competing scenario, for example "the sweep may be a genuine breakout".
- For PAXG, also send whether the gold market is open or closed, the Binance–Coinbase price difference, and upcoming US economic events. The AI must call the instrument PAXG, say so when the gold market is closed, and never present PAXG prices as XAUUSD prices.
- Validate AI output against the detected SMC data. Reject or flag any response that cites a price level or zone the engine did not produce.
- Maintain historical AI analysis.
- Control API usage through aggregation, caching and event-driven execution.

Never represent AI-generated opinions as guaranteed predictions.

### 5. 3D AI visualization

Create a futuristic animated neural network/brain visualization.

It must respond to actual system events:

- Idle: slow animation.
- Receiving data: active particle movement.
- Analysing: increased activity.
- **Pattern detected / setup state change: a distinct pulse or highlight tied to the actual detection event.**
- Analysis completed: completion animation.
- Error: error-state visualization.

Do not use random animations as a substitute for actual backend processing.

### 6. Dashboard

Create:

- Command Center, including a gold panel: PAXG on both venues, the price difference between them, whether the gold market is open (with the next open or close), and upcoming US events.
- AI Intelligence Center
- Technical Analysis
- **Smart Money / Liquidity Map:** multi-timeframe candlestick charts overlaid with swing points, BOS/MSS labels, EQH/EQL lines, session and previous-period highs/lows, OBs, FVGs, supply/demand zones, sweep markers, and mitigation state. PAXG charts also shade gold-market closures and mark thin-book wicks.
- **Setup Scanner:** live and recent pattern instances across instruments and timeframes, showing state, checklist results, confluence score, hypothetical entry/invalidation/target, risk-to-reward, and the AI commentary for each.
- **Economic Calendar:** upcoming high-impact events and blackout windows.
- Market Activity
- Whale Tracker
- Alert Center
- Historical Analytics (now including setup outcome statistics and the replay view)
- System Health (now including detector latency and the timeframe backfill status)

Use a professional futuristic dark theme.

### 7. Whale monitoring

Separate exchange large-trade detection from actual blockchain wallet monitoring.

Integrate suitable on-chain data providers only after evaluating their API access, pricing and coverage.

PAXG is an ERC-20 token on Ethereum. Once an on-chain provider is approved, wallet monitoring also covers large PAXG transfers and Paxos mint and burn events, which show the token supply growing or shrinking.

Large trades and order-book walls near detected liquidity levels or POIs should be shown as additional context in the Liquidity Map, but they must not change the deterministic detection rules.

### 8. Alerts

Configurable alerts (per instrument, timeframe, pattern and direction) for:

- Price, indicator and volume conditions (existing).
- Liquidity level swept / false breakout detected.
- BOS or MSS/CHOCH confirmed.
- Price entering a POI (OB, FVG or supply/demand zone).
- Pattern state transitions (triggered, confirmed, entry zone active, resolved).
- High-impact economic event approaching.
- PAXG price difference between Binance and Coinbase passing a threshold.
- Gold market opening or closing (PAXG, optional).
- A trading pair halted or delisted on a venue.

Alerts must be de-duplicated, rate-limited and delivered through in-app, web and desktop notifications.

### 9. Web and desktop

- Share reusable frontend components.
- Use the same backend and data services.
- Implement desktop notifications.
- Support Windows and macOS packaging.
- Ensure the application behaves correctly when disconnected and reconnected. After reconnecting, SMC state and setup states must be resynchronised from the backend rather than calculated on the client.

### 10. Security

- Protect all API credentials.
- Keep AI API keys on the backend.
- Never expose exchange secrets in frontend code.
- Implement authentication, authorization and audit logging.
- Validate all AI outputs.
- Do not implement real-money trading in the initial release. SMC setups, hypothetical levels and the position-size calculator must not connect to any order-placement API.

## Engineering requirements

Use a monorepo with separate applications and reusable packages. The SMC engine must be a **framework-independent, pure TypeScript package** (for example `packages/smc-engine`) that takes candles and returns detections. Live processing, replay/backtest and tests all use this same package.

Implement:

- Clean architecture
- Modular services
- Typed API contracts (including SMC entities and setup state events)
- Database migrations
- Environment configuration (including SMC parameter sets and versioning)
- Structured logging
- Automated tests (unit, golden-fixture tests for the SMC engine, integration and end-to-end)
- Docker deployment
- CI/CD
- Technical documentation, including an **SMC rulebook** that states every definition, parameter and default value used by the engine.

### Data model additions (to be detailed in the schema design)

- `swing_points` (instrument, timeframe, type, price, time, confirmed_at, structure_level)
- `structure_events` (BOS / MSS / CHOCH, direction, broken swing, candle, timeframe)
- `liquidity_levels` (type: EQH / EQL / PDH / PDL / PWH / PWL / session / range / weekend, price, touches, status, swept_at, sweep_extreme)
- `poi_zones` (type: OB / FVG / supply / demand, direction, top, bottom, timeframe, internal/external, fill %, status)
- `trading_ranges` (high, low, equilibrium, start, end)
- `setups` (pattern type, direction, instrument, timeframes, current state, entry zone, invalidation, targets, risk-to-reward, confluence score, rule-set version, quality flags such as underlying-closed or low-liquidity)
- `setup_transitions` (setup, from_state, to_state, time, triggering candle, reason)
- `setup_checklist_results` (setup, item, pass/fail, evidence)
- `setup_outcomes` (setup, result, MFE_R, MAE_R, resolved_at)
- `economic_events` (source, title, country/currency, impact, scheduled_at, actual/forecast/previous)
- `instruments` (venue, symbol, base/quote, asset class: crypto or tokenised gold, instrument profile, underlying-market calendar, venue status)
- `instrument_profiles` (versioned SMC and indicator parameter sets)
- `underlying_market_closures` (calendar, start, end, reason: weekend / daily break / holiday)
- `cross_venue_spreads` (instrument, venue pair, USD-normalised price difference, time)

Time-series tables use TimescaleDB hypertables where appropriate.

## Development approach

Do not start by implementing the entire system immediately.

First:

1. Analyse the requirements.
2. Produce a feasibility assessment, including the SMC definitions that need judgement calls, PAXG volume and order-book depth on each venue, the optional spot-gold reference feed, and the economic calendar provider.
3. Prepare a detailed architecture document.
4. Identify technical risks and third-party dependencies. At minimum, address these SMC risks: subjectivity of definitions, repainting / look-ahead bias, sensitivity to parameters, false positives in ranging markets, the cost of running detection on many instruments × timeframes, and users misreading setups as trade advice. For PAXG, also address thin liquidity, trading while the gold market is closed, the premium or discount to spot gold, the USDT quote currency, and the risk of a pair being delisted.
5. Define database schemas and API contracts.
6. Create a phased implementation plan. The SMC work should come after core market data and technical analysis are in place, and be split into at least: (a) market structure + liquidity primitives, (b) POIs, (c) pattern state machines + checklist, (d) charts/overlays + Setup Scanner, (e) outcome tracking + replay. PAXG ingestion, the gold-market closure schedule and the cross-venue price check belong to the market-data phase. The gold instrument profile is calibrated during the SMC phases.
7. Define acceptance criteria for every phase.

Wait for approval before starting implementation.

After approval, implement one phase at a time.

Do not move to the next phase until the current phase passes its acceptance criteria.

### Minimum acceptance criteria for the SMC phases

- Every concept in 3.2–3.4 and every pattern in 3.5 passes golden-fixture tests, including bullish, bearish and negative (must-not-detect) cases.
- Replaying stored candles gives exactly the same detections as live processing of the same candles.
- No confirmed detection changes after the fact (verified by a repaint test).
- Detection latency from candle close to published event stays within an agreed budget (to be set in the architecture document) for the configured instrument × timeframe matrix.
- Chart overlays match the stored detections exactly.
- The AI never cites a level that isn't in its SMC context (verified with automated output-validation tests).
- The gold profile passes its own golden fixtures, including closure, reopening and thin-book cases.
- PAXG candles inside gold-market closures are flagged, and with default settings no setup that forms during a closure reaches "confirmed".

## Final acceptance criteria

The finished application must:

- Receive genuine live market data for the configured cryptocurrencies, and for gold through PAXG (Binance PAXG/USDT and Coinbase PAXG-USD).
- Calculate validated technical indicators.
- **Detect SMC structure, liquidity, POIs and the four liquidity-trap patterns deterministically, without repainting, validated against labelled reference data.**
- **Show the confluence checklist, hypothetical levels and risk-to-reward for each setup, clearly labelled as educational analysis.**
- **Flag PAXG activity while the gold market is closed, and keep PAXG clearly distinguished from XAUUSD everywhere.**
- Generate AI market analysis using real input data.
- Display actual processing states through the 3D visualization.
- Store historical analysis, signals, **setup state histories and setup outcomes**.
- Generate configurable alerts.
- Work as both a web and desktop application.
- Recover correctly from network interruptions.
- Have automated tests and deployment documentation.

The final product must be maintainable, secure, scalable and reliable.

Do not sacrifice actual functionality for visual appearance.

## Glossary

| Term | Meaning |
|---|---|
| SMC | Smart Money Concepts: price-action analysis based on liquidity and institutional order flow |
| BOS | Break of Structure: trend continuation |
| MSS / CHOCH | Market Structure Shift / Change of Character: potential trend reversal |
| EQH / EQL | Equal Highs / Equal Lows: resting liquidity pools |
| OB | Order Block: the last opposing candle before a displacement |
| FVG | Fair Value Gap: a three-candle price imbalance |
| POI | Point of Interest: an OB, FVG or supply/demand zone |
| Sweep | Price trades beyond a liquidity level and closes back inside |
| Displacement | A strong, impulsive, ATR-relative move |
| R:R | Risk-to-reward ratio of the hypothetical levels |
| MFE / MAE | Maximum favourable / adverse excursion after a setup is confirmed |
| PAXG | PAX Gold: an ERC-20 token issued by Paxos; each token represents one fine troy ounce of gold |
| XAUUSD | Spot gold in US dollars per troy ounce, as quoted by FX and metals brokers |
| Underlying closed | A period when PAXG still trades but the gold market it tracks is closed |
| Thin-book wick | A wick printed by very little traded volume on a thin order book |
