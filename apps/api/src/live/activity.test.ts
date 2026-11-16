import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_PULSES_PER_SEC,
  type ActivityReport,
  ActivitySnapshotSchema,
  type SystemHealth,
  type VenueLinkState,
} from '@cip/contracts';
import { ActivityAggregator, aiOutcomeOf, aiResultOf, errorsOf, PulseLimiter, pulseOf } from './activity.js';

const T = Date.UTC(2026, 10, 16, 12, 0);
const ID = '019a7500-0000-7000-8000-000000000001';
const entry = (type: string, data: unknown) => ['type', type, 'data', JSON.stringify(data)];

const ingest = (
  instance: string,
  at: number,
  msgs: Record<string, number>,
  venues: Record<string, VenueLinkState>,
): ActivityReport => ({
  service: 'ingestor',
  instance,
  at,
  ingest: { msgsPerSec: msgs, venues },
});

const health = (over: Partial<SystemHealth> = {}): SystemHealth => ({
  status: 'ok',
  checkedAt: T,
  dependencies: [
    { name: 'database', status: 'ok', latencyMs: 1, detail: 'reachable' },
    { name: 'redis', status: 'ok', latencyMs: 1, detail: 'reachable' },
  ],
  services: [],
  feeds: [],
  analysis: [],
  calendar: { status: 'ok', available: true, detail: 'ok' },
  ...over,
});

describe('ActivityAggregator (ADR 024)', () => {
  it('starts empty, with the ingestion down, and nothing fabricated', () => {
    const a = new ActivityAggregator();
    const s = a.snapshot(T);
    expect(ActivitySnapshotSchema.parse(s)).toEqual(s);
    expect(s).toEqual({
      ts: T,
      ingest: { msgsPerSec: 0, perVenue: {}, state: 'down' },
      analysis: { candlesPerSec: 0, activeJobs: 0, backlog: 0, paused: 0 },
      ai: { inflight: 0, queued: 0, lastCompletedAt: null, lastResult: null },
      alerts: { firedLastMin: 0 },
      errors: [],
    });
  });

  it('adds up the instances, keeps each one’s latest report, and drops reports older than 5 s', () => {
    const a = new ActivityAggregator();
    a.report(
      ingest('i1', T - 1_000, { binance: 200, coinbase: 0 }, { binance: 'open', coinbase: 'standby' }),
    );
    a.report(
      ingest('i2', T - 1_000, { binance: 0, coinbase: 40.25 }, { binance: 'standby', coinbase: 'open' }),
    );
    // An older report of i1 arriving late does not replace the newer one.
    a.report(ingest('i1', T - 3_000, { binance: 999 }, { binance: 'open' }));
    a.report({
      service: 'analyzer',
      instance: 'a1',
      at: T - 500,
      analysis: { candlesPerSec: 1.5, activeJobs: 2, backlog: 1, paused: 0 },
    });
    a.report({
      service: 'analyzer',
      instance: 'a2',
      at: T - 500,
      analysis: { candlesPerSec: 0.5, activeJobs: 1, backlog: 0, paused: 3 },
    });
    a.report({ service: 'jobs', instance: 'j1', at: T - 200, ai: { inflight: 1, queued: 4 } });
    a.report({ service: 'jobs', instance: 'j2', at: T - 200, ai: { inflight: 0, queued: 4 } });
    const s = a.snapshot(T);
    expect(s.ingest).toEqual({
      msgsPerSec: 240.25,
      perVenue: { binance: 200, coinbase: 40.25 },
      state: 'ok',
    });
    expect(s.analysis).toEqual({ candlesPerSec: 2, activeJobs: 3, backlog: 1, paused: 3 });
    // The queue is shared: every jobs instance sees the same four.
    expect(s.ai).toMatchObject({ inflight: 1, queued: 4 });

    // Five seconds on, every report is stale: nothing counts and the ingestion is down.
    const later = a.snapshot(T + 6_000);
    expect(later.ingest.state).toBe('down');
    expect(later.analysis.activeJobs).toBe(0);
    expect(later.ai.inflight).toBe(0);
  });

  it('says the ingestion is degraded when a venue is not connected, or held by no instance', () => {
    const a = new ActivityAggregator();
    a.report(ingest('i1', T, { binance: 10 }, { binance: 'open', coinbase: 'closed' }));
    expect(a.snapshot(T).ingest.state).toBe('degraded');
    const b = new ActivityAggregator();
    b.report(ingest('i1', T, { binance: 10 }, { binance: 'standby' }));
    expect(b.snapshot(T).ingest.state).toBe('degraded');
  });

  it('counts alerts of the last minute and keeps the latest AI result', () => {
    const a = new ActivityAggregator();
    a.alertFired(T - 61_000);
    a.alertFired(T - 30_000);
    a.alertFired(T - 1_000);
    expect(a.snapshot(T).alerts.firedLastMin).toBe(2);
    a.aiFinished('rejected', T - 5_000);
    a.aiFinished('accepted', T - 10_000);
    expect(a.snapshot(T).ai).toMatchObject({ lastCompletedAt: T - 5_000, lastResult: 'rejected' });
    a.aiFinished('failed', T - 1_000);
    expect(a.snapshot(T).ai).toMatchObject({ lastCompletedAt: T - 1_000, lastResult: 'failed' });
  });

  it('takes its errors from System Health: critical when a dependency or a service is down, a warning when degraded', () => {
    const h = health({
      dependencies: [
        { name: 'database', status: 'down', latencyMs: null, detail: 'connection refused' },
        { name: 'redis', status: 'ok', latencyMs: 1, detail: 'reachable' },
      ],
      services: [
        { service: 'api', status: 'ok', instances: [] },
        { service: 'jobs', status: 'down', instances: [] },
        {
          service: 'analyzer',
          status: 'degraded',
          instances: [
            {
              service: 'analyzer',
              instance: 'a1',
              version: '1',
              startedAt: T,
              sentAt: T,
              status: 'degraded',
              detail: '1 paused on a data gap',
              ageMs: 0,
            },
          ],
        },
        { service: 'broker', status: 'degraded', instances: [] },
      ],
    });
    expect(errorsOf(h)).toEqual([
      { component: 'database', severity: 'critical', detail: 'connection refused' },
      { component: 'jobs', severity: 'critical', detail: 'no instance is running' },
      { component: 'analyzer', severity: 'warning', detail: '1 paused on a data gap' },
      { component: 'broker', severity: 'warning' },
    ]);
    const a = new ActivityAggregator();
    a.health(h, T);
    expect(a.errorsAt).toBe(T);
    expect(a.snapshot(T).errors).toHaveLength(4);
    a.health(health(), T + 5_000);
    expect(a.snapshot(T + 5_000).errors).toEqual([]);
  });
});

