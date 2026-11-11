import { Controller, Get, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  type DetectionRun,
  type IndicatorSeries,
  type IndicatorsQuery,
  IndicatorsQuerySchema,
  type RunsQuery,
  RunsQuerySchema,
} from '@cip/contracts';
import { Access } from '../common/access.js';
import { ProblemError } from '../common/problem.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { MarketRepository } from '../market/market.repository.js';
import { AnalysisStatusService } from './analysis-status.service.js';
import { AnalysisRepository } from './analysis.repository.js';

const IdPipe = new ZodPipe(z.uuid());

/** Technical analysis (API contracts §3): indicator values and the runs that produce them. */
@Controller()
@Access('dashboards.view')
export class AnalysisController {
  constructor(
    private readonly analysis: AnalysisRepository,
    private readonly statuses: AnalysisStatusService,
    private readonly market: MarketRepository,
  ) {}

  @Get('indicators/:instrumentId')
  async indicators(
    @Param('instrumentId', IdPipe) id: string,
    @Query(new ZodPipe(IndicatorsQuerySchema)) q: IndicatorsQuery,
  ): Promise<IndicatorSeries> {
    await this.market.requireInstrument(id);
    if (q.from !== undefined && q.to !== undefined && q.to <= q.from)
      throw new ProblemError('VALIDATION_FAILED', '`to` must be after `from`.');
    return this.analysis.series(id, q.tf, q);
  }

  /** Live and replay runs with status and, for open live runs, the analyzer's lag. */
  @Get('system/runs')
  async runs(@Query(new ZodPipe(RunsQuerySchema)) q: RunsQuery): Promise<DetectionRun[]> {
    const [runs, statuses] = await Promise.all([this.analysis.runs(q), this.statuses.all()]);
    const byRun = new Map(statuses.map((s) => [s.runId, s]));
    return runs.map((r) => {
      const s = byRun.get(r.id);
      return {
        ...r,
        lagSec: s?.lagSec ?? null,
        paused: s?.paused ?? false,
        pauseReason: s?.pauseReason ?? null,
      };
    });
  }
}
