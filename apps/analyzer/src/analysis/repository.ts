import { type Kysely, sql } from 'kysely';
import { type Candle, TF_MS, type Timeframe } from '@cip/domain';
import {
  type Database,
  type DetectionRunRow,
  type NewIndicatorValue,
  rowToCandle,
  type RunStatus,
} from '@cip/db';

/** An enabled instrument with its profile: the unit of analysis (one actor each). */
export interface AnalysedInstrument {
  id: string;
  venue: string;
  symbol: string;
  profileId: string;
  profileName: string;
  profileVersion: number;
  params: unknown;
  paramsHash: string;
}

/** What the analyzer reads and writes (data model §5). It connects as `svc_analyzer`. */
export class AnalysisRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** Enabled instruments that have a profile. */
  async instruments(): Promise<AnalysedInstrument[]> {
    const rows = await this.db
      .selectFrom('market.instruments as i')
      .innerJoin('market.instrument_profiles as p', 'p.id', 'i.profile_id')
      .select([
        'i.id',
        'i.venue_id',
        'i.venue_symbol',
        'p.id as profile_id',
        'p.name',
        'p.version',
        'p.params',
        'p.params_hash',
      ])
      .where('i.enabled', '=', true)
      .orderBy('i.id')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      venue: r.venue_id,
      symbol: r.venue_symbol,
      profileId: r.profile_id,
      profileName: r.name,
      profileVersion: r.version,
      params: r.params,
      paramsHash: r.params_hash,
    }));
  }

  /** The instrument's open live run (at most one: `one_open_live_run`). */
  async openRun(instrumentId: string): Promise<DetectionRunRow | null> {
    return (
      (await this.db
        .selectFrom('analysis.detection_runs')
        .selectAll()
        .where('instrument_id', '=', instrumentId)
        .where('mode', '=', 'live')
        .where('status', 'in', ['warming_up', 'running'])
        .executeTakeFirst()) ?? null
    );
  }

  /** Opens a live run; null when another analyzer opened one first (the unique index refused). */
  async createRun(run: {
    id: string;
    instrumentId: string;
    profileId: string;
    rulesetVersion: string;
    paramsHash: string;
    from: number;
    startedAt: number;
  }): Promise<DetectionRunRow | null> {
    try {
      return await this.db
        .insertInto('analysis.detection_runs')
        .values({
          id: run.id,
          mode: 'live',
          instrument_id: run.instrumentId,
          profile_id: run.profileId,
          ruleset_version: run.rulesetVersion,
          params_hash: run.paramsHash,
          from_time: new Date(run.from),
          status: 'warming_up',
          started_at: new Date(run.startedAt),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return null;
      throw err;
    }
  }

  async setStatus(runId: string, status: RunStatus, now = new Date()): Promise<void> {
    const closing = status === 'completed' || status === 'failed' || status === 'superseded';
    await this.db
      .updateTable('analysis.detection_runs')
      .set(closing ? { status, finished_at: now, to_time: now } : { status })
      .where('id', '=', runId)
      .execute();
  }

  /**
   * Fixes where a run's series for one timeframe starts, unless it is fixed already, and returns the
   * stored start: a run never changes what it computes, whatever history arrives later.
   */
  async fixOrigin(runId: string, tf: Timeframe, origin: number): Promise<number> {
    const row = await this.db
      .updateTable('analysis.detection_runs')
      .set({
        series_origins: sql<
          Record<string, number>
        >`series_origins || jsonb_build_object(${tf}::text, ${origin}::bigint)`,
      })
      .where('id', '=', runId)
      .where(sql<boolean>`NOT series_origins ? ${tf}`)
      .returning('series_origins')
      .executeTakeFirst();
    if (row) return Number(row.series_origins[tf]);
    const stored = await this.db
      .selectFrom('analysis.detection_runs')
      .select('series_origins')
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    return Number(stored.series_origins[tf]);
  }

  async earliestOpenTime(instrumentId: string, tf: Timeframe): Promise<number | null> {
    const row = await this.db
      .selectFrom('market.candles')
      .select('open_time')
      .where('instrument_id', '=', instrumentId)
      .where('timeframe', '=', tf)
      .orderBy('open_time')
      .limit(1)
      .executeTakeFirst();
    return row ? row.open_time.getTime() : null;
  }

  async latestOpenTime(instrumentId: string, tf: Timeframe): Promise<number | null> {
    const row = await this.db
      .selectFrom('market.candles')
      .select('open_time')
      .where('instrument_id', '=', instrumentId)
      .where('timeframe', '=', tf)
      .orderBy('open_time', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row ? row.open_time.getTime() : null;
  }

  /** Stored candles from `from` (inclusive), oldest first. */
  async candlesFrom(instrumentId: string, tf: Timeframe, from: number, limit: number): Promise<Candle[]> {
    const rows = await this.db
      .selectFrom('market.candles')
      .selectAll()
      .where('instrument_id', '=', instrumentId)
      .where('timeframe', '=', tf)
      .where('open_time', '>=', new Date(from))
      .orderBy('open_time')
      .limit(limit)
      .execute();
    return rows.map(rowToCandle);
  }

  /**
   * Whether a kline gap that is still open (or being backfilled) overlaps [from, to) for this
   * timeframe. A 1m gap holds back every timeframe, since higher ones are aggregated from 1m; a
   * gap recorded for one timeframe (deep history) holds back only that one.
   */
  async openGapOverlaps(instrumentId: string, tf: Timeframe, from: number, to: number): Promise<boolean> {
    const row = await this.db
      .selectFrom('market.data_gaps')
      .select('id')
      .where('instrument_id', '=', instrumentId)
      .where('stream', '=', 'kline')
      .where('status', 'in', ['open', 'backfilling'])
      .where('gap_start', '<', new Date(to))
      .where((eb) => eb.or([eb('gap_end', 'is', null), eb('gap_end', '>', new Date(from))]))
      .where(
        sql<boolean>`(details->>'timeframe' IS NULL OR details->>'timeframe' = '1m' OR details->>'timeframe' = ${tf})`,
      )
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Whether an aggregate over [from, to) lacks 1m candles that will still be repaired: minutes
   * missing inside the instrument's 1m history (not before it starts), unless the gap over them was
   * given up as unrepairable. Such a candle is not final yet.
   */
  async awaitsRepair(instrumentId: string, from: number, to: number): Promise<boolean> {
    const { rows } = await sql<{ present: string; first: Date | null; given_up: boolean }>`
      SELECT
        (SELECT count(*) FROM market.candles
          WHERE instrument_id = ${instrumentId} AND timeframe = '1m'
            AND open_time >= ${new Date(from)} AND open_time < ${new Date(to)}) AS present,
        (SELECT min(open_time) FROM market.candles
          WHERE instrument_id = ${instrumentId} AND timeframe = '1m') AS first,
        EXISTS (SELECT 1 FROM market.data_gaps
          WHERE instrument_id = ${instrumentId} AND stream = 'kline' AND status = 'unrepairable'
            AND gap_start < ${new Date(to)} AND (gap_end IS NULL OR gap_end > ${new Date(from)})) AS given_up
    `.execute(this.db);
    const r = rows[0]!;
    const insideHistory = r.first !== null && new Date(r.first).getTime() <= from;
    return insideHistory && Number(r.present) < (to - from) / 60_000 && !r.given_up;
  }

  /**
   * Idempotent: a run's values are deterministic, so a value already stored is the same value.
   * Returns the open times written now (not stored before), which are the ones to publish.
   */
  async insertValues(rows: NewIndicatorValue[]): Promise<Set<number>> {
    const written = new Set<number>();
    for (let i = 0; i < rows.length; i += 500) {
      const res = await this.db
        .insertInto('analysis.indicator_values')
        .values(rows.slice(i, i + 500))
        .onConflict((oc) => oc.doNothing())
        .returning('open_time')
        .execute();
      for (const r of res) written.add(r.open_time.getTime());
    }
    return written;
  }
}

/** The candle that closes last at or before `boundary` for this timeframe opens here. */
export function lastClosedOpen(tf: Timeframe, boundary: number): number {
  return Math.floor(boundary / TF_MS[tf]) * TF_MS[tf] - TF_MS[tf];
}
