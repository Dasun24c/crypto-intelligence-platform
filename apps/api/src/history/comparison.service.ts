import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { type Kysely, type RawBuilder, sql } from 'kysely';
import {
  type ReplaySettings,
  type RunComparison,
  type RunDigest,
  SETUP_DIFFERENCES_SHOWN,
  type SettingDifference,
  type SetupDifference,
  type SetupSide,
} from '@cip/contracts';
import type { Database, DetectionRunRow } from '@cip/db';
import { digestLine } from '@cip/smc-engine';
import { ProblemError } from '../common/problem.js';
import { DB } from '../tokens.js';

/** A run with its profile, as a comparison reads it. */
export interface ComparedRun extends DetectionRunRow {
  profile_name: string;
  profile_version: number;
  profile_params: unknown;
}

/** The setup fields a `setup_transition` event carries (the whole setup after the transition). */
interface TransitionData {
  pattern: SetupDifference['pattern'];
  variant: 'A' | 'B' | null;
  direction: 'bullish' | 'bearish';
  contextTf: SetupDifference['contextTf'];
  setupTf: SetupDifference['setupTf'];
  to: SetupSide['state'];
  resolution: SetupSide['resolution'];
  createdAt: number;
  score: number;
  mandatoryPassed: boolean;
}

interface SideRow {
  key: string;
  a_data: TransitionData | null;
  a_n: number | null;
  b_data: TransitionData | null;
  b_n: number | null;
}

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

/** JSON values compared by content: objects regardless of key order, arrays in order. */
function sameJson(a: unknown, b: unknown): boolean {
  if (isObject(a) && isObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((k) => sameJson(a[k], b[k]));
  }
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  return a === b || (a === undefined && b === null) || (a === null && b === undefined);
}

type Json = SettingDifference['base'];
const asJson = (x: unknown): Json => (x === undefined ? null : (x as Json));

/** Every leaf (a value that is not an object) that differs between two settings objects, by path. */
export function settingDifferences(base: unknown, other: unknown, path = ''): SettingDifference[] {
  if (isObject(base) && isObject(other)) {
    const keys = [...new Set([...Object.keys(base), ...Object.keys(other)])].sort();
    return keys.flatMap((k) => settingDifferences(base[k], other[k], path ? `${path}.${k}` : k));
  }
  return sameJson(base, other) ? [] : [{ path, base: asJson(base), other: asJson(other) }];
}

/** The settings a run ran with: its own (a replay that changed some), else its profile's. */
export const effectiveParams = (run: ComparedRun): unknown => run.params ?? run.profile_params;

/** The period a run's events cover: a replay its (from, to]; a live run from its first candle on. */
function span(run: ComparedRun, now: number): { from: number; to: number } {
  if (run.mode === 'replay') return { from: run.from_time.getTime(), to: run.to_time!.getTime() };
  const origins = Object.values(run.series_origins);
  return {
    from: origins.length ? Math.min(...origins) : run.from_time.getTime(),
    to: run.to_time?.getTime() ?? now,
  };
}

/**
 * Compares two runs of one instrument over the period both cover (criteria 4.3 and 12.3, ADR 026):
 * their digests (ADR 017), the settings that differ, and the detections that differ, matched by
 * type, timeframe, natural key and decision time (the same in every run), counting repeats of the
 * same event at the same candle in order.
 */
@Injectable()
export class ComparisonService {
  constructor(@Inject(DB) private readonly db: Kysely<Database>) {}

  async run(runId: string): Promise<ComparedRun | null> {
    const row = await this.db
      .selectFrom('analysis.detection_runs as r')
      .innerJoin('market.instrument_profiles as p', 'p.id', 'r.profile_id')
      .selectAll('r')
      .select(['p.name as profile_name', 'p.version as profile_version', 'p.params as profile_params'])
      .where('r.id', '=', runId)
      .executeTakeFirst();
    return row ?? null;
  }

