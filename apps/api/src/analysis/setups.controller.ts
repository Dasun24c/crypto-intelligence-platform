import { Controller, Get, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  type Page,
  type SetupDetail,
  type SetupStats,
  type SetupStatsQuery,
  SetupStatsQuerySchema,
  type SetupSummary,
  type SetupsQuery,
  SetupsQuerySchema,
} from '@cip/contracts';
import { Access } from '../common/access.js';
import { ProblemError } from '../common/problem.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ComparisonService } from '../history/comparison.service.js';
import { StatsRepository } from '../history/stats.repository.js';
import { MarketRepository } from '../market/market.repository.js';
import { SetupsRepository } from './setups.repository.js';

/**
 * Setups (API contracts §3 "Setups and replays", rulebook §6–§8). Every level comes with the
 * disclaimer "Educational analysis — not financial advice"; nothing here places an order. The
 * statistics (Phase 12) are labelled "historical observations", never expected performance.
 */
@Controller('setups')
@Access('dashboards.view')
export class SetupsController {
  constructor(
    private readonly setups: SetupsRepository,
    private readonly market: MarketRepository,
    private readonly stats: StatsRepository,
    private readonly comparisons: ComparisonService,
  ) {}

  /** Outcome statistics by pattern, variant, direction, TF pair, instrument, session and rules version. */
  @Get('stats')
  async statistics(@Query(new ZodPipe(SetupStatsQuerySchema)) q: SetupStatsQuery): Promise<SetupStats> {
    if (q.instrumentId) await this.market.requireInstrument(q.instrumentId);
    if (q.runId && !(await this.comparisons.run(q.runId)))
      throw new ProblemError('NOT_FOUND', 'No such run.');
    return this.stats.stats(q);
  }

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
