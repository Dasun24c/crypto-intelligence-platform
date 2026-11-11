# Phase 2 · Market data: acceptance report

| | |
|---|---|
| Status | **Accepted 2026-11-10** (you asked to start Phase 3), with these items carried forward: decision 1 (NFR-01 against the ticker rate, 2.10) and decision 2 (Coinbase candles for thin products, 2.2) are still open; the soak (2.6) and chaos tests (2.4) wait for D2; the first GitHub CI run and the nightly live run (2.11) wait for the pull request. Originally: 6 met, 2 partly verified, 1 measured but not met as written, 2 not yet run |
| Date | 2026-11-10 |
| Scope | [Implementation plan, Phase 2](../phase-0/08-implementation-plan.md#phase-2--market-data) |
| Evidence | This machine (Windows 11, Docker Desktop, Node.js 26.13.0), live public data from Binance (`data-stream.binance.vision`, `data-api.binance.vision`) and Coinbase Exchange, 2026-11-10 06:30–09:45 UTC |

## Summary

Phase 2 delivers live market data for the nine pairs, end to end:

- adapters for Binance and Coinbase (public endpoints only, no keys), a message recorder, and a **replay venue** that plays recordings through the same code (ADR 015)
- 1m candles (Binance: the venue's kline; Coinbase: built from trades, flat when nothing traded) with micro volume profiles, aggregated to 5m–1d in the same transaction
- local order books with sequence validation, 1 Hz depth metrics, 10 s snapshots
- gap detection (sequence, heartbeat, reconnect, silent streams, missing candle close) and REST backfill
- the gold closure calendar and `underlying_closed` flags, the PAXG cross-venue spread with the USDT-USD conversion
- large trades (merged per taker order) and order-book walls
- REST endpoints, instrument administration (audited, live without restarts), pair-status polling, a nightly candle consistency check
- the Socket.IO gateway: live ticker, book and candle channels, durable channels with replay after a reconnect (ADR 014)
- the Command Center, Market Activity, System Health feeds and admin Instruments pages

Verifying against the live venues and in Docker found ten defects that the unit and integration tests could not see. All are fixed and listed [below](#found-by-live-verification-and-fixed). Two findings need your decision.

## Acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 2.1 | All 9 pairs stream trades, books and tickers. Live prices update in the UI at least once per second. | **Met** | All 9 instruments and 31 feeds connected (System Health; [`scripts/live-smoke.mjs`](../../scripts/live-smoke.mjs) passed). Delivered to a WebSocket client over 60 s: BTC tickers 1.5–2.3/s, ETH 1.5/s, books 9.5/s per instrument, candles in progress 1/s. The Command Center in a browser shows prices changing between screenshots 2 s apart. An illiquid pair's price changes only when it trades (PAXG-USD 0.3 updates/s, USDT-USD 0.1/s); the UI shows how old each price is and invents nothing in between. |
| 2.2 | Over 24 h, Binance 1m, 1h, 4h and 1d equal the venue's REST klines; Coinbase 1m, 1h and 1d match REST candles for every interval with trades, with flat candles for the rest | **Partly verified** | Binance 1m: **96 of 96** minutes identical to the REST klines (two windows). Coinbase 1m after the clock fix ([defect 4](#found-by-live-verification-and-fixed)): BTC-USD, ETH-USD, SOL-USD **42 of 42** identical. PAXG-USD and USDT-USD differ, and the difference is Coinbase's own: its REST *candles* disagree with its REST *trades* for these thin products. Example: trade 3453266 (09:23:20.892, 0.00037 PAXG) has no 09:23 candle, and trade 3453269 (09:28:24) is counted in the 09:26 candle. Our stored trades equal the venue's trades exactly, and our candles are built from them. **Your decision 2** below. The full 24 h comparison runs with the soak (2.6); the nightly job ([`consistency.ts`](../../apps/jobs/src/consistency.ts)) compares the previous UTC day automatically and keeps the evidence. |
| 2.3 | Book sequence validation is active; an injected sequence gap triggers a resync within 5 s; depth metrics stored every second | **Met** (timed resync not yet observed live) | `book.test.ts`: an update-id gap or a crossed book discards the book and reports `resync`; the pipeline records a `depth` gap and requests a snapshot 0.5 s later (REST round trip here 0.7–1 s). Metrics: 1 row per instrument per second (3,537 rows in 6.5 min for 9 instruments). Also fixed while verifying: depth bands beyond what the book knows are now reported as unknown ([defect 8](#found-by-live-verification-and-fixed)). |
| 2.4 | Chaos tests with 30 s and 10 min network cuts: reconnect ≤ 10 s after the network returns, gap recorded, backfill ≤ 60 s, no duplicate or missing 1m candles | **Not yet run** | Needs a Toxiproxy harness on the staging host (D2). In place: reconnect gaps are recorded and repaired (`pipeline.int.test.ts`, `backfill.int.test.ts`; live restarts repaired within 30–90 s, including the 30 s settle wait); the reconnect backoff is now capped at 8 s so a reconnect follows the network within 10 s; candle writes cannot duplicate (primary key, `DO NOTHING`), and the consistency check finds missing minutes. |
| 2.5 | A silent stream is detected within the NFR-04 bound; an injected 3 s latency raises "delayed" | **Met** (not chaos-tested) | Per-stream silence thresholds of 30 s (5 min for depth, which Coinbase sends only on change) and a 30 s socket watchdog; `gaps.test.ts`. A 3 s latency was in fact injected: the replay venue first replayed a recording with a 3 s clock error, and every feed reported **"delayed" (p50 3,039 ms)**. |
| 2.6 | 24 h staging soak: no unrepaired gaps, except venue outages recorded as unrepairable with evidence | **Not yet run** | Needs D2. Locally, over about 3 h of runs: 57 gaps recorded (two of them the week of PAXG history requested for 2.8), all 57 repaired, none unrepairable. |
| 2.7 | An instrument added through the admin API streams without a restart and backfills its history; disabling it stops its feed; a delisting stops the feed and raises a health alert | **Met** | Live, XRPUSDT: the API checked the pair on Binance and stored its tick (0.0001) and step (0.1); all four streams connected in **2.4 s** without disturbing the other pairs; the day of history (1,440 minutes and 415 aggregates) was repaired within 62 s; disabling stopped the ticker at once; both changes audited. Delisting: `market-jobs.int.test.ts` (venue answers simulated, since the replay venue has no pair-status API): status stored, feed event, `feed.status` "delisted" on the market channel, ingestor reload, System Health degraded. |
| 2.8 | PAXG candles inside closures are flagged, checked against the generated closure table for a full week; the cross-venue spread uses the USDT-USD conversion and is visible in the UI | **Met** | One week, both venues: **10,074 and 10,075 minutes, 3,180 flagged, 3,180 inside closures, 0 mismatches** (4 daily breaks of 60 min and the weekend from Friday 22:00 to Sunday 23:00 UTC). Spread in the Command Center: Binance PAXG/USDT × USDT-USD 0.998655 = $4,079.14 against Coinbase PAXG/USD $4,079.05, −0.22 bps. |
| 2.9 | Large trades (merged per taker order) and walls are detected and stored correctly on replay fixtures with known answers | **Met** | [`exchange-flow-known.jsonl`](../../packages/exchange-adapters/fixtures/exchange-flow-known.jsonl) with hand-worked answers: a Binance sweep of 3 aggTrades → one order (4.5 BTC, $332,839.25 at USDT-USD 0.9995); Coinbase matches merged by taker order id; a PAXG bid wall that is swept (filled) and an ask wall withdrawn (pulled). Checked in `market-data` (pure) and through the ingestor into PostgreSQL and `md:events`. Live calibration: see [walls](#calibration-walls). |
| 2.10 | NFR-01 latency is measured and met | **Measured; not met for tickers** | Ingestor receive → browser client receive, same clock, 60–90 s samples: **book p50 39–50 ms, p95 101–108 ms; ticker p50 12–19 ms, p95 204–239 ms.** NFR-01 asks p95 ≤ 100 ms to our socket. The approved ticker rate cap (4 Hz, architecture §10) holds an update for up to 250 ms on a busy pair, so both cannot be met. **Your decision 1** below. |
| 2.11 | End-to-end tests in CI use only the replay venue; the nightly live smoke test passes | **Partly verified** | CI's e2e job now starts the stack with the replay overlay ([`compose.replay.yaml`](../../infra/docker/compose.replay.yaml)); live instruments are disabled there, so nothing contacts the venues. Locally, on a fresh stack started that way from images built on this branch: **Playwright 4 of 4 passed**; the stack streamed the 5 replay instruments (17 feeds connected) and recorded no gaps while looping. The nightly workflow ([`nightly-live.yml`](../../.github/workflows/nightly-live.yml)) runs `live-smoke.mjs`, which passes here; its first scheduled run needs the repository's CI (D7). |

## Found by live verification and fixed

| # | Defect | Effect | Fix |
|---|---|---|---|
| 1 | A backfill job could run before its gap's last minute had ended | Minute 06:53 missing on all Coinbase products; the gap still marked repaired | Jobs wait until the last minute has settled (30 s); the worker re-delays an early job instead of failing it |
| 2 | Venue leases (15 s TTL) were renewed only every 60 s, and a standby built pipelines for every venue | Two ingestors could stream the same venue; a standby wrote flat Coinbase candles that could win over the real ones | Renewal every 5 s; pipelines only for venues whose lease this instance holds |
| 3 | Socket.IO `volatile` emits drop a message whenever a write is in flight | 20–70% of live messages lost (5m candle updates at 0.22/s instead of 1/s) | Slow clients are skipped explicitly (a room maintained by the backpressure check); no volatile emits |
| 4 | This host's clock runs 2.5 s ahead of both venues | Every feed "delayed"; Coinbase minutes closed before they ended, dropping their last trades | The ingestor measures the offset every 5 minutes (health warning above 500 ms, as architecture §5.4 specifies), corrects lag, and decides minute boundaries on venue time |
| 5 | Changing the instrument set reconnected the venue socket | About 10 s of trades and book lost for every other pair on that venue | Live `SUBSCRIBE`/`UNSUBSCRIBE` (Binance) and `subscribe`/`unsubscribe` (Coinbase) on the open connection |
| 6 | The last ticker and book were rewritten to Redis every second, also during an outage | REST and subscribe snapshots served stale prices as live | Written only while the connection and depth stream are live; a stopped instrument's keys are deleted |
| 7 | A 1,000-level Binance snapshot covers only ±0.3–0.4% of the BTCUSDT book | BTCUSDT depth within ±0.5% and ±1% understated | 5,000-level snapshots; the book tracks the range it knows completely; bands beyond it are `null`, never an undercount; a background refresh keeps ±1% known as the price moves |
| 8 | The 4 Hz / 10 Hz live output used fixed timers | Up to 250 ms added to every update, even on quiet pairs | Leading-edge throttles with the same caps; envelopes carry the receive time, so latency is measurable |
| 9 | The replay venue numbered ids across all symbols | Per-product sequence trackers would have seen gaps | Counters per symbol (caught by the replay tests) |
| 10 | The server image neither built nor copied the three new packages (domain, exchange-adapters, market-data) | In Docker, migrate and every service failed to start (`ERR_MODULE_NOT_FOUND`) | Added to the Dockerfile's build and copy steps (found by the end-to-end run) |

## Tests and coverage

486 automated tests, all passing. `pnpm verify` (formatting, lint, typecheck, dependency rules, the no-trading check, unit tests with coverage, build, artefact scan) passes; `pnpm test:integration:coverage` passes; Playwright passes 4 of 4 on a fresh replay stack. The Docker stack built from this branch also passes the live smoke test against the real venues.

| Package | Tests | Kind | Coverage gate | Measured (lines / branches) |
|---|---|---|---|---|
| contracts | 46 | unit | 90% | 100% / 100% |
| domain | 17 | unit | 90% | 98.9% / 95.5% |
| market-data | 40 | unit, including the known-answer fixtures | 90% | 98.1% / 90.4% |
| exchange-adapters | 25 | unit: parsers on recorded traffic, sockets, REST, the replay venue on the demo recordings | 70% | 93.8% / 74.5% |
| observability | 15 | unit + Valkey integration | 70% | 94.7% / 83.0% |
| db | 20 | unit + TimescaleDB integration | 70% | 98.3% / 80.0% |
| api | 200 | unit + integration (TimescaleDB, Valkey, a Socket.IO client), including all 36 routes × 4 callers in the RBAC matrix | 70% | 90.5% / 73.1% |
| ingestor | 18 | unit + integration, including the whole ingestor running on the replay venue | 70% | 91.0% / 76.7% |
| jobs | 16 | unit + integration (BullMQ on Valkey) | 70% | 95.7% / 80.3% |
| analyzer | 6 | unit (still the Phase 1 skeleton) | 70% | 86.7% / 100% |
| app, ui | 75 + 4 | unit (jsdom), with a fake socket for the live client | none yet | app 83.7% / 72.5% |
| End to end | 4 | Playwright on the Compose stack with the replay venue | — | — |

## Decisions made during Phase 2

| Decision | Why | Recorded in |
|---|---|---|
| No Socket.IO Redis adapter or emitter: live messages over Redis pub/sub (`live:*`), durable ones from `md:events`, each API instance serving its own sockets | The adapter packages are unmaintained (R25) and would forward almost nothing useful in this design | [ADR 014](../adr/014-live-fan-out-without-socketio-adapter.md) (supersedes part of ADR 007) |
| The replay venue replays recordings at the event level, with whole-minute time shifts, per-symbol id counters and the recorder's clock error removed | Keeps the production code path; CI needs no network | [ADR 015](../adr/015-replay-venue.md) |
| The consistency check reports differences (feed events, a report in Redis) and does not overwrite published candles | Rewriting history needs a policy; the architecture asks for differences to be reported | Architecture §5.2 |
| Detection floors (large trades $50k–$250k, walls $100k–$1M by asset) are starting values in code | The architecture fixes the method; the floors need live calibration | `packages/market-data/src/detection.ts` |
| Pair status, closure calendar and the consistency check run as scheduled tasks on the `maintenance` queue | One small job at a time; separate queues add nothing | Architecture §6 note |
| `GET /system/feeds` and `SystemHealth.feeds` list every enabled instrument's streams, reporting "not streaming" when the ingestor says nothing | A dead ingestor must not look like an empty list | API contracts §4 note |

## Calibration: walls

In 30 minutes of live data, Coinbase pairs produced about 6 walls per minute each (SOL-USD 91, ETH-USD 77, BTC-USD 77); Binance pairs 3–6 in total. Coinbase walls sit just above the floors (SOL-USD median $273k against a $250k floor, BTC-USD $1.18M against $1M), and 90% end as "pulled" after a median 33–55 s: market makers re-quoting size a tick away. The detection is doing what the architecture specifies; the floors are too low for Coinbase books. Proposal for Phase 11 (whale views): floors per venue from the 95th percentile of level notionals, and a re-quote within a few ticks treated as the same wall.

## Carried forward

| Item | Plan |
|---|---|
| Chaos tests with Toxiproxy (2.4) and the 24 h soak (2.6) | On the staging host, once D2 is decided |
| OpenAPI generation from the zod schemas and the breaking-change check (API contracts §1) | Still open from Phase 1; the market schemas are now in `packages/contracts` and ready for it |
| A consistency difference becomes a repair | Needs a policy (published candles do not change today); differences are recorded as evidence |
| Wall floors per venue, re-quote de-duplication | Phase 11, with the whale views |
| Desktop sign-in on Windows/macOS and CI bundles (from Phase 1) | Unchanged: need a desktop run and the repository's CI (D7) |

## What I need from you

1. **NFR-01 against the ticker rate (2.10).** Keep the 4 Hz ticker cap and measure NFR-01 on the book (10 Hz, p95 101–108 ms, just over the target), or raise the ticker cap to 10 Hz so tickers meet p95 ≈ 100 ms at up to 2.5× the messages for busy pairs. A tighter target than 100 ms needs a faster cap for both.
2. **Coinbase candles for thin products (2.2).** Accept the venue's trades as the reference where its candles contradict them (PAXG-USD, USDT-USD), and amend 2.2 accordingly. The alternative, copying Coinbase's candle bucketing, would make our candles disagree with the trades they are built from.
3. **D2: hosting provider and region**, for the soak (2.6) and the chaos tests (2.4).
4. **D7 / the pull request.** GitHub still shows no pull request and no workflow run for the repository, so CI has not run yet (Phase 1 items 1.2, 1.6 and 1.8, and 2.11's nightly run). Phase 2 is on the local branch `phase-2/market-data`, not committed.
5. Your approval of this report, and whether to commit and push Phase 2.