  /** sha256 over a run's events decided in (from, to], in seq order (the analyzer's digest). */
  async digest(runId: string, from: number, to: number): Promise<{ digest: string; events: number }> {
    const hash = createHash('sha256');
    let events = 0;
    // As the analyzer counts (smc-store.ts): event numbers start at 1.
    let after = 0;
    for (;;) {
      const rows = await this.db
        .selectFrom('analysis.detection_events')
        .select(['seq', 'type', 'timeframe', 'candle_time', 'payload'])
        .where('run_id', '=', runId)
        .where('candle_time', '>', new Date(from))
        .where('candle_time', '<=', new Date(to))
        .where('seq', '>', String(after))
        .orderBy('seq')
        .limit(5_000)
        .execute();
      for (const r of rows) {
        const p = r.payload as { key: string; data: unknown };
        hash.update(
          digestLine({
            seq: Number(r.seq),
            type: r.type,
            tf: r.timeframe,
            time: r.candle_time.getTime(),
            key: p.key,
            data: p.data,
          }),
        );
      }
      events += rows.length;
      if (rows.length < 5_000) break;
      after = Number(rows.at(-1)!.seq);
    }
    return { digest: hash.digest('hex'), events };
  }

  /** Where a live run's analysis has reached: the close of its latest 1m candle (null before any). */
  private async analysedUntil(run: ComparedRun): Promise<number | null> {
    const row = await this.db
      .selectFrom('analysis.indicator_values')
      .select('open_time')
      .where('instrument_id', '=', run.instrument_id)
      .where('timeframe', '=', '1m')
      .where('run_id', '=', run.id)
      .orderBy('open_time', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row ? row.open_time.getTime() + 60_000 : null;
  }

  /** The two runs' events in the period, numbered within each (type, timeframe, key, candle). */
  private differing(baseId: string, otherId: string, from: number, to: number): RawBuilder<unknown> {
    const events = (runId: string) => sql`
      SELECT type, timeframe, payload ->> 'key' AS key, candle_time, seq, payload -> 'data' AS data,
             row_number() OVER (PARTITION BY type, timeframe, payload ->> 'key', candle_time ORDER BY seq) AS occ
      FROM analysis.detection_events
      WHERE run_id = ${runId} AND candle_time > ${new Date(from)} AND candle_time <= ${new Date(to)}`;
    return sql`
      a AS (${events(baseId)}),
      b AS (${events(otherId)}),
      d AS (
        SELECT COALESCE(a.type, b.type) AS type, COALESCE(a.key, b.key) AS key,
               a.key IS NOT NULL AS in_a, b.key IS NOT NULL AS in_b
        FROM a FULL JOIN b
          ON a.type = b.type AND a.timeframe = b.timeframe AND a.key = b.key
         AND a.candle_time = b.candle_time AND a.occ = b.occ
        WHERE a.key IS NULL OR b.key IS NULL OR a.data IS DISTINCT FROM b.data
      )`;
  }

  /** The setups whose transitions in the period differ, oldest first (all of them with `limit` null). */
  async setupDifferences(
    base: ComparedRun,
    other: ComparedRun,
    from: number,
    to: number,
    limit: number | null,
  ): Promise<SetupDifference[]> {
    const { rows } = await sql<SideRow>`
      WITH ${this.differing(base.id, other.id, from, to)},
      keys AS (SELECT DISTINCT key FROM d WHERE type = 'setup_transition'),
      sides AS (
        SELECT 'a' AS side, a.key, a.data, a.seq, count(*) OVER (PARTITION BY a.key) AS n
        FROM a JOIN keys k ON k.key = a.key WHERE a.type = 'setup_transition'
        UNION ALL
        SELECT 'b' AS side, b.key, b.data, b.seq, count(*) OVER (PARTITION BY b.key) AS n
        FROM b JOIN keys k ON k.key = b.key WHERE b.type = 'setup_transition'
      ),
      latest AS (SELECT DISTINCT ON (side, key) side, key, data, n FROM sides ORDER BY side, key, seq DESC)
      SELECT k.key, la.data AS a_data, la.n::int AS a_n, lb.data AS b_data, lb.n::int AS b_n
      FROM keys k
      LEFT JOIN latest la ON la.side = 'a' AND la.key = k.key
      LEFT JOIN latest lb ON lb.side = 'b' AND lb.key = k.key
      ORDER BY (COALESCE(la.data, lb.data) ->> 'createdAt')::bigint, k.key
      ${limit === null ? sql`` : sql`LIMIT ${limit}`}`.execute(this.db);
    const side = (data: TransitionData | null, n: number | null): SetupSide | null =>
      data
        ? {
            state: data.to,
            resolution: data.resolution,
            score: data.score,
            mandatoryPassed: data.mandatoryPassed,
            transitions: n ?? 0,
          }
        : null;
    return rows.map((r) => {
      const d = (r.a_data ?? r.b_data)!;
      return {
        key: r.key,
        pattern: d.pattern,
        variant: d.variant,
        direction: d.direction,
        contextTf: d.contextTf,
        setupTf: d.setupTf,
        createdAt: d.createdAt,
        base: side(r.a_data, r.a_n),
        other: side(r.b_data, r.b_n),
      };
    });
  }

  /** The period both runs cover; refuses runs of different instruments or with no common period. */
  period(base: ComparedRun, other: ComparedRun, now = Date.now()): { from: number; to: number } {
    if (base.instrument_id !== other.instrument_id)
      throw new ProblemError('VALIDATION_FAILED', 'Only runs of the same instrument can be compared.');
    const a = span(base, now);
    const b = span(other, now);
    const from = Math.max(a.from, b.from);
    const to = Math.min(a.to, b.to);
    if (!(to > from)) throw new ProblemError('VALIDATION_FAILED', 'The two runs share no period.');
    return { from, to };
  }

  /** The settings that differ: the rules version, the profile, then each setting by path. */
  settings(base: ComparedRun, other: ComparedRun): SettingDifference[] {
    const out: SettingDifference[] = [];
    if (base.ruleset_version !== other.ruleset_version)
      out.push({ path: 'rulesetVersion', base: base.ruleset_version, other: other.ruleset_version });
    if (base.profile_id !== other.profile_id)
      out.push({
        path: 'profile',
        base: `${base.profile_name} v${base.profile_version}`,
        other: `${other.profile_name} v${other.profile_version}`,
      });
    return [...out, ...settingDifferences(effectiveParams(base), effectiveParams(other))];
  }

  async compare(base: ComparedRun, other: ComparedRun, now = Date.now()): Promise<RunComparison> {
    const { from, to } = this.period(base, other, now);
    const [a, b, types, counts, setups, until] = await Promise.all([
      this.digest(base.id, from, to),
      this.digest(other.id, from, to),
      this.db
        .selectFrom('analysis.detection_events')
        .select(['run_id', 'type', sql<number>`count(*)::int`.as('n')])
        .where('run_id', 'in', [base.id, other.id])
        .where('candle_time', '>', new Date(from))
        .where('candle_time', '<=', new Date(to))
        .groupBy(['run_id', 'type'])
        .execute(),
      sql<{ only_in_base: number; only_in_other: number; changed: number; setups: number }>`
        WITH ${this.differing(base.id, other.id, from, to)}
        SELECT count(*) FILTER (WHERE NOT in_b)::int AS only_in_base,
               count(*) FILTER (WHERE NOT in_a)::int AS only_in_other,
               count(*) FILTER (WHERE in_a AND in_b)::int AS changed,
               count(DISTINCT key) FILTER (WHERE type = 'setup_transition')::int AS setups
        FROM d`.execute(this.db),
      this.setupDifferences(base, other, from, to, SETUP_DIFFERENCES_SHOWN),
      Promise.all(
        [base, other].map((r) => (r.mode === 'live' ? this.analysedUntil(r) : Promise.resolve(Infinity))),
      ),
    ]);
    const byType = new Map<string, { base: number; other: number }>();
    for (const t of types) {
      const entry = byType.get(t.type) ?? { base: 0, other: 0 };
      if (t.run_id === base.id) entry.base = t.n;
      else entry.other = t.n;
      byType.set(t.type, entry);
    }
    const c = counts.rows[0]!;
    const side = (r: ComparedRun, d: { digest: string; events: number }): RunDigest => ({
      runId: r.id,
      mode: r.mode,
      profile: { name: r.profile_name, version: r.profile_version },
      rulesetVersion: r.ruleset_version,
      digest: d.digest,
      events: d.events,
      settings: (r.settings as ReplaySettings | null) ?? null,
    });
    return {
      base: side(base, a),
      other: side(other, b),
      from,
      to,
      equal: a.digest === b.digest && a.events === b.events,
      sameOrigins: sameJson(base.series_origins, other.series_origins),
      incomplete: until.some((u) => u === null || u < to),
      settings: this.settings(base, other),
      eventTypes: [...byType.entries()]
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([type, n]) => ({ type, ...n })),
      onlyInBase: c.only_in_base,
      onlyInOther: c.only_in_other,
      changed: c.changed,
      setups,
      setupsTotal: c.setups,
    };
  }
}
