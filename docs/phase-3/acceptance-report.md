# Phase 3 · Technical analysis: acceptance report

| | |
|---|---|
| Status | **Built; awaiting your review.** All five criteria are met. For 3.5 you decided on 2026-11-11 that latency is measured from the moment a candle is final in the platform |
| Date | 2026-11-10 |
| Scope | [Implementation plan, Phase 3](../phase-0/08-implementation-plan.md#phase-3--technical-analysis) |
| Evidence | This machine (Windows 11, Docker Desktop, Node.js 26.13.0); TA-Lib 0.8.3 (official wheel, Python 3.14.5); the local Compose stack streaming live public data from Binance and Coinbase, 2026-11-10 13:50–15:56 UTC |

## Summary

Phase 3 delivers technical analysis, end to end:

- **The indicators package** (`packages/indicators`): RSI, MACD, EMA, ATR, VWAP, volume anomalies and the indicator trend, each in streaming and batch form.
  - RSI, MACD, EMA and ATR are bit-identical to TA-Lib 0.8.3. That needed a correctly rounded fused multiply-add, because TA-Lib 0.8 computes with C's `fma()` ([ADR 016](../adr/016-indicators-match-ta-lib-fma-arithmetic.md)).
  - VWAP uses exact decimal sums.
- **The TA-Lib reference tool** (`tools/reference-data`, dev-only, [ADR 012](../adr/012-ta-lib-reference-data.md)). It produced 9 datasets of 10,000 Binance candles each, plus a script that checks a running stack's stored values against TA-Lib.
- **The analyzer**:
  - one live run per instrument, behind a lease;
  - each timeframe warmed up on 1,000 candles of history, so the ingestor and the backfill now fetch 5m–1d history from the venues' candles when it is short;
  - analysis pauses at data gaps (ADR 005);
  - values stored in `analysis.indicator_values` and published on `an:events`.
- **The API**:
  - `GET /indicators/{id}`, `GET /system/runs`;
  - the analysis state in System Health;
  - the durable `indicators:{id}:{tf}` channel.
- **The Technical Analysis page**: price, EMA and VWAP chart, RSI, MACD and volume panels, the latest values, and the run's state. System Health also lists the analysis state of every instrument.

Verification found eight defects that the unit and integration tests had not:

- **One** came from the golden test.
- **Seven** came from the live stack. Four of those were in Phase 2 code; they surfaced because analysis now waits at every missing minute.

All are fixed and listed [below](#found-by-verification-and-fixed).

## Acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 3.1 | RSI, MACD, EMA and ATR match TA-Lib within 1e-9 relative error after the documented warm-up, on 3 instruments × 3 timeframes × 10,000 candles | **Met, to the bit** | See [3.1](#31-ta-lib) below |
| 3.2 | VWAP matches hand-verified fixtures exactly, including the 00:00 UTC anchor reset | **Met** | See [3.2](#32-vwap) below |
| 3.3 | Volume-anomaly and trend detection pass labelled positive and negative fixtures | **Met** | See [3.3](#33-volume-anomalies-and-trend) below |
| 3.4 | Streaming and batch implementations give identical results on the same data (property test) | **Met** | See [3.4](#34-streaming-and-batch) below |
| 3.5 | Indicators published ≤ 1 s (p95) after candle close; a script confirms the UI shows the API's values | **Met** (p95 114 ms from the candle being final, as you decided) | See [3.5](#35-publishing-and-the-ui) below |

### 3.1 TA-Lib

**Golden test** (`golden.test.ts`):

- **Data:** BTCUSDT, ETHUSDT and PAXGUSDT × 5m, 1h and 4h, the 10,000 Binance candles before 2026-11-01 00:00 UTC (no gaps).
- **Reference:** the official TA-Lib 0.8.3 wheel (C library built 28 Oct 2026); each dataset records the versions.
- **Result:** all 716,454 values after the warm-ups are **bit-identical** to TA-Lib (relative error 0), for the batch, the streaming and the combined series alike.
- **Assertions:** the test asserts the criterion (1e-9) and, separately, bit-identity, so any drift shows.
- **Warm-ups**, documented next to each indicator and in [`packages/indicators/README.md`](../../packages/indicators/README.md): RSI 14, MACD 33, EMA 19 / 49 / 199, ATR 14.

**Live:** `tools/reference-data/check_live.py` reads every stored value of every run (9 instruments × 6 timeframes) through the API and recomputes it with TA-Lib from the run's first candle. On the fresh runs, after the fixes: **411,124 of 411,124 values bit-identical** across all 54 series. Every run starts 1,000 candles back, except PAXG-USD 1d, which starts where Coinbase's history begins (2025-05-08, 551 candles).

The first live check found one real difference (defect 6 below); after the fix, the check was rerun on fresh runs.

### 3.2 VWAP

[`fixtures/vwap/hand-verified.json`](../../packages/indicators/fixtures/vwap/hand-verified.json) holds 4 cases and 21 values, each with its arithmetic written out:

- two whole UTC days of 4h candles: the anchor resets at 00:00, so day 2 starts at 99 rather than the carried-over 101.44;
- a 5m series that starts before midnight: that day has no VWAP, because its 00:00 is unseen;
- decimal exactness: volumes 0.1 and 0.2 give exactly 3, where doubles give 2.9999999999999996;
- venue-precision prices and volumes.

Every value equals the double nearest the hand-derived one, in the batch, streaming and combined forms.

VWAP is not reported on 1d candles, where one candle per day makes it just the typical price.

### 3.3 Volume anomalies and trend

[`fixtures/labelled/volume.json`](../../packages/indicators/fixtures/labelled/volume.json) has 9 cases:

- **3 anomalies**: a spike, a spike just past the threshold, a trade in a thin market;
- **5 normal**: busy, just under the threshold, quiet, an ordinary thin-market trade, steadily rising volume;
- **1 without a basis**: identical volumes.

`labelled.test.ts` has 8 trend cases:

- **bullish and bearish**: steady rises and falls, with and without noise;
- **neutral**: a flat market, alternating noise, a sharp pullback inside an uptrend, no range at all.

All 17 pass. Each also checks that values are null throughout the warm-up and that the streaming form agrees.

### 3.4 Streaming and batch

`property.test.ts` runs 400 random series of over 70,000 candles in total, with:

- random settings and timeframes;
- flat stretches, zero volume and price gaps;
- series that start mid-day.

`IndicatorSeries` (one candle at a time) gives exactly the values `computeIndicators` gives, compared with `Object.is`. It also checks that values never repaint: for 60 series, 5 cut points each, a prefix gives the same values as the full series.

On the stack, each analyzer restart recomputes runs from their stored start. The values match what was stored, and nothing is published twice (`analyzer.int.test.ts`).

### 3.5 Publishing and the UI

**Publishing.** `scripts/analysis-latency.mjs` measured 32 minutes of the live stack (15:01–15:33 UTC): 360 publications from 9 instruments on 1m, 5m and 15m.

| From | To | p50 | p95 | max |
|---|---|---|---|---|
| The ingestor announcing a final candle (`md:candles`) | `indicators.closed` on `an:events` | 14 ms | **114 ms** | 343 ms |
| The minute boundary, venue time: Binance (4 pairs) | the same | 142–242 ms | **194–338 ms** | 463 ms |
| The minute boundary, venue time: Coinbase (5 products) | the same | 1.64–1.76 s | **2.67–2.88 s** | 3.42 s |

How to read the rows:

- **The analyzer** (first row) is timed on one clock, Redis stream ids at both ends. Its p95 is well inside 1 s.
- **Binance**, measured from the venue's minute boundary, also meets 1 s.
- **Coinbase** does not. Its candles are built from trades and become final only after the 2 s late-trade grace (Phase 2, architecture §5.4), so that wait makes up most of the figure; analysis adds the first row's 0.1 s. No trade arrived late in this window: the ingestor counted 0.
- **Clock caveat**: boundary-based figures from this host are good to about ±1 s. The Docker VM's clock drifted from 2.3 s to 1.2 s ahead of venue time during the window, and the ingestor re-measures it only every 5 minutes.

**Decided on 2026-11-11:** "after candle close" means after the candle is final in the platform, which is the first row. Coinbase's 2 s late-trade grace stays as it is. NFR-02 is read the same way.

**UI = API:** [`e2e/tests/analysis.spec.ts`](../../e2e/tests/analysis.spec.ts) is the script the criterion asks for. It does five things:

1. It signs in.
2. It opens Technical Analysis for an instrument with an open run.
3. It reads the 13 values of the latest closed candle. Each value sits in a `data-value` attribute exactly as the API sent it.
4. It compares them with `GET /indicators/{id}?tf&limit=1` for the same candle: numbers by `Object.is`, null as null, and the run id and warm-up flag too.
5. It runs an accessibility scan.

Results:

- **Live stack:** passed, with every value present.
- **Fresh replay stack** (as CI runs it): the full suite passed, 5 of 5 specs in 1.6 minutes. The replay venue has no history, so after two minutes each instrument had only 1–2 one-minute points, all still in warm-up (null). That run checks the wiring and the handling of missing values; the live run checks real ones.

## Found by verification and fixed

| # | Defect | Effect | Fix |
|---|---|---|---|
| 1 | The first implementation used the documented TA-Lib formulas; TA-Lib 0.8 computes with `fma()` | Last-place differences; MACD near zero failed 1e-9 (up to 2.2e-8) | TA-Lib 0.8's arithmetic, with a correctly rounded software `fma` ([ADR 016](../adr/016-indicators-match-ta-lib-fma-arithmetic.md)) |
| 2 | A minute lost before anything recorded a gap stayed lost: Phase 2's defect 1 left Coinbase's 06:53 missing, with its gap marked repaired | All five Coinbase products paused at 06:53, correctly, with nothing to repair it | The consistency check finds holes in our own 1m history, even where the venue has no candle, and queues each for the backfill. The jobs service sweeps the last 24 h every 10 minutes; nightly and on-demand checks do the same. Only missing minutes are added: published candles still never change |
| 3 | A Coinbase stream's first connection, opening a few seconds after the minute the pipeline planned to start with, dropped that minute without a gap (Phase 2) | Coinbase minute 13:53 lost on a restart | The first connection records a gap for minutes it never saw |
| 4 | A run started a short history where it began, and a restart after older history arrived would start elsewhere | One run's stored values would mix two computations | Each timeframe's start is stored on the run (`series_origins`) and kept |
| 5 | This database held only one day of 1m history (from Phase 2 testing), so 5m had 374 candles, not 1,000 | 5m warmed up on a third of its history | 5m is fetched from the venues' candles whenever it is short, like 15m–1d |
| 6 | A partial aggregate (missing minutes, no gap recorded yet) was taken as final | After the repair rebuilt it, 10 PAXG-USD 5m values no longer matched TA-Lib on the stored candles (up to 1.2%) | A partial aggregate whose missing minutes lie inside the 1m history is held ("waiting for repair") unless its gap was given up as unrepairable |
| 7 | The consistency check on a day not yet over asked the venues for future candles | Coinbase answered HTTP 400; the check failed | It checks up to the last settled minute |
| 8 | A failed first clock-offset measurement waited 5 minutes for the next one (Phase 2) | Feeds reported 2.5 s "delayed", and Coinbase minutes closed on the fast local clock (Phase 2's defect 4 again) for up to 5 minutes | Retried every 15 s until the first success |

## Tests and coverage

638 automated tests, all passing:

- `pnpm verify` passes: formatting, lint, typecheck, dependency rules, the no-trading check, unit tests with coverage gates, build and the artefact scan.
- `pnpm test:integration:coverage` passes.
- Playwright passes 5 of 5 on a fresh replay stack.

Beyond the automated suite, `tools/reference-data/check_live.py` compares a running stack with TA-Lib.

| Package | Tests | Kind | Coverage gate | Measured (lines / branches) |
|---|---|---|---|---|
| indicators | 68 | unit: TA-Lib golden datasets, VWAP and labelled fixtures, the streaming = batch property, `fma` against an exact reference (1.3 million operands) | 90% | 99.0% / 94.8% |
| contracts | 49 | unit | 90% | 100% / 100% |
| domain | 23 | unit | 90% | 99.0% / 95.9% |
| market-data | 40 | unit | 90% | 98.1% / 90.4% |
| exchange-adapters | 25 | unit | 70% | 93.8% / 74.5% |
| observability | 15 | unit + Valkey integration | 70% | 94.7% / 83.0% |
| db | 22 | unit + TimescaleDB integration | 70% | 98.4% / 81.3% |
| api | 213 | unit + integration, including the RBAC matrix (38 routes) and the indicators channel | 70% | 91.1% / 75.0% |
| ingestor | 20 | unit + integration, including history gaps and a late first connection | 70% | 92.4% / 80.6% |
| jobs | 31 | unit + integration, including history at each timeframe and hole repair | 70% | 96.6% / 86.0% |
| analyzer | 13 | unit + integration: warm-up equal to the package, live publishing, gaps, partial candles, restarts, leases, profile changes, fixed series starts | 70% | 91.4% / 79.5% |
| app, ui | 110 + 4 | unit (jsdom) | none yet | app 87.4% / 78.4% |
| End to end | 5 | Playwright on the Compose stack | — | — |

## Decisions made during Phase 3

| Decision | Why | Recorded in |
|---|---|---|
| Criterion 3.5 and NFR-02 are measured from the moment a candle is final in the platform (the ingestor's `md:candles` entry), not from the venue's minute boundary. You decided this on 2026-11-11 | Coinbase candles become final only after the 2 s late-trade grace, and the grace stays | [Implementation plan](../phase-0/08-implementation-plan.md#phase-3--technical-analysis) and [requirements](../phase-0/01-requirements-analysis.md) notes |
| Match TA-Lib 0.8 bit for bit, `fma` included | The criterion's 1e-9 cannot be met near MACD's zero crossings otherwise, and deterministic replays (Phase 4) benefit | [ADR 016](../adr/016-indicators-match-ta-lib-fma-arithmetic.md) |
| **Indicator trend**: bullish when close > EMA 20 > EMA 50 > EMA 200 and EMA 50 rose ≥ 0.1 ATR over 5 candles; bearish mirrored; else neutral | The requirements name the trend but not its rule. Without the minimum slope, alternating noise read as a trend; on 90,000 Binance candles the floor relabels only the weakest tenth of aligned candles | [`packages/indicators/README.md`](../../packages/indicators/README.md) |
| **Volume anomaly**: robust z (median and MAD over the previous 50 candles; the mean absolute deviation when the MAD is 0), flagged at z ≥ 3.5, spikes only | Robust to the outliers it looks for; 3.5 is Iglewicz and Hoaglin's cut-off | same |
| VWAP is null on 1d and for a day the series did not see from 00:00 UTC; RSI reads 50 on a flat market (TA-Lib 0.8) | Never show a value that cannot be right | same |
| `GET /indicators/{id}` returns `{ run, params, points }`, not a bare array; `SystemHealth.analysis` arrived in Phase 3 | The chart needs the run's settings and warm-up boundary; the analysis state exists now | [API contracts](../phase-0/06-api-contracts.md) notes |
| Warm-up: 1,000 candles per timeframe (`HISTORY_CANDLES`). A timeframe waits while its history is being fetched; with no history gap recorded after 120 s, it accepts the shorter history the venue has (a later listing, or the replay venue) | The architecture asks for at least 500 candles of the highest timeframe | [Architecture §7](../phase-0/03-architecture.md#7-analysis-pipeline) note |
| No checkpoints yet: a restart recomputes each run from its start, publishing nothing again; the lease has no fencing epoch yet | Indicator writes are idempotent and deterministic; checkpoints and epochs belong to the Phase 4 engine runtime | same |

## Calibration: volume anomalies

On the live 1h BTCUSDT chart, 18 of the last 150 candles reach z ≥ 3.5. Crypto volume is heavy-tailed, so a normal-distribution cut-off flags often, especially around large moves. The detection does what the definition says, but the threshold probably needs calibrating per timeframe before Phase 8's alert rules use it.

## Carried forward

| Item | Plan |
|---|---|
| From Phase 2: decision 1 (NFR-01 against the ticker rate), decision 2 (Coinbase candles for thin products) | Still yours to decide; unchanged |
| From Phase 2: chaos tests (2.4) and the 24 h soak (2.6) | On the staging host, once D2 is decided |
| The first CI run, and the nightly live run | Wait for the pull request (D7) |
| Engine checkpoints and lease fencing epochs | Phase 4 |
| History is refetched at each start when the venue has less than 1,100 candles (PAXG-USD 1d on Coinbase starts in 2025) | A few requests, and that timeframe waits a minute per start. A per-instrument note that the venue's history is exhausted would avoid it; harmless until then |
| Theme colours meant for chart series | The charts borrow status colours (`warn`) for one series; a few older labels (`fg-subtle`) fall short of 4.5:1 contrast on pages the accessibility scan does not cover yet |

## What I need from you

Criterion 3.5 is settled: you chose to measure from the candle being final (2026-11-11). Still open:

1. **The indicator trend rule** (EMA order plus EMA 50 slope ≥ 0.1 ATR over 5 candles): approve it or adjust it. The requirements name the trend but not its rule.
2. **The volume-anomaly threshold:** keep 3.5 until Phase 8's alerts calibrate it, or calibrate per timeframe now.
3. **Still open from Phase 2:** decision 1 (NFR-01 against the ticker rate), decision 2 (Coinbase candles for thin products), D2 hosting, and the pull request, which CI needs.
4. Your approval of this report, and whether to commit Phase 3 (and push it).
