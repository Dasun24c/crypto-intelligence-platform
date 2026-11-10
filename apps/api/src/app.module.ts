import { type DynamicModule, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { createDb, createPool, type Database } from '@cip/db';
import type { Logger } from '@cip/observability';
import { AdminAuditController } from './admin/admin-audit.controller.js';
import { AdminUsersController } from './admin/admin-users.controller.js';
import { AuditService } from './audit/audit.service.js';
import { AccessGuard } from './auth/access.guard.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { MfaService } from './auth/mfa.service.js';
import { PasswordService } from './auth/password.service.js';
import { RefreshTokensService } from './auth/refresh-tokens.service.js';
import { TokenService } from './auth/token.service.js';
import { ProblemFilter } from './common/problem.filter.js';
import { RateLimiter } from './common/rate-limiter.js';
import type { ApiConfig } from './config.js';
import { LiveGateway } from './live/live.gateway.js';
import { AdminClosuresController, AdminInstrumentsController } from './market/admin-market.controller.js';
import { MarketController } from './market/market.controller.js';
import { MarketRepository } from './market/market.repository.js';
import { publicVenueDirectory, VENUE_DIRECTORY, type VenueDirectory } from './market/venue-directory.js';
import { MeController } from './me/me.controller.js';
import { FeedsService } from './system/feeds.service.js';
import { HealthService } from './system/health.service.js';
import { ProbesController, SystemController } from './system/system.controller.js';
import { API_CONFIG, CLOCK, type Clock, DB, LOGGER, PG_POOL, REDIS } from './tokens.js';
import { UsersRepository } from './users/users.repository.js';

export interface ApiModuleOptions {
  config: ApiConfig;
  logger: Logger;
  clock?: Clock;
  /** Venue lookups for instrument administration; tests pass a fake. */
  venues?: VenueDirectory;
}

/** Closes the connection pools when the application shuts down. */
class Connections implements OnApplicationShutdown {
  constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}

@Module({})
export class AppModule {
  static forRoot(opts: ApiModuleOptions): DynamicModule {
    const { config } = opts;
    return {
      module: AppModule,
      controllers: [
        AuthController,
        MeController,
        AdminUsersController,
        AdminAuditController,
        AdminInstrumentsController,
        AdminClosuresController,
        MarketController,
        SystemController,
        ProbesController,
      ],
      providers: [
        { provide: API_CONFIG, useValue: config },
        { provide: LOGGER, useValue: opts.logger },
        { provide: CLOCK, useValue: opts.clock ?? (() => Date.now()) },
        {
          provide: PG_POOL,
          useFactory: () => createPool({ connectionString: config.DATABASE_URL, applicationName: 'cip-api' }),
        },
        {
          provide: DB,
          useFactory: (pool: ReturnType<typeof createPool>) => createDb({ pool }),
          inject: [PG_POOL],
        },
        {
          provide: REDIS,
          useFactory: () =>
            new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, connectionName: 'cip-api' }),
        },
        { provide: VENUE_DIRECTORY, useFactory: () => opts.venues ?? publicVenueDirectory() },
        { provide: APP_GUARD, useClass: AccessGuard },
        { provide: APP_FILTER, useClass: ProblemFilter },
        Connections,
        UsersRepository,
        AuditService,
        RateLimiter,
        PasswordService,
        TokenService,
        RefreshTokensService,
        MfaService,
        AuthService,
        HealthService,
        FeedsService,
        MarketRepository,
        LiveGateway,
      ],
    };
  }
}