describe('pulses (ADR 024)', () => {
  it('makes a pattern pulse of a setup transition, and sweep and MSS pulses of SMC detections', () => {
    expect(pulseOf('an:events', `${T}-0`, entry('setup', { id: 'setup-1', instrumentId: ID }))).toEqual({
      ts: T,
      kind: 'pattern',
      refId: 'setup-1',
      instrumentId: ID,
    });
    expect(
      pulseOf(
        'an:events',
        `${T}-1`,
        entry('smc', { instrumentId: ID, runId: 'r', seq: 7, type: 'sweep', data: { id: 'sw-1' } }),
      ),
    ).toEqual({ ts: T, kind: 'sweep', refId: 'sw-1', instrumentId: ID });
    expect(
      pulseOf(
        'an:events',
        `${T}-2`,
        entry('smc', { instrumentId: ID, runId: 'r', seq: 8, type: 'structure', data: { type: 'mss' } }),
      ),
    ).toEqual({ ts: T, kind: 'mss', refId: 'r:8', instrumentId: ID });
    // Not every detection pulses: a BOS, an indicator point, a malformed entry.
    expect(
      pulseOf(
        'an:events',
        `${T}-3`,
        entry('smc', { instrumentId: ID, type: 'structure', data: { type: 'bos' } }),
      ),
    ).toBeNull();
    expect(pulseOf('an:events', `${T}-4`, entry('indicators.closed', { instrumentId: ID }))).toBeNull();
    expect(pulseOf('an:events', `${T}-5`, ['type', 'setup', 'data', '{not json'])).toBeNull();
    expect(pulseOf('an:events', `${T}-6`, entry('setup', { instrumentId: ID }))).toBeNull();
    expect(pulseOf('an:events', `${T}-7`, entry('setup', { id: 's' }))).toBeNull();
    expect(pulseOf('md:events', `${T}-8`, entry('trade.large', { instrumentId: ID }))).toBeNull();
  });

  it('makes a pulse of an accepted AI analysis, and of a fired alert with nothing of the user', () => {
    expect(
      pulseOf('ai:events', `${T}-0`, entry('ai.completed', { analysis: { id: 'an-1', instrumentId: ID } })),
    ).toEqual({ ts: T, kind: 'ai_completed', refId: 'an-1', instrumentId: ID });
    expect(
      pulseOf('ai:events', `${T}-1`, entry('ai.completed', { analysis: { id: 'an-2', instrumentId: null } })),
    ).toEqual({ ts: T, kind: 'ai_completed', refId: 'an-2' });
    expect(pulseOf('ai:events', `${T}-2`, entry('ai.rejected', { analysis: { id: 'an-3' } }))).toBeNull();
    expect(pulseOf('ai:events', `${T}-3`, entry('ai.completed', {}))).toBeNull();
    const alert = pulseOf('alerts:events', `${T}-4`, [
      'type',
      'alert.fired',
      'user',
      'user-1',
      'data',
      JSON.stringify({ notification: { title: 'private' } }),
    ]);
    expect(alert).toEqual({ ts: T, kind: 'alert', refId: `${T}-4` });
    expect(
      pulseOf('alerts:events', `${T}-5`, ['type', 'notification.read', 'user', 'u', 'data', '{}']),
    ).toBeNull();
  });

  it('reads AI outcomes, maps stored statuses, and lets 20 pulses a second through', () => {
    expect(aiOutcomeOf(entry('ai.completed', {}))).toBe('accepted');
    expect(aiOutcomeOf(entry('ai.rejected', {}))).toBe('rejected');
    expect(aiOutcomeOf(entry('ai.failed', {}))).toBe('failed');
    expect(aiOutcomeOf(entry('ai.started', {}))).toBeNull();
    expect(aiResultOf('cache_hit')).toBe('accepted');
    expect(aiResultOf('accepted')).toBe('accepted');
    expect(aiResultOf('rejected')).toBe('rejected');
    expect(aiResultOf('skipped_budget')).toBe('failed');

    const limiter = new PulseLimiter();
    const allowed = Array.from({ length: 30 }, () => limiter.allow(T + 100)).filter(Boolean).length;
    expect(allowed).toBe(ACTIVITY_PULSES_PER_SEC);
    expect(limiter.dropped).toBe(30 - ACTIVITY_PULSES_PER_SEC);
    expect(limiter.allow(T + 1_000)).toBe(true);
  });
});
