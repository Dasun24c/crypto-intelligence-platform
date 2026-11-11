import { type Candle, type Closure, TF_MS, TIMEFRAMES, type Timeframe } from '@cip/domain';
import { type IndicatorParams, IndicatorSeries, type IndicatorValues } from '@cip/indicators';
import { type EngineCandle, type SmcEvent, SmcEngine, type SmcParams } from '@cip/smc-engine';
import type { RunState } from './checkpoint.js';

/** What the processor reads: stored candles and the state of data gaps (AnalysisRepository). */
export interface CandleSource {
  candlesFrom(instrumentId: string, tf: Timeframe, from: number, limit: number): Promise<Candle[]>;
  openGapOverlaps(instrumentId: string, tf: Timeframe, from: number, to: number): Promise<boolean>;
  awaitsRepair(instrumentId: string, from: number, to: number): Promise<boolean>;
  unrepairableCovers(instrumentId: string, tf: Timeframe, from: number, to: number): Promise<boolean>;
}

export interface ProcessorConfig {
  instrumentId: string;
  tick: string;
  indicators: IndicatorParams;
  smc: SmcParams;
  /** The closure calendar known now (the same object until it changes). */
  context: () => { closures: readonly Closure[] };
  /** Engine step time, for the 2 ms budget (criterion 4.6). */
  onStep?: (ms: number) => void;
}

/** Why `advance` stopped. */
export type Stop =
  /** The next candle is not stored yet: everything available is done. */
  | { kind: 'caught_up' }
  /** A missing or partial candle can still be repaired: wait (ADR 005, "paused: data gap"). */
  | { kind: 'paused'; detail: string }
  /** Processed the boundaries asked for. */
  | { kind: 'limit' }
  /** Reached `until`. */
  | { kind: 'done' };

export interface Output {
  values: { tf: Timeframe; values: IndicatorValues }[];
  events: SmcEvent[];
  boundaries: number;
}

type Peek =
  | { kind: 'candle'; candle: Candle }
  | { kind: 'missing' }
  | { kind: 'not_yet' }
  | { kind: 'pause'; detail: string };

const PAGE = 1_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');

/**
 * One run's analysis, a boundary at a time (architecture §7): at each instant where candles close,
 * every timeframe closing there gives its candle (or a gap marker) to its indicator series and,
 * all together, to the SMC engine, which evaluates the longest timeframe first. A timeframe takes
 * part from its origin, the first candle of its series, fixed on the run.
 *
 * Strictly in order (ADR 005): a candle that is missing, or partial while its minutes can still be
 * repaired, stops the run at that boundary; a gap declared unrepairable becomes a gap marker.
 */
export class RunProcessor {
  private engine: SmcEngine;
  private readonly series = new Map<Timeframe, IndicatorSeries>();
  private readonly next = new Map<Timeframe, number>();
  private readonly buffers = new Map<Timeframe, Candle[]>();
  private readonly skipUntil = new Map<Timeframe, number>();
  private out: Output = { values: [], events: [], boundaries: 0 };
  /** The last boundary processed, or null before the first. */
  boundary: number | null = null;

  constructor(
    private readonly src: CandleSource,
    private readonly cfg: ProcessorConfig,
  ) {
    this.engine = new SmcEngine({ params: cfg.smc, tick: cfg.tick });
  }

  static restore(src: CandleSource, cfg: ProcessorConfig, state: RunState): RunProcessor {
    const p = new RunProcessor(src, cfg);
    p.engine = SmcEngine.restore(state.engine, { params: cfg.smc, tick: cfg.tick });
    for (const [tf, s] of Object.entries(state.series) as [Timeframe, RunState['series'][Timeframe]][])
      p.series.set(tf, IndicatorSeries.restore(s!, cfg.indicators));
    for (const [tf, n] of Object.entries(state.next) as [Timeframe, number][]) p.next.set(tf, n);
    p.boundary = state.boundary;
    return p;
  }

  snapshot(): RunState {
    if (this.boundary === null) throw new Error('nothing processed yet');
    return {
      v: 1,
      boundary: this.boundary,
      engine: this.engine.snapshot(),
      series: Object.fromEntries([...this.series].map(([tf, s]) => [tf, s.snapshot()])),
      next: Object.fromEntries(this.next),
    };
  }

  /** Timeframes taking part. */
  get timeframes(): Timeframe[] {
    return TIMEFRAMES.filter((tf) => this.next.has(tf));
  }

  /** The earliest open time a timeframe may still join at: its first candle must close later. */
  joinFloor(tf: Timeframe): number {
    return this.boundary === null ? -Infinity : Math.floor(this.boundary / TF_MS[tf]) * TF_MS[tf];
  }

  /** Adds a timeframe whose series starts at `origin` (the first candle's open time). */
  join(tf: Timeframe, origin: number): void {
    if (this.next.has(tf)) throw new Error(`${tf} takes part already`);
    if (origin % TF_MS[tf] !== 0) throw new RangeError(`${tf} origin ${origin} is not aligned`);
    if (origin < this.joinFloor(tf)) throw new RangeError(`${tf} cannot join before ${this.boundary}`);
    this.next.set(tf, origin);
    this.series.set(tf, new IndicatorSeries(tf, this.cfg.indicators));
  }

