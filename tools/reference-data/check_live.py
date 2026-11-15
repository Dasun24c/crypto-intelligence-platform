"""Check a running stack's stored indicator values against TA-Lib (dev-only, ADR 012).

The golden test (criterion 3.1) proves the indicators package matches TA-Lib on fixed datasets.
This script checks the running system end to end. For each instrument and timeframe it does three
things:

1. It reads the current live run's points through the API (`GET /indicators/{id}`).
2. It reads the candles the run was computed from (`GET /market/{id}/candles`).
3. It recomputes RSI, MACD, EMA and ATR with TA-Lib from the run's first candle, then compares
   every value.

Usage (from the repository root, with the virtual environment from README.md):
    python tools/reference-data/check_live.py [http://localhost:3000] [--tf 1m 5m 15m 1h 4h 1d]

It signs in as the development viewer (DEV_SEED_PASSWORD, as for seed-dev), reads only, and exits
non-zero if any value differs by more than 1e-9 relative.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import urllib.request

import numpy as np
import talib

TOLERANCE = 1e-9
SERIES = ["rsi", "macd", "macdSignal", "macdHist", "emaFast", "emaMid", "emaSlow", "atr"]


def call(base: str, path: str, token: str | None = None, body: dict | None = None):
    request = urllib.request.Request(
        base + path,
        data=json.dumps(body).encode() if body is not None else None,
        method="POST" if body is not None else "GET",
        headers={"content-type": "application/json", "x-client": "desktop"}
        | ({"authorization": f"Bearer {token}"} if token else {}),
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def talib_series(candles: list[dict], params: dict) -> dict[str, np.ndarray]:
    high = np.array([float(c["h"]) for c in candles], dtype=np.float64)
    low = np.array([float(c["l"]) for c in candles], dtype=np.float64)
    close = np.array([float(c["c"]) for c in candles], dtype=np.float64)
    macd, signal, hist = talib.MACD(
        close, fastperiod=params["macd"]["fast"], slowperiod=params["macd"]["slow"], signalperiod=params["macd"]["signal"]
    )
    return {
        "rsi": talib.RSI(close, timeperiod=params["rsi"]["period"]),
        "macd": macd,
        "macdSignal": signal,
        "macdHist": hist,
        "emaFast": talib.EMA(close, timeperiod=params["ema"]["fast"]),
        "emaMid": talib.EMA(close, timeperiod=params["ema"]["mid"]),
        "emaSlow": talib.EMA(close, timeperiod=params["ema"]["slow"]),
        "atr": talib.ATR(high, low, close, timeperiod=params["atr"]["period"]),
    }


def check(base: str, token: str, instrument: dict, tf: str) -> tuple[int, int, float]:
    # from=0: the run's first 5,000 points, so TA-Lib starts at the same candle the run did.
    series = call(base, f"/indicators/{instrument['id']}?tf={tf}&from=0&limit=5000", token)
    points = series["points"]
    if not series["run"] or not points:
        return 0, 0, 0.0
    first = points[0]["t"]
    candles = call(base, f"/market/{instrument['id']}/candles?tf={tf}&from={first}&limit=5000", token)
    by_time = {c["t"]: c for c in candles}
    # The run's series starts at its first point; TA-Lib must start at the same candle.
    run_candles = [by_time[p["t"]] for p in points if p["t"] in by_time]
    if len(run_candles) != len(points):
        raise SystemExit(f"{instrument['venueSymbol']} {tf}: {len(points) - len(run_candles)} candles missing")
    reference = talib_series(run_candles, series["params"])
    compared = exact = 0
    worst = 0.0
    for key in SERIES:
        for i, p in enumerate(points):
            want = float(reference[key][i])
            got = p[key]
            if math.isnan(want):
                if got is not None:
                    raise SystemExit(f"{instrument['venueSymbol']} {tf} {key}[{i}]: {got}, TA-Lib has none")
                continue
            if got is None:
                raise SystemExit(f"{instrument['venueSymbol']} {tf} {key}[{i}]: none, TA-Lib {want}")
            compared += 1
            exact += got == want
            error = abs(got) if want == 0 else abs(got - want) / abs(want)
            worst = max(worst, error)
    return compared, exact, worst


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("base", nargs="?", default="http://localhost:3000")
    parser.add_argument("--tf", nargs="+", default=["1m", "5m", "15m", "1h", "4h", "1d"])
    args = parser.parse_args()
    base = args.base.rstrip("/") + "/api/v1"
    password = os.environ.get("DEV_SEED_PASSWORD", "local-dev-password")
    token = call(base, "/auth/login", body={"email": "viewer@cip.test", "password": password})["accessToken"]
    failed = False
    total = total_exact = 0
    for instrument in call(base, "/instruments", token):
        for tf in args.tf:
            compared, exact, worst = check(base, token, instrument, tf)
            total += compared
            total_exact += exact
            ok = worst <= TOLERANCE
            failed |= not ok
            print(
                f"{instrument['venueSymbol']:9} {tf:3}  {compared:6} values  {exact:6} identical  "
                f"worst relative error {worst:.3g}  {'ok' if ok else 'FAIL'}"
            )
    print(f"total: {total} values compared, {total_exact} bit-identical")
    sys.exit(1 if failed or total == 0 else 0)


if __name__ == "__main__":
    main()
