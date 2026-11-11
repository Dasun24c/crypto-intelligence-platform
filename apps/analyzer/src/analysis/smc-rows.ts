import type { SmcEventMessage } from '@cip/contracts';
import type { NewDetectionEvent } from '@cip/db';
import { TF_MS } from '@cip/domain';
import { type SmcEvent, storedPayload } from '@cip/smc-engine';
import { entityId } from './ids.js';

/**
 * How engine events become rows (the event log and the data model §5.1 projections) and live
 * messages. The event log stores the engine's own event; projections and messages add the run's
 * ids and two flags that depend on the run, not on the market: `warmup` (decided before the run
 * started) and `late_detection` (decided more than LATE_MS after its candle closed, ADR 005).
 */
export const LATE_MS = 120_000;

export interface RunInfo {
  runId: string;
  instrumentId: string;
  /** The run's from_time: events decided at or before it are warm-up. */
  from: number;
  live: boolean;
}

export function runFlags(info: RunInfo, e: SmcEvent, now: number): string[] {
  if (e.time <= info.from) return ['warmup'];
  return info.live && now - e.time > LATE_MS ? ['late_detection'] : [];
}

export const isWarmup = (info: RunInfo, e: SmcEvent) => e.time <= info.from;

export function eventRow(info: RunInfo, e: SmcEvent): NewDetectionEvent {
  return {
    run_id: info.runId,
    seq: e.seq,
    candle_time: new Date(e.time),
    instrument_id: info.instrumentId,
    timeframe: e.tf,
    type: e.type,
    entity_id: entityId(info.runId, e.key),
    payload: JSON.stringify(storedPayload(e)),
  };
}

/** One level's changes within a batch, merged in order (each sets absolute values). */
export interface LevelChange {
  status?: string;
  price?: string;
  touches?: number;
  sweep_count?: number;
  status_changed_at?: Date | null;
}

/** The projection writes for a batch of new events, in an order that keeps foreign keys valid. */
export interface Projection {
  swings: Record<string, unknown>[];
  structure: Record<string, unknown>[];
  ranges: Record<string, unknown>[];
  levels: Record<string, unknown>[];
  sweeps: Record<string, unknown>[];
  rangeEnds: Map<string, { ended_at: Date; end_reason: string }>;
  levelChanges: Map<string, LevelChange>;
}

export function project(info: RunInfo, events: readonly SmcEvent[], now: number): Projection {
  const p: Projection = {
    swings: [],
    structure: [],
    ranges: [],
    levels: [],
    sweeps: [],
    rangeEnds: new Map(),
    levelChanges: new Map(),
  };
  const id = (key: string) => entityId(info.runId, key);
  const base = (e: SmcEvent) => ({
    id: id(e.key),
    run_id: info.runId,
    instrument_id: info.instrumentId,
  });
  const change = (levelId: string, c: LevelChange) =>
    p.levelChanges.set(levelId, { ...p.levelChanges.get(levelId), ...c });
  for (const e of events) {
    const flags = (engine: readonly string[]) => [...engine, ...runFlags(info, e, now)];
    switch (e.type) {
      case 'swing_confirmed':
        p.swings.push({
          ...base(e),
          timeframe: e.tf,
          kind: e.data.kind,
          structure_level: e.data.level,
          price: e.data.price,
          candle_time: new Date(e.data.candleTime),
          confirmed_at: new Date(e.data.confirmedAt),
          flags: flags(e.data.flags),
        });
        break;
      case 'structure':
        p.structure.push({
          ...base(e),
          timeframe: e.tf,
          structure_level: e.data.level,
          type: e.data.type,
          direction: e.data.direction,
          broken_swing_id: e.data.brokenSwing === null ? null : id(e.data.brokenSwing),
          break_price: e.data.breakPrice,
          break_candle_time: new Date(e.data.breakCandleTime),
          is_initial: e.data.isInitial,
          displacement: e.data.displacement === null ? null : JSON.stringify(e.data.displacement),
          flags: flags(e.data.flags),
        });
        break;
      case 'range_detected':
        p.ranges.push({
          ...base(e),
          timeframe: e.tf,
          high: e.data.high,
          low: e.data.low,
          equilibrium: e.data.equilibrium,
          window_start: new Date(e.data.windowStart),
          detected_at: new Date(e.data.detectedAt),
          flags: flags(e.data.flags),
        });
        break;
      case 'range_ended':
        p.rangeEnds.set(id(e.key), { ended_at: new Date(e.data.endedAt), end_reason: e.data.reason });
        break;
      case 'level_created':
        p.levels.push({
          ...base(e),
          origin_timeframe: e.tf,
          type: e.data.type,
          side: e.data.side,
          price: e.data.price,
          touches: e.data.touches,
          session_name: e.data.sessionName,
          source_ref: JSON.stringify({ keys: e.data.sourceRefs }),
          location: e.data.location,
          known_at: new Date(e.data.knownAt),
          status: e.data.status,
          sweep_count: e.data.sweepCount,
          flags: flags(e.data.flags),
        });
        break;
      case 'level_status':
        change(id(e.key), {
          status: e.data.status,
          price: e.data.price,
          touches: e.data.touches,
          sweep_count: e.data.sweepCount,
          status_changed_at: e.data.statusChangedAt === null ? null : new Date(e.data.statusChangedAt),
        });
        break;
      case 'sweep':
        p.sweeps.push({
          ...base(e),
          timeframe: e.tf,
          level_id: id(e.data.level),
          group_id: id(e.data.group),
          kind: e.data.kind,
          side: e.data.side,
          level_price: e.data.levelPrice,
          extreme_price: e.data.extremePrice,
          penetration_atr: e.data.penetrationAtr,
          breach_candle_time: new Date(e.data.breachCandleTime),
          confirmed_candle_time: new Date(e.data.confirmedCandleTime),
          notional_beyond_usd: e.data.notionalBeyondUsd,
          flags: flags(e.data.flags),
        });
        change(id(e.data.level), { sweep_count: e.data.levelSweepCount, status: e.data.levelStatus });
        break;
      case 'gap_marker':
        break;
    }
  }
  return p;
}

