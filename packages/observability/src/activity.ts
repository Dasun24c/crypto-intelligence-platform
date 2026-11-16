import type { Redis } from 'ioredis';
import {
  ACTIVITY_REPORT_MS,
  ACTIVITY_STREAM,
  type ActivityCounters,
  type ActivityReport,
  type ActivityService,
} from '@cip/contracts';
import type { Logger } from './logger.js';

/** `sys:activity` keeps about this many reports (a few minutes of every instance's seconds). */
const STREAM_MAXLEN = '1000';
const WARN_EVERY_MS = 60_000;

/**
 * Counts events and gives their rate a second since the last `take` (ADR 024): venue messages, candle
 * boundaries analysed.
 */
export class RateCounter {
  private count = 0;
  private since: number;

  constructor(private readonly now: () => number = Date.now) {
    this.since = now();
  }

  add(n = 1): void {
    this.count += n;
  }

  /** Events a second since the previous take (or since it was made), to two decimals; then starts over. */
  take(): number {
    const now = this.now();
    const rate = this.count / Math.max(0.001, (now - this.since) / 1000);
    this.count = 0;
    this.since = now;
    return Math.round(rate * 100) / 100;
  }
}

/**
 * Things in progress (analysis steps, AI calls), and the most at once since the last `take`: a step of
 * a few milliseconds still counts for its second, where a sample at the second's end would miss it.
 */
export class PeakGauge {
  private current = 0;
  private peak = 0;

  inc(): void {
    this.current++;
    if (this.current > this.peak) this.peak = this.current;
  }

  dec(): void {
    this.current = Math.max(0, this.current - 1);
  }

  get value(): number {
    return this.current;
  }

  /** The most at once since the previous take; then starts again from what is in progress now. */
  take(): number {
    const peak = this.peak;
    this.peak = this.current;
    return peak;
  }
}

/**
 * Appends this instance's second to `sys:activity` every ACTIVITY_REPORT_MS (ADR 024): what the
 * service counted during it. The api keeps each instance's latest report for the brain's snapshot. A
 * failed write is logged at most once a minute; the brain then counts nothing from this instance.
 */
export class ActivityPublisher {
  private timer: NodeJS.Timeout | undefined;
  private lastWarn = -Infinity;

  constructor(
    private readonly redis: Redis,
    private readonly id: { service: ActivityService; instance: string },
    private readonly counters: () => ActivityCounters | Promise<ActivityCounters>,
    private readonly log?: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.report(), ACTIVITY_REPORT_MS);
    this.timer.unref();
  }

  async report(): Promise<void> {
    try {
      const report: ActivityReport = { ...this.id, at: this.now(), ...(await this.counters()) };
      await this.redis.xadd(
        ACTIVITY_STREAM,
        'MAXLEN',
        '~',
        STREAM_MAXLEN,
        '*',
        'type',
        'activity',
        'data',
        JSON.stringify(report),
      );
    } catch (err) {
      const now = this.now();
      if (now - this.lastWarn < WARN_EVERY_MS) return;
      this.lastWarn = now;
      this.log?.warn({ err }, 'activity report failed');
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