  nextBoundary(): number | null {
    let b: number | null = null;
    for (const [tf, n] of this.next) if (b === null || n + TF_MS[tf] < b) b = n + TF_MS[tf];
    return b;
  }

  /** Takes what the processed boundaries produced since the last call. */
  drain(): Output {
    const out = this.out;
    this.out = { values: [], events: [], boundaries: 0 };
    return out;
  }

  /**
   * Processes boundaries in order until it must stop. `max` caps how many (for checkpoints);
   * `until` is the last boundary to process (replays). In `strict` mode (replays) anything that
   * would wait is an error: a replay reads stored history only.
   */
  async advance(opts: { max?: number; until?: number; strict?: boolean } = {}): Promise<Stop> {
    let done = 0;
    for (;;) {
      const b = this.nextBoundary();
      if (b === null) return { kind: 'caught_up' };
      if (opts.until !== undefined && b > opts.until) return { kind: 'done' };
      if (opts.max !== undefined && done >= opts.max) return { kind: 'limit' };
      const due = this.timeframes.filter((tf) => this.next.get(tf)! + TF_MS[tf] === b);
      const taken: { tf: Timeframe; peek: Peek }[] = [];
      for (const tf of due) {
        const peek = await this.peek(tf, b - TF_MS[tf]);
        if (peek.kind === 'not_yet') {
          if (opts.strict) throw new Error(`${tf} candle closing at ${iso(b)} is not stored`);
          return { kind: 'caught_up' };
        }
        if (peek.kind === 'pause') {
          if (opts.strict) throw new Error(`${peek.detail}: not final, cannot replay it yet`);
          return { kind: 'paused', detail: peek.detail };
        }
        taken.push({ tf, peek });
      }
      this.process(b, taken);
      done++;
    }
  }

  private process(b: number, taken: { tf: Timeframe; peek: Peek }[]): void {
    const candles: EngineCandle[] = [];
    const missing: Timeframe[] = [];
    for (const { tf, peek } of taken) {
      if (peek.kind !== 'candle') {
        missing.push(tf);
        continue;
      }
      const c = peek.candle;
      const buf = this.buffers.get(tf);
      if (buf?.[0]?.openTime === c.openTime) buf.shift();
      const series = this.series.get(tf)!;
      const last = series.lastOpenTime;
      // Candles skipped as missing for good: the series carries on across them.
      if (last !== null && c.openTime !== last + TF_MS[tf]) series.resumeAfterGap(c.openTime);
      this.out.values.push({ tf, values: series.next(c) });
      candles.push({
        tf,
        openTime: c.openTime,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        quality: c.quality,
        underlyingClosed: c.underlyingClosed,
        microProfile: c.microProfile,
      });
    }
    const t0 = performance.now();
    const events = this.engine.step({ time: b, candles, missing }, this.cfg.context());
    this.cfg.onStep?.(performance.now() - t0);
    this.out.events.push(...events);
    for (const { tf } of taken) this.next.set(tf, this.next.get(tf)! + TF_MS[tf]);
    this.boundary = b;
    this.out.boundaries++;
  }

  private async refill(tf: Timeframe, from: number): Promise<Candle[]> {
    const page = await this.src.candlesFrom(this.cfg.instrumentId, tf, from, PAGE);
    this.buffers.set(tf, page);
    return page;
  }

  /** What the candle opening at `open` on `tf` is, without taking it. */
  private async peek(tf: Timeframe, open: number): Promise<Peek> {
    const until = this.skipUntil.get(tf);
    if (until !== undefined) {
      if (open < until) return { kind: 'missing' };
      this.skipUntil.delete(tf);
    }
    let buf = this.buffers.get(tf) ?? [];
    if (!buf.length || buf[0]!.openTime < open) buf = await this.refill(tf, open);
    if (!buf.length) return { kind: 'not_yet' };
    // A missing or partial candle may have been repaired since it was read: decide on fresh data.
    if (buf[0]!.openTime !== open || buf[0]!.quality === 'partial') buf = await this.refill(tf, open);
    const head = buf[0];
    if (!head) return { kind: 'not_yet' };
    const id = this.cfg.instrumentId;
    const size = TF_MS[tf];
    if (head.openTime === open) {
      if (head.quality !== 'partial') return { kind: 'candle', candle: head };
      // A partial aggregate is final only once its missing minutes can no longer be repaired.
      if (await this.src.openGapOverlaps(id, tf, open, open + size))
        return { kind: 'pause', detail: `${tf}: ${iso(open)} is missing minutes (backfill running)` };
      if (await this.src.awaitsRepair(id, open, open + size))
        return { kind: 'pause', detail: `${tf}: ${iso(open)} is missing minutes (waiting for repair)` };
      return { kind: 'candle', candle: head };
    }
    // Candles [open, head) are missing.
    if (await this.src.openGapOverlaps(id, tf, open, head.openTime))
      return { kind: 'pause', detail: `${tf}: missing ${iso(open)} (backfill running)` };
    if (await this.src.unrepairableCovers(id, tf, open, head.openTime)) {
      this.skipUntil.set(tf, head.openTime);
      return { kind: 'missing' };
    }
    return { kind: 'pause', detail: `${tf}: missing ${iso(open)}` };
  }
}
