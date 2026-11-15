# @cip/indicators

Technical indicators for the analyzer and replays. Each comes in two forms:

- **Streaming**: one closed candle at a time, which is how the analyzer runs them.
- **Batch**: a whole series at once.

The package is pure: no I/O and no framework. Apart from `@cip/domain` (for timeframes and decimals) it depends on nothing.

| Indicator | Defaults | Checked against |
|---|---|---|
| RSI | 14 | TA-Lib 0.8.3, bit for bit |
| MACD | 12, 26, 9 | TA-Lib 0.8.3, bit for bit |
| EMA | 20, 50, 200 | TA-Lib 0.8.3, bit for bit |
| ATR | 14 (Wilder) | TA-Lib 0.8.3, bit for bit |
| VWAP | anchored at 00:00 UTC | hand-verified fixtures |
| Volume anomaly | robust z over 50 candles, flagged at z ≥ 3.5 | labelled fixtures |
| Trend | EMA order and mid-EMA slope ≥ 0.1 ATR over 5 candles | labelled fixtures |

`IndicatorSeries` (streaming) and `computeIndicators` (batch) produce every indicator for one instrument and timeframe. The parameters are `IndicatorParams`, part of an instrument profile; `DEFAULT_INDICATOR_PARAMS` holds the values above.

## Warm-up and seeding

Every indicator returns null until it has enough candles. The warm-up is the number of candles before the first value.

| Indicator | Warm-up (defaults) | Seed | After the seed |
|---|---|---|---|
| EMA(n) | n − 1 (19, 49, 199) | Average of the first n closes, added left to right from 0, divided by n | `fma(β, EMA, k × close)`, with β = (n − 1)/(n + 1) and k = 1 − β |
| RSI(n) | n (14) | Gains and losses of the first n changes, added left to right, × 1/n | Each average × (n − 1), + today's gain or loss, × 1/n |
| MACD(f, s, g) | s + g − 2 (33) | Both EMAs are seeded at index s − 1. The fast EMA uses the f closes ending there, not the first f. The signal is seeded with the average of the first g MACD values. | EMA steps as above. The histogram is MACD − signal. |
| ATR(n) | n (14) | Average of TR₁ to TRₙ. The first candle has no previous close, so it has no TR. | `fma(β, ATR, α × TR)`, with β = (n − 1)/n and α = 1 − β |
| VWAP | none | Σ((H + L + C) × V) and ΣV start from 0 at 00:00 UTC | Exact decimal sums; one division, rounded to 30 places, then the nearest double |
| Volume z | 50 | — | (V − median) / (1.4826 × MAD) over the previous 50 candles; when the MAD is 0, / (1.253314 × mean absolute deviation) |
| Trend | 199 | — | Needs the slow EMA, the mid EMA 5 candles earlier and the ATR |

### Details to know

- **RSI on a flat market.** RSI is 50 when there was neither gain nor loss. This follows TA-Lib 0.8, where older TA-Lib returned 0.
- **VWAP's first day.** VWAP is null for a whole day whose 00:00 UTC candle is not in the series, because that day's VWAP cannot be known. It is also null on 1d candles, where one candle per day makes it just the typical price.
- **Volume anomalies.** Only spikes are anomalies. Unusually low volume shows as a negative z but is not flagged. The z is null when every volume in the window is the same.
- **Trend.** The trend describes prices; it does not predict them. It is separate from the SMC structure trend (requirements C3).
  - **Bullish**: close > fast EMA > mid EMA > slow EMA, and the strength (the mid EMA's change over 5 candles, divided by ATR) is at least 0.1.
  - **Bearish**: the mirror image.
  - **Neutral**: anything else.
  - **Why 0.1**: without the 0.1 floor, noise that alternates every candle reads as a trend. On 90,000 Binance candles, the floor moves only the weakest tenth of the aligned candles to neutral.

## Matching TA-Lib

TA-Lib 0.8 computes its EMA, MACD and ATR recursions with C's `fma()`, so each multiply-add is rounded once (its "FMA numerical contract"). JavaScript has no `Math.fma`, so `fma.ts` provides a correctly rounded one:

- **Fast path**: an error-free product and sum, with the remainder rounded to odd (Boldo and Melquiond, 2008).
- **Exact path**: BigInt arithmetic for operands outside 2^±400 or non-finite ones.

The tests check the two paths against each other on 1.3 million operands, near-ties included.

The reference datasets are 3 instruments × 3 timeframes × 10,000 Binance candles, made with `tools/reference-data` (ADR 012). Every value matches TA-Lib 0.8.3 exactly (relative error 0), well within criterion 3.1's 1e-9.

Some differences from other descriptions of these indicators matter when comparing values:

- RSI scales by 1/n rather than dividing by n.
- The EMA weights are derived as β first, then k = 1 − β.
- MACD seeds its fast EMA late.

A different seed changes early values. With the same seed, results match only when the series starts at the same candle: the EMA seed's weight decays as β^m, about 3 × 10⁻⁴ for EMA(200) after 1,000 candles. So the analyzer computes every run from a fixed starting candle, and values are reproducible within a run.

## Tests

`pnpm --filter @cip/indicators test` runs:

| File | What it covers |
|---|---|
| `golden.test.ts` | Criterion 3.1: TA-Lib, bit for bit, for the batch, streaming and combined forms |
| `vwap.test.ts` | Criterion 3.2: hand-verified fixtures in `fixtures/vwap/`, including the 00:00 UTC reset |
| `labelled.test.ts` | Criterion 3.3: volume and trend fixtures, positive and negative |
| `property.test.ts` | Criterion 3.4: streaming equals batch to the bit on 400 random series, and no value changes when later candles arrive |
| `fma.test.ts` | Known fused results, IEEE special cases, subnormals, and fast path = exact path |
| `indicators.test.ts` | Worked examples, warm-ups and parameter validation |
