import type {
  AiTriggerRef,
  IndicatorsClosedEvent,
  SetupTransitionMessage,
  SmcEventMessage,
  StructureEvent,
  Sweep,
  Tf,
} from '@cip/contracts';

/** Architecture §8: a call at a window score of 100; 60 s windows; a 15 min cooldown; a 4-hourly digest. */
export const TRIGGER_THRESHOLD = 100;
export const TRIGGER_WINDOW_MS = 60_000;
export const TRIGGER_COOLDOWN_MS = 15 * 60_000;
export const DIGEST_EVERY_MS = 4 * 3_600_000;
export const DIGEST_SCORE = 30;
/** An on-demand request counts as a significant event for the budget's throttle. */
export const ON_DEMAND_SCORE = 100;
export const VOLUME_Z_TRIGGER = 3;
const DAY_WEEK_LEVELS = new Set(['pdh', 'pdl', 'pwh', 'pwl']);
const HOUR = 3_600_000;

/** An `an:events` entry as the trigger follower reads it. */
export type AnalysisEventEntry =
  | { type: 'setup'; data: SetupTransitionMessage }
  | { type: 'smc'; data: SmcEventMessage }
  | { type: 'indicators.closed'; data: IndicatorsClosedEvent };

export interface ScoredEvent {
  instrumentId: string;
  ref: AiTriggerRef;
  /** A setup confirmation is analysed even during the instrument's cooldown. */
  bypassCooldown: boolean;
}

/**
 * The event's significance (architecture §8, ADR 023), or null when it scores nothing: a setup
 * confirmed 100, an MSS on a context timeframe 70, a setup resolved 60, a sweep of a previous day
 * or week level 50, a 1h volume anomaly (|z| ≥ 3) 50.
 */
export function scoreEvent(
  e: AnalysisEventEntry,
  contextTfs: (instrumentId: string) => readonly Tf[],
): ScoredEvent | null {
  if (e.type === 'setup') {
    const to = e.data.transition.to;
    if (to !== 'confirmed' && to !== 'resolved') return null;
    return {
      instrumentId: e.data.instrumentId,
      ref: {
        kind: to === 'confirmed' ? 'setup.confirmed' : 'setup.resolved',
        id: e.data.id,
        score: to === 'confirmed' ? 100 : 60,
        at: e.data.transition.decidedAt,
      },
      bypassCooldown: to === 'confirmed',
    };
  }
  if (e.type === 'smc') {
    const m = e.data;
    if (m.type === 'structure') {
      const s = m.data as StructureEvent;
      if (s.type !== 'mss' || !contextTfs(m.instrumentId).includes(s.tf)) return null;
      return {
        instrumentId: m.instrumentId,
        ref: { kind: 'structure.mss', id: s.id, score: 70, at: m.time },
        bypassCooldown: false,
      };
    }
    if (m.type === 'sweep') {
      const s = m.data as Sweep;
      if (!DAY_WEEK_LEVELS.has(s.levelType)) return null;
      return {
        instrumentId: m.instrumentId,
        ref: { kind: 'sweep', id: s.id, score: 50, at: m.time },
        bypassCooldown: false,
      };
    }
    return null;
  }
  const p = e.data.point;
  if (e.data.tf !== '1h' || p.warmup || p.volumeZ === null || Math.abs(p.volumeZ) < VOLUME_Z_TRIGGER)
    return null;
  return {
    instrumentId: e.data.instrumentId,
    ref: { kind: 'volume.anomaly', id: `${e.data.instrumentId}:1h:${p.t}`, score: 50, at: p.t + HOUR },
    bypassCooldown: false,
  };
}

/** A window that scored enough: one `event` analysis. */
export interface DueTrigger {
  instrumentId: string;
  windowStart: number;
  score: number;
  refs: AiTriggerRef[];
}

interface Window {
  start: number;
  refs: AiTriggerRef[];
}

/**
 * Per-instrument aggregation (architecture §8): the first scored event opens a 60 s window; when it
 * closes, a score of 100 or more makes one call, and the instrument cools down for 15 min, during
 * which only a setup confirmation opens a window. Pure: the follower feeds it and keeps the
 * cooldowns in Redis.
 */
export class TriggerAggregator {
  private readonly windows = new Map<string, Window>();
  private readonly cooldownUntil = new Map<string, number>();

  constructor(
    private readonly o: { windowMs: number; threshold: number; cooldownMs: number } = {
      windowMs: TRIGGER_WINDOW_MS,
      threshold: TRIGGER_THRESHOLD,
      cooldownMs: TRIGGER_COOLDOWN_MS,
    },
  ) {}

  /** A cooldown known from before (a takeover). */
  coolDown(instrumentId: string, until: number): void {
    this.cooldownUntil.set(instrumentId, Math.max(until, this.cooldownUntil.get(instrumentId) ?? 0));
  }

  cooling(instrumentId: string, now: number): boolean {
    return (this.cooldownUntil.get(instrumentId) ?? 0) > now;
  }

  /** Adds a scored event: `opened` a window, `joined` one, or dropped while `cooling` down. */
  add(e: ScoredEvent, now: number): 'opened' | 'joined' | 'cooling' {
    const open = this.windows.get(e.instrumentId);
    if (open) {
      if (!open.refs.some((r) => r.kind === e.ref.kind && r.id === e.ref.id)) open.refs.push(e.ref);
      return 'joined';
    }
    if (!e.bypassCooldown && this.cooling(e.instrumentId, now)) return 'cooling';
    this.windows.set(e.instrumentId, { start: now, refs: [e.ref] });
    return 'opened';
  }

  /** The windows that closed by `now` and scored enough; the instrument then cools down. */
  due(now: number): DueTrigger[] {
    const out: DueTrigger[] = [];
    for (const [instrumentId, w] of [...this.windows].sort(
      (a, b) => a[1].start - b[1].start || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    )) {
      if (now < w.start + this.o.windowMs) continue;
      this.windows.delete(instrumentId);
      const score = w.refs.reduce((s, r) => s + r.score, 0);
      if (score < this.o.threshold) continue;
      out.push({ instrumentId, windowStart: w.start, score, refs: w.refs });
      this.cooldownUntil.set(instrumentId, now + this.o.cooldownMs);
    }
    return out;
  }

  /** Whether the instrument has a window open (the follower holds its stream cursor before it). */
  isOpen(instrumentId: string): boolean {
    return this.windows.has(instrumentId);
  }

  get openWindows(): number {
    return this.windows.size;
  }
}

/** The 4-hourly digest slot `at` falls in (00:00, 04:00 … 20:00 UTC). */
export function digestSlot(at: number): number {
  return Math.floor(at / DIGEST_EVERY_MS) * DIGEST_EVERY_MS;
}

/**
 * Deterministic job ids: a follower that reads an event again cannot queue a call twice. Dots, not
 * colons: BullMQ refuses custom ids with colons (it allows three parts for now, for old repeatable jobs).
 */
export const eventJobId = (instrumentId: string, windowStart: number) =>
  `event.${instrumentId}.${windowStart}`;
export const digestJobId = (instrumentId: string, slot: number) => `digest.${instrumentId}.${slot}`;
