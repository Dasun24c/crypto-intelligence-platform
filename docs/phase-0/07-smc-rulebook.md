# 07 · SMC rulebook (draft v0.1)

| | |
|---|---|
| Status | Approved 2026-11-10 with the proposed judgement calls (J1–J10). This document becomes `rulesetVersion` 0.1.0 of `packages/smc-engine`. |
| Date | 2026-11-09 |
| Source | [REQUIREMENTS.md](../../REQUIREMENTS.md) §3 and the reference infographics (four liquidity-trap patterns, gold checklist) |

SMC is normally applied by eye. This rulebook turns every concept into an exact rule so detections can be tested, replayed and audited. Parameters marked † are starting values. They will be calibrated against labelled data during Phases 4–6, separately for each instrument profile. Section 11 lists the judgement calls that need your approval.

## 1. Conventions

- **Candles.** Closed candles only. Candle `c_i` has open time `t_i` and fields O, H, L, C, V. The index increases with time. Timeframes (TF): 1m, 5m, 15m, 1h, 4h, 1d, aligned to UTC. Days start at 00:00 UTC; weeks start Monday 00:00 UTC.
- **ATR.** ATR(14), Wilder smoothing, on the same TF, taken at the close of the candle being evaluated. "x ATR" means x × that value.
- **Tick.** The instrument's price tick. Every tolerance is at least one tick.
- **Order of evaluation.** When several TFs close at the same instant, the engine processes the highest TF first. Within a TF, rules run in the order of this document: swings → structure → displacement → ranges → liquidity → sweeps → points of interest → patterns → checklist → outcomes.
- **Determinism.** The engine is a pure reducer: `step(state, candle, context) → (newState, events)`. It reads no clock, uses no randomness and performs no I/O. `context` holds only information known at the candle's close: higher-TF candles that have already closed, the gold-market closure calendar, economic events, order-book metrics up to that second, and the profile parameters.
- **Provisional vs confirmed.** Anything that depends on later candles (swing confirmation, a sweep's close back inside) stays provisional until confirmed. Only confirmed facts are stored as detections and used by patterns. The UI may show provisional items, labelled as provisional.
- **Versioning.** Every detection carries `rulesetVersion` (the version of this rulebook as implemented), `paramsHash` (hash of the profile parameters) and the `runId` of the live or replay run that produced it.

## 2. Market structure

### 2.1 Swing points

A **swing high** of order k is a candle `i` where:

- `H_i > max(H_{i−k} … H_{i−1})` (strictly higher than the k candles before it), and
- `H_i ≥ max(H_{i+1} … H_{i+k})` (at least as high as the k candles after it).

A swing low mirrors this with lows. The tie rule means that in a run of equal highs, the first one counts.

- A swing is **confirmed at the close of candle `i+k`**. Before that it is provisional.
- **Internal swings** use order `k_int` (2†). **External swings** use `k_ext` (5†). Every external swing is also an internal swing.
- The 2k+1 candle window must be contiguous. A window that spans a data gap produces no swing.

### 2.2 Trend and structure breaks

Tracked per TF, separately for external structure (which defines the trend) and internal structure.

State: `trend ∈ {undefined, bullish, bearish}`, `refHigh` (latest confirmed, unbroken swing high), `refLow`, `protectedLow` (in a bullish trend), `protectedHigh` (in a bearish trend).

A break is tested on the **candle close**: "close above X" means `C ≥ X + ε`, with ε = max(breakBufferAtr × ATR, 1 tick) and breakBufferAtr = 0†.

| Current trend | Event | Result |
|---|---|---|
| undefined | Close above `refHigh` | Trend becomes bullish. Event: BOS bullish, flagged `initial`. |
| undefined | Close below `refLow` | Trend becomes bearish. Event: BOS bearish, flagged `initial`. |
| bullish | Close above `refHigh` | **BOS** bullish (continuation). `protectedLow` = the most recent confirmed swing low before the break, or the lowest low since the previous BOS if there is none. `refHigh` resets until a new swing high is confirmed. |
| bullish | Close below `protectedLow` | **CHOCH** bearish. Trend becomes bearish. `protectedHigh` is set the same way, mirrored. |
| bearish | Mirror of the two rows above | BOS bearish, or CHOCH bullish |

**MSS** = a CHOCH whose breaking leg contains displacement (§2.3). The breaking leg runs from the extreme before the break (for a bearish CHOCH, the highest high since `protectedLow` was set) to the break candle. A CHOCH without displacement is recorded as CHOCH only.

Patterns don't use this trend-level MSS. They use the **sweep-anchored MSS** in §6.1, which is tied to a specific sweep.

### 2.3 Displacement

A strong, one-directional move, measured against ATR:

- **Single candle** (bullish case): `C > O`, body `(C − O) ≥ 1.2† × ATR`, and body/range `(C − O)/(H − L) ≥ 0.6†`.
- **Leg**: 2 to 4† consecutive candles in the same direction, each with body/range ≥ 0.5†, and total body ≥ 2.0† × ATR.

A displacement event records its first and last candle and whether it created an FVG (§4.2).

### 2.4 Trading ranges

Detected per TF (by default on the setup TFs in §5).

**Detection.** When no range is active, at each close look at the last W = 48† contiguous candles. Let `hi` = max H and `lo` = min L. A range is detected when all of these hold:

- Height: `hi − lo ≤ 6.0† × ATR`.
- Sideways movement: Kaufman efficiency ratio `|C_last − C_first| / Σ|C_j − C_{j−1}| ≤ 0.30†`.
- At least 2† candles with `H ≥ hi − 0.25† ATR` and at least 2 with `L ≤ lo + 0.25† ATR`, with touches on the same side at least 5† candles apart.

**Locked boundaries.** At detection the range is fixed as `{high: hi, low: lo, eq: (hi + lo)/2}`. Its boundaries don't move afterwards, and wicks beyond them that close back inside are sweeps (§3.4), not range extensions. Above `eq` is the **premium** zone; below it is the **discount** zone.

**End of range.** Two† consecutive closes beyond a boundary by at least 0.25† ATR end it as `breakout_up` or `breakout_down`. After 300† candles it ends as `expired`. A new range can't be detected before the candle after the end.

## 3. Liquidity

### 3.1 Level types

| Side | Types |
|---|---|
| Buy-side (above highs) | EQH, previous day/week/month high (PDH, PWH, PMH), session high, range high, weekend high (gold), unswept external swing high, sweep extreme |
| Sell-side (below lows) | The mirror: EQL, PDL, PWL, PML, session low, range low, weekend low, unswept external swing low, sweep extreme |

Each level has a price, side, origin TF, the time it became known, and a status: `active`, `swept`, `broken` or `expired`.

### 3.2 Equal highs and lows

Two confirmed internal swing highs `a` and `b` (b later) form an **EQH** when:

- `|H_a − H_b| ≤ tol`, where tol = max(0.10† × ATR at b, 1 tick) (gold profile: 0.15†),
- they are 5† to 200† candles apart, and
- no candle between them has a high above `max(H_a, H_b) + tol` (otherwise the liquidity was already taken).

The level price is `max(H_a, H_b)`, because the resting orders sit above the higher of the two. Each further swing within tolerance adds a touch and raises the price to the new maximum. The level becomes known when swing `b` is confirmed. EQL mirrors this.

### 3.3 Period, session and weekend levels

- PDH/PDL at 00:00 UTC for the previous UTC day; PWH/PWL at Monday 00:00 UTC; PMH/PML on the first day of the month.
- Session highs and lows, created when the session ends. Default windows (UTC, editable, or set in a named time zone so they follow daylight saving): Asia 00:00–07:00, London 07:00–13:00, New York 13:00–21:00†.
- Weekend high and low (gold profile): PAXG's high and low during the latest gold-market closure, created when the market reopens.
- Expiry: session and day levels 5 days, week levels 4 weeks, month levels 3 months, EQH/EQL 500 candles of their origin TF, swing levels 300 candles†.

### 3.4 Sweeps, false breakouts and breakouts

Sweeps are evaluated on each pattern's setup TF and context TF (§5). Only levels whose origin TF is the same as or higher than the evaluating TF are considered.

For a buy-side level ℓ (sell-side mirrors):

1. **Breach**: a candle j with `H_j ≥ ℓ + pMin`, where pMin = max(0.02† × ATR, 1 tick).
2. If `C_j < ℓ`, it is a **wick sweep**, confirmed at the close of j.
3. If `C_j ≥ ℓ`, the breach is pending. The first of the next 3† candles to close below ℓ confirms a **false breakout**. If none does, the level is **broken** (a genuine breakout).
4. **Sweep extreme** = the highest high from the breach candle to the confirming candle.
5. If `extreme − ℓ > 2.0† × ATR`, the sweep is flagged `deep` and can't satisfy a pattern.
6. A confirmed sweep sets the level's status to `swept` and creates a new `sweep_extreme` level at the extreme, which can be swept in turn (used by Pattern 1).
7. **Exception:** while a range is active, its high and low are not used up by sweeps. They stay `active` and count their sweeps.
8. When one candle sweeps several levels, the sweep records share a `sweepGroupId`. Patterns treat the group as one sweep.

### 3.5 Thin-book wicks

The candle builder stores a **micro volume profile** on every 1m candle: the range [L, H] split into B = 24† equal buckets, with each trade's quantity added to its bucket.

For a sweep of level ℓ, `volumeBeyond` = the sum, over the 1m candles in the breach-to-confirmation window, of profile volume beyond ℓ (the bucket that contains ℓ is counted pro rata). `notionalBeyond = volumeBeyond × ℓ` in USD.

- If `notionalBeyond < thinNotionalUsd` (crypto majors 100,000†, gold 20,000†), the sweep is flagged `thin_book` and **can't satisfy a pattern's sweep step on its own**.
- If any 1m candle in the window has no profile (for example, history backfilled from REST without trades), the result is unknown. The sweep is flagged `liquidity_unverified` and still counts.

### 3.6 Gold-market closures

A candle is `underlyingClosed` when its interval overlaps a closure in the gold-market calendar. A sweep, structure event or zone whose deciding candle is `underlyingClosed` inherits the flag. With the gold profile's default `blockConfirmWhenUnderlyingClosed = true`†, a setup carrying this flag can't reach `confirmed` (§6.1).

## 4. Points of interest

### 4.1 Order blocks

For each BOS or CHOCH whose breaking leg contains displacement:

- **Bearish OB**: the last up-close candle (`C > O`) at or before the start of the bearish leg, searching back up to 5† candles. If several up-close candles come just before it, include up to 3† of them as one cluster.
- Zone: top = highest high of the cluster, bottom = lowest low (`zoneMode = wick`†; the alternative `body` uses the bodies only).
- A **bullish OB** mirrors this, using the last down-close candle before a bullish leg.
- The OB is created at the close of the break candle and must be within 10† candles of the leg start. OBs on 1h, 4h and 1d are flagged `htf`. `sweptLiquidityAtOrigin` is true when a sweep happened within the 10 candles before the leg.

### 4.2 Fair value gaps

For three consecutive candles i−1, i, i+1:

- **Bullish FVG** when `L_{i+1} > H_{i−1}`. Zone: [H_{i−1}, L_{i+1}].
- **Bearish FVG** when `H_{i+1} < L_{i−1}`. Zone: [H_{i+1}, L_{i−1}].
- Minimum size 0.20† × ATR. Created at the close of i+1. Its midpoint is the **consequent encroachment (CE)** level.

### 4.3 Supply and demand zones

- **Base**: 1 to 4† consecutive candles, each with a body ≤ 0.5† × ATR.
- **Departure**: a displacement (§2.3) that starts within one candle after the base and travels at least 2.0† × ATR beyond the base.
- **Demand** (upward departure): proximal edge = highest body top in the base; distal edge = lowest low in the base. **Supply** mirrors this.
- When a supply/demand zone overlaps an OB by more than 50%, both are kept and linked.

### 4.4 Touches, fills and invalidation

These rules apply to all zones:

- **Touched**: a candle trades into the zone from its proximal edge.
- **fillPct**: the deepest penetration from the proximal edge, as a percentage of zone height, capped at 100.
- Statuses: `untouched` → `partially_filled` → `filled` (penetration reached the far edge).
- **Invalidated**: a candle **closes** beyond the distal edge.
- **Expired**: after 200† candles (FVG) or 300† candles (OB, supply/demand) of the zone's TF.

### 4.5 Internal and external

When a level or zone is created and its TF has an active range: `internal` if it lies entirely inside [range.low, range.high]; `external` if entirely outside; `straddling` otherwise. With no active range: `none`. A range's own high and low, and any level beyond them, count as external liquidity.

## 5. Timeframe pairs

Patterns run on a **(context TF, setup TF)** pair. Defaults: **(4h, 15m)** and **(1h, 5m)**, configurable per profile.

- The **setup TF** is where ranges, sweeps, MSS and entry zones for the pattern are evaluated.
- The **context TF** supplies trend, POIs (Patterns 2 and 3), premium/discount zones and ATR for proximity rules.
- At a setup-TF close at time t, only context candles that closed at or before t are visible.

## 6. Patterns

### 6.1 Common rules

**States**

| State | Meaning | UI label |
|---|---|---|
| `forming` | The pattern's preconditions exist | Watching |
| `triggered` | The required sweep(s) are confirmed | Watching |
| `confirmed` | MSS confirmed, every mandatory checklist item passes, and no blocking quality flag. The entry zone is armed. | Confirmed |
| `entry_active` | Price traded into the entry zone (the hypothetical entry happened) | Entry reached |
| `resolved` | `target_reached`, `invalidated`, `expired_no_entry`, `expired_open` or `ambiguous` | Resolved |

Every transition is stored with the candle that caused it and a reason.

**Sweep-anchored MSS** (bearish case, after a buy-side sweep):

- The anchor is the most recent internal swing low on the setup TF whose candle comes before the sweep's breach candle and that is confirmed by the time of the break.
- Confirmation: a setup-TF candle closes below the anchor within 12† candles after the sweep is confirmed, without any candle trading above the sweep extreme in between.
- With `requireDisplacement = true`†, the leg from the sweep extreme to the break candle must contain displacement.
- If the anchor is more than 6.0† ATR from the sweep extreme, there's no valid anchor and the pattern can't confirm.

**Entry zone.** The first FVG in the setup's direction created within the MSS leg (including the candle after the break, which completes the three-candle pattern). If there is none, the OB of the MSS leg. If there is neither, checklist item 6 fails and the setup stays `triggered`.

**Hypothetical levels**

- **Entry price**: the proximal edge of the entry zone (`entry.ref = proximal`†).
- **Invalidation (hypothetical stop loss)**: the sweep extreme plus a 0.10† × ATR buffer. Price trading beyond it resolves the setup as `invalidated`, before or after entry.
- **Targets**: T1 = the nearest active opposing liquidity level, or unfilled opposing FVG, at least 1.0† ATR from the entry (Pattern 4 overrides this). T2 = the next one. R:R = |T1 − entry| / |entry − invalidation|.

**Expiry and ambiguity**

- `confirmed` → `expired_no_entry` when the entry zone isn't touched within 24† setup candles.
- `entry_active` → `expired_open` when neither T1 nor invalidation is reached within 288† setup candles.
- When one setup candle trades through both T1 and the invalidation price, the outcome is decided by replaying that period's 1m candles in order. If a single 1m candle contains both, the result is `ambiguous`.
- There's at most one live setup per (instrument, pattern, direction, TF pair). A new trigger while one is live is logged and ignored.

### 6.2 Pattern 1: Double Liquidity Trap

Described bearish; bullish mirrors it.

| Step | Rule |
|---|---|
| forming | An active range R on the setup TF |
| first sweep S1 | A qualifying sweep (not `deep`, not `thin_book`) of R.high, or of any buy-side level within 0.5† ATR of R.high |
| triggered | A second qualifying sweep S2 of the same liquidity (R.high again, or S1's `sweep_extreme`), 5† to 60† setup candles after S1. **Variant B:** S1 sweeps R.low and S2 sweeps R.high (false breakouts on both sides); direction is always opposite to S2's side. |
| confirmed | Sweep-anchored MSS after S2, plus the checklist |
| invalidation | S2's extreme + buffer ("beyond the final liquidity sweep") |
| expires | No S2 within 60 candles (S1 is dropped and the setup returns to `forming`), or no MSS within 12 candles of S2 |

Two sweeps without an MSS are never shown as more than "watching".

### 6.3 Pattern 2: Equal highs/lows near a POI

Described bearish.

| Step | Rule |
|---|---|
| forming | An active EQH E (origin: setup or context TF) and a bearish POI Z on the context TF (bearish OB or supply zone, `untouched` or less than 50†% filled), with E below Z and `Z.bottom − E.price ≤ 1.0† × context ATR` |
| triggered | A qualifying sweep of E whose extreme reaches Z (`extreme ≥ Z.bottom`). A close above Z.top invalidates Z and expires the setup. |
| confirmed | Sweep-anchored MSS on the setup TF, plus the checklist |
| invalidation | Sweep extreme + buffer, or a close above Z.top |

Equal highs alone never create a setup.

### 6.4 Pattern 3: Large H4/H1 order block

Described bearish.

| Step | Rule |
|---|---|
| forming | An `htf` bearish OB Z on the context TF (created with displacement and a structure break, ≤ 50†% filled) and price within 2.0† context ATR below Z |
| triggered | Price touches Z on the setup TF, **and** within 12† setup candles before or after the touch, a qualifying sweep takes a buy-side level inside Z or up to 1.0† context ATR below it ("liquidity swept before or inside the OB") |
| confirmed | Sweep-anchored MSS while no setup candle has closed above Z.top, plus the checklist |
| invalidation | Sweep extreme + buffer, or a context-TF close above Z.top |

Touching the OB alone never creates a setup.

### 6.5 Pattern 4: Sweep outside – fill inside

Described bearish, following the detailed pattern card (a reversal toward an internal imbalance).

| Step | Rule |
|---|---|
| forming | An active range R on the setup TF (or, without a range, an unswept external swing high), **and** at least one unfilled bullish FVG F inside R below price (`internal`, less than 50†% filled) |
| triggered | A qualifying sweep of R.high (external liquidity) that closes back inside R |
| confirmed | Sweep-anchored MSS, plus the checklist |
| targets | T1 = the proximal (top) edge of F, the start of the "fill inside". T2 = F's far edge, or R.low if that is nearer. Checklist item 7 is evaluated on T1 only. |
| invalidation | Sweep extreme + buffer |

The summary card's continuation reading ("sweep, fill the internal FVG, then expand in the original direction") isn't implemented in v0.1. See J7.

## 7. Confluence checklist and score

Evaluated at every state transition. Each item scores full (1), half (0.5) or nothing (0) of its weight.

| # | Item | Weight | Mandatory | Rule |
|---|---|---|---|---|
| 1 | Higher-timeframe bias | 15 | No | Full when the context-TF structure trend equals the setup direction. Half when the context TF is ranging and the sweep happened in its premium zone (bearish) or discount zone (bullish). Otherwise 0. |
| 2 | Liquidity marked | 10 | No | Full when the swept level is EQH/EQL with ≥ 2 touches, a period or session level, a range boundary, a weekend level or a sweep extreme. Half for a plain swing level. |
| 3 | POI present | 15 | No | Patterns 2 and 3: full when the sweep reached the context POI. Patterns 1 and 4: full when the entry zone overlaps, or is within 0.5 ATR of, a context-TF POI; half when only the entry zone exists. |
| 4 | Liquidity sweep | 15 | **Yes** | A qualifying sweep: not `deep`, not `thin_book` |
| 5 | MSS / CHOCH | 20 | **Yes** | Sweep-anchored MSS. With `requireDisplacement`, a break without displacement scores 0. |
| 6 | Levels defined | 5 | **Yes** | Entry zone, invalidation and T1 exist in the right order (bearish: T1 < entry < invalidation) |
| 7 | Risk-to-reward | 15 | No | R:R(T1) ≥ minRR (2.0†) |
| 8 | News clear | 5 | No | No high-impact event for the profile's currencies from `before` to `after` the confirmation time (crypto 30/30 min†, gold 60/60 min†). If the calendar is unavailable, the item fails with reason `calendar_unavailable`. |

Score = Σ weight × credit (0–100). **Confirmed** requires every mandatory item to pass and no blocking quality flag.

| Quality flag | Set when | Blocks confirmation by default |
|---|---|---|
| `underlying_closed` | A deciding candle falls inside a gold-market closure | Yes (gold profile) |
| `thin_book` | The sweep's notional beyond the level is below the threshold | Makes the sweep non-qualifying |
| `liquidity_unverified` | Micro profiles are missing for the sweep window | No |
| `low_liquidity` | At trigger, the median quote volume of the last 20 setup candles is below 0.3† × the instrument's 30-day median for that TF, or the spread exceeds maxSpreadBps (crypto 5†, gold 15†) | No (configurable) |
| `data_gap` | The setup's window contains an unrepairable gap | Yes |
| `late_detection` | The deciding candle was processed more than 120† s after it closed (catch-up after a gap or restart) | No. Alerts are labelled "late". |

## 8. Outcomes

- Tracking starts at `entry_active`. MFE and MAE (maximum favourable and adverse excursion) are measured in R using setup-TF highs and lows from the entry touch to resolution.
- Each resolved setup stores its result, MFE_R, MAE_R, bars held, and which TF resolved any ambiguity.
- Statistics are grouped by pattern, variant, direction, TF pair, instrument, session and ruleset/params version. They are labelled as historical observations, never as expected performance.

## 9. Data quality handling

- The engine processes candles strictly in order. When the next expected candle is missing, it **waits**. The UI shows "analysis paused: data gap" for that instrument.
- When the gap is repaired, processing resumes from the repaired candles. Nothing already published changes.
- When a gap is declared unrepairable (no REST data after the retry window), the engine processes a **gap marker**:
  - swing windows don't span it,
  - pending breaches and sweeps that span it are dropped,
  - live setups whose window includes it get `data_gap`.

## 10. Default parameters

| Group | Parameter | Crypto majors | Gold (PAXG) |
|---|---|---|---|
| Swings | internalOrder / externalOrder | 2 / 5 | 2 / 5 |
| Structure | breakBufferAtr | 0 | 0 |
| Displacement | candleBodyAtr / candleBodyRatio | 1.2 / 0.6 | 1.2 / 0.6 |
| | legCandles / legBodyAtr / legCandleBodyRatio | 2–4 / 2.0 / 0.5 | 2–4 / 2.0 / 0.5 |
| Ranges | lookback / maxHeightAtr / maxEfficiency | 48 / 6.0 / 0.30 | 48 / 6.0 / 0.30 |
| | touchTolAtr / minTouches / minTouchSeparation | 0.25 / 2 / 5 | 0.25 / 2 / 5 |
| | breakCloses / breakBufferAtr / maxAge | 2 / 0.25 / 300 | 2 / 0.25 / 300 |
| Equal highs/lows | tolAtr / minGap / maxGap | 0.10 / 5 / 200 | 0.15 / 5 / 200 |
| Sweeps | minPenetrationAtr / maxPenetrationAtr / closeBackBars | 0.02 / 2.0 / 3 | 0.02 / 2.0 / 3 |
| Thin book | notionalUsd / profileBuckets | 100,000 / 24 | 20,000 / 24 |
| Order blocks | lookback / maxClusterCandles / breakWithinBars / zoneMode | 5 / 3 / 10 / wick | 5 / 3 / 10 / wick |
| FVG | minSizeAtr | 0.20 | 0.20 |
| Supply/demand | baseMaxCandles / baseBodyAtr / departureAtr | 4 / 0.5 / 2.0 | 4 / 0.5 / 2.0 |
| Zone expiry | FVG / OB / supply-demand (candles) | 200 / 300 / 300 | 200 / 300 / 300 |
| TF pairs | (context, setup) | (4h, 15m), (1h, 5m) | (4h, 15m), (1h, 5m) |
| MSS | maxBars / maxDistanceAtr / requireDisplacement | 12 / 6.0 / true | 12 / 6.0 / true |
| Levels | slBufferAtr / targetMinDistanceAtr / entry.ref | 0.10 / 1.0 / proximal | 0.10 / 1.0 / proximal |
| Timing | entryExpiryBars / maxHoldBars | 24 / 288 | 24 / 288 |
| Pattern 1 | minBarsBetweenSweeps / maxBarsBetweenSweeps / rangeEdgeTolAtr | 5 / 60 / 0.5 | 5 / 60 / 0.5 |
| Pattern 2 | proximityAtr / maxPoiFill | 1.0 / 0.5 | 1.0 / 0.5 |
| Pattern 3 | approachAtr / liqProximityAtr / sweepWindowBars / maxObFill | 2.0 / 1.0 / 12 / 0.5 | 2.0 / 1.0 / 12 / 0.5 |
| Pattern 4 | maxTargetFvgFill | 0.5 | 0.5 |
| Checklist | minRR / newsBlackout (min before/after) | 2.0 / 30, 30 | 2.0 / 60, 60 |
| Quality | lowLiqVolumeRatio / maxSpreadBps / lateThresholdSec | 0.3 / 5 / 120 | 0.3 / 15 / 120 |
| Gold only | blockConfirmWhenUnderlyingClosed | — | true |

## 11. Judgement calls for approval

| # | Decision | Proposed | Alternative |
|---|---|---|---|
| J1 | Does confirmation need displacement? | Yes: MSS = break + displacement | Accept any CHOCH (more setups, more noise) |
| J2 | Swing sizes | k = 2 internal, 5 external, on every TF | Different k per TF |
| J3 | Range detection | Locked boundaries, efficiency-ratio filter | Rolling boundaries (simpler, but sweeps then stretch the range) |
| J4 | Sweep close-back window | 3 candles; false breakouts count as sweeps | Wick-only sweeps (stricter) |
| J5 | Order block zone | Full wick range of the last opposite candle, cluster of up to 3 | Body only (tighter zones, more misses) |
| J6 | Entry and targets | Entry at the zone's proximal edge; T1 = nearest opposing liquidity at least 1 ATR away | Entry at the zone midpoint (CE) |
| J7 | Pattern 4 | Reversal toward the internal FVG (detailed card) | Also build the continuation variant from the summary card |
| J8 | Checklist item 1 for reversals | Half credit when the context TF is ranging and the sweep is in premium/discount | Strict alignment only |
| J9 | Gold-market closures | Setups can't confirm during a closure | Allow them, flagged |
| J10 | Concurrent setups | One live setup per instrument + pattern + direction + TF pair | Allow overlapping setups |

## 12. Labelled fixtures

Fixtures live in `packages/smc-engine/fixtures/<concept>/<case>.json`:

```json
{
  "id": "p1-bearish-variant-a-001",
  "description": "Double sweep of range high, MSS with displacement, FVG entry",
  "profile": "crypto-majors@1",
  "source": "recorded:binance:BTCUSDT:2026-10-02T08:00Z/2026-10-02T20:00Z",
  "candles": { "5m": [[1759392000000, "60321.5", "60410.0", "60290.1", "60388.2", "152.31"]], "1h": [] },
  "context": { "closures": [], "economicEvents": [] },
  "expected": [
    { "type": "sweep", "at": "2026-10-02T10:35:00Z", "levelType": "range_high", "kind": "wick" },
    { "type": "setup_transition", "pattern": "double_liquidity_trap", "to": "confirmed", "at": "2026-10-02T11:10:00Z" }
  ],
  "notExpected": [{ "type": "setup_transition", "to": "confirmed", "before": "2026-10-02T11:10:00Z" }],
  "labelledBy": "analyst-a",
  "reviewedBy": "analyst-b"
}
```

(The fixture above is illustrative; its numbers are not real data.)

- Recorded fixtures come from real stored candles. Synthetic fixtures cover edge cases that are rare in real data.
- Every recorded fixture is labelled by one person and reviewed by a second. Phase 4 includes a development-only labelling page in the web app.
- Minimum coverage: for every concept in §2–§4, 3 bullish, 3 bearish and 3 negative cases. For every pattern and variant, 5 positive cases in each direction and 5 near-misses. For the gold profile, closure, reopening and thin-book cases.

## 13. Test obligations

- **Golden fixtures**: every fixture passes in CI.
- **Prefix stability** (repaint test): for random n, the events emitted while processing candles 0..n are identical whether or not later candles exist. Property-based, using fast-check.
- **Replay equals live**: replaying a stored period reproduces the live run's event digest exactly.
- **Invariants**: no transition out of `resolved`; no event refers to a candle after the one being processed; prices respect the instrument tick.
- **Performance**: p95 `step` time ≤ 2 ms per candle for one instrument with all rules enabled, on the reference CI runner.
