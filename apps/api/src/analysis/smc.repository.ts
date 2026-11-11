import { Inject, Injectable } from '@nestjs/common';
import type { Kysely, SelectQueryBuilder } from 'kysely';
import {
  type LevelType,
  type LiquidityLevel,
  type RunRef,
  type StructureEvent,
  type Sweep,
  type SwingPoint,
  type Tf,
  type TradingRange,
} from '@cip/contracts';
import type {
  Database,
  LiquidityLevelRow,
  StructureEventRow,
  SweepRow,
  SwingPointRow,
  TradingRangeRow,
} from '@cip/db';
import { TF_MS, TIMEFRAMES } from '@cip/domain';
import { DB } from '../tokens.js';

const t = (d: Date) => d.getTime();
const tn = (d: Date | null) => (d === null ? null : d.getTime());

export const toSwing = (r: SwingPointRow): SwingPoint => ({
  id: r.id,
  tf: r.timeframe,
  kind: r.kind,
  level: r.structure_level,
  price: r.price,
  candleTime: t(r.candle_time),
  confirmedAt: t(r.confirmed_at),
  flags: r.flags,
});

export const toStructure = (r: StructureEventRow): StructureEvent => ({
  id: r.id,
  tf: r.timeframe,
  level: r.structure_level,
  type: r.type,
  direction: r.direction,
  brokenSwingId: r.broken_swing_id,
  breakPrice: r.break_price,
  breakCandleTime: t(r.break_candle_time),
  isInitial: r.is_initial,
  displacement: (r.displacement as StructureEvent['displacement']) ?? null,
  flags: r.flags,
});

export const toRange = (r: TradingRangeRow): TradingRange => ({
  id: r.id,
  tf: r.timeframe,
  high: r.high,
  low: r.low,
  equilibrium: r.equilibrium,
  windowStart: t(r.window_start),
  detectedAt: t(r.detected_at),
  endedAt: tn(r.ended_at),
  endReason: r.end_reason,
  flags: r.flags,
});

export const toLevel = (r: LiquidityLevelRow): LiquidityLevel => ({
  id: r.id,
  tf: r.origin_timeframe,
  type: r.type as LevelType,
  side: r.side,
  price: r.price,
  touches: r.touches,
  sessionName: r.session_name,
  location: r.location,
  knownAt: t(r.known_at),
  status: r.status,
  statusChangedAt: tn(r.status_changed_at),
  sweepCount: r.sweep_count,
  flags: r.flags,
});

export const toSweep = (r: SweepRow & { level_type: string }): Sweep => ({
  id: r.id,
  tf: r.timeframe,
  levelId: r.level_id,
  levelType: r.level_type as LevelType,
  groupId: r.group_id,
  kind: r.kind,
  side: r.side,
  levelPrice: r.level_price,
  extremePrice: r.extreme_price,
  penetrationAtr: r.penetration_atr,
  breachAt: t(r.breach_candle_time),
  confirmedAt: t(r.confirmed_candle_time) + TF_MS[r.timeframe],
  notionalBeyondUsd: r.notional_beyond_usd,
  flags: r.flags,
});

/** Timeframes at least as long as `tf`: the origins of the levels a `tf` chart shows. */
export const atLeast = (tf: Tf): Tf[] => TIMEFRAMES.filter((x) => TF_MS[x] >= TF_MS[tf]);

export interface Window {
  from?: number;
  to?: number;
  limit: number;
}

/**
 * SMC detections for the REST API and the live channel's snapshot (data model §5.1). Runs are
 * chosen as for indicators: the instrument's open live run, else its latest; or `runId`.
 */
@Injectable()
export class SmcRepository {
  constructor(@Inject(DB) private readonly db: Kysely<Database>) {}

  /** The run to read: `runId` when given (it must be the instrument's), else the current live run. */
  async run(instrumentId: string, runId?: string): Promise<RunRef | null> {
    let q = this.db
      .selectFrom('analysis.detection_runs as r')
      .innerJoin('market.instrument_profiles as p', 'p.id', 'r.profile_id')
      .select(['r.id', 'r.status', 'r.from_time', 'p.name', 'p.version'])
      .where('r.instrument_id', '=', instrumentId);
    q = runId
      ? q.where('r.id', '=', runId)
      : q
          .where('r.mode', '=', 'live')
          .orderBy((eb) => eb.case().when('r.status', 'in', ['warming_up', 'running']).then(0).else(1).end())
          .orderBy('r.started_at', 'desc');
    const row = await q.limit(1).executeTakeFirst();
    return row
      ? {
          id: row.id,
          status: row.status,
          from: t(row.from_time),
          profile: { name: row.name, version: row.version },
        }
      : null;
  }

  /** Rows of a time window: with `from`, the first `limit` from there; else the latest `limit`. */
  private async windowed<O extends Record<string, unknown>>(
    query: SelectQueryBuilder<Database, never, O>,
    column: string,
    w: Window,
  ): Promise<O[]> {
    let q = query;
    const col = column as never;
    if (w.from !== undefined) q = q.where(col, '>=', new Date(w.from) as never);
    if (w.to !== undefined) q = q.where(col, '<', new Date(w.to) as never);
    return w.from !== undefined
      ? q.orderBy(col).limit(w.limit).execute()
      : (await q.orderBy(col, 'desc').limit(w.limit).execute()).reverse();
  }

