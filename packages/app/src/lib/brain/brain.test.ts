import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ActivityPulse, type ActivitySnapshot, emptyActivitySnapshot } from '@cip/contracts';
import { buildLayout, regionAt, seeded } from './layout.js';
import {
  firingRate,
  IDLE_PARAMS,
  livePulses,
  MAX_PULSES,
  particleDensity,
  particleSpeed,
  pulseAnchor,
  pulseEnvelope,
  type ShownPulse,
  smoothParams,
  targetParams,
} from './mapping.js';
import { frameloopFor, QualityController } from './quality.js';
import {
  alarms,
  type BrainInput,
  brainState,
  describeError,
  describePulse,
  formatRate,
  regionsOf,
  STATE_LABEL,
  stateReason,
} from './state.js';

const T = Date.UTC(2026, 10, 16, 12, 0);

/** A snapshot with what a test sets on top of nothing happening. */
function snap(
  over: {
    msgs?: number;
    activeJobs?: number;
    candles?: number;
    inflight?: number;
    queued?: number;
    fired?: number;
    errors?: ActivitySnapshot['errors'];
  } = {},
): ActivitySnapshot {
  const s = emptyActivitySnapshot(T);
  return {
    ...s,
    ingest: { msgsPerSec: over.msgs ?? 0, perVenue: { binance: over.msgs ?? 0 }, state: 'ok' },
    analysis: { ...s.analysis, activeJobs: over.activeJobs ?? 0, candlesPerSec: over.candles ?? 0 },
    ai: { ...s.ai, inflight: over.inflight ?? 0, queued: over.queued ?? 0 },
    alerts: { firedLastMin: over.fired ?? 0 },
    errors: over.errors ?? [],
  };
}
const input = (snapshot: ActivitySnapshot | null, o: Partial<BrainInput> = {}): BrainInput => ({
  snapshot,
  receivedAt: T,
  live: true,
  now: T + 100,
  ...o,
});

afterEach(() => vi.restoreAllMocks());

describe('criterion 10.1: injected activity drives the expected states', () => {
  it('goes idle → receiving → analysing → completion → pattern pulse → error → disconnected', () => {
    const pulses: ShownPulse[] = [];
    const seen: string[] = [];
    const step = (snapshot: ActivitySnapshot | null, o: Partial<BrainInput> = {}) => {
      const i = input(snapshot, o);
      const state = brainState(i);
      const live = livePulses(pulses, i.now);
      seen.push([state, ...live.map((p) => `${p.shape}:${p.region}`)].join(' + '));
    };
    step(snap());
    step(snap({ msgs: 240 }));
    step(snap({ msgs: 240, activeJobs: 2 }));
    // An AI analysis completed: a wave out of the AI region over the current state.
    pulses.push({ pulse: { ts: T, kind: 'ai_completed', refId: 'a1' }, at: T });
    step(snap({ msgs: 240 }), { now: T + 300 });
    // A setup changed: a flash in the analysis region (the wave is still fading).
    pulses.push({ pulse: { ts: T, kind: 'pattern', refId: 's1', instrumentId: 'i' }, at: T + 1_000 });
    step(snap({ msgs: 240 }), { now: T + 1_100 });
    step(
      snap({ msgs: 240, errors: [{ component: 'ingestor', severity: 'critical', detail: 'no instance' }] }),
      {
        receivedAt: T + 4_900,
        now: T + 5_000,
      },
    );
    // No snapshot for 3 s after the last one.
    step(snap({ msgs: 240 }), { receivedAt: T + 4_900, now: T + 4_900 + 3_001 });
    expect(seen).toEqual([
      'idle',
      'receiving',
      'analysing',
      'receiving + wave:ai',
      'receiving + flash:analysis + wave:ai',
      'error',
      'disconnected',
    ]);
  });

  it('is disconnected with the connection down, before the first snapshot, or after 3 s without one', () => {
    expect(brainState(input(snap({ msgs: 10 }), { live: false }))).toBe('disconnected');
    expect(brainState(input(null))).toBe('disconnected');
    expect(brainState(input(snap({ msgs: 10 }), { receivedAt: null }))).toBe('disconnected');
    expect(brainState(input(snap({ msgs: 10 }), { now: T + 3_000 }))).toBe('receiving');
    expect(brainState(input(snap({ msgs: 10 }), { now: T + 3_001 }))).toBe('disconnected');
    // An AI call alone is analysing; a warning is not an error; below one message a second is idle.
    expect(brainState(input(snap({ inflight: 1 })))).toBe('analysing');
    expect(brainState(input(snap({ errors: [{ component: 'analyzer', severity: 'warning' }] })))).toBe(
      'idle',
    );
    expect(brainState(input(snap({ msgs: 0.9 })))).toBe('idle');
  });

  it('says why in words, names the component in error, and places problems in their regions', () => {
    expect(STATE_LABEL.receiving).toBe('Receiving data');
    expect(stateReason('receiving', input(snap({ msgs: 1234.6 })))).toBe('1,235 venue messages a second.');
    expect(stateReason('receiving', input(snap({ msgs: 12.34 })))).toBe('12.3 venue messages a second.');
    expect(stateReason('analysing', input(snap({ activeJobs: 1, inflight: 2 })))).toBe(
      '1 instrument analysing; 2 AI calls in progress.',
    );
    expect(stateReason('analysing', input(snap({ activeJobs: 3 })))).toBe('3 instruments analysing.');
    expect(stateReason('idle', input(snap()))).toBe('No venue messages, analysis or AI calls right now.');
    expect(stateReason('disconnected', input(null, { live: false }))).toBe('The live connection is down.');
    expect(stateReason('disconnected', input(null))).toBe('Waiting for the first activity report.');
    expect(stateReason('disconnected', input(snap()))).toBe('No activity report for 3 seconds.');
    const failing = snap({
      errors: [
        { component: 'database', severity: 'critical', detail: 'connection refused' },
        { component: 'jobs', severity: 'critical' },
        { component: 'analyzer', severity: 'warning', detail: 'paused on a gap' },
      ],
    });
    expect(stateReason('error', input(failing))).toBe(
      'The database: connection refused. The jobs service: down.',
    );
    expect(alarms(failing)).toEqual({ ingestion: 1, analysis: 1, ai: 1, alerts: 1 });
    expect(alarms(snap({ errors: [{ component: 'analyzer', severity: 'warning' }] }))).toEqual({
      ingestion: 0,
      analysis: 0.5,
      ai: 0,
      alerts: 0.5,
    });
    expect(regionsOf('ingestor')).toEqual(['ingestion']);
    expect(regionsOf('jobs')).toEqual(['ai', 'alerts']);
    expect(describeError({ component: 'analyzer', severity: 'warning' })).toBe('The analyzer: degraded');
    expect(describeError({ component: 'x', severity: 'critical' })).toBe('x (critical): down');
    const pulse: ActivityPulse = { ts: T, kind: 'sweep', refId: 'r', instrumentId: 'btc' };
    expect(describePulse(pulse, () => 'Binance BTC/USDT')).toBe('Sweep on Binance BTC/USDT');
    expect(describePulse({ ts: T, kind: 'alert', refId: '1-0' }, () => null)).toBe('Alert fired');
    expect(formatRate(0.25)).toBe('0.3');
  });
});

