import { createHash } from 'node:crypto';
import { type Kysely, sql, type Transaction } from 'kysely';
import type { Database, NewIndicatorValue } from '@cip/db';
import { digestLine, type SmcEvent } from '@cip/smc-engine';
import { eventRow, type LevelChange, project, type RunInfo, type ZoneChange } from './smc-rows.js';

/** A former lease holder found a newer epoch on the run: it must stop writing (architecture §6). */
export class LeaseLost extends Error {
  constructor(runId: string) {
    super(`run ${runId} is now written by a newer lease holder`);
    this.name = 'LeaseLost';
  }
}

export interface Batch {
  info: RunInfo;
  values: NewIndicatorValue[];
  events: SmcEvent[];
  /** Live runs: every write is fenced with the lease epoch. */
  epoch?: number;
  checkpoint?: { boundary: number; state: Buffer };
  now: number;
}

export interface Written {
  /** `tf|openTime` of indicator values stored now (not before). */
  values: Set<string>;
  /** Events stored now, in order: the ones to publish. */
  events: SmcEvent[];
}

const CHUNK = 500;

/**
 * The analysis writes of one batch of boundaries in a single transaction (architecture §7):
 * indicator values, the event log, the projections and, every 60 boundaries, the checkpoint. Every
 * write is idempotent: events are keyed by (run, seq) and entities by ids derived from the run and
 * their natural key, so a restart that recomputes a stretch writes nothing new. Projections follow
 * only events stored now, and a checkpoint is never replaced by an older epoch.
 */
export class SmcStore {
  constructor(private readonly db: Kysely<Database>) {}

  async write(b: Batch): Promise<Written> {
    return this.db.transaction().execute(async (tx) => {
      if (b.epoch !== undefined) {
        const held = await tx
          .selectFrom('analysis.engine_checkpoints')
          .select('lease_epoch')
          .where('run_id', '=', b.info.runId)
          .forUpdate()
          .executeTakeFirst();
        if (held && Number(held.lease_epoch) > b.epoch) throw new LeaseLost(b.info.runId);
      }
      const values = new Set<string>();
      for (let i = 0; i < b.values.length; i += CHUNK) {
        const res = await tx
          .insertInto('analysis.indicator_values')
          .values(b.values.slice(i, i + CHUNK))
          .onConflict((oc) => oc.doNothing())
          .returning(['timeframe', 'open_time'])
          .execute();
        for (const r of res) values.add(`${r.timeframe}|${r.open_time.getTime()}`);
      }
      const seqs = new Set<number>();
      for (let i = 0; i < b.events.length; i += CHUNK) {
        const res = await tx
          .insertInto('analysis.detection_events')
          .values(b.events.slice(i, i + CHUNK).map((e) => eventRow(b.info, e)))
          .onConflict((oc) => oc.doNothing())
          .returning('seq')
          .execute();
        for (const r of res) seqs.add(Number(r.seq));
      }
      const fresh = b.events.filter((e) => seqs.has(e.seq));
      await this.applyProjection(tx, b.info, fresh, b.now);
      if (b.checkpoint) {
        const row = await tx
          .insertInto('analysis.engine_checkpoints')
          .values({
            run_id: b.info.runId,
            last_boundary: new Date(b.checkpoint.boundary),
            lease_epoch: b.epoch ?? 0,
            state: b.checkpoint.state,
          })
          .onConflict((oc) =>
            oc
              .column('run_id')
              .doUpdateSet((eb) => ({
                last_boundary: eb.ref('excluded.last_boundary'),
                lease_epoch: eb.ref('excluded.lease_epoch'),
                state: eb.ref('excluded.state'),
                updated_at: sql<Date>`now()`,
              }))
              .where('analysis.engine_checkpoints.lease_epoch', '<=', sql<string>`excluded.lease_epoch`),
          )
          .returning('run_id')
          .executeTakeFirst();
        if (!row) throw new LeaseLost(b.info.runId);
      }
      return { values, events: fresh };
    });
  }

  private async applyProjection(tx: Transaction<Database>, info: RunInfo, events: SmcEvent[], now: number) {
    if (events.length === 0) return;
    const p = project(info, events, now);
    // Inserts in dependency order (structure → swings, sweeps → levels), then updates.
    const insert = async (table: keyof Database, rows: Record<string, unknown>[]) => {
      for (let i = 0; i < rows.length; i += CHUNK)
        await tx
          .insertInto(table)
          .values(rows.slice(i, i + CHUNK))
          .onConflict((oc) => oc.column('id').doNothing())
          .execute();
    };
    await insert('analysis.swing_points', p.swings);
    await insert('analysis.structure_events', p.structure);
    await insert('analysis.trading_ranges', p.ranges);
    await insert('analysis.liquidity_levels', p.levels);
    await insert('analysis.sweeps', p.sweeps);
    // After structure events (an order block refers to its break), in creation order (links point back).
    await insert('analysis.poi_zones', p.zones);
    for (const [id, end] of p.rangeEnds)
      await tx
        .updateTable('analysis.trading_ranges')
        .set({ ended_at: end.ended_at, end_reason: end.end_reason as never })
        .where('id', '=', id)
        .execute();
    await this.updateLevels(tx, p.levelChanges);
    await this.updateZones(tx, p.zoneChanges);
    for (const [id, linked] of p.zoneLinks)
      await tx
        .updateTable('analysis.poi_zones')
        .set({ linked_zone_id: id })
        .where('id', '=', linked)
        .where('linked_zone_id', 'is', null)
        .execute();
  }

