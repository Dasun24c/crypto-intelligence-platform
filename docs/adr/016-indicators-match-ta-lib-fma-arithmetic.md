# ADR 016: Indicators match TA-Lib 0.8's arithmetic, fused multiply-add included

| | |
|---|---|
| Status | Accepted |
| Date | 2026-11-10 |
| Deciders | Phase 3 implementation, within the architecture approved in Phase 0 |
| Related | [ADR 012](012-ta-lib-reference-data.md) · [Implementation plan, criterion 3.1](../phase-0/08-implementation-plan.md#phase-3--technical-analysis) · `packages/indicators/README.md` · `tools/reference-data/README.md` |

## Context

ADR 012 chose TA-Lib 0.8.3 as the reference for RSI, MACD, EMA and ATR, and left one question open: TA-Lib's exact seeding and arithmetic conventions. Criterion 3.1 allows a relative error of 1e-9.

The first implementation followed the formulas TA-Lib has documented for years:

- EMA: `(x − prev) × k + prev`;
- RSI and ATR: divide by n.

That version differed from TA-Lib 0.8.3 by one or two units in the last place on most values. On EMA, RSI and ATR this is harmless: about 2e-16 relative. On MACD it failed the criterion. The MACD line is the difference of two nearly equal EMAs, so a last-place difference in the EMAs becomes a relative error of up to 2.2e-8 where the line crosses zero.

The TA-Lib 0.8.3 C source explains the difference. TA-Lib 0.8 adopted an "FMA numerical contract" (its PR #96):

- **EMA, MACD and ATR**: each step is an explicit C `fma()` call: `fma(β, prev, k × x)`. A fused multiply-add rounds once where a multiply followed by an add rounds twice.
- **Weights**: β = (n − 1)/(n + 1) for EMA and (n − 1)/n for ATR, then k = 1 − β, so the two sum to exactly 1.
- **RSI**: scales by the rounded reciprocal 1/n, and returns 50 rather than 0 when there was no movement at all.
- **Build flags**: TA-Lib builds with `-ffp-contract=off`, so `fma()` is the only fusion and results are the same bits on every platform.

We confirmed this on this machine in two ways:

- The official PyPI wheel and a from-source build give identical output.
- A Python model of `fma(β, prev, k × x)`, computed in exact rational arithmetic, reproduced 9,981 of 9,981 EMA values bit for bit. The documented formula matched only 8,067 of them.

## Decision

Implement the TA-Lib 0.8 arithmetic exactly in `packages/indicators`: the same weights, operation order, reciprocal scaling and RSI neutral value.

JavaScript has no `Math.fma`, so `packages/indicators/src/fma.ts` provides a correctly rounded fused multiply-add with two paths:

- **A fast path** for the magnitudes prices and indicators have (2^−400 to 2^400). It uses Dekker's exact product and Knuth's exact sum, then rounds the remainder to odd (Boldo and Melquiond, 2008). It does not allocate.
- **An exact path in BigInt arithmetic** for everything else, including subnormal results, overflow and non-finite operands.

The tests compare the two paths on 1.3 million operands, constructed near-ties included, and check known results and IEEE 754 special cases.

The golden test asserts the criterion, 1e-9 relative error. It also asserts bit-identity with TA-Lib 0.8.3, so any drift in either implementation shows up at once.

## Consequences

**Positive**

- All 720,000 reference values (9 datasets × 8 series × 10,000 candles, minus warm-ups) match TA-Lib exactly, for the batch, streaming and combined forms alike.
- MACD near zero is no longer a special case, and no tolerance has to be argued for.
- Deterministic replays (Phase 4) can rely on the indicators being reproducible to the bit on any platform Node runs on.

**Negative and costs**

- The package depends on a software `fma` whose correctness rests on a published proof and on our tests, not on hardware.
- Each EMA and ATR step costs a few dozen floating-point operations instead of two. This is negligible at our volumes: per candle close, 54 series × a handful of steps.
- A future TA-Lib release that changes its arithmetic again would fail the bit-identity assertion. That is intended: whoever regenerates the reference data sees the change and decides.

## Alternatives considered

| Option | Why not chosen |
|---|---|
| Keep the documented formulas and relax the comparison for MACD (error relative to the EMAs' magnitude rather than the MACD value) | It would meet the letter of "relative error" only by redefining it. The values would still not be TA-Lib's. |
| Pin an older TA-Lib (0.6.x) without fma | ADR 012 pinned 0.8.3. The older arithmetic is not the current reference, and it rounds twice. |
| Exact BigInt fma only | Simpler, but about 100 times slower. Keeping it as the fallback path and as the test oracle gives both speed and an independent check. |
