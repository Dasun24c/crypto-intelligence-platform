import { Inject, Injectable } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import {
  type ChecklistResult,
  type Page,
  type PoiZone,
  SETUP_DISCLAIMER,
  SETUP_LABELS,
  type SetupDetail,
  type SetupState,
  type SetupSummary,
  type SetupsQuery,
  type SetupTransition,
  type Tf,
} from '@cip/contracts';
import type { Database, SetupRow, SweepRow } from '@cip/db';
import { ProblemError } from '../common/problem.js';
import { decodeCursor, encodeCursor } from '../market/market.repository.js';
import { DB } from '../tokens.js';
import { toLevel, toRange, toStructure, toSweep, toZone } from './smc.repository.js';

/** A transition decided more than this after its candle closed is late (ADR 005). */
const LATE_MS = 120_000;

interface Refs {
  sweeps: string[];
  mss: {
    anchorId: string;
    anchorPrice: string;
    breakCandleTime: number;
    displacement: { from: number; to: number; bodyAtr: number } | null;
    structureEventId: string | null;
  } | null;
  rangeId: string | null;
  poiId: string | null;
  levelIds: string[];
}

export function toSetupSummary(r: SetupRow): SetupSummary {
  return {
    id: r.id,
    instrumentId: r.instrument_id,
    runId: r.run_id,
    pattern: r.pattern,
    variant: r.variant,
    direction: r.direction,
    contextTf: r.context_tf,
    setupTf: r.setup_tf,
    state: r.state,
    resolution: r.resolution,
    displayLabel: SETUP_LABELS[r.state],
    levels: {
      entry: r.entry_price,
      invalidation: r.invalidation_price,
      target1: r.target1_price,
      target2: r.target2_price,
      rr: r.rr_target1,
    },
    score: Number(r.confluence_score),
    mandatoryPassed: r.mandatory_passed,
    qualityFlags: r.quality_flags,
    flags: r.flags,
    createdAt: r.created_candle_time.getTime(),
    updatedAt: r.updated_candle_time.getTime(),
    resolvedAt: r.resolved_candle_time?.getTime() ?? null,
    disclaimer: SETUP_DISCLAIMER,
  };
}

/**
 * Setups (data model §5.2, API contracts §3 "Setups and replays"): lists, one setup in full, the
 * overlay's setups and the channel snapshot. A list reads each instrument's current live run (else
 * its latest live run), or the run `runId` names.
 */
@Injectable()
export class SetupsRepository {
  constructor(@Inject(DB) private readonly db: Kysely<Database>) {}

  /** The runs a list or snapshot reads. */
  private async runIds(instrumentId?: string, runId?: string): Promise<string[]> {
    if (runId) {
      let q = this.db.selectFrom('analysis.detection_runs').select('id').where('id', '=', runId);
      if (instrumentId) q = q.where('instrument_id', '=', instrumentId);
      const row = await q.executeTakeFirst();
      if (!row) throw new ProblemError('NOT_FOUND', 'No such run.');
      return [row.id];
    }
    const { rows } = await sql<{ id: string }>`
      SELECT DISTINCT ON (instrument_id) id FROM analysis.detection_runs
      WHERE mode = 'live' ${instrumentId ? sql`AND instrument_id = ${instrumentId}` : sql``}
      ORDER BY instrument_id, (status IN ('warming_up', 'running')) DESC, started_at DESC`.execute(this.db);
    return rows.map((r) => r.id);
  }

