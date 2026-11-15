# ADR 005: Analysis pauses at data gaps

| | |
|---|---|
| Status | Accepted |
| Date | 2026-11-10 |
| Deciders | Project owner (Phase 0 approval) |
| Related | [Architecture §5.4 Gap and delay detection](../phase-0/03-architecture.md#54-gap-and-delay-detection) · [Architecture §7](../phase-0/03-architecture.md#7-analysis-pipeline) · [SMC rulebook §9](../phase-0/07-smc-rulebook.md#9-data-quality-handling) · [Risks R04, R05](../phase-0/04-risks-and-dependencies.md#1-risk-register) · [ADR 004](004-smc-engine-event-sourced-reducer.md) |

## Context

Venue feeds drop messages and connections. Coinbase `matches` can lose messages, and any connection can be cut. The ingestor records a `data_gaps` row and schedules a backfill, which repairs candles after the fact (`quality = repaired`).

If the engine kept going past a missing candle, it would produce detections from incomplete data. If it later recomputed after the repair, detections that users and alerts had already seen would change. That would break principle 5 ("fail visibly") and the no-repaint guarantee of ADR 004.

## Decision

The analyzer processes candles **strictly in order**. When the next expected candle is missing, it **waits** and reports "paused: data gap" for that instrument. The UI shows "analysis paused: data gap".

- When the backfill repairs the gap, processing resumes from the repaired candles. **Nothing already published changes.**
- When a gap is declared unrepairable (no REST data after the retry window), the engine processes a **gap marker**. Swing windows do not span it, pending breaches and sweeps that span it are dropped, and live setups whose window includes it get the `data_gap` flag.
- A detection decided more than 120 s (a starting value) after its candle closed gets `late_detection`, and its alerts are labelled "late".

## Consequences

**Positive**

- Published detections are stable. No later repair rewrites history.
- The pause is visible to users, in line with principle 5.
- Gap behaviour is part of the same deterministic reducer, so a replay reproduces it.

**Negative and costs**

- A long outage delays all analysis for the affected instrument until the gap is repaired or declared unrepairable (R05). Fast backfill and the retry window limit this.
- Catch-up after a pause produces late detections, so alerts must carry the late label.
- The unrepairable path loses some detections by design (dropped pending breaches and sweeps).

**What we must do because of it**

- Run the chaos tests with 30 s and 10 min network cuts. They check that gaps are recorded and backfilled, and that no 1m candle is duplicated or missing afterwards (implementation plan, Phase 2).
- Test that the gap marker drops exactly the pending state the rulebook lists.
- Show the paused state on the System Health page and in the instrument views.

## Alternatives considered

| Option | Why not chosen |
|---|---|
| **Recompute after repair** | Changes detections that were already published and may have triggered alerts (architecture §20). |
| Continue past the gap without waiting | Produces detections from incomplete data. The gap marker exists only for gaps that cannot be repaired. |
