import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import {
  type DetectionRun,
  type IndicatorParams,
  type IndicatorPoint,
  type IndicatorSeries,
  ProfileParamsSchema,
  type RunRef,
  type RunsQuery,
  type Tf,
} from '@cip/contracts';
import type { Database, IndicatorValueRow } from '@cip/db';
import { DB } from '../tokens.js';

interface RunWithProfile {
  id: string;
  status: RunRef['status'];
  from_time: Date;
  name: string;
  version: number;
  params: unknown;
}

export function toPoint(r: IndicatorValueRow, runFrom: number): IndicatorPoint {
  const t = r.open_time.getTime();
  return {
    t,
    rsi: r.rsi,
    macd: r.macd,
    macdSignal: r.macd_signal,
    macdHist: r.macd_hist,
    emaFast: r.ema_fast,
    emaMid: r.ema_mid,
    emaSlow: r.ema_slow,
    vwap: r.vwap,
    atr: r.atr,
    volumeZ: r.volume_z,
    volumeAnomaly: r.volume_anomaly,
    trend: r.trend,
    trendStrength: r.trend_strength,
    warmup: t < runFrom,
  };
}

/** Analysis results (data model §5) for the REST API; the analyzer writes them. */
@Injectable()
export class AnalysisRepository {
  constructor(@Inject(DB) private readonly db: Kysely<Database>) {}

  /** The instrument's open live run, else its latest live run; null when it was never analysed. */
  async currentRun(instrumentId: string): Promise<RunWithProfile | null> {
    const row = await this.db
      .selectFrom('analysis.detection_runs as r')
      .innerJoin('market.instrument_profiles as p', 'p.id', 'r.profile_id')
      .select(['r.id', 'r.status', 'r.from_time', 'p.name', 'p.version', 'p.params'])
      .where('r.instrument_id', '=', instrumentId)
      .where('r.mode', '=', 'live')
      // Open runs first, then the most recent.
      .orderBy((eb) => eb.case().when('r.status', 'in', ['warming_up', 'running']).then(0).else(1).end())
      .orderBy('r.started_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row ?? null;
  }

  /**
   * The run's points for one timeframe, oldest first. With `from`, the first `limit` from there;
   * otherwise the latest `limit` before `to` (or the newest).
   */
  async series(
    instrumentId: string,
    tf: Tf,
    q: { from?: number; to?: number; limit: number },
  ): Promise<IndicatorSeries> {
    const run = await this.currentRun(instrumentId);
    if (!run) return { instrumentId, tf, run: null, params: null, points: [] };
    let query = this.db
      .selectFrom('analysis.indicator_values')
      .selectAll()
      .where('instrument_id', '=', instrumentId)
      .where('timeframe', '=', tf)
      .where('run_id', '=', run.id);
    if (q.from !== undefined) query = query.where('open_time', '>=', new Date(q.from));
    if (q.to !== undefined) query = query.where('open_time', '<', new Date(q.to));
    const rows =
      q.from !== undefined
        ? await query.orderBy('open_time').limit(q.limit).execute()
        : (await query.orderBy('open_time', 'desc').limit(q.limit).execute()).reverse();
    const from = run.from_time.getTime();
    // Only the indicator settings: a profile from an earlier version lacks newer SMC settings.
    const params = ProfileParamsSchema.pick({ indicators: true }).safeParse(run.params);
    return {
      instrumentId,
      tf,
      run: { id: run.id, status: run.status, from, profile: { name: run.name, version: run.version } },
      params: params.success ? (params.data.indicators satisfies IndicatorParams) : null,
      points: rows.map((r) => toPoint(r, from)),
    };
  }

  /** Runs newest first (`GET /system/runs`), without the live state the controller adds. */
  async runs(q: RunsQuery): Promise<Omit<DetectionRun, 'lagSec' | 'paused' | 'pauseReason'>[]> {
    let query = this.db
      .selectFrom('analysis.detection_runs as r')
      .innerJoin('market.instrument_profiles as p', 'p.id', 'r.profile_id')
      .selectAll('r')
      .select(['p.name', 'p.version'])
      .orderBy('r.started_at', 'desc')
      .orderBy('r.id', 'desc')
      .limit(q.limit);
    if (q.instrumentId) query = query.where('r.instrument_id', '=', q.instrumentId);
    const rows = await query.execute();
    return rows.map((r) => ({
      id: r.id,
      mode: r.mode,
      instrumentId: r.instrument_id,
      profile: { name: r.name, version: r.version },
      rulesetVersion: r.ruleset_version,
      paramsHash: r.params_hash,
      from: r.from_time.getTime(),
      to: r.to_time?.getTime() ?? null,
      status: r.status,
      startedAt: r.started_at.getTime(),
      finishedAt: r.finished_at?.getTime() ?? null,
    }));
  }
}
