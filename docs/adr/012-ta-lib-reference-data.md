# ADR 012: Indicator reference data generated with TA-Lib in a dev-only Python tool

| | |
|---|---|
| Status | Accepted |
| Date | 2026-11-10 |
| Deciders | Project owner (Phase 0 approval) |
| Related | [Architecture §4 Monorepo](../phase-0/03-architecture.md#4-monorepo) · [Architecture §19 Testing strategy](../phase-0/03-architecture.md#19-testing-strategy) · [Feasibility §7.2](../phase-0/02-feasibility.md#72-pinned-versions) · [Feasibility §7.3](../phase-0/02-feasibility.md#73-licences-and-checks-for-phase-1) · [Implementation plan, Phase 3](../phase-0/08-implementation-plan.md#phase-3--technical-analysis) · [ADR 001](001-pnpm-turborepo-monorepo.md) |

## Context

The `indicators` package (streaming and batch versions) is a pure TypeScript package that the SMC engine and the Technical Analysis page rely on. Its results must be correct, and "correct" needs an independent reference. Indicator definitions differ in details such as how an EMA is seeded, so a reference computed by hand or by our own code proves little.

TA-Lib is the established open-source reference. Version 0.8.3 is BSD-licensed and has Python wheels for Windows, macOS and Linux (feasibility §7.2). It is not needed at runtime.

## Decision

Generate indicator reference datasets with **TA-Lib 0.8.3 in a Python tool under `tools/reference-data/`**. The tool is **dev-only**: it is not part of any app, image or runtime dependency. The generated datasets are committed as fixtures, and the `indicators` package is tested against them as golden tests (Vitest).

The Phase 3 acceptance criterion is that RSI, MACD, EMA and ATR match TA-Lib output within 1e-9 relative error after the documented warm-up, on 3 instruments, 3 timeframes and 10,000 candles each. Indicators that TA-Lib does not cover in the form we need, such as VWAP with its 00:00 UTC anchor reset, use hand-verified fixtures instead.

## Consequences

**Positive**

- An independent, widely used implementation checks ours. Streaming and batch versions can be compared with the same data.
- No Python in production images. TA-Lib's licence is BSD, and the tool is outside the shipped product.
- Datasets are regenerable and reviewable, and fixtures are plain files.

**Negative and costs**

- Contributors who change reference data need Python and the TA-Lib wheel. Everyone else only reads the committed fixtures.
- The EMA seeding convention in TA-Lib is still to be confirmed (feasibility §7.3, §11). We must match it in Phase 3 and document the warm-up, or our results will differ from the reference.
- Two languages in one repository, with a second toolchain to keep working.

**What we must do because of it**

- Pin the TA-Lib version in the tool and record it in each dataset.
- Document the warm-up and seeding rules next to each indicator.
- Keep the golden tests in CI, and keep `tools/reference-data` out of the production image (the dependency rules and Dockerfiles must reflect this).
- Add a property test that streaming and batch implementations agree (Phase 3, criterion 3.4).

## Alternatives considered

| Option | Why not chosen |
|---|---|
| **Hand-computed spreadsheets** | Slow and error-prone (architecture §20), and hard to extend to thousands of candles per case. |
| Hand-verified fixtures only | Kept as the fallback in the risk register, and used where TA-Lib has no equivalent (VWAP). It does not scale to the 3 × 3 × 10,000-candle comparisons. |
