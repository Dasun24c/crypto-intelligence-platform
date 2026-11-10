import { type DynamicModule, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { createPool, pingDb } from '@cip/db';
import { checkDependencies, type HeartbeatProbe, type Readiness } from '@cip/observability';
import type { IngestorConfig } from './config.js';

export const CONFIG = Symbol('CONFIG');
export const PG_POOL = Symbol('PG_POOL');
export const REDIS = Symbol('REDIS');

/**
 * Phase 1 skeleton: the service runs, connects with its own database role and reports a truthful
 * idle state to System Health. It produces no data until its phase delivers the real work.
 */
@Injectable()
export class IngestorStatus implements OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  probe(): HeartbeatProbe {
    return { status: 'ok', detail: 'idle: venue connections arrive in Phase 2' };
  }

  readiness(): Promise<Readiness> {
    return checkDependencies({ database: () => pingDb(this.pool), redis: () => this.redis.ping() });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

@Module({})
export class IngestorModule {
  static forRoot(config: IngestorConfig, redis: Redis): DynamicModule {
    return {
      module: IngestorModule,
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: REDIS, useValue: redis },
        {
          provide: PG_POOL,
          useFactory: () =>
            createPool({ connectionString: config.DATABASE_URL, max: 4, applicationName: 'cip-ingestor' }),
        },
        IngestorStatus,
      ],
    };
  }
}