describe('criterion 10.2: deterministic mappings that settle at idle', () => {
  it('maps the message rate and the analyses running as designed', () => {
    expect(particleSpeed(0)).toBe(0.05);
    expect(particleSpeed(999)).toBeCloseTo(1, 6);
    expect(particleSpeed(1e6)).toBe(1);
    expect(particleSpeed(99)).toBeCloseTo(2 / 3, 6);
    expect(particleDensity(0)).toBe(0.1);
    expect(particleDensity(-5)).toBe(0.1);
    expect(firingRate(0)).toBe(0.2);
    expect(firingRate(2)).toBeCloseTo(1.4, 9);
    expect(firingRate(100)).toBe(5);
    // Proportional: each analysis running adds the same.
    expect(firingRate(3) - firingRate(2)).toBeCloseTo(firingRate(2) - firingRate(1), 9);
  });

  it('with zero activity settles at the idle parameters, whatever it started from', () => {
    const idle = targetParams(brainState(input(snap())), snap());
    expect(idle).toEqual(IDLE_PARAMS);
    for (const start of [
      targetParams('analysing', snap({ msgs: 5_000, activeJobs: 6, inflight: 1, fired: 30 })),
      targetParams('disconnected', null),
      targetParams('error', snap({ errors: [{ component: 'api', severity: 'critical' }] })),
    ]) {
      let p = start;
      // Ten seconds at 60 frames a second, then at an uneven 23 frames a second: the same place.
      for (let i = 0; i < 600; i++) p = smoothParams(p, idle, 1 / 60);
      let q = start;
      for (let i = 0; i < 230; i++) q = smoothParams(q, idle, 1 / 23);
      for (const [a, b] of [
        [p.brightness, IDLE_PARAMS.brightness],
        [p.particleSpeed, IDLE_PARAMS.particleSpeed],
        [p.firingRate, IDLE_PARAMS.firingRate],
        [p.breathing, IDLE_PARAMS.breathing],
        [p.glow.ai, IDLE_PARAMS.glow.ai],
        [p.alarm.analysis, 0],
        [q.particleDensity, IDLE_PARAMS.particleDensity],
        [q.saturation, IDLE_PARAMS.saturation],
      ] as const)
        expect(Math.abs(a - b)).toBeLessThan(1e-6);
    }
  });

  it('never calls a random number generator for a state, a rate, a pulse or the quality', () => {
    const random = vi.spyOn(Math, 'random');
    const s = snap({ msgs: 300, activeJobs: 1, inflight: 1, fired: 4 });
    const a = targetParams(brainState(input(s)), s);
    const b = targetParams(brainState(input(s)), s);
    expect(a).toEqual(b);
    expect(smoothParams(IDLE_PARAMS, a, 0.016)).toEqual(smoothParams(IDLE_PARAMS, b, 0.016));
    expect(pulseEnvelope('pattern', 400)).toBe(pulseEnvelope('pattern', 400));
    expect(pulseAnchor('setup-1', 400)).toBe(pulseAnchor('setup-1', 400));
    const q = new QualityController('auto');
    for (let i = 1; i <= 200; i++) q.frame(16, T + i * 16);
    buildLayout(7, 50, 100);
    expect(random).not.toHaveBeenCalled();
  });

  it('shows each pulse with a quick rise and a fall to nothing, at most eight at once, newest first', () => {
    expect(pulseEnvelope('pattern', -1)).toBe(0);
    expect(pulseEnvelope('pattern', 40)).toBeCloseTo(0.5, 9);
    expect(pulseEnvelope('pattern', 80)).toBe(1);
    expect(pulseEnvelope('pattern', 1_600)).toBe(0);
    expect(pulseEnvelope('ai_completed', 2_000)).toBeGreaterThan(0);
    const many: ShownPulse[] = Array.from({ length: 12 }, (_, i) => ({
      pulse: { ts: T, kind: 'sweep', refId: `r${i}` },
      at: T + i,
    }));
    const live = livePulses(many, T + 20);
    expect(live).toHaveLength(MAX_PULSES);
    expect(live[0]!.pulse.refId).toBe('r11');
    expect(livePulses(many, T + 5_000)).toEqual([]);
    expect(pulseAnchor('anything', 0)).toBe(0);
    expect(pulseAnchor('setup-1', 10)).toBeLessThan(10);
  });
});

