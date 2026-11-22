import { Inject, Injectable } from '@nestjs/common';
import { type Kysely, type RawBuilder, sql } from 'kysely';
import {
  HISTORICAL_NOTICE,
  HISTORICAL_OBSERVATIONS,
  type SessionBucket,
  type SetupExportQuery,
  type SetupStats,
  type SetupStatsQuery,
  type SetupStatsRow,
  type StatsDimension,
  type StatsKey,
  type Tf,
} from '@cip/contracts';
import type { Database } from '@cip/db';
import { DB } from '../tokens.js';

/** The columns each dimension groups by (in the `counted` rows below). */
const DIMENSION_COLUMNS: Record<StatsDimension, readonly string[]> = {
  pattern: ['pattern'],
  variant: ['variant'],
  direction: ['direction'],
  tfPair: ['context_tf', 'setup_tf'],
  instrument: ['instrument_id'],
  session: ['session'],
  rules: ['ruleset_version', 'profile_name', 'profile_version', 'params_hash', 'changed'],
};

type Filter = Pick<SetupExportQuery, 'from' | 'to' | 'instrumentId' | 'found' | 'runId'>;

/** One counted setup, as the setups export lists it. */
export interface CountedSetup {
  id: string;
  run_id: string;
  run_mode: 'live' | 'replay';
  instrument_id: string;
  venue_id: string;
  venue_symbol: string;
  pattern: string;
  variant: 'A' | 'B' | null;
  direction: 'bullish' | 'bearish';
  context_tf: Tf;
  setup_tf: Tf;
  session: SessionBucket;
  warmup: boolean;
  ruleset_version: string;
  profile_name: string;
  profile_version: number;
  params_hash: string;
  changed: boolean;
  created_candle_time: Date;
  state: string;
  resolution: string | null;
  confirmed: boolean;
  result: string | null;
  entry_touched_at: Date | null;
  resolved_at: Date | null;
  mfe_r: number | null;
  mae_r: number | null;
  bars_held: number | null;
  resolved_with_tf: string | null;
  confluence_score: string;
  mandatory_passed: boolean;
  entry_price: string | null;
  invalidation_price: string | null;
  target1_price: string | null;
  rr_target1: number | null;
  quality_flags: string[];
}

interface StatsSqlRow {
  total: number;
  runs: number;
  pattern?: string;
  variant?: 'A' | 'B' | null;
  direction?: 'bullish' | 'bearish';
  context_tf?: Tf;
  setup_tf?: Tf;
  instrument_id?: string;
  session?: SessionBucket;
  ruleset_version?: string;
  profile_name?: string;
  profile_version?: number;
  params_hash?: string;
  changed?: boolean;
  detected: number;
  warmup: number;
  confirmed: number;
  open: number;
  resolved: number;
  entered: number;
  target_reached: number;
  invalidated: number;
  expired_no_entry: number;
  expired_open: number;
  ambiguous: number;
  avg_mfe_r: number | null;
  avg_mae_r: number | null;
}

/**
 * Outcome statistics of setups (REQUIREMENTS §3.9, rulebook §8, ADR 026), read straight from the
 * analyzer's projections: `analysis.setups` and `analysis.setup_outcomes`.
 *
 * - **Which setups**: those of every live run (or of the run `runId` names) that started forming
 *   in the period. Two live runs of one instrument under the same rules version (a restart after an
 *   unusable checkpoint) compute the same setups: each counts once, from the newer run.
 * - **Found while warming up**: decided at or before its run's start, on stored history (the rule
 *   the analyzer flags warm-up detections by); otherwise found live.
 * - **Session**: the profile's session (whole UTC hours, the first that matches in the profile's
 *   order) holding the candle the setup started forming on; `outside` when none does.
 * - **Confirmed**: it has an outcome (only confirmed setups get one, §8) or is confirmed or entry
 *   active now. The averages of MFE and MAE are over resolved setups whose entry was touched.
 */
@Injectable()
export class StatsRepository {
  constructor(@Inject(DB) private readonly db: Kysely<Database>) {}