  /** One statement for all of a batch's zone changes: each carries the zone's whole state. */
  private async updateZones(tx: Transaction<Database>, changes: Map<string, ZoneChange>): Promise<void> {
    const list = [...changes];
    for (let i = 0; i < list.length; i += CHUNK) {
      const rows = list
        .slice(i, i + CHUNK)
        .map(
          ([id, c]) =>
            sql`(${id}::uuid, ${c.status}::text, ${c.fill_pct}::numeric, ${c.first_touch_at}::timestamptz, ${c.status_changed_at}::timestamptz)`,
        );
      await sql`
        UPDATE analysis.poi_zones AS z SET
          status = v.status, fill_pct = v.fill_pct, first_touch_at = v.first_touch_at,
          status_changed_at = v.status_changed_at
        FROM (VALUES ${sql.join(rows)}) AS v (id, status, fill_pct, first_touch_at, status_changed_at)
        WHERE z.id = v.id`.execute(tx);
    }
  }

  /** One statement for all of a batch's level changes, each merged in event order. */
  private async updateLevels(tx: Transaction<Database>, changes: Map<string, LevelChange>): Promise<void> {
    const list = [...changes];
    for (let i = 0; i < list.length; i += CHUNK) {
      const rows = list.slice(i, i + CHUNK).map(
        ([id, c]) =>
          sql`(${id}::uuid, ${c.status ?? null}::text, ${c.price ?? null}::numeric, ${c.touches ?? null}::int,
               ${c.sweep_count ?? null}::int, ${c.status_changed_at ?? null}::timestamptz, ${'status_changed_at' in c}::boolean)`,
      );
      await sql`
        UPDATE analysis.liquidity_levels AS l SET
          status = COALESCE(v.status, l.status),
          price = COALESCE(v.price, l.price),
          touches = COALESCE(v.touches, l.touches),
          sweep_count = COALESCE(v.sweep_count, l.sweep_count),
          status_changed_at = CASE WHEN v.has_changed_at THEN v.changed_at ELSE l.status_changed_at END
        FROM (VALUES ${sql.join(rows)}) AS v (id, status, price, touches, sweep_count, changed_at, has_changed_at)
        WHERE l.id = v.id`.execute(tx);
    }
  }

  async loadCheckpoint(runId: string): Promise<{ boundary: number; epoch: number; state: Buffer } | null> {
    const row = await this.db
      .selectFrom('analysis.engine_checkpoints')
      .select(['last_boundary', 'lease_epoch', 'state'])
      .where('run_id', '=', runId)
      .executeTakeFirst();
    return row
      ? { boundary: row.last_boundary.getTime(), epoch: Number(row.lease_epoch), state: row.state }
      : null;
  }

  /**
   * Takes the run for a new lease epoch: from now on a former holder's writes fail their fence.
   * False when a newer epoch already holds it.
   */
  async claim(runId: string, epoch: number): Promise<boolean> {
    const row = await this.db
      .selectFrom('analysis.engine_checkpoints')
      .select('lease_epoch')
      .where('run_id', '=', runId)
      .executeTakeFirst();
    if (!row) return true;
    if (Number(row.lease_epoch) > epoch) return false;
    await this.db
      .updateTable('analysis.engine_checkpoints')
      .set({ lease_epoch: epoch })
      .where('run_id', '=', runId)
      .where('lease_epoch', '<', String(epoch))
      .execute();
    return true;
  }

  async lastSeq(runId: string): Promise<number> {
    const row = await this.db
      .selectFrom('analysis.detection_events')
      .select((eb) => eb.fn.max('seq').as('seq'))
      .where('run_id', '=', runId)
      .executeTakeFirst();
    return row?.seq === null || row?.seq === undefined ? 0 : Number(row.seq);
  }

  /** Stored events after `seq`, in order, as the engine emitted them (for publishing after a restart). */
  async eventsAfter(runId: string, seq: number, limit = 1_000): Promise<SmcEvent[]> {
    const rows = await this.db
      .selectFrom('analysis.detection_events')
      .select(['seq', 'type', 'timeframe', 'candle_time', 'payload'])
      .where('run_id', '=', runId)
      .where('seq', '>', String(seq))
      .orderBy('seq')
      .limit(limit)
      .execute();
    return rows.map((r) => {
      const p = r.payload as { key: string; data: SmcEvent['data'] };
      return {
        seq: Number(r.seq),
        type: r.type,
        tf: r.timeframe,
        time: r.candle_time.getTime(),
        key: p.key,
        data: p.data,
      } as SmcEvent;
    });
  }

  /**
   * sha256 over the run's events decided in (from, to], in seq order (ADR 004): the digest a replay
   * of the same period must reproduce.
   */
  async digest(runId: string, from: number, to: number): Promise<{ digest: string; events: number }> {
    const hash = createHash('sha256');
    let events = 0;
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
}
