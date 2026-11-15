import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import {
  type DependencyHealth,
  type HealthStatus,
  SERVICE_NAMES,
  type ServiceHealth,
  type SystemHealth,
} from '@cip/contracts';
import { pingDb } from '@cip/db';
import { effectiveStatus, type Readiness, readHeartbeats } from '@cip/observability';
import { AnalysisStatusService } from '../analysis/analysis-status.service.js';
import { CLOCK, type Clock, PG_POOL, REDIS } from '../tokens.js';
import { FeedsService } from './feeds.service.js';

const RANK: Record<HealthStatus, number> = { ok: 0, degraded: 1, down: 2 };
const worst = (statuses: HealthStatus[]): HealthStatus =>
  statuses.reduce<HealthStatus>((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok');

/**
 * Builds the System Health view from dependency pings and the heartbeats every service writes to
 * Redis (architecture §16). Nothing here is simulated: a service that is not running shows as down.
 */
@Injectable()
export class HealthService {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly feedsService: FeedsService,
    private readonly analysisStatus: AnalysisStatusService,
  ) {}

  private async probe(name: DependencyHealth['name'], fn: () => Promise<number>): Promise<DependencyHealth> {
    try {
      const latencyMs = await fn();
      return { name, status: 'ok', latencyMs, detail: 'reachable' };
    } catch (err) {
      return {
        name,
        status: 'down',
        latencyMs: null,
        detail: err instanceof Error ? err.message : 'unreachable',
      };
    }
  }

  dependencies(): Promise<DependencyHealth[]> {
    return Promise.all([
      this.probe('database', () => pingDb(this.pool)),
      this.probe('redis', async () => {
        const started = performance.now();
        await this.redis.ping();
        return Math.round(performance.now() - started);
      }),
    ]);
  }

  async check(): Promise<SystemHealth> {
    const now = this.clock();
    const dependencies = await this.dependencies();
    const redisUp = dependencies.find((d) => d.name === 'redis')?.status === 'ok';
    const heartbeats = redisUp ? await readHeartbeats(this.redis, now) : [];
    const services: ServiceHealth[] = SERVICE_NAMES.map((service) => {
      const instances = heartbeats
        .filter((h) => h.service === service)
        .map((h) => ({ ...h, status: effectiveStatus(h, now), ageMs: now - h.sentAt }));
      const statuses = instances.map((i) => i.status);
      const status: HealthStatus = statuses.includes('ok')
        ? 'ok'
        : statuses.includes('degraded')
          ? 'degraded'
          : 'down';
      return { service, status, instances };
    });
    const dbUp = dependencies.find((d) => d.name === 'database')?.status === 'ok';
    const [feeds, analysis] =
      dbUp && redisUp ? await Promise.all([this.feedsService.feeds(), this.analysisStatus.all()]) : [[], []];
    const dependencyStatus = worst(dependencies.map((d) => d.status));
    const serviceStatus = worst(services.map((s) => s.status));
    const feedsOk = feeds.every((f) => f.state === 'connected');
    // Analysis held back (warming up or waiting on a data gap) is not yet available: degraded.
    const analysisOk = analysis.every((a) => !a.paused);
    const status: HealthStatus =
      dependencyStatus === 'down'
        ? 'down'
        : serviceStatus === 'ok' && feedsOk && analysisOk
          ? 'ok'
          : 'degraded';
    return { status, checkedAt: now, dependencies, services, feeds, analysis };
  }

  /** Readiness of this api instance: it can serve only if both dependencies answer. */
  async readiness(): Promise<Readiness> {
    const deps = await this.dependencies();
    const down = deps.filter((d) => d.status === 'down');
    return down.length === 0
      ? { status: 'ok', detail: 'database and redis reachable' }
      : { status: 'down', detail: `unreachable: ${down.map((d) => d.name).join(', ')}` };
  }
}