describe('adaptive quality (criterion 10.3) and when it draws (10.4)', () => {
  it('drops a tier below 45 fps, and rises again after 10 s above 57 fps, on Auto only', () => {
    const q = new QualityController('auto');
    expect(q.tier).toBe('high');
    let now = T;
    const run = (ms: number, dt: number) => {
      for (const end = now + ms; now < end;) {
        now += dt;
        q.frame(dt, now);
      }
    };
    run(2_100, 16.7);
    expect(q.fps).toBeGreaterThan(59);
    expect(q.tier).toBe('high');
    run(2_100, 25); // 40 fps
    expect(q.tier).toBe('medium');
    run(2_100, 25);
    expect(q.tier).toBe('low');
    run(2_100, 25);
    expect(q.tier).toBe('low');
    run(9_000, 16.7);
    expect(q.tier).toBe('low');
    run(3_500, 16.7);
    expect(q.tier).toBe('medium');
    // A pause (a hidden tab) is not slowness.
    q.frame(5_000, (now += 5_000));
    expect(q.tier).toBe('medium');
    expect(q.frames).toBeGreaterThan(0);

    const fixed = new QualityController('medium');
    for (let i = 1; i <= 300; i++) fixed.frame(40, T + i * 40);
    expect(fixed.tier).toBe('medium');
    expect(fixed.fps).toBeCloseTo(25, 6);
  });

  it('draws nothing while hidden, off screen or paused, and one frame per change with reduced motion', () => {
    const base = { hidden: false, offscreen: false, paused: false, reducedMotion: false };
    expect(frameloopFor(base)).toBe('always');
    expect(frameloopFor({ ...base, hidden: true })).toBe('never');
    expect(frameloopFor({ ...base, offscreen: true })).toBe('never');
    expect(frameloopFor({ ...base, paused: true, reducedMotion: true })).toBe('never');
    expect(frameloopFor({ ...base, reducedMotion: true })).toBe('demand');
  });
});

describe('the seeded layout', () => {
  it('is the same for the same seed, fills every region, and links near nodes', () => {
    const a = buildLayout(42, 400, 500);
    const b = buildLayout(42, 400, 500);
    expect(a.positions).toEqual(b.positions);
    expect(a.particleC).toEqual(b.particleC);
    expect(buildLayout(43, 400, 500).positions).not.toEqual(a.positions);
    for (const r of ['ingestion', 'analysis', 'ai', 'alerts'] as const)
      expect(a.byRegion[r].length).toBeGreaterThan(10);
    expect(a.links.length).toBeGreaterThan(400);
    expect(a.links.length % 2).toBe(0);
    for (let p = 0; p < 500; p++) {
      expect(a.particleOffset[p]).toBeGreaterThanOrEqual(0);
      expect(a.particleRate[p]).toBeGreaterThanOrEqual(0.6);
      expect(a.particleRate[p]).toBeLessThanOrEqual(1.4);
    }
    expect(regionAt(0, -0.9)).toBe('ingestion');
    expect(regionAt(0, 0.9)).toBe('ai');
    expect(regionAt(-0.5, 0)).toBe('alerts');
    expect(regionAt(0.3, 0)).toBe('analysis');
    const r = seeded(1);
    const first = [r(), r(), r()];
    const again = seeded(1);
    expect([again(), again(), again()]).toEqual(first);
  });
});