  async swings(
    runId: string,
    tf: Tf,
    w: Window & { level?: 'internal' | 'external' },
  ): Promise<SwingPoint[]> {
    let q = this.db
      .selectFrom('analysis.swing_points')
      .selectAll()
      .where('run_id', '=', runId)
      .where('timeframe', '=', tf);
    if (w.level) q = q.where('structure_level', '=', w.level);
    return (await this.windowed(q as never, 'candle_time', w)).map((r) => toSwing(r as SwingPointRow));
  }

  async structure(runId: string, tf: Tf, w: Window): Promise<StructureEvent[]> {
    const q = this.db
      .selectFrom('analysis.structure_events')
      .selectAll()
      .where('run_id', '=', runId)
      .where('timeframe', '=', tf);
    return (await this.windowed(q as never, 'break_candle_time', w)).map((r) =>
      toStructure(r as StructureEventRow),
    );
  }

  async sweeps(runId: string, tf: Tf, w: Window): Promise<Sweep[]> {
    const q = this.db
      .selectFrom('analysis.sweeps as s')
      .innerJoin('analysis.liquidity_levels as l', 'l.id', 's.level_id')
      .selectAll('s')
      .select('l.type as level_type')
      .where('s.run_id', '=', runId)
      .where('s.timeframe', '=', tf);
    return (await this.windowed(q as never, 's.confirmed_candle_time', w)).map((r) =>
      toSweep(r as SweepRow & { level_type: string }),
    );
  }

  /** Ranges that overlap the window (detected before its end, not ended before its start). */
  async ranges(runId: string, tf: Tf, w: Window): Promise<TradingRange[]> {
    let q = this.db
      .selectFrom('analysis.trading_ranges')
      .selectAll()
      .where('run_id', '=', runId)
      .where('timeframe', '=', tf);
    if (w.to !== undefined) q = q.where('detected_at', '<=', new Date(w.to));
    if (w.from !== undefined) {
      const from = new Date(w.from);
      q = q.where((eb) => eb.or([eb('ended_at', 'is', null), eb('ended_at', '>=', from)]));
    }
    const rows = (await q.orderBy('detected_at', 'desc').limit(w.limit).execute()).reverse();
    return rows.map(toRange);
  }

  /**
   * Levels a `tf` chart shows (origin `tf` or longer). Without a window: by status (active by
   * default). With one: the levels known by its end that were still active at its start.
   */
  async levels(
    runId: string,
    tf: Tf,
    q: Window & { status?: LiquidityLevel['status'][]; types?: LevelType[] },
  ): Promise<LiquidityLevel[]> {
    let query = this.db
      .selectFrom('analysis.liquidity_levels')
      .selectAll()
      .where('run_id', '=', runId)
      .where('origin_timeframe', 'in', atLeast(tf));
    if (q.types?.length) query = query.where('type', 'in', q.types);
    if (q.from !== undefined || q.to !== undefined) {
      if (q.to !== undefined) query = query.where('known_at', '<=', new Date(q.to));
      if (q.from !== undefined) {
        const from = new Date(q.from);
        query = query.where((eb) =>
          eb.or([eb('status', '=', 'active'), eb('status_changed_at', '>=', from)]),
        );
      }
      if (q.status?.length) query = query.where('status', 'in', q.status);
    } else {
      query = query.where('status', 'in', q.status?.length ? q.status : ['active']);
    }
    const rows = (await query.orderBy('known_at', 'desc').limit(q.limit).execute()).reverse();
    return rows.map(toLevel);
  }

  /** Gold-market closures overlapping a window, for an instrument with an underlying calendar. */
  async closures(
    instrumentId: string,
    from: number,
    to: number,
  ): Promise<{ from: number; to: number; reason: string }[]> {
    const rows = await this.db
      .selectFrom('market.underlying_market_closures as c')
      .innerJoin('market.instruments as i', 'i.underlying_calendar_id', 'c.calendar_id')
      .select(['c.starts_at', 'c.ends_at', 'c.reason'])
      .where('i.id', '=', instrumentId)
      .where('c.ends_at', '>', new Date(from))
      .where('c.starts_at', '<', new Date(to))
      .orderBy('c.starts_at')
      .execute();
    return rows.map((r) => ({ from: t(r.starts_at), to: t(r.ends_at), reason: r.reason }));
  }

  /** The current state for the `smc:` channel snapshot: active levels and ranges on every timeframe. */
  async active(runId: string): Promise<{ levels: LiquidityLevel[]; ranges: TradingRange[] }> {
    const [levels, ranges] = await Promise.all([
      this.db
        .selectFrom('analysis.liquidity_levels')
        .selectAll()
        .where('run_id', '=', runId)
        .where('status', '=', 'active')
        .orderBy('known_at')
        .limit(2_000)
        .execute(),
      this.db
        .selectFrom('analysis.trading_ranges')
        .selectAll()
        .where('run_id', '=', runId)
        .where('ended_at', 'is', null)
        .orderBy('detected_at')
        .execute(),
    ]);
    return { levels: levels.map(toLevel), ranges: ranges.map(toRange) };
  }
}
