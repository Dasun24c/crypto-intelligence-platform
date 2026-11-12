import { Controller, Get, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  type Page,
  type SetupDetail,
  type SetupSummary,
  type SetupsQuery,
  SetupsQuerySchema,
} from '@cip/contracts';
import { Access } from '../common/access.js';
import { ProblemError } from '../common/problem.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { MarketRepository } from '../market/market.repository.js';
import { SetupsRepository } from './setups.repository.js';

/**
 * Setups (API contracts §3 "Setups and replays", rulebook §6–§8). Every level comes with the
 * disclaimer "Educational analysis — not financial advice"; nothing here places an order.
 * `GET /setups/stats` arrives with Phase 12.
 */
@Controller('setups')
@Access('dashboards.view')
export class SetupsController {
  constructor(
    private readonly setups: SetupsRepository,
    private readonly market: MarketRepository,
  ) {}

  @Get()
  async list(@Query(new ZodPipe(SetupsQuerySchema)) q: SetupsQuery): Promise<Page<SetupSummary>> {
    if (q.from !== undefined && q.to !== undefined && q.to < q.from)
      throw new ProblemError('VALIDATION_FAILED', '`to` must not be before `from`.');
    if (q.instrumentId) await this.market.requireInstrument(q.instrumentId);
    return this.setups.list(q);
  }

  @Get(':id')
  async detail(@Param('id', new ZodPipe(z.uuid())) id: string): Promise<SetupDetail> {
    const setup = await this.setups.detail(id);
    if (!setup) throw new ProblemError('NOT_FOUND', 'No such setup.');
    return setup;
  }
}
