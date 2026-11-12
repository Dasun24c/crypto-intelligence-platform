import {
  SETUP_DISCLAIMER,
  SETUP_LABELS,
  type SetupSummary,
  type SetupTransitionMessage,
  type SmcEventMessage,
} from '@cip/contracts';
import type { NewDetectionEvent } from '@cip/db';
import { TF_MS } from '@cip/domain';
import { type SetupTransitionData, type SmcEvent, storedPayload, type TargetRef } from '@cip/smc-engine';
import { entityId } from './ids.js';

type SetupEvent = Extract<SmcEvent, { type: 'setup_transition' }>;

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

/** A zone's state after its latest change in a batch (each `zone_status` event carries all of it). */
export interface ZoneChange {
  status: string;
  fill_pct: number;
  first_touch_at: Date | null;
  status_changed_at: Date | null;
}

/** The projection writes for a batch of new events, in an order that keeps foreign keys valid. */
export interface Projection {
  swings: Record<string, unknown>[];
  structure: Record<string, unknown>[];
  ranges: Record<string, unknown>[];
  levels: Record<string, unknown>[];
  sweeps: Record<string, unknown>[];
  zones: Record<string, unknown>[];
  rangeEnds: Map<string, { ended_at: Date; end_reason: string }>;
  levelChanges: Map<string, LevelChange>;
  zoneChanges: Map<string, ZoneChange>;
  /** [zone id, the zone it links to]: the linked zone links back unless it already links elsewhere. */
  zoneLinks: [string, string][];
  /** Setups after their latest transition in the batch, by id; every transition; the checklist per state. */
  setups: Map<string, Record<string, unknown>>;
  setupTransitions: Record<string, unknown>[];
  setupChecklist: Map<string, Record<string, unknown>>;
  setupOutcomes: Map<string, Record<string, unknown>>;
}

/** A setup's references (sweeps, MSS, range, POI, levels) by projection id. */
export function setupRefs(d: SetupTransitionData, id: (key: string) => string) {
  return {
    sweeps: d.refs.sweeps.map(id),
    mss: d.refs.mss
      ? {
          anchorId: id(d.refs.mss.anchor),
          anchorPrice: d.refs.mss.anchorPrice,
          breakCandleTime: d.refs.mss.breakCandleTime,
          displacement: d.refs.mss.displacement,
          structureEventId: d.refs.mss.structureEvent === null ? null : id(d.refs.mss.structureEvent),
        }
      : null,
    rangeId: d.refs.range === null ? null : id(d.refs.range),
    poiId: d.refs.poi === null ? null : id(d.refs.poi),
    levelIds: d.refs.levels.map(id),
  };
}

const targetRef = (t: TargetRef | null, id: (key: string) => string) =>
  t ? { kind: t.kind, id: id(t.key), price: t.price } : null;

export function project(info: RunInfo, events: readonly SmcEvent[], now: number): Projection {
  const p: Projection = {
    swings: [],
    structure: [],
    ranges: [],
    levels: [],
    sweeps: [],
    zones: [],
    rangeEnds: new Map(),
    levelChanges: new Map(),
    zoneChanges: new Map(),
    zoneLinks: [],
    setups: new Map(),
    setupTransitions: [],
    setupChecklist: new Map(),
    setupOutcomes: new Map(),
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
      case 'zone_created':
        p.zones.push({
          ...base(e),
          timeframe: e.tf,
          type: e.data.type,
          direction: e.data.direction,
          top: e.data.top,
          bottom: e.data.bottom,
          origin_from: new Date(e.data.originFrom),
          origin_to: new Date(e.data.originTo),
          known_at: new Date(e.data.knownAt),
          htf: e.data.htf,
          location: e.data.location,
          structure_event_id: e.data.structureEvent === null ? null : id(e.data.structureEvent),
          linked_zone_id: e.data.linkedZone === null ? null : id(e.data.linkedZone),
          swept_liquidity_at_origin: e.data.sweptLiquidityAtOrigin,
          status: e.data.status,
          fill_pct: e.data.fillPct,
          flags: flags(e.data.flags),
        });
        if (e.data.linkedZone !== null) p.zoneLinks.push([id(e.key), id(e.data.linkedZone)]);
        break;
      case 'zone_status':
        p.zoneChanges.set(id(e.key), {
          status: e.data.status,
          fill_pct: e.data.fillPct,
          first_touch_at: e.data.firstTouchAt === null ? null : new Date(e.data.firstTouchAt),
          status_changed_at: e.data.statusChangedAt === null ? null : new Date(e.data.statusChangedAt),
        });
        break;
      case 'setup_transition': {
        // Each transition carries the whole setup: the latest one in the batch is its row.
        const d = e.data;
        const sid = id(e.key);
        p.setups.set(sid, {
          ...base(e),
          pattern: d.pattern,
          variant: d.variant,
          direction: d.direction,
          context_tf: d.contextTf,
          setup_tf: d.setupTf,
          state: d.to,
          resolution: d.resolution,
          entry_zone_id: d.entryZone === null ? null : id(d.entryZone),
          entry_price: d.levels.entry,
          invalidation_price: d.levels.invalidation,
          target1_price: d.levels.target1,
          target2_price: d.levels.target2,
          target1_ref: JSON.stringify(targetRef(d.targets.target1, id)),
          target2_ref: JSON.stringify(targetRef(d.targets.target2, id)),
          rr_target1: d.levels.rr,
          confluence_score: d.score,
          mandatory_passed: d.mandatoryPassed,
          quality_flags: [...d.qualityFlags],
          flags: runFlags(info, e, now),
          refs: JSON.stringify(setupRefs(d, id)),
          created_candle_time: new Date(d.createdAt),
          updated_candle_time: new Date(e.time),
          resolved_candle_time: d.to === 'resolved' ? new Date(e.time) : null,
        });
        p.setupTransitions.push({
          setup_id: sid,
          event_seq: e.seq,
          from_state: d.from,
          to_state: d.to,
          candle_time: new Date(e.time - TF_MS[d.setupTf]),
          decided_at: new Date(e.time),
          processed_at: new Date(now),
          reason: d.reason,
          evidence: JSON.stringify(d.evidence),
        });
        for (const c of d.checklist)
          p.setupChecklist.set(`${sid}|${d.to}|${c.item}`, {
            setup_id: sid,
            state: d.to,
            item: c.item,
            credit: c.credit,
            weight: c.weight,
            mandatory: c.mandatory,
            evidence: JSON.stringify(c.evidence),
          });
        if (d.outcome)
          p.setupOutcomes.set(sid, {
            setup_id: sid,
            entry_touched_at: d.outcome.entryTouchedAt === null ? null : new Date(d.outcome.entryTouchedAt),
            resolved_at: new Date(d.outcome.resolvedAt),
            result: d.outcome.result,
            mfe_r: d.outcome.mfeR,
            mae_r: d.outcome.maeR,
            bars_held: d.outcome.barsHeld,
            resolved_with_tf: d.outcome.resolvedWithTf,
          });
        break;
      }
      case 'gap_marker':
        break;
    }
  }
  return p;
}

