import { type DynamicModule, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { createPool, pingDb } from '@cip/db';
import { checkDependencies, type Readiness } from '@cip/observability';
import type { AnalyzerConfig } from './config.js';

export const CONFIG = Symbol('CONFIG');
export const PG_POOL = Symbol('PG_POOL');
export const REDIS = Symbol('REDIS');

/**
 * The service's connections and readiness. The analysis itself is `Analyzer` (analysis/), which
 * main.ts starts on the module's database pool and reports to System Health.
 */
@Injectable()
export class AnalyzerStatus implements OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  readiness(): Promise<Readiness> {
    return checkDependencies({ database: () => pingDb(this.pool), redis: () => this.redis.ping() });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

@Module({})
export class AnalyzerModule {
  static forRoot(config: AnalyzerConfig, redis: Redis): DynamicModule {
    return {
      module: AnalyzerModule,
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: REDIS, useValue: redis },
        {
          provide: PG_POOL,
          useFactory: () =>
            createPool({ connectionString: config.DATABASE_URL, max: 4, applicationName: 'cip-analyzer' }),
        },
        AnalyzerStatus,
      ],
    };
  }
}
