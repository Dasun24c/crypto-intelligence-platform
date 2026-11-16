import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { ACTIVITY_STREAM, ActivityReportSchema } from '@cip/contracts';
import { ActivityPublisher, PeakGauge, RateCounter } from './activity.js';

describe('activity counters (ADR 024)', () => {
  it('gives a rate a second since the previous take, then starts over', () => {
    let now = 10_000;
    const rate = new RateCounter(() => now);
    rate.add(150);
    rate.add();
    now += 2_000;
    expect(rate.take()).toBe(75.5);
    now += 1_000;
    expect(rate.take()).toBe(0);
    rate.add(3);
    now += 1_500;
    expect(rate.take()).toBe(2);
    // No time elapsed: no division by zero.
    rate.add(1);
    expect(Number.isFinite(rate.take())).toBe(true);
  });

  it('keeps the most in progress at once since the previous take, so a short step still counts', () => {
    const g = new PeakGauge();
    g.inc();
    g.inc();
    g.dec();
    g.dec();
    expect(g.value).toBe(0);
    expect(g.take()).toBe(2);
    expect(g.take()).toBe(0);
    g.inc();
    expect(g.take()).toBe(1);
    // Still running at the next take: it counts again.
    expect(g.take()).toBe(1);
    g.dec();
    g.dec();
    expect(g.value).toBe(0);
  });
});

describe('ActivityPublisher', () => {
  it('appends each second as a report of who, when and what to sys:activity, capped', async () => {
    const xadd = vi.fn(() => Promise.resolve('1-0'));
    const redis = { xadd } as unknown as Redis;
    const publisher = new ActivityPublisher(
      redis,
      { service: 'jobs', instance: 'jobs-1' },
      () => ({ ai: { inflight: 1, queued: 2 } }),
      undefined,
      () => 42_000,
    );
    await publisher.report();
    expect(xadd).toHaveBeenCalledTimes(1);
    const args = xadd.mock.calls[0] as unknown as string[];
    expect(args.slice(0, 8)).toEqual([
      ACTIVITY_STREAM,
      'MAXLEN',
      '~',
      '1000',
      '*',
      'type',
      'activity',
      'data',
    ]);
    expect(ActivityReportSchema.parse(JSON.parse(args[8]!))).toEqual({
      service: 'jobs',
      instance: 'jobs-1',
      at: 42_000,
      ai: { inflight: 1, queued: 2 },
    });
  });

  it('logs a failed write at most once a minute, and stops', async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const warn = vi.fn();
      const xadd = vi.fn(() => Promise.reject(new Error('redis down')));
      const publisher = new ActivityPublisher(
        { xadd } as unknown as Redis,
        { service: 'ingestor', instance: 'i' },
        () => ({}),
        { warn } as never,
        () => now,
      );
      await publisher.report();
      now += 30_000;
      await publisher.report();
      expect(warn).toHaveBeenCalledTimes(1);
      now += 31_000;
      await publisher.report();
      expect(warn).toHaveBeenCalledTimes(2);
      // Started, it reports every second until stopped.
      publisher.start();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(xadd).toHaveBeenCalledTimes(6);
      publisher.stop();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(xadd).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });
});
