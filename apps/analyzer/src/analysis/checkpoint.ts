import { gunzipSync, gzipSync } from 'node:zlib';
import type { Timeframe } from '@cip/domain';
import type { IndicatorSeriesState } from '@cip/indicators';
import type { EngineSnapshot } from '@cip/smc-engine';

/**
 * What a checkpoint holds (architecture §7): everything a run needs to continue after
 * `boundary` exactly as if it had never stopped. Stored as gzip(JSON) in
 * `analysis.engine_checkpoints.state`.
 */
export interface RunState {
  v: 1;
  /** The last boundary processed. */
  boundary: number;
  engine: EngineSnapshot;
  /** Indicator series per timeframe. */
  series: Partial<Record<Timeframe, IndicatorSeriesState>>;
  /** Open time of the next candle per timeframe taking part. */
  next: Partial<Record<Timeframe, number>>;
}

export function encodeState(state: RunState): Buffer {
  return gzipSync(JSON.stringify(state));
}

export function decodeState(data: Buffer): RunState {
  const state = JSON.parse(gunzipSync(data).toString('utf8')) as RunState;
  if (state.v !== 1) throw new RangeError(`unknown checkpoint format ${String(state.v)}`);
  return state;
}
