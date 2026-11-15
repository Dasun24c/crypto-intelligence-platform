# ADR 015: The replay venue plays recordings through the production adapters

| | |
|---|---|
| Status | Accepted |
| Date | 2026-11-10 |
| Deciders | Phase 2 implementation, within the architecture approved in Phase 0 |
| Related | [Architecture principle 1, §4 (`tools/recorder`), §19 testing](../phase-0/03-architecture.md) · [Implementation plan, criteria 2.7 and 2.11](../phase-0/08-implementation-plan.md#phase-2--market-data) · [ADR 014](014-live-fan-out-without-socketio-adapter.md) |

## Context

Architecture principle 1 says no production code path produces simulated values, and that a *replay venue* exists for tests and demos, always labelled as a replay. Criterion 2.11 requires end-to-end tests in CI to use only the replay venue (CI must not depend on Binance or Coinbase being reachable), and criterion 2.7 simulates a delisting on it. The architecture did not say how a recording becomes a live-looking stream. A naive loop breaks the pipelines in four ways:

1. **Times**: recorded times are in the past, so candles land on old minutes, and minute boundaries drift when a loop's length is not a whole number of minutes.
2. **Sequence ids**: aggTrade ids, trade ids, depth update ids and Coinbase trade ids repeat on every loop. The pipelines would see duplicates, then gaps, then resync the book.
3. **The book**: at the end of a loop the book is in its final state while the next loop starts from the first one. Deltas applied to the wrong state can cross the book.
4. **Clock error**: a recording carries the recording host's clock offset. Ours recorded about 3 s, which replays as "delayed" on every feed.

## Decision

`ReplayVenue` (in `@cip/exchange-adapters`) plays recordings made by `tools/recorder` through the **same parsers** as the live venues, and hands the normalised events to the **unchanged** ingestor pipelines. The ingestor runs it with `MARKET_SOURCE=replay` and `REPLAY_FILES=<recordings>`, and then streams only instruments whose venue is `replay` (seeded with `cip-db seed-replay`, never by a migration).

- **Window**: each symbol's window starts at its book snapshot (the recorder's Binance REST snapshot, or the Coinbase channel snapshot) and spans whole minutes. Times move forward by whole minutes, so every loop has exactly one final kline per minute, on the same boundaries the live venues use.
- **Ids**: every id family is renumbered from a per-symbol counter, so ids are contiguous across loops (as at the venue, ids are per product).
- **Book**: at each loop boundary the book returns to the window's starting state. For Binance this is one depth update; for Coinbase it is a new channel snapshot. These are messages the venues themselves send. The Binance "REST snapshot" comes from the replay's own book at the current position, so the snapshot-plus-diff procedure runs as it does live.
- **Joining**: a replay that starts mid-window applies the earlier book changes silently, without emitting a catch-up burst.
- **Clock**: the median of a recording's (receive − venue) times is taken as the recording host's clock error and removed. Replayed lag then reflects this host's processing, not the recorder's clock.
- **No history**: the replay venue has no REST history. The ingestor records no history gap for replay instruments, and the backfill worker marks any replay gap unrepairable instead of pretending to repair it.

## Consequences

**Positive**

- CI and demos run the production parsing, book synchronisation, candle building, detection and fan-out code paths with recorded real data and no network.
- The ingestor integration test now covers the whole `MarketIngestor` (leases, sync, pipelines, live output, feed status) on the replay venue.
- Every value shown in a replay was really traded or quoted at a venue; only times and ids are moved.

**Negative and costs**

- A replay repeats: the same prices recur every loop. The UI must label replay instruments (principle 1), and nobody may read a replay as market information.
- The demo recording must span at least one whole minute after its snapshot (`tools/recorder --seconds 75` or more). The short contract-test fixtures replay only with a test-only `periodMs` override.
- Indicators and SMC analysis on a replay see the same minutes again and again. That is fine for functional tests, not for evaluating detectors.

## Alternatives considered

| Option | Why not chosen |
|---|---|
| A synthetic market generator | Produces simulated values, which principle 1 rules out. |
| Replaying raw WebSocket frames through a fake socket | Exercises the socket layer too, but every frame would need its embedded times and ids rewritten in venue-specific formats. Event-level replay rewrites them once, in one place. |
| Pointing CI at the live venues | Makes CI depend on third-party availability and the BLS-block rules for some regions; criterion 2.11 forbids it. |
