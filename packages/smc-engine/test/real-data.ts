import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { TF_MS, type Timeframe } from '@cip/domain';
import { aggregate, type CandlesByTf } from '../src/harness.js';
import type { EngineCandle } from '../src/types.js';

/**
 * Binance candles from Phase 3's TA-Lib reference data (10,000 each, `packages/indicators/fixtures`),
 * aggregated to every longer timeframe up to 1d, as the platform builds them.
 */
export function realCandles(file = 'BTCUSDT-5m.json.gz', count = 10_000): CandlesByTf {
  const url = new URL(`../../indicators/fixtures/talib/${file}`, import.meta.url);
  const data = JSON.parse(gunzipSync(readFileSync(url)).toString('utf8')) as {
    meta: { interval: Timeframe };
    candles: [number, string, string, string, string, string][];
  };
  const tf = data.meta.interval;
  const base: EngineCandle[] = data.candles
    .slice(0, count)
    .map(([openTime, open, high, low, close, volume]) => ({
      tf,
      openTime,
      open,
      high,
      low,
      close,
      volume,
      quality: 'complete',
      underlyingClosed: false,
    }));
  const end = base.at(-1)!.openTime + TF_MS[tf];
  const out: CandlesByTf = { [tf]: base };
  for (const longer of ['15m', '1h', '4h', '1d'] as Timeframe[])
    if (TF_MS[longer] > TF_MS[tf])
      out[longer] = aggregate(base, longer).filter((c) => c.openTime + TF_MS[longer] <= end);
  return out;
}
