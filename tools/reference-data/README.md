# TA-Lib reference data

A dev-only Python tool ([ADR 012](../../docs/adr/012-ta-lib-reference-data.md)). It produces the datasets that the `indicators` package is checked against. Nothing here ships in an image or runs in production.

`generate.py` does three things for 3 instruments (BTCUSDT, ETHUSDT and PAXGUSDT) × 3 timeframes (5m, 1h and 4h):

1. It fetches the 10,000 closed candles before a fixed end time (2026-11-01 00:00 UTC by default) from Binance's public market-data endpoint, `data-api.binance.vision`. No API key is used.
2. It runs TA-Lib's RSI(14), MACD(12, 26, 9), EMA(20, 50, 200) and ATR(14) over them.
3. It writes one gzipped JSON file per dataset to `packages/indicators/fixtures/talib/`.

Each file holds:

- the candles exactly as Binance sent them (decimal strings);
- TA-Lib's output;
- the versions and parameters used.

The golden test `packages/indicators/src/golden.test.ts` checks the package against these files (implementation plan, criterion 3.1). Everyone else only reads the committed files; only someone changing the reference data needs Python.

## Set up and run

You need Python 3.11 or later. TA-Lib 0.8.3 publishes wheels for 3.11 to 3.15. On 3.10, pip compiles TA-Lib from source instead. That build gives the same output, but the official wheel is the reference.

```bash
python -m venv tools/reference-data/.venv
```

```bash
tools/reference-data/.venv/Scripts/python -m pip install -r tools/reference-data/requirements.txt
```

```bash
tools/reference-data/.venv/Scripts/python tools/reference-data/generate.py
```

On macOS and Linux the interpreter is `.venv/bin/python`.

`check_live.py` checks a running stack end to end:

- it reads each instrument's live run and its candles through the API (as the development viewer);
- it recomputes RSI, MACD, EMA and ATR with TA-Lib from the run's first candle;
- it compares every stored value and exits non-zero if any differs by more than 1e-9.

```bash
tools/reference-data/.venv/Scripts/python tools/reference-data/check_live.py http://localhost:3000
``` `--end`, `--count` and `--out` change the defaults. The output is byte-for-byte reproducible for the same candles: the gzip timestamp is fixed, and TA-Lib's arithmetic is the same on every platform (see below).

## What matching TA-Lib 0.8 takes

TA-Lib 0.8 changed its arithmetic, so older descriptions of TA-Lib do not reproduce it:

- **Explicit `fma()` calls.** Its EMA, MACD and ATR recursions call C's `fma()`. A fused multiply-add rounds once where a multiply followed by an add rounds twice. TA-Lib builds with `-ffp-contract=off`, so its results are the same bits on every platform. This is its "FMA numerical contract".
- **EMA weights.** The weights are β = (n − 1) / (n + 1) and k = 1 − β, and each step is `fma(β, previous, k × x)`.
- **ATR weights.** The weights are β = (n − 1) / n and α = 1 − β, and each step is `fma(β, previous, α × TR)`.
- **RSI.** RSI scales by the rounded reciprocal 1/n rather than dividing. It reports 50 (neutral) when there was neither gain nor loss.

JavaScript has no `Math.fma`, so `packages/indicators/src/fma.ts` provides a correctly rounded one. With it, the package's output is bit-identical to TA-Lib's on all nine datasets, well within the 1e-9 the criterion allows.

The datasets were generated with the official TA-Lib 0.8.3 wheel (C library built on 28 Oct 2026), Python 3.14.5 and numpy 2.5.4, as each file's `meta` records. A from-source build of the same version on Python 3.10 gave identical output.