/** A setup as lists and channels carry it, after transition `e`. */
export function setupSummary(info: RunInfo, e: SetupEvent, now: number): SetupSummary {
  const d = e.data;
  return {
    id: entityId(info.runId, e.key),
    instrumentId: info.instrumentId,
    runId: info.runId,
    pattern: d.pattern,
    variant: d.variant,
    direction: d.direction,
    contextTf: d.contextTf,
    setupTf: d.setupTf,
    state: d.to,
    resolution: d.resolution,
    displayLabel: SETUP_LABELS[d.to],
    levels: { ...d.levels },
    score: d.score,
    mandatoryPassed: d.mandatoryPassed,
    qualityFlags: [...d.qualityFlags],
    flags: runFlags(info, e, now),
    createdAt: d.createdAt,
    updatedAt: e.time,
    resolvedAt: d.to === 'resolved' ? e.time : null,
    disclaimer: SETUP_DISCLAIMER,
  };
}

/** The `setup.transition` message for the `setups` channels (API contracts §5.3). */
export function toSetupMessage(info: RunInfo, e: SmcEvent, now: number): SetupTransitionMessage | null {
  if (e.type !== 'setup_transition') return null;
  const d = e.data;
  return {
    ...setupSummary(info, e, now),
    transition: {
      from: d.from,
      to: d.to,
      reason: d.reason,
      candleTime: e.time - TF_MS[d.setupTf],
      decidedAt: e.time,
      processedAt: now,
      late: info.live && now - e.time > LATE_MS,
      evidence: d.evidence,
    },
  };
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
    case 'zone_created':
      return {
        ...head,
        type: 'zone.created',
        data: {
          id: id(e.key),
          tf: e.tf,
          type: e.data.type,
          direction: e.data.direction,
          top: e.data.top,
          bottom: e.data.bottom,
          originFrom: e.data.originFrom,
          originTo: e.data.originTo,
          knownAt: e.data.knownAt,
          htf: e.data.htf,
          location: e.data.location,
          status: e.data.status,
          fillPct: e.data.fillPct,
          firstTouchAt: null,
          statusChangedAt: null,
          structureEventId: e.data.structureEvent === null ? null : id(e.data.structureEvent),
          linkedZoneId: e.data.linkedZone === null ? null : id(e.data.linkedZone),
          sweptLiquidityAtOrigin: e.data.sweptLiquidityAtOrigin,
          flags: flags(e.data.flags),
        },
      };
    case 'zone_status':
      return {
        ...head,
        type: 'zone.status',
        data: {
          id: id(e.key),
          status: e.data.status,
          fillPct: e.data.fillPct,
          firstTouchAt: e.data.firstTouchAt,
          statusChangedAt: e.data.statusChangedAt,
        },
      };
    // Setups go to the `setups` channels instead (toSetupMessage); gap markers are not published.
    case 'setup_transition':
    case 'gap_marker':
      return null;
  }
}