  /** Newest change first (keyset on the latest transition's time). */
  async list(q: SetupsQuery): Promise<Page<SetupSummary>> {
    const runs = await this.runIds(q.instrumentId, q.runId);
    if (!runs.length) return { items: [], nextCursor: null };
    let query = this.db.selectFrom('analysis.setups').selectAll().where('run_id', 'in', runs);
    if (q.instrumentId) query = query.where('instrument_id', '=', q.instrumentId);
    if (q.pattern) query = query.where('pattern', 'in', q.pattern);
    if (q.direction) query = query.where('direction', '=', q.direction);
    if (q.state) query = query.where('state', 'in', q.state);
    if (q.minScore !== undefined) query = query.where('confluence_score', '>=', String(q.minScore));
    if (q.from !== undefined) query = query.where('updated_candle_time', '>=', new Date(q.from));
    if (q.to !== undefined) query = query.where('updated_candle_time', '<=', new Date(q.to));
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      query = query.where((eb) =>
        eb.or([
          eb('updated_candle_time', '<', c.ts),
          eb.and([eb('updated_candle_time', '=', c.ts), eb('id', '<', c.id)]),
        ]),
      );
    }
    const rows = await query
      .orderBy('updated_candle_time', 'desc')
      .orderBy('id', 'desc')
      .limit(q.limit + 1)
      .execute();
    const items = rows.slice(0, q.limit);
    const last = items.at(-1);
    return {
      items: items.map(toSetupSummary),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.updated_candle_time, last.id) : null,
    };
  }

  async detail(id: string): Promise<SetupDetail | null> {
    const row = await this.db
      .selectFrom('analysis.setups')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) return null;
    const run = await this.db
      .selectFrom('analysis.detection_runs')
      .select(['from_time', 'mode'])
      .where('id', '=', row.run_id)
      .executeTakeFirstOrThrow();
    const refs = row.refs as Refs;
    const zoneIds = [row.entry_zone_id, refs.poiId].filter((x): x is string => x !== null);
    const [transitions, checklist, outcome, sweeps, structure, zones, levels, range] = await Promise.all([
      this.db
        .selectFrom('analysis.setup_transitions')
        .selectAll()
        .where('setup_id', '=', id)
        .orderBy('id')
        .execute(),
      this.db.selectFrom('analysis.setup_checklist_results').selectAll().where('setup_id', '=', id).execute(),
      this.db.selectFrom('analysis.setup_outcomes').selectAll().where('setup_id', '=', id).executeTakeFirst(),
      refs.sweeps.length
        ? this.db
            .selectFrom('analysis.sweeps as s')
            .innerJoin('analysis.liquidity_levels as l', 'l.id', 's.level_id')
            .selectAll('s')
            .select('l.type as level_type')
            .where('s.id', 'in', refs.sweeps)
            .execute()
        : [],
      refs.mss?.structureEventId
        ? this.db
            .selectFrom('analysis.structure_events')
            .selectAll()
            .where('id', '=', refs.mss.structureEventId)
            .executeTakeFirst()
        : undefined,
      zoneIds.length
        ? this.db.selectFrom('analysis.poi_zones').selectAll().where('id', 'in', zoneIds).execute()
        : [],
      refs.levelIds.length
        ? this.db
            .selectFrom('analysis.liquidity_levels')
            .selectAll()
            .where('id', 'in', refs.levelIds)
            .execute()
        : [],
      refs.rangeId
        ? this.db
            .selectFrom('analysis.trading_ranges')
            .selectAll()
            .where('id', '=', refs.rangeId)
            .executeTakeFirst()
        : undefined,
    ]);
    const zone = (zid: string | null): PoiZone | null => {
      const z = zid === null ? undefined : zones.find((x) => x.id === zid);
      return z ? toZone(z) : null;
    };
    const byState: Partial<Record<SetupState, ChecklistResult[]>> = {};
    const order = (item: string) =>
      [
        'htf_bias',
        'liquidity_marked',
        'poi_present',
        'sweep',
        'mss',
        'levels_defined',
        'risk_reward',
        'news_clear',
      ].indexOf(item);
    for (const c of [...checklist].sort((a, b) => order(a.item) - order(b.item)))
      (byState[c.state as SetupState] ??= []).push({
        item: c.item as ChecklistResult['item'],
        credit: c.credit as ChecklistResult['credit'],
        weight: c.weight,
        mandatory: c.mandatory,
        evidence: c.evidence as Record<string, unknown>,
      });
    const toTransition = (t: (typeof transitions)[number]): SetupTransition => ({
      from: t.from_state as SetupState | null,
      to: t.to_state as SetupState,
      reason: t.reason,
      candleTime: t.candle_time.getTime(),
      decidedAt: t.decided_at.getTime(),
      processedAt: t.processed_at.getTime(),
      late:
        run.mode === 'live' &&
        t.decided_at > run.from_time &&
        t.processed_at.getTime() - t.decided_at.getTime() > LATE_MS,
      evidence: t.evidence as Record<string, unknown>,
    });
    const target = (x: unknown) => (x ?? null) as SetupDetail['targets']['target1'];
    return {
      ...toSetupSummary(row),
      transitions: transitions.map(toTransition),
      checklist: byState[row.state] ?? [],
      checklistByState: byState,
      outcome: outcome
        ? {
            result: outcome.result,
            entryTouchedAt: outcome.entry_touched_at?.getTime() ?? null,
            resolvedAt: outcome.resolved_at.getTime(),
            mfeR: outcome.mfe_r,
            maeR: outcome.mae_r,
            barsHeld: outcome.bars_held,
            resolvedWithTf: outcome.resolved_with_tf,
          }
        : null,
      targets: { target1: target(row.target1_ref), target2: target(row.target2_ref) },
      refs: {
        sweeps: refs.sweeps
          .map((sid) => sweeps.find((s) => s.id === sid))
          .filter((s) => s !== undefined)
          .map((s) => toSweep(s as SweepRow & { level_type: string })),
        mss: refs.mss
          ? {
              anchorId: refs.mss.anchorId,
              anchorPrice: refs.mss.anchorPrice,
              breakCandleTime: refs.mss.breakCandleTime,
              displacement: refs.mss.displacement,
              structureEvent: structure ? toStructure(structure) : null,
            }
          : null,
        entryZone: zone(row.entry_zone_id),
        levels: refs.levelIds
          .map((lid) => levels.find((l) => l.id === lid))
          .filter((l) => l !== undefined)
          .map(toLevel),
        range: range ? toRange(range) : null,
        poi: zone(refs.poiId),
      },
    };
  }

  /** The overlay's setups: the run's on setup timeframe `tf` that were alive in [from, to). */
  async alive(runId: string, tf: Tf, from: number, to: number, limit: number): Promise<SetupSummary[]> {
    const rows = await this.db
      .selectFrom('analysis.setups')
      .selectAll()
      .where('run_id', '=', runId)
      .where('setup_tf', '=', tf)
      .where('created_candle_time', '<', new Date(to))
      .where((eb) =>
        eb.or([eb('resolved_candle_time', 'is', null), eb('resolved_candle_time', '>=', new Date(from))]),
      )
      .orderBy('created_candle_time')
      .limit(limit)
      .execute();
    return rows.map(toSetupSummary);
  }

  /**
   * The `setups` and `setups:{id}` snapshot (API contracts §5.4): every setup of the current live
   * runs that is not resolved, and the latest 50 transitions.
   */
  async snapshot(instrumentId?: string): Promise<{
    setups: SetupSummary[];
    transitions: (SetupTransition & { setupId: string })[];
  }> {
    const runs = await this.runIds(instrumentId);
    if (!runs.length) return { setups: [], transitions: [] };
    const [setups, transitions] = await Promise.all([
      this.db
        .selectFrom('analysis.setups')
        .selectAll()
        .where('run_id', 'in', runs)
        .where('state', '!=', 'resolved')
        .orderBy('updated_candle_time', 'desc')
        .limit(1_000)
        .execute(),
      this.db
        .selectFrom('analysis.setup_transitions as t')
        .innerJoin('analysis.setups as s', 's.id', 't.setup_id')
        .selectAll('t')
        .where('s.run_id', 'in', runs)
        .orderBy('t.decided_at', 'desc')
        .orderBy('t.id', 'desc')
        .limit(50)
        .execute(),
    ]);
    return {
      setups: setups.map(toSetupSummary),
      transitions: transitions.map((t) => ({
        setupId: t.setup_id,
        from: t.from_state as SetupState | null,
        to: t.to_state as SetupState,
        reason: t.reason,
        candleTime: t.candle_time.getTime(),
        decidedAt: t.decided_at.getTime(),
        processedAt: t.processed_at.getTime(),
        late: t.processed_at.getTime() - t.decided_at.getTime() > LATE_MS,
        evidence: t.evidence as Record<string, unknown>,
      })),
    };
  }
}
