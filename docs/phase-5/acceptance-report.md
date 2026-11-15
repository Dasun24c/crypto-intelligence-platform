# Phase 5 · SMC points of interest: acceptance report

| | |
|---|---|
| Status | **Accepted 2026-11-11** (you asked to start Phase 6), with these items carried forward: the review of rulebook §14 notes I14–I24 (and I1–I13); recorded fixtures reviewed by a second person, now also for zones (5.1 is met with synthetic fixtures only); a 7-day replay of purely live time; the first start's serial warm-up; and the Phase 3 and Phase 2 items. Committed as 61147fc, pushed, and opened as pull request #1 |
| Date | 2026-11-11 |
| Scope | [Implementation plan, Phase 5](../phase-0/08-implementation-plan.md#phase-5--smc-points-of-interest) |
| Evidence | This machine (Windows 11, Docker Desktop, Node.js 26.13.0); the local Compose stack streaming live public data from Binance and Coinbase; nine new live runs (ruleset `indicators-1+smc-0.2.0`), live from 2026-11-11 09:56 UTC; checks to 10:23 UTC |

## Summary

Phase 5 adds rulebook §4, points of interest, to the SMC engine and everything around it:

- **The engine** (`packages/smc-engine`, ruleset 0.2.0):
  - order blocks from every structure break whose leg contains displacement, with their cluster, the `htf` flag and `sweptLiquidityAtOrigin`;
  - fair value gaps, at least 0.2 ATR;
  - supply and demand zones: a base of small candles, then a departure of at least 2 ATR;
  - for every zone, touches, the fill percentage, `partially_filled` and `filled`, invalidation on a close beyond the far edge, expiry, and internal or external location against an active range.
  - Zones run on the structure timeframes (5m to 1d), after the sweeps of the same candle, as the rulebook orders it.
  - Where §4 leaves a choice open, the engine's answer is listed as implementation notes I14–I24 in [rulebook §14](../phase-0/07-smc-rulebook.md#points-of-interest-ruleset-020), for your review.
- **Fixtures and tests**:
  - 45 new golden fixtures, covering five concepts (order blocks, FVGs, supply/demand, fills and statuses, location), 3 bullish, 3 bearish and 3 negative each;
  - zone invariants in every fixture, the property test and the real-data test;
  - unit tests for each rule at its boundaries.
- **Storage**: migration 0008 adds the `poi_zones` projection, two event types (`zone_created`, `zone_status`), and profiles version 3 with the zone settings.
- **Runtime and API**:
  - the analyzer projects and publishes zones;
  - `GET /smc/{id}/zones`;
  - zones in the overlay and in the `smc` channel (messages and snapshot).
- **The labelling page**: it draws zones and offers them, with their latest status, as candidates to label. It can also add a missed zone.

Verification found two defects, both while I designed the fixtures, before any fixture ran: the fill percentage could be off by 0.01, and one of my unit tests did not test what it claimed. Both are fixed and listed [below](#found-by-verification-and-fixed). The live checks found nothing new: the runtime needed no change for zones.

## Acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 5.1 | Golden fixtures for rulebook §4 pass | **Met, with synthetic fixtures** (as 4.1) | [5.1](#51-golden-fixtures) |
| 5.2 | Fill percentages and status transitions match fixture expectations | **Met** | [5.2](#52-fills-and-statuses) |
| 5.3 | Prefix stability and replay digests still pass with POIs enabled | **Met**: every cut point of all 182 fixtures; live replays reproduce all nine runs, over 7 days and over live time | [5.3](#53-stability-and-replays) |

### 5.1 Golden fixtures

182 fixtures now pass in `golden.test.ts`: Phase 4's 137, unchanged and still passing with zones on, plus 45 for §4. The coverage test requires 3 bullish, 3 bearish and 3 negative fixtures for each §4 concept, as for §2–§3.

| Concept | Bullish (and their mirror images) | Negative |
|---|---|---|
| Order blocks | An initial BOS with displacement: a cluster of 3 down-close candles, created once for the internal and external break; an MSS after two higher highs; a BOS whose leg starts at a wick sweep (`sweptLiquidityAtOrigin`) | A BOS without displacement; a break 12 candles after the leg start (more than 10); no opposite-colour candle among the 5 searched |
| Fair value gaps | A clear gap; a gap of exactly 0.2 ATR; two gaps in a row | 0.29 against 0.30; candles that touch; a missing middle candle |
| Supply and demand | A single-candle departure; a two-candle leg after a two-candle base; one candle between base and departure | Travel short of 2 ATR; base candles too large; two candles between base and departure |
| Fills and statuses | See [5.2](#52-fills-and-statuses) | |
| Location | Internal, external and straddling while a range is active | Before any range; at the candle where the range ends; on 4h, where ranges never run |

- **How they were made**: as in Phase 4. I designed each pattern and worked out its answer from the rulebook before running anything; the bearish twins are exact mirror images. All 45 matched on their first run.
- **Whether the checks bite**: changing one expected fill from 75 to 76 makes its fixture fail in two ways. My value is reported missing, and the engine's actual event is reported as not labelled.
- **Real data**: on 34 days of BTCUSDT, every zone kind appears in both directions, and every status occurs. See [Real data](#real-data).
- **Not yet**: recorded fixtures reviewed by a second person (§12), as for Phase 4. The labelling page now covers zones.

### 5.2 Fills and statuses

The `zone-fills` fixtures check every value of every status event of their zone (each fixture lists them all). They use a bullish FVG [100.75, 101.75] of height 1:

| Fixture | Candles | Events |
|---|---|---|
| zone-fill-stepwise | Lows 101.45, 101.55, 101.0, 100.75, then a close at 100.7 | touch 30 %; nothing (not deeper); fill 75 %; `filled` 100 %; `invalidated` |
| zone-fill-edge-touch | A low exactly at the top; a low and a close exactly at the bottom | touch at 0 %; `filled`, not invalidated (a close at the edge is not beyond it) |
| zone-expired | Touched once (30 %), then 200 candles above it | `expired` at the 200th candle after creation, keeping 30 % and the first touch |
| zone-near-miss | A low one cent above the top | nothing |
| zone-wick-through | One wick through the whole zone, closing inside | touched and `filled` at once; never invalidated |
| zone-creation-candle | An order block whose creating candle lies inside it | nothing: a zone is evaluated from the next candle |

- **Every fixture, the property test and real data** check the same invariants: statuses only move forward; the fill never shrinks; it reads 100 exactly when the zone is `filled`; a zone never changes after it is invalidated or expired.
- **Exact fills**: the fill is computed in whole price units, so 29 % reads 29, not 28.99 (defect 1). A unit test checks a BTC-sized zone, where the arithmetic exceeds 2^53.

### 5.3 Stability and replays

- **No repainting with zones**: every one of the 182 fixtures is checked at every cut point, and checkpoints continue exactly. The fast-check property test (1,000 random markets with gaps and partial candles) and the real-data test pass with zones on.
- **Integration tests** (`apps/analyzer/test/smc.int.test.ts`), where every digest now includes zone events:
  - a run killed mid-way and finished by a standby equals replays over three periods;
  - a run paused at a gap and resumed after the repair equals a replay;
  - the zone projection matches the event log: one row per zone, holding the status, fill and first touch of its last status event; order blocks point at their break; links go both ways.
- **Live, 7 days**: deploying Phase 5 superseded every run; the new ones warmed up with zones at 09:56 UTC. `cli.js replay` over the 7 days to 09:54 reproduced every run's digest, which now includes the zone events:

| Instrument | Events in the 7 days | Digest (first 16) | Equal |
|---|---|---|---|
| BTCUSDT | 4,167 | `2ddea6e857d3787f` | Yes |
| ETHUSDT | 4,028 | `460a1ce70b267c90` | Yes |
| SOLUSDT | 3,849 | `354e30853e3d195f` | Yes |
| PAXGUSDT | 4,439 | `d2ab71ba5f4d8794` | Yes |
| BTC-USD | 3,662 | `8894e4b869908339` | Yes |
| ETH-USD | 3,542 | `2082fe3f219408f4` | Yes |
| SOL-USD | 3,598 | `87649146d78fcc75` | Yes |
| PAXG-USD | 4,204 | `1760469200593781` | Yes |
| USDT-USD | 2,953 | `a3d25049f0568fc7` | Yes |

  Those 7 days were computed during the warm-up. Phase 4's BTCUSDT had 2,473 events over a comparable week; zones make up the difference.
- **Live time**: a replay of 09:50 to 10:19 UTC (each run's live time so far, 10–30 events per run, zone creations and fills among them) also reproduced all nine digests.

## Real data

On 34 days of Binance BTCUSDT (5m, aggregated to 15m–1d), zones per day:

| Timeframe | FVGs (bullish / bearish) | Order blocks | Demand / supply |
|---|---|---|---|
| 5m | 29.6 / 29.2 | 6.8 / 5.9 | 4.2 / 4.0 |
| 15m | 7.6 / 7.1 | 1.8 / 1.9 | 0.9 / 1.0 |
| 1h | 1.4 / 1.6 | 0.3 / 0.5 | 0.2 / 0.3 |
| 4h | 0.4 / 0.4 | 0.1 / 0.1 | 0 / 0.1 |

- Most 5m zones are invalidated within the hour (median 55 minutes after creation); 1h zones last about 11 hours.
- 219 order blocks are linked to an overlapping supply or demand zone; 240 order blocks start right after a sweep.
- Zones are 41 % of all events, about 390 a day for one instrument.
- The engine's step stays far inside its budget (`realdata.test.ts` fails above 2 ms).

## Live

On the local stack, after the deploy (2026-11-11 09:56 to 10:23 UTC):

- **Zones per run**: each new run holds 510 to 1,223 zones from its warm-up (1,000 candles per timeframe). Of those, 31 to 88 are live; most others are invalidated, and 34 to 158 expired. 54 to 138 are linked to a zone of the other kind.
- **Live zone events**: in the first 25 minutes of live time, each run created 1 to 3 zones and recorded 4 to 12 touches, fills, invalidations or expiries.
- **The API**: `GET /smc/{id}/zones?tf=1h` returned BTCUSDT's 34 live zones on 1h and longer timeframes. Among them was a 1h bearish order block linked to an overlapping supply zone, and 4h FVGs filled to 99.16 %. The 15m overlay held 123 zones across all five statuses.
- **Speed**, over the 20 minutes 10:01 to 10:21 UTC:
  - SMC detections, zones included, were published **p95 77 ms** after the candle was final (n = 122), and indicator points p95 59 ms. Measured from the venue's minute boundary, the p95 was 3.0 s (Coinbase's 2 s late-trade grace); on Binance alone, 0.2 to 0.3 s.
  - The engine's step p95 was **0.19 ms** over the last 4,096 steps.
- **Consistency**: every run's event log is contiguous, and every detection decided live was published exactly once (12 to 27 per run).
- **Start-up**: the nine runs warmed up in 6 to 8 s each. PAXG-USD took longer because Coinbase's daily history is short.

## Found by verification and fixed

| # | Defect | Effect | Fix |
|---|---|---|---|
| 1 | The fill percentage was a floating-point ratio, floored | 29 % would read 28.99 (0.29 × 10,000 = 2,899.999…); exact fixtures would fail and the API would show it | Computed in whole price units with integer arithmetic; a unit test covers 29 % and a BTC-sized zone |
| 2 | My unit test for "one candle between base and departure" did not reach that path (the in-between candle became part of the departure) | The rule was untested | The test's data now forces the path, and checks a second case with two candles between (no zone) |

## Tests and coverage

1,301 automated tests, all passing:

- `pnpm verify` passes: formatting, lint, typecheck, dependency rules, the no-trading check, unit tests with coverage gates, build and the artefact scan.
- The integration suites of all six packages that have them pass with coverage.
- Playwright passes 5 of 5 against the live Phase 5 stack.

| Package | Tests | What is new in Phase 5 | Coverage gate | Measured (lines / branches) |
|---|---|---|---|---|
| smc-engine | 593 (Phase 4: 443) | 45 golden fixtures, each with 3 checks; unit tests for the zone rules (14); zone invariants in the golden, property and real-data tests; every zone kind and status on real data | 90% | 99.7% / 98.3% |
| contracts | 54 | `PoiZone`, the zones query, the profile's zone settings | 90% | 100% / 100% |
| db | 22 | Migration 0008, profiles version 3 equal to the engine's defaults | 70% | 98.4% / 81.3% |
| analyzer | 21 | Zone projections equal to the event log (status, fill, first touch, links); every digest now includes zones | 70% | 90.5% / 79.5% |
| api | 258 (Phase 4: 253) | `GET /smc/{id}/zones`, zones in the overlay and the channel snapshot, the new route in the RBAC matrix | 70% | 92.1% / 75.1% |
| app | 117 | Zones on the labelling page | none yet | 86.6% / 76.4% |
| indicators, domain, market-data, exchange-adapters, observability, ingestor, jobs, ui | 73, 23, 40, 25, 15, 20, 31, 4 | Unchanged | as before | as before |
| End to end | 5 | Unchanged | — | — |

## Decisions made during Phase 5

| Decision | Why | Recorded in |
|---|---|---|
| The eleven engine choices where §4 is silent (I14–I24) | Each is listed with its reason; changing one is a new ruleset version | [Rulebook §14](../phase-0/07-smc-rulebook.md#points-of-interest-ruleset-020) |
| Ruleset 0.2.0 and profiles version 3; the analyzer's rules version becomes `indicators-1+smc-0.2.0` | New event types change every digest, so Phase 4 runs are superseded | Migration 0008; [architecture §7](../phase-0/03-architecture.md#7-analysis-pipeline) note |
| `fill_pct` stored as `numeric(5,2)`, not `real` | The engine's fill is exact to 0.01 %; `real` would not round-trip it | [Data model](../phase-0/05-data-model.md) note |
| `PoiZone` adds `firstTouchAt`, `statusChangedAt`, `structureEventId`, `linkedZoneId` and `sweptLiquidityAtOrigin` | The patterns (Phase 6) need them; the data model already holds them | [API contracts](../phase-0/06-api-contracts.md) note |

## Carried forward

| Item | Plan |
|---|---|
| Review of rulebook §14 notes I1–I13 (Phase 4) and I14–I24 (Phase 5) | Yours to decide |
| Recorded fixtures reviewed by a second person (§12), now also for zones | Need two people; the labelling page is ready |
| A 7-day replay of purely live time | Once a stack has run for 7 days |
| A first start (or rules change) warms runs up one after another | Unchanged from Phase 4; this deploy hits it again |
| From Phase 3 and Phase 2: the trend rule and volume threshold; decisions 1 and 2; D2 hosting; the pull requests CI needs | Unchanged |

## What I need from you

1. **Review the implementation notes I14–I24** ([rulebook §14](../phase-0/07-smc-rulebook.md#points-of-interest-ruleset-020)), along with I1–I13 from Phase 4.
2. **Recorded fixtures (§12)**: label some with a colleague using `/dev/labelling`, or accept the synthetic fixtures for now.
3. **Still open**: the Phase 3 trend rule and volume threshold; Phase 2 decisions 1 and 2; D2 hosting; the pull requests.
4. Your approval of this report, and whether to commit Phase 5 (and push it).
