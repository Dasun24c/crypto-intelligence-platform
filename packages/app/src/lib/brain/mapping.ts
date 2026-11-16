import type { ActivityPulse, ActivityPulseKind, ActivitySnapshot } from '@cip/contracts';
import { alarms, type BrainState, PULSE_REGION, type Region, REGIONS } from './state.js';

/**
 * What the scene shows, as deterministic functions of the activity snapshot (architecture §12, ADR
 * 024): the targets, the smoothing towards them, and the pulse envelopes. Nothing here is random, and
 * nothing depends on the frame rate except through the elapsed time it is given.
 */

export interface BrainParams {
  /** Overall brightness, 0–1 (dimmed when disconnected). */
  brightness: number;
  /** Colour saturation, 0–1 (grey when disconnected). */
  saturation: number;
  /** Particle flow speed, 0.05–1 (from the venue message rate). */
  particleSpeed: number;
  /** Share of the quality tier's particles drawn, 0.1–1. */
  particleDensity: number;
  /** Node flashes a second (from the analyses running). */
  firingRate: number;
  /** The idle breathing's depth, 0–1. */
  breathing: number;
  /** Each region's glow, 0–1. */
  glow: Record<Region, number>;
  /** Each region's alarm: 0 none, 0.5 a warning, 1 critical. */
  alarm: Record<Region, number>;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const regions = (f: (r: Region) => number): Record<Region, number> =>
  Object.fromEntries(REGIONS.map((r) => [r, f(r)])) as Record<Region, number>;

/** As designed: clamp(log10(1 + msgsPerSec) / 3, 0.05, 1); 1,000 messages a second is full speed. */
export function particleSpeed(msgsPerSec: number): number {
  return clamp(Math.log10(1 + Math.max(0, msgsPerSec)) / 3, 0.05, 1);
}

export function particleDensity(msgsPerSec: number): number {
  return clamp(Math.log10(1 + Math.max(0, msgsPerSec)) / 3, 0.1, 1);
}

/** Proportional to the analyses running: 0.2 flashes a second at rest, 0.6 more per analysis, at most 5. */
export function firingRate(activeJobs: number): number {
  return Math.min(5, 0.2 + 0.6 * Math.max(0, activeJobs));
}

const BASE_GLOW = 0.15;

/** The brain with nothing happening: what zero activity settles at (criterion 10.2). */
export const IDLE_PARAMS: BrainParams = {
  brightness: 1,
  saturation: 1,
  particleSpeed: 0.05,
  particleDensity: 0.1,
  firingRate: 0.2,
  breathing: 1,
  glow: regions(() => BASE_GLOW),
  alarm: regions(() => 0),
};

/** What the scene should show for this state and snapshot. */
export function targetParams(state: BrainState, snapshot: ActivitySnapshot | null): BrainParams {
  if (state === 'disconnected' || !snapshot)
    return {
      brightness: 0.35,
      saturation: 0,
      particleSpeed: 0.02,
      particleDensity: 0.1,
      firingRate: 0.05,
      breathing: 0.25,
      glow: regions(() => 0.05),
      alarm: regions(() => 0),
    };
  const msgs = snapshot.ingest.msgsPerSec;
  const busy = snapshot.analysis.activeJobs > 0 || snapshot.ai.inflight > 0 || msgs >= 1;
  const glow: Record<Region, number> = {
    ingestion: BASE_GLOW + 0.85 * (msgs >= 1 ? particleSpeed(msgs) : 0),
    analysis:
      BASE_GLOW + 0.85 * clamp(snapshot.analysis.activeJobs / 4 + snapshot.analysis.candlesPerSec / 20, 0, 1),
    ai: BASE_GLOW + 0.85 * (snapshot.ai.inflight > 0 ? 1 : clamp(snapshot.ai.queued / 5, 0, 0.5)),
    alerts: BASE_GLOW + 0.85 * clamp(snapshot.alerts.firedLastMin / 10, 0, 1),
  };
  return {
    brightness: 1,
    saturation: 1,
    particleSpeed: particleSpeed(msgs),
    particleDensity: particleDensity(msgs),
    firingRate: firingRate(snapshot.analysis.activeJobs),
    breathing: busy ? 0.3 : 1,
    glow,
    alarm: alarms(snapshot),
  };
}

/** Time constant of the smoothing towards the targets, in seconds. */
export const SMOOTHING_S = 0.5;

/**
 * One step towards the targets after `dtS` seconds: each value moves by 1 − e^(−dt/τ) of the way, so
 * the result depends on elapsed time only, never on the frame rate.
 */
export function smoothParams(
  current: BrainParams,
  target: BrainParams,
  dtS: number,
  tau = SMOOTHING_S,
): BrainParams {
  const k = 1 - Math.exp(-Math.max(0, dtS) / tau);
  const step = (c: number, t: number) => c + (t - c) * k;
  return {
    brightness: step(current.brightness, target.brightness),
    saturation: step(current.saturation, target.saturation),
    particleSpeed: step(current.particleSpeed, target.particleSpeed),
    particleDensity: step(current.particleDensity, target.particleDensity),
    firingRate: step(current.firingRate, target.firingRate),
    breathing: step(current.breathing, target.breathing),
    glow: regions((r) => step(current.glow[r], target.glow[r])),
    alarm: regions((r) => step(current.alarm[r], target.alarm[r])),
  };
}

/** How long each pulse shows, in milliseconds. */
export const PULSE_MS: Record<ActivityPulseKind, number> = {
  pattern: 1_600,
  sweep: 900,
  mss: 1_200,
  ai_completed: 2_200,
  alert: 1_200,
};
/** At most this many pulses show at once (the newest). */
export const MAX_PULSES = 8;
const ATTACK_MS = 80;

/** A pulse's strength `ageMs` after it arrived: a quick rise, then a fall to nothing at its end. */
export function pulseEnvelope(kind: ActivityPulseKind, ageMs: number): number {
  const length = PULSE_MS[kind];
  if (ageMs < 0 || ageMs >= length) return 0;
  if (ageMs < ATTACK_MS) return ageMs / ATTACK_MS;
  const fall = (ageMs - ATTACK_MS) / (length - ATTACK_MS);
  return (1 - fall) * (1 - fall);
}

/** A completed AI analysis is a wave out of its region; everything else is a local flash. */
export const PULSE_SHAPE: Record<ActivityPulseKind, 'flash' | 'wave'> = {
  pattern: 'flash',
  sweep: 'flash',
  mss: 'flash',
  ai_completed: 'wave',
  alert: 'flash',
};

export interface ShownPulse {
  pulse: ActivityPulse;
  /** Client time it arrived. */
  at: number;
}

export interface LivePulse extends ShownPulse {
  region: Region;
  shape: 'flash' | 'wave';
  strength: number;
}

/** The pulses still showing at `now`, newest first, at most MAX_PULSES. */
export function livePulses(pulses: readonly ShownPulse[], now: number): LivePulse[] {
  const out: LivePulse[] = [];
  for (let i = pulses.length - 1; i >= 0 && out.length < MAX_PULSES; i--) {
    const p = pulses[i]!;
    const strength = pulseEnvelope(p.pulse.kind, now - p.at);
    if (strength > 0)
      out.push({ ...p, region: PULSE_REGION[p.pulse.kind], shape: PULSE_SHAPE[p.pulse.kind], strength });
  }
  return out;
}

/**
 * Which node of its region a pulse starts from: a hash of the event's id, so each detection lights
 * its own place, the same every time (never a random one).
 */
export function pulseAnchor(refId: string, nodes: number): number {
  let h = 2166136261;
  for (let i = 0; i < refId.length; i++) {
    h ^= refId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return nodes > 0 ? (h >>> 0) % nodes : 0;
}
