import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { FeedStatus, SystemHealth } from '@cip/contracts';
import { Access } from '../common/access.js';
import { FeedsService } from './feeds.service.js';
import { HealthService } from './health.service.js';

@Controller('system')
@Access('dashboards.view')
export class SystemController {
  constructor(
    private readonly health: HealthService,
    private readonly feeds: FeedsService,
  ) {}

  @Get('health')
  check(): Promise<SystemHealth> {
    return this.health.check();
  }

  @Get('feeds')
  feedStatus(): Promise<FeedStatus[]> {
    return this.feeds.feeds();
  }
}

/** Unauthenticated probes for Docker and Caddy, outside the /api/v1 prefix. They reveal nothing. */
@Controller()
@Access('public')
export class ProbesController {
  constructor(private readonly health: HealthService) {}

  @Get('healthz')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  async ready(@Res({ passthrough: true }) res: Response): Promise<{ status: string }> {
    const r = await this.health.readiness();
    if (r.status === 'down') res.status(503);
    return { status: r.status };
  }
}
