import {
  ACTIVITY_SILENT_MS,
  type ActivityError,
  type ActivityPulse,
  type ActivityPulseKind,
  type ActivitySnapshot,
} from '@cip/contracts';

/**
 * The 3D brain's state (Phase 10, architecture §12, ADR 024): a pure function of the latest activity
 * snapshot, when it arrived and whether the live connection is up. Nothing here is random.
 */

export const BRAIN_STATES = ['disconnected', 'error', 'analysing', 'receiving', 'idle'] as const;
export type BrainState = (typeof BRAIN_STATES)[number];

export const REGIONS = ['ingestion', 'analysis', 'ai', 'alerts'] as const;
export type Region = (typeof REGIONS)[number];

export const REGION_LABEL: Record<Region, string> = {
  ingestion: 'Ingestion',
  analysis: 'Analysis',
  ai: 'AI',
  alerts: 'Alerts',
};

/** Each region's colour in the scene and its legend (always with the region's name beside it). */
export const REGION_COLOUR: Record<Region, string> = {
  ingestion: '#38bdf8',
  analysis: '#a78bfa',
  ai: '#f472b6',
  alerts: '#34d399',
};

export const STATE_LABEL: Record<BrainState, string> = {
  disconnected: 'Disconnected',
  error: 'Error',
  analysing: 'Analysing',
  receiving: 'Receiving data',
  idle: 'Idle',
};

/** Venue messages a second at or above which the brain is receiving: the idle threshold (C8). */
export const RECEIVING_MIN_MSGS = 1;

export interface BrainInput {
  snapshot: ActivitySnapshot | null;
  /** Client time the latest snapshot arrived; null before the first. */
  receivedAt: number | null;
  /** Whether the live connection is up. */
  live: boolean;
  now: number;
}

/** The state, first that holds (architecture §12). */
export function brainState({ snapshot, receivedAt, live, now }: BrainInput): BrainState {
  if (!live || !snapshot || receivedAt === null || now - receivedAt > ACTIVITY_SILENT_MS)
    return 'disconnected';
  if (snapshot.errors.some((e) => e.severity === 'critical')) return 'error';
  if (snapshot.analysis.activeJobs > 0 || snapshot.ai.inflight > 0) return 'analysing';
  if (snapshot.ingest.msgsPerSec >= RECEIVING_MIN_MSGS) return 'receiving';
  return 'idle';
}

/**
 * The regions a component's problem shows in: the ingestor's in ingestion; the analyzer's in
 * analysis and alerts (it evaluates the alert rules); the jobs service's in AI and alerts (it calls
 * the AI and delivers notifications); anything else (the api, the database, Redis, the broker) in all.
 */
export function regionsOf(component: string): readonly Region[] {
  switch (component) {
    case 'ingestor':
      return ['ingestion'];
    case 'analyzer':
      return ['analysis', 'alerts'];
    case 'jobs':
      return ['ai', 'alerts'];
    default:
      return REGIONS;
  }
}

export const COMPONENT_LABEL: Record<string, string> = {
  database: 'The database',
  redis: 'Redis',
  api: 'The api',
  ingestor: 'The ingestor',
  analyzer: 'The analyzer',
  jobs: 'The jobs service',
  broker: 'The practice broker',
};

const componentName = (c: string) => COMPONENT_LABEL[c] ?? c;
const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;

export function formatRate(n: number): string {
  return n >= 100
    ? Math.round(n).toLocaleString('en-GB')
    : n.toLocaleString('en-GB', { maximumFractionDigits: 1 });
}

/** Why the brain is in its state, in one sentence (the text status, NFR-10). */
export function stateReason(state: BrainState, input: BrainInput): string {
  const s = input.snapshot;
  switch (state) {
    case 'disconnected':
      return !input.live
        ? 'The live connection is down.'
        : !s
          ? 'Waiting for the first activity report.'
          : 'No activity report for 3 seconds.';
    case 'error':
      return (s?.errors ?? [])
        .filter((e) => e.severity === 'critical')
        .map((e) => `${componentName(e.component)}: ${e.detail ?? 'down'}.`)
        .join(' ');
    case 'analysing': {
      const parts: string[] = [];
      if (s && s.analysis.activeJobs > 0)
        parts.push(plural(s.analysis.activeJobs, 'instrument analysing', 'instruments analysing'));
      if (s && s.ai.inflight > 0)
        parts.push(plural(s.ai.inflight, 'AI call in progress', 'AI calls in progress'));
      return `${parts.join('; ')}.`;
    }
    case 'receiving':
      return `${formatRate(s?.ingest.msgsPerSec ?? 0)} venue messages a second.`;
    case 'idle':
      return 'No venue messages, analysis or AI calls right now.';
  }
}

/** Warnings and critical problems, by the regions they show in. */
export function alarms(snapshot: ActivitySnapshot | null): Record<Region, 0 | 0.5 | 1> {
  const out: Record<Region, 0 | 0.5 | 1> = { ingestion: 0, analysis: 0, ai: 0, alerts: 0 };
  for (const e of snapshot?.errors ?? []) {
    const level = e.severity === 'critical' ? 1 : 0.5;
    for (const r of regionsOf(e.component)) if (level > out[r]) out[r] = level;
  }
  return out;
}

export function describeError(e: ActivityError): string {
  return `${componentName(e.component)}${e.severity === 'critical' ? ' (critical)' : ''}: ${e.detail ?? (e.severity === 'critical' ? 'down' : 'degraded')}`;
}

/** Where each pulse shows: detections in analysis, a completed AI analysis in AI, an alert in alerts. */
export const PULSE_REGION: Record<ActivityPulseKind, Region> = {
  pattern: 'analysis',
  sweep: 'analysis',
  mss: 'analysis',
  ai_completed: 'ai',
  alert: 'alerts',
};

export const PULSE_LABEL: Record<ActivityPulseKind, string> = {
  pattern: 'Setup change',
  sweep: 'Sweep',
  mss: 'Market structure shift',
  ai_completed: 'AI analysis completed',
  alert: 'Alert fired',
};

/** A pulse as the text status lists it. */
export function describePulse(p: ActivityPulse, instrumentName: (id: string) => string | null): string {
  const name = p.instrumentId ? instrumentName(p.instrumentId) : null;
  return name ? `${PULSE_LABEL[p.kind]} on ${name}` : PULSE_LABEL[p.kind];
}
