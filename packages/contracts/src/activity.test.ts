import { describe, expect, it } from 'vitest';
import {
  ActivityPulseSchema,
  ActivityReportSchema,
  ActivitySnapshotSchema,
  emptyActivitySnapshot,
} from './activity.js';
import { CHANNEL_PATTERN, channels, isDurableChannel } from './market.js';

const T = Date.UTC(2026, 10, 16, 12, 0);

describe('system activity (Phase 10, ADR 024)', () => {
  it('takes each service’s report, and refuses negative or fractional counts', () => {
    const ingest = {
      service: 'ingestor',
      instance: 'ingestor-1',
      at: T,
      ingest: {
        msgsPerSec: { binance: 212.5, coinbase: 31 },
        venues: { binance: 'open', coinbase: 'standby' },
      },
    };
    expect(ActivityReportSchema.parse(ingest)).toEqual(ingest);
    const analysis = {
      service: 'analyzer',
      instance: 'analyzer-1',
      at: T,
      analysis: { candlesPerSec: 3, activeJobs: 2, backlog: 0, paused: 1 },
    };
    expect(ActivityReportSchema.safeParse(analysis).success).toBe(true);
    expect(
      ActivityReportSchema.safeParse({ ...analysis, analysis: { ...analysis.analysis, activeJobs: -1 } })
        .success,
    ).toBe(false);
    expect(
      ActivityReportSchema.safeParse({
        service: 'jobs',
        instance: 'j',
        at: T,
        ai: { inflight: 0.5, queued: 0 },
      }).success,
    ).toBe(false);
    expect(ActivityReportSchema.safeParse({ service: 'api', instance: 'a', at: T }).success).toBe(false);
    expect(
      ActivityReportSchema.safeParse({
        ...ingest,
        ingest: { msgsPerSec: { binance: Number.POSITIVE_INFINITY }, venues: {} },
      }).success,
    ).toBe(false);
  });

  it('starts from an empty snapshot that says the ingestion is down, and carries pulses without user data', () => {
    const empty = emptyActivitySnapshot(T);
    expect(ActivitySnapshotSchema.parse(empty)).toEqual(empty);
    expect(empty.ingest.state).toBe('down');
    expect(
      ActivitySnapshotSchema.safeParse({
        ...empty,
        errors: [{ component: 'database', severity: 'critical', detail: 'unreachable' }],
      }).success,
    ).toBe(true);
    expect(
      ActivitySnapshotSchema.safeParse({ ...empty, errors: [{ component: 'x', severity: 'fatal' }] }).success,
    ).toBe(false);
    expect(ActivityPulseSchema.parse({ ts: T, kind: 'alert', refId: '1-0' })).toEqual({
      ts: T,
      kind: 'alert',
      refId: '1-0',
    });
    expect(ActivityPulseSchema.safeParse({ ts: T, kind: 'random', refId: 'x' }).success).toBe(false);
  });

  it('is a channel of its own, not durable', () => {
    expect(channels.systemActivity).toBe('system:activity');
    expect(CHANNEL_PATTERN.test(channels.systemActivity)).toBe(true);
    expect(isDurableChannel(channels.systemActivity)).toBe(false);
  });
});