  /** The counted setups (`counted`), as common table expressions to select from. */
  private counted(f: Filter): RawBuilder<unknown> {
    const runFilter = f.runId ? sql`r.id = ${f.runId}` : sql`r.mode = 'live'`;
    const instrument = f.instrumentId ? sql`AND r.instrument_id = ${f.instrumentId}` : sql``;
    const from = f.from !== undefined ? sql`AND s.created_candle_time > ${new Date(f.from)}` : sql``;
    const to = f.to !== undefined ? sql`AND s.created_candle_time <= ${new Date(f.to)}` : sql``;
    const found =
      f.found === 'live'
        ? sql`AND s.created_candle_time > ru.from_time`
        : f.found === 'warmup'
          ? sql`AND s.created_candle_time <= ru.from_time`
          : sql``;
    return sql`
      runs AS (
        SELECT r.id, r.mode, r.instrument_id, r.ruleset_version, r.params_hash, r.from_time, r.started_at,
               r.params IS NOT NULL AS changed, p.name AS profile_name, p.version AS profile_version,
               COALESCE(r.params, p.params) -> 'smc' -> 'sessions' AS sessions
        FROM analysis.detection_runs r
        JOIN market.instrument_profiles p ON p.id = r.profile_id
        WHERE ${runFilter} ${instrument}
      ),
      found AS (
        SELECT DISTINCT ON (s.instrument_id, ru.ruleset_version, ru.params_hash, s.pattern, s.direction,
                            s.context_tf, s.setup_tf, s.created_candle_time)
               s.id, s.run_id, ru.mode AS run_mode, s.instrument_id, s.pattern, s.variant, s.direction,
               s.context_tf, s.setup_tf, s.state, s.resolution, s.created_candle_time, s.confluence_score,
               s.mandatory_passed, s.entry_price, s.invalidation_price, s.target1_price, s.rr_target1,
               s.quality_flags, s.created_candle_time <= ru.from_time AS warmup,
               ru.ruleset_version, ru.params_hash, ru.changed, ru.profile_name, ru.profile_version, ru.sessions
        FROM analysis.setups s
        JOIN runs ru ON ru.id = s.run_id
        WHERE true ${from} ${to} ${found}
        ORDER BY s.instrument_id, ru.ruleset_version, ru.params_hash, s.pattern, s.direction,
                 s.context_tf, s.setup_tf, s.created_candle_time, ru.started_at DESC, s.run_id DESC
      ),
      counted AS (
        SELECT f.*, o.result, o.entry_touched_at, o.resolved_at, o.mfe_r, o.mae_r, o.bars_held,
               o.resolved_with_tf,
               (o.setup_id IS NOT NULL OR f.state IN ('confirmed', 'entry_active')) AS confirmed,
               COALESCE(ses.name, 'outside') AS session
        FROM found f
        LEFT JOIN analysis.setup_outcomes o ON o.setup_id = f.id
        LEFT JOIN LATERAL (
          SELECT w ->> 'name' AS name
          FROM jsonb_array_elements(COALESCE(f.sessions, '[]'::jsonb)) WITH ORDINALITY AS x (w, i)
          WHERE extract(hour FROM (f.created_candle_time - interval '1 millisecond') AT TIME ZONE 'UTC')
                  >= split_part(w ->> 'start', ':', 1)::int
            AND extract(hour FROM (f.created_candle_time - interval '1 millisecond') AT TIME ZONE 'UTC')
                  < split_part(w ->> 'end', ':', 1)::int
          ORDER BY i
          LIMIT 1
        ) ses ON true
      )`;
  }

  async stats(q: SetupStatsQuery): Promise<SetupStats> {
    const columns = [...new Set(q.groupBy.flatMap((d) => DIMENSION_COLUMNS[d]))];
    const group = sql.join(columns.map((c) => sql.ref(c)));
    const { rows } = await sql<StatsSqlRow>`
      WITH ${this.counted(q)}
      SELECT GROUPING(${sql.ref(columns[0]!)})::int AS total, count(DISTINCT run_id)::int AS runs, ${group},
             count(*)::int AS detected,
             count(*) FILTER (WHERE warmup)::int AS warmup,
             count(*) FILTER (WHERE confirmed)::int AS confirmed,
             count(*) FILTER (WHERE confirmed AND result IS NULL)::int AS open,
             count(result)::int AS resolved,
             count(entry_touched_at)::int AS entered,
             count(*) FILTER (WHERE result = 'target_reached')::int AS target_reached,
             count(*) FILTER (WHERE result = 'invalidated')::int AS invalidated,
             count(*) FILTER (WHERE result = 'expired_no_entry')::int AS expired_no_entry,
             count(*) FILTER (WHERE result = 'expired_open')::int AS expired_open,
             count(*) FILTER (WHERE result = 'ambiguous')::int AS ambiguous,
             avg(mfe_r) AS avg_mfe_r,
             avg(mae_r) AS avg_mae_r
      FROM counted
      GROUP BY GROUPING SETS ((${group}), ())
      ORDER BY total DESC, detected DESC, ${group}`.execute(this.db);
    const totals = rows.find((r) => r.total === 1);
    const groups = rows.filter((r) => r.total === 0);
    return {
      label: HISTORICAL_OBSERVATIONS,
      notice: HISTORICAL_NOTICE,
      groupBy: q.groupBy,
      from: q.from ?? null,
      to: q.to ?? null,
      instrumentId: q.instrumentId ?? null,
      found: q.found,
      runId: q.runId ?? null,
      runs: totals?.runs ?? 0,
      totals: totals ? toRow(totals, {}) : emptyRow(),
      rows: groups.map((r) => toRow(r, keyOf(r, q.groupBy))),
    };
  }

