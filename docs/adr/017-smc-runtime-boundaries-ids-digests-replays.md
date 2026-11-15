# ADR 017: The SMC runtime steps boundaries, derives ids from natural keys, and runs replays in the analyzer

| | |
|---|---|
| Status | Accepted |
| Date | 2026-11-11 |
| Deciders | Phase 4 implementation, within the architecture approved in Phase 0 |
| Related | [ADR 004](004-smc-engine-event-sourced-reducer.md) · [ADR 005](005-analysis-pauses-at-data-gaps.md) · [Architecture §6, §7](../phase-0/03-architecture.md#7-analysis-pipeline) · [Rulebook §1, §9, §13](../phase-0/07-smc-rulebook.md) · [Implementation plan, criteria 4.3–4.5](../phase-0/08-implementation-plan.md#phase-4--smc-structure-and-liquidity) · `packages/smc-engine/README.md` |

## Context

ADR 004 fixed the shape of the SMC engine: a pure reducer, checkpoints every 60 boundaries, a digest a replay must reproduce. Building it left five questions open.

1. **What one step takes.** The rulebook evaluates the longest timeframe first when several close at once, and the thin-book rule (§3.5) reads the 1m micro profiles of the candle being evaluated. A step per candle would hand a 4h candle to the engine before the 1m candle that closes at the same instant.
2. **How Phase 3's indicators fit.** Phase 3 stepped each timeframe on its own and paused it alone. The engine needs every timeframe in one order, and a checkpoint is only useful if the indicator state is in it too: Phase 3 recomputed a run from its start on every restart.
3. **Ids.** The data model wants UUIDs. A replay must produce the same events as the live run, but its rows sit in the same tables, so it cannot reuse the live run's ids.
4. **Lost publications.** Detections are committed, then published on `an:events`. A process that dies between the two never publishes them, and its successor recomputes them as "already stored".
5. **Who runs replays.** The architecture puts every BullMQ queue in `jobs`, but the engine runtime (candle loading, gap handling, writes) lives in the analyzer, and apps cannot import each other.

## Decision

**1. One step per boundary.** `SmcEngine.step({time, candles, missing}, context)` takes everything that closes at one instant. The engine first takes the 1m profiles in, then evaluates each timeframe from the longest down, each in the rulebook's rule order. A missing candle is named in `missing`: a gap marker (§9).

**2. One loop for indicators and SMC.** The analyzer's `RunProcessor` walks a run boundary by boundary from each timeframe's origin. At each boundary every due timeframe's candle goes to its indicator series and, together, to the engine. The whole instrument waits at the first candle that can still be repaired (ADR 005: strictly in order); a gap declared unrepairable is stepped over with a gap marker. The checkpoint holds the engine state, every indicator series and the next candle per timeframe (gzip JSON), and is written in the same transaction as the detections up to it.

**3. Natural keys, derived ids.** Every engine event carries a natural key that is the same in every run: `sw:15m:int:h:<candle>`, `lv:1d:pdh:b:<knownAt>`, `sp:5m:<level key>:<breach>`, and so on. The keys match the data model's unique constraints. The analyzer derives each row's UUID from (run, key): UUIDv7-shaped, with the key's time as the timestamp and sha256 for the rest. A restart therefore writes the same rows, and a replay writes its own.

**4. The digest uses the engine's events.** `detection_events.payload` stores the event as the engine emitted it (`{key, data}`). The digest is sha256 over one canonical line per event in `seq` order (`seq|type|tf|time|key|sorted-key JSON of data`) for the events decided in a period. Flags that depend on the run or the clock (`warmup`, `late_detection`) live only in the projections and messages, never in the digest.

**5. Fencing and an outbox.** Each lease acquisition takes an epoch from a counter that never expires (`lease:analyzer:{id}:epoch`). Every write transaction first locks the run's checkpoint row and refuses to continue if a newer epoch holds it; a checkpoint is replaced only by an epoch at least as new. Each step writes under the epoch it started with, so a write is never unfenced, even if the lease changes hands during the step. Leases are renewed on their own timer, never behind analysis work: a warm-up can take a minute, and a lease that lapses under it would let a standby start the same instrument. Publishing follows the commit and advances a cursor (`an:published:{runId}`). A new holder first publishes stored events after the cursor, so nothing a dead holder committed goes unpublished.

**6. Replays run in the analyzer.** `POST /replays` adds a job to the `replay` queue; the analyzer takes it (`ReplayWorker`, one at a time) and runs the same processor over stored history. A replay of a period that a live run covers (the newest live run under the same ruleset whose series had started by the period's start) starts each timeframe where that run did (its stored origins) with that run's profile, so its state when the period starts is the live run's and the digests must match. This holds whether the live run computed the period live or while warming up on stored history before its start. The replay run records that live run (`detection_runs.source_run_id`), and `GET /replays/{runId}` compares against exactly it. The analyzer also has a CLI (`node apps/analyzer/dist/cli.js replay <instrument> <from> <to>`) that runs a replay in-process and compares digests.

## Consequences

**Positive**

- One deterministic path for live runs, restarts, takeovers and replays; the integration tests check all four against each other by digest.
- Restarts resume from the last checkpoint instead of recomputing a run from its start (Phase 3's cost).
- A standby takes over without double writes or missed publications.

**Negative and costs**

- A gap on one timeframe now holds the instrument's whole analysis, where Phase 3 held only that timeframe. This is what ADR 005 asks for, but a long 1m outage also delays 1d indicators.
- A replay of a live period recomputes from the live run's origins, up to 1,000 days back on 1d; it costs seconds to minutes, not milliseconds.
- `RULESET_VERSION` now covers both indicators and SMC (`indicators-1+smc-0.1.0`): a change to either supersedes every run.
- The analyzer, not `jobs`, consumes the `replay` queue; architecture §6's table of queues says so.

## Alternatives considered

| Option | Why not chosen |
|---|---|
| A step per candle with the 1m profiles in `context` | The runtime would have to know in advance which candles the thin-book rule needs; one step per boundary keeps the engine self-contained. |
| Separate indicator and SMC loops | Two cursors to keep consistent and two restart paths; the indicators would still recompute from the run start. |
| Random UUIDs | Restarts would write duplicates, and replays could not be compared without mapping ids. |
| Ids derived from the natural key alone | The same detection in a replay would collide with the live run's row. |
| A replay worker in `jobs` | Needs the analyzer's runtime in a shared package; a larger change for no gain, since replays are CPU-bound engine work. |
