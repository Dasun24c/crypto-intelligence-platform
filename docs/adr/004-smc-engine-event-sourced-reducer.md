# ADR 004: SMC engine as an event-sourced pure reducer with checkpoints

| | |
|---|---|
| Status | Accepted (runtime details in [017](017-smc-runtime-boundaries-ids-digests-replays.md)) |
| Date | 2026-11-10 |
| Deciders | Project owner (Phase 0 approval) |
| Related | [Architecture §7 Analysis pipeline](../phase-0/03-architecture.md#7-analysis-pipeline) · [SMC rulebook §1](../phase-0/07-smc-rulebook.md#1-conventions) · [SMC rulebook §13](../phase-0/07-smc-rulebook.md#13-test-obligations) · [Risks R08, R11](../phase-0/04-risks-and-dependencies.md#1-risk-register) · [ADR 005](005-analysis-pauses-at-data-gaps.md) |

## Context

SMC is normally applied by eye. The rulebook turns it into exact rules so that detections can be tested, replayed and audited. Two risks follow directly: repainting or look-ahead bugs (R08, impact high) and computation cost growing with instruments and timeframes (R11).

The engine must also behave identically live and in replay (principle 4), and it must survive restarts without changing results.

## Decision

The SMC engine is a **pure reducer**: `step(state, candle, context) → (newState, events)`. It reads no clock, uses no randomness and does no I/O. It processes **closed candles only**, in order. Anything that depends on later candles stays provisional until confirmed, and only confirmed facts are stored as detections (rulebook §1).

The analyzer runs one actor per instrument:

- It writes detections, setup transitions and the checkpoint in **one transaction**.
- Engine state is serialised (JSON, gzip) as a checkpoint every 60 boundaries and on shutdown. After a restart it loads the checkpoint and replays the candles since then through the same reducer.
- A new live run (new instrument or new parameters) warms up on history first, with at least 500 candles of the highest timeframe in use. Warm-up events carry a `warmup` flag and never alert.
- Every detection carries `rulesetVersion`, `paramsHash` and `runId`. A replay uses a new `run_id` and produces a digest that can be compared with the live run.

## Consequences

**Positive**

- Repainting is structurally prevented: a detection cannot depend on a candle after the one being processed.
- A restart gives the same result as an uninterrupted run.
- Replays, labelled fixtures and audits use the same code path as live.
- The engine is incremental, so the cost per candle stays small.

**Negative and costs**

- Engine state must be serialisable and versioned, and checkpoint format changes need care.
- Changing a rule or a parameter means a new `rulesetVersion` or `paramsHash` and a new run. Old detections are not rewritten.
- Provisional items need explicit labelling in the UI.

**What we must do because of it**

- Write the tests listed in rulebook §13: prefix stability (fast-check), replay equals live (event digest), and invariants (no transition out of `resolved`, no event referring to a later candle, prices respect the tick).
- Hold a performance budget: p95 `step` time of 2 ms or less per candle for one instrument with all rules enabled, on the reference CI runner.
- Keep `smc-engine` free of NestJS, Redis and database imports (ADR 001).

## Alternatives considered

| Option | Why not chosen |
|---|---|
| **Recompute over a sliding window** | Causes repainting at the window edge (architecture §20): the same candle can give different detections depending on where the window starts. |
| Recompute the full history on every candle | The sources do not treat it as a serious option. It conflicts with the incremental design and the cost risk R11. |
