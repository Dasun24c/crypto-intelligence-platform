import {
  addDecimals,
  type Closure,
  maxDecimal,
  minDecimal,
  TF_MS,
  TIMEFRAMES,
  type Timeframe,
} from '@cip/domain';
import type { SmcEngine } from './engine.js';
import type { EngineCandle, SmcEvent, StepContext, StepInput } from './types.js';

export type CandlesByTf = Partial<Record<Timeframe, readonly EngineCandle[]>>;

/** Whether [openTime, openTime + tf) overlaps a closure (rulebook §3.6, as the ingestor flags it). */
export function overlapsClosure(openTime: number, tf: Timeframe, closures: readonly Closure[]): boolean {
  const end = openTime + TF_MS[tf];
  return closures.some((c) => c.startsAt < end && c.endsAt > openTime);
}

/**
 * Candles of several timeframes as the engine takes them: one step per boundary, in time order.
 * Within a timeframe, a hole between two candles becomes `missing` (an unrepairable gap). A
 * timeframe takes part from its first candle to its last.
 */
export function toSteps(candles: CandlesByTf): StepInput[] {
  const at = new Map<number, { candles: EngineCandle[]; missing: Timeframe[] }>();
  const slot = (time: number) => {
    let s = at.get(time);
    if (!s) {
      s = { candles: [], missing: [] };
      at.set(time, s);
    }
    return s;
  };
  for (const tf of TIMEFRAMES) {
    const list = candles[tf];
    if (!list?.length) continue;
    const size = TF_MS[tf];
    let expected: number | null = null;
    for (const c of list) {
      if (c.tf !== tf) throw new RangeError(`a ${c.tf} candle is listed under ${tf}`);
      if (c.openTime % size !== 0) throw new RangeError(`${tf} candle at ${c.openTime} is not aligned`);
      if (expected !== null && c.openTime < expected) throw new RangeError(`${tf} candles are out of order`);
      for (let t = expected ?? c.openTime; t < c.openTime; t += size) slot(t + size).missing.push(tf);
      slot(c.openTime + size).candles.push(c);
      expected = c.openTime + size;
    }
  }
  return [...at.entries()].sort(([a], [b]) => a - b).map(([time, s]) => ({ time, ...s }));
}

export interface RunResult {
  events: SmcEvent[];
  /** The boundary each step processed, with the events it returned. */
  steps: { time: number; events: SmcEvent[] }[];
}

/** Steps an engine through candles; `onStep` sees each boundary's events (and may snapshot). */
export function runEngine(
  engine: SmcEngine,
  steps: readonly StepInput[],
  context: StepContext = { closures: [] },
  onStep?: (time: number, events: SmcEvent[], index: number) => void,
): RunResult {
  const events: SmcEvent[] = [];
  const out: RunResult['steps'] = [];
  steps.forEach((step, i) => {
    const e = engine.step(step, context);
    events.push(...e);
    out.push({ time: step.time, events: e });
    onStep?.(step.time, e, i);
  });
  return { events, steps: out };
}

/**
 * Builds `tf` candles from shorter ones, as the platform aggregates them (architecture §5.2): a
 * period with some children missing is `partial`; one with none is absent.
 */
export function aggregate(children: readonly EngineCandle[], tf: Timeframe): EngineCandle[] {
  const size = TF_MS[tf];
  const groups = new Map<number, EngineCandle[]>();
  for (const c of children) {
    if (TF_MS[c.tf] >= size) throw new RangeError(`cannot build ${tf} from ${c.tf}`);
    const start = Math.floor(c.openTime / size) * size;
    let g = groups.get(start);
    if (!g) {
      g = [];
      groups.set(start, g);
    }
    g.push(c);
  }
  const out: EngineCandle[] = [];
  for (const [openTime, g] of [...groups.entries()].sort(([a], [b]) => a - b)) {
    g.sort((a, b) => a.openTime - b.openTime);
    const childSize = TF_MS[g[0]!.tf];
    let high = g[0]!.high;
    let low = g[0]!.low;
    for (const c of g) {
      high = maxDecimal(high, c.high);
      low = minDecimal(low, c.low);
    }
    out.push({
      tf,
      openTime,
      open: g[0]!.open,
      high,
      low,
      close: g.at(-1)!.close,
      volume: addDecimals(g.map((c) => c.volume)),
      quality:
        g.length === size / childSize && g.every((c) => c.quality !== 'partial') ? 'complete' : 'partial',
      underlyingClosed: g.some((c) => c.underlyingClosed),
    });
  }
  return out;
}
