# @cip/smc-engine

The SMC rulebook ([docs/phase-0/07-smc-rulebook.md](../../docs/phase-0/07-smc-rulebook.md), v0.1, `RULESET_VERSION` 0.3.0) as a deterministic, event-sourced reducer ([ADR 004](../../docs/adr/004-smc-engine-event-sourced-reducer.md), [ADR 017](../../docs/adr/017-smc-runtime-boundaries-ids-digests-replays.md)). Phase 4 implemented §2 (swings, structure, displacement, ranges), §3 (liquidity levels, sweeps, false breakouts, breakouts, thin-book wicks, gold-market closures) and §9 (gap markers); Phase 5 added §4 (order blocks, fair value gaps, supply and demand zones, their touches, fills, invalidation and location); Phase 6 adds §5–§8 (`setups.ts`: the four patterns as state machines with the sweep-anchored MSS, entry zones and hypothetical levels, the confluence checklist and score, quality flags, and outcomes resolved with 1m candles).

The package is pure: no clock, no randomness, no I/O. It depends only on `@cip/domain` and `@cip/indicators` (for ATR); digests and gzip are left to the analyzer.

## Using it

```ts
const engine = new SmcEngine({ params: CRYPTO_MAJORS_SMC_PARAMS, tick: '0.01' });
const events = engine.step({ time, candles, missing }, { closures });
const state = engine.snapshot(); // plain JSON; SmcEngine.restore(state, config) continues exactly
```

- **One step per boundary**: `candles` are the closed candles of every timeframe closing at `time` (1m micro profiles included); `missing` names timeframes whose candle is missing for good. Every timeframe that has started must appear at each of its boundaries.
- **Order**: the 1m profiles are taken in first, then each timeframe is evaluated from the longest down, each in the rulebook's rule order (swings, structure with displacement, ranges, levels, sweeps, points of interest), then expiries.
- **Events** (`SmcEvent`): `swing_confirmed`, `structure`, `range_detected`, `range_ended`, `level_created`, `level_status`, `sweep`, `zone_created`, `zone_status`, `gap_marker`. Each has a per-run `seq`, the deciding timeframe and close time, and a natural key the same in every run (`digestLine` makes the run digest from them).
- **Prices** are decimal strings in and out; inside, whole numbers of 10⁻⁸, so "a tick beyond" is exact.

## Parameters

`SmcParams` is the `smc` part of an instrument profile (rulebook §10). `CRYPTO_MAJORS_SMC_PARAMS` and `GOLD_SMC_PARAMS` are the launch values, stored by migration 0009 as version 4 of the two profiles (with `setups`, the §5–§8 settings). Ranges are detected on the setup timeframes of `timeframePairs`; sweeps are evaluated on setup and context timeframes; swings and structure run on `structureTimeframes` (5m to 1d).

## Where the rulebook is silent

These are the engine's choices; the rulebook's [implementation notes](../../docs/phase-0/07-smc-rulebook.md#14-implementation-notes-ruleset-010) list them with their reasons.

| Topic | The engine's rule |
|---|---|
| Sweeps on several timeframes | A level's status (swept, broken) is decided on its *home* timeframe: the longest sweep timeframe not longer than its origin. Shorter sweep timeframes record their own sweeps of it and stop evaluating it, without using it up for the others. |
| Partial candles | A candle with minutes missing for good is a gap: no swing window, displacement leg or range spans it, and pending breaches on its timeframe are dropped. Its prices still feed ATR and period levels (flagged `data_gap`). |
| Origin timeframes | Day, week, month and weekend levels: 1d. Session levels: 1h, built from 1h candles (sessions are whole UTC hours). |
| Range high and low | Stay active while the range is active and count their sweeps; when it ends, the side it broke out of is `broken`, the other `expired`. |
| Lifetimes | Sweep extremes: 300 candles of their timeframe. Weekend levels: until the next weekend's, at most 7 days. Candle counts are applied as that many candle durations. |
| MSS | Recorded once, as `mss` (a CHOCH with displacement), not also as `choch`. |
| Displacement | The strongest qualifying run in the breaking leg (largest body in ATR). `createdFvg` counts FVGs completed by the break candle. |
| Equal highs/lows | A new swing joins the nearest active level in tolerance; otherwise it pairs with the most recent earlier swing that qualifies. |
| Thin book | Volume beyond the level is summed per sweep-timeframe candle over its 1m profiles; a missing minute or profile makes it `liquidity_unverified`. |
| Zones: where and when | On the structure timeframes, evaluated from the candle after the one that creates them; missing or partial candles are not evaluated. |
| Zone edges and fills | Bullish zones are approached from above (top = proximal edge). A touch at the edge counts (0 %). The fill is the deepest penetration, floored to 0.01 % and exact; 100 only at the far edge. A filled zone is tracked until a close beyond its far edge invalidates it, or it expires. |
| Order blocks | The leg-start candle and the 4 before it; a cluster of at most 3 same-colour candles; the break within 10 candles of the leg start; one zone per set of candles (the internal break when both break together). |
| Supply and demand | The base ends right before the departure, or one candle earlier; at most its last 4 small candles; the departure is a displacement ending at the current candle that travels 2 ATR beyond the base. |
| Linking | An order block and a supply/demand zone link when their overlap exceeds half of the smaller height. |
| Setups | One per pattern, direction and timeframe pair, from `forming` (preconditions hold) to `resolved`; one that never confirms ends `expired`. Confirmation is decided once, at the MSS candle or the one after (for an FVG it completes); a failure stays `triggered` with its reasons. Outcomes start the candle after confirmation; 1m candles order events inside one setup candle. Every transition names its evidence. Rulebook notes I25–I37. |

## Tests

- `golden.test.ts`: the 286 fixtures in `fixtures/<concept>/` (rulebook §12): labelled detections, §13 invariants, and prefix and checkpoint stability at every cut point (criteria 4.1, 4.2, 5.1–5.3, 6.1–6.6). The pattern concepts need 5 positive cases in each direction and 5 near misses each. `pnpm fixtures` regenerates the synthetic ones from `scripts/fixtures/` (hand-designed patterns whose answers are worked out from the rulebook; bearish twins are exact mirror images).
- `property.test.ts`: fast-check, 1,000 random markets with gaps and partial candles: no repainting, exact checkpoint continuation, invariants. The markets must reach every setup state (about 11,600 setups form and 10,600 resolve with the fixed seed), so the setup invariants are exercised (criterion 6.2).
- `realdata.test.ts`: 34 days of Binance BTCUSDT (Phase 3's reference data): every rule fires, every zone kind and status occurs, every pattern forms and triggers and three or more confirm, invariants hold, step p95 well under 2 ms (criterion 4.6).
- `zones.test.ts`: the zone rules at their boundaries (minimum gap, search windows, base and departure, exact fills).
- `units.test.ts`: prices, canonical JSON, parameters, inputs, the thin-book volume.

The test files run one after another (`fileParallelism: false`): each is CPU-bound for 20–30 s, and run side by side they left other packages' Vitest workers no room to start within Vitest's fixed 60 s during `pnpm verify`.
