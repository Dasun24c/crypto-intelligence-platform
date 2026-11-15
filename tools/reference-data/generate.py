"""Generate TA-Lib reference datasets for the indicators package (ADR 012).

Dev-only: nothing here ships in an image or runs in production. The datasets it writes are
committed under packages/indicators/fixtures/talib/ and checked by the golden test
(packages/indicators/src/golden.test.ts, implementation plan criterion 3.1).

For each instrument and timeframe it fetches the 10,000 closed candles before a fixed end time
from Binance's public market-data endpoint (no API key), runs TA-Lib over the closes, highs and
lows, and writes one gzipped JSON file with the candles exactly as Binance sent them (decimal
strings), TA-Lib's output and the versions used.

Usage (from the repository root, with the virtual environment from README.md):
    python tools/reference-data/generate.py
    python tools/reference-data/generate.py --end 2026-11-01T00:00:00Z --count 10000
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import math
import platform
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
import talib

KLINES_URL = "https://data-api.binance.vision/api/v3/klines"
USER_AGENT = "cip-reference-data/1.0"
INSTRUMENTS = ["BTCUSDT", "ETHUSDT", "PAXGUSDT"]
TIMEFRAMES = {"5m": 5 * 60_000, "1h": 60 * 60_000, "4h": 4 * 60 * 60_000}
PAGE = 1000

# The platform's default profile parameters (packages/indicators DEFAULT_INDICATOR_PARAMS).
PARAMS = {"rsi": 14, "macd": [12, 26, 9], "ema": [20, 50, 200], "atr": 14}

REPO = Path(__file__).resolve().parents[2]
DEFAULT_OUT = REPO / "packages" / "indicators" / "fixtures" / "talib"


def fetch_page(symbol: str, interval: str, end_ms: int) -> list[list]:
    query = urllib.parse.urlencode(
        {"symbol": symbol, "interval": interval, "endTime": end_ms, "limit": PAGE}
    )
    request = urllib.request.Request(f"{KLINES_URL}?{query}", headers={"User-Agent": USER_AGENT})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except OSError as err:  # network errors and HTTP 5xx/429: back off and retry
            if attempt == 4:
                raise
            wait = 2**attempt
            print(f"  {symbol} {interval}: {err}; retrying in {wait} s", file=sys.stderr)
            time.sleep(wait)
    raise AssertionError("unreachable")


def fetch_candles(symbol: str, interval: str, end_ms: int, count: int) -> list[list]:
    """The `count` candles that closed at or before `end_ms` (exclusive), oldest first."""
    step = TIMEFRAMES[interval]
    by_time: dict[int, list] = {}
    cursor = end_ms - 1
    while len(by_time) < count:
        page = fetch_page(symbol, interval, cursor)
        if not page:
            break
        for row in page:
            open_time = int(row[0])
            if open_time + step <= end_ms:
                by_time[open_time] = row
        oldest = min(int(row[0]) for row in page)
        if oldest - 1 >= cursor:
            break
        cursor = oldest - 1
        time.sleep(0.2)  # well under the public endpoint's request weight limit
    rows = [by_time[t] for t in sorted(by_time)][-count:]
    if len(rows) < count:
        raise SystemExit(f"{symbol} {interval}: only {len(rows)} candles before the end time")
    return rows


def gaps_in(rows: list[list], step: int) -> list[dict]:
    out = []
    for prev, row in zip(rows, rows[1:]):
        if int(row[0]) - int(prev[0]) != step:
            out.append({"after": int(prev[0]), "next": int(row[0])})
    return out


def as_list(values: np.ndarray) -> list[float | None]:
    return [None if math.isnan(v) else float(v) for v in values]


def build(symbol: str, interval: str, end_ms: int, count: int) -> dict:
    rows = fetch_candles(symbol, interval, end_ms, count)
    # float() of a decimal string is the nearest double, the same value JavaScript's Number() gives.
    high = np.array([float(r[2]) for r in rows], dtype=np.float64)
    low = np.array([float(r[3]) for r in rows], dtype=np.float64)
    close = np.array([float(r[4]) for r in rows], dtype=np.float64)
    fast, slow, signal = PARAMS["macd"]
    macd, macd_signal, macd_hist = talib.MACD(close, fastperiod=fast, slowperiod=slow, signalperiod=signal)
    ema_fast, ema_mid, ema_slow = (talib.EMA(close, timeperiod=n) for n in PARAMS["ema"])
    return {
        "meta": {
            "venue": "binance",
            "symbol": symbol,
            "interval": interval,
            "source": KLINES_URL,
            "end": dt.datetime.fromtimestamp(end_ms / 1000, dt.timezone.utc).isoformat().replace("+00:00", "Z"),
            "count": len(rows),
            "gaps": gaps_in(rows, TIMEFRAMES[interval]),
            "params": PARAMS,
            "talib": {"python": talib.__version__, "c": talib.__ta_version__.decode()},
            "numpy": np.__version__,
            "python": platform.python_version(),
            "generated": dt.date.today().isoformat(),
        },
        # [open time, open, high, low, close, volume], strings as Binance sent them.
        "candles": [[int(r[0]), r[1], r[2], r[3], r[4], r[5]] for r in rows],
        "talib": {
            "rsi": as_list(talib.RSI(close, timeperiod=PARAMS["rsi"])),
            "macd": as_list(macd),
            "macdSignal": as_list(macd_signal),
            "macdHist": as_list(macd_hist),
            "emaFast": as_list(ema_fast),
            "emaMid": as_list(ema_mid),
            "emaSlow": as_list(ema_slow),
            "atr": as_list(talib.ATR(high, low, close, timeperiod=PARAMS["atr"])),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--end", default="2026-11-01T00:00:00Z", help="exclusive end time, UTC")
    parser.add_argument("--count", type=int, default=10_000, help="candles per dataset")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output directory")
    args = parser.parse_args()
    end_ms = int(dt.datetime.fromisoformat(args.end.replace("Z", "+00:00")).timestamp() * 1000)
    args.out.mkdir(parents=True, exist_ok=True)
    for symbol in INSTRUMENTS:
        for interval in TIMEFRAMES:
            data = build(symbol, interval, end_ms, args.count)
            path = args.out / f"{symbol}-{interval}.json.gz"
            body = json.dumps(data, separators=(",", ":")).encode()
            # mtime=0 keeps the file byte-for-byte reproducible for the same data.
            with open(path, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as gz:
                gz.write(body)
            gaps = len(data["meta"]["gaps"])
            print(f"{path.name}: {data['meta']['count']} candles, {gaps} gaps, {path.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