  /** How many setups the export would list. */
  async countSetups(f: Filter): Promise<number> {
    const { rows } = await sql<{ n: number }>`
      WITH ${this.counted(f)} SELECT count(*)::int AS n FROM counted`.execute(this.db);
    return rows[0]?.n ?? 0;
  }

  /** The counted setups, oldest first (the setups export). */
  async setups(f: Filter): Promise<CountedSetup[]> {
    const { rows } = await sql<CountedSetup>`
      WITH ${this.counted(f)}
      SELECT c.id, c.run_id, c.run_mode, c.instrument_id, i.venue_id, i.venue_symbol, c.pattern, c.variant,
             c.direction, c.context_tf, c.setup_tf, c.session, c.warmup, c.ruleset_version, c.profile_name,
             c.profile_version, c.params_hash, c.changed, c.created_candle_time, c.state, c.resolution,
             c.confirmed, c.result, c.entry_touched_at, c.resolved_at, c.mfe_r, c.mae_r, c.bars_held,
             c.resolved_with_tf, c.confluence_score, c.mandatory_passed, c.entry_price, c.invalidation_price,
             c.target1_price, c.rr_target1, c.quality_flags
      FROM counted c
      JOIN market.instruments i ON i.id = c.instrument_id
      ORDER BY c.created_candle_time, c.instrument_id, c.pattern, c.direction, c.setup_tf, c.id`.execute(
      this.db,
    );
    return rows;
  }
}

function keyOf(r: StatsSqlRow, groupBy: readonly StatsDimension[]): StatsKey {
  const key: StatsKey = {};
  for (const d of groupBy)
    switch (d) {
      case 'pattern':
        key.pattern = r.pattern as StatsKey['pattern'];
        break;
      case 'variant':
        key.variant = r.variant ?? null;
        break;
      case 'direction':
        key.direction = r.direction!;
        break;
      case 'tfPair':
        key.tfPair = { context: r.context_tf!, setup: r.setup_tf! };
        break;
      case 'instrument':
        key.instrumentId = r.instrument_id!;
        break;
      case 'session':
        key.session = r.session!;
        break;
      case 'rules':
        key.rules = {
          rulesetVersion: r.ruleset_version!,
          profile: { name: r.profile_name!, version: r.profile_version! },
          paramsHash: r.params_hash!,
          changedSettings: r.changed!,
        };
        break;
    }
  return key;
}

function toRow(r: StatsSqlRow, key: StatsKey): SetupStatsRow {
  return {
    key,
    detected: r.detected,
    warmup: r.warmup,
    confirmed: r.confirmed,
    open: r.open,
    resolved: r.resolved,
    entered: r.entered,
    outcomes: {
      target_reached: r.target_reached,
      invalidated: r.invalidated,
      expired_no_entry: r.expired_no_entry,
      expired_open: r.expired_open,
      ambiguous: r.ambiguous,
    },
    avgMfeR: r.avg_mfe_r === null ? null : Number(r.avg_mfe_r),
    avgMaeR: r.avg_mae_r === null ? null : Number(r.avg_mae_r),
  };
}

function emptyRow(): SetupStatsRow {
  return {
    key: {},
    detected: 0,
    warmup: 0,
    confirmed: 0,
    open: 0,
    resolved: 0,
    entered: 0,
    outcomes: { target_reached: 0, invalidated: 0, expired_no_entry: 0, expired_open: 0, ambiguous: 0 },
    avgMfeR: null,
    avgMaeR: null,
  };
}