/** The live message for an event (API form), or null for events that are not published. */
export function toMessage(info: RunInfo, e: SmcEvent, now: number): SmcEventMessage | null {
  const id = (key: string) => entityId(info.runId, key);
  const flags = (engine: readonly string[]) => [...engine, ...runFlags(info, e, now)];
  const head = { instrumentId: info.instrumentId, runId: info.runId, seq: e.seq, tf: e.tf, time: e.time };
  switch (e.type) {
    case 'swing_confirmed':
      return {
        ...head,
        type: 'swing.confirmed',
        data: {
          id: id(e.key),
          tf: e.tf,
          kind: e.data.kind,
          level: e.data.level,
          price: e.data.price,
          candleTime: e.data.candleTime,
          confirmedAt: e.data.confirmedAt,
          flags: flags(e.data.flags),
        },
      };
    case 'structure':
      return {
        ...head,
        type: 'structure',
        data: {
          id: id(e.key),
          tf: e.tf,
          level: e.data.level,
          type: e.data.type,
          direction: e.data.direction,
          brokenSwingId: e.data.brokenSwing === null ? null : id(e.data.brokenSwing),
          breakPrice: e.data.breakPrice,
          breakCandleTime: e.data.breakCandleTime,
          isInitial: e.data.isInitial,
          displacement: e.data.displacement,
          flags: flags(e.data.flags),
        },
      };
    case 'range_detected':
      return {
        ...head,
        type: 'range.detected',
        data: {
          id: id(e.key),
          tf: e.tf,
          high: e.data.high,
          low: e.data.low,
          equilibrium: e.data.equilibrium,
          windowStart: e.data.windowStart,
          detectedAt: e.data.detectedAt,
          endedAt: null,
          endReason: null,
          flags: flags(e.data.flags),
        },
      };
    case 'range_ended':
      return {
        ...head,
        type: 'range.ended',
        data: { id: id(e.key), endedAt: e.data.endedAt, endReason: e.data.reason },
      };
    case 'level_created':
      return {
        ...head,
        type: 'level.created',
        data: {
          id: id(e.key),
          tf: e.tf,
          type: e.data.type,
          side: e.data.side,
          price: e.data.price,
          touches: e.data.touches,
          sessionName: e.data.sessionName,
          location: e.data.location,
          knownAt: e.data.knownAt,
          status: e.data.status,
          statusChangedAt: null,
          sweepCount: e.data.sweepCount,
          flags: flags(e.data.flags),
        },
      };
    case 'level_status':
      return {
        ...head,
        type: 'level.status',
        data: {
          id: id(e.key),
          status: e.data.status,
          price: e.data.price,
          touches: e.data.touches,
          sweepCount: e.data.sweepCount,
          statusChangedAt: e.data.statusChangedAt,
        },
      };
    case 'sweep':
      return {
        ...head,
        type: 'sweep',
        data: {
          id: id(e.key),
          tf: e.tf,
          levelId: id(e.data.level),
          levelType: e.data.levelType,
          groupId: id(e.data.group),
          kind: e.data.kind,
          side: e.data.side,
          levelPrice: e.data.levelPrice,
          extremePrice: e.data.extremePrice,
          penetrationAtr: e.data.penetrationAtr,
          breachAt: e.data.breachCandleTime,
          confirmedAt: e.data.confirmedCandleTime + TF_MS[e.tf],
          notionalBeyondUsd: e.data.notionalBeyondUsd,
          flags: flags(e.data.flags),
        },
      };
    case 'gap_marker':
      return null;
  }
}
