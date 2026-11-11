import { Controller, Get, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  type ChartOverlay,
  type LevelsQuery,
  LevelsQuerySchema,
  type LiquidityLevel,
  type SmcQuery,
  SmcQuerySchema,
  type StructureEvent,
  type Sweep,
  type SwingPoint,
  type SwingsQuery,
  SwingsQuerySchema,
  type TradingRange,
} from '@cip/contracts';
import { TF_MS } from '@cip/domain';
import { Access } from '../common/access.js';
import { ProblemError } from '../common/problem.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { MarketRepository } from '../market/market.repository.js';
import { SmcRepository } from './smc.repository.js';

const IdPipe = new ZodPipe(z.uuid());
/** Candles an overlay covers when no window is given. */
const OVERLAY_CANDLES = 300;

/**
 * SMC detections (API contracts §3 "Indicators and SMC", rulebook §2–§3). Each list reads one run:
 * the instrument's current live run, or `runId` (a replay). An instrument never analysed gives
 * empty lists.
 */
@Controller('smc')
@Access('dashboards.view')
export class SmcController {
  constructor(
    private readonly smc: SmcRepository,
    private readonly market: MarketRepository,
  ) {}

  private async runOf(id: string, runId: string | undefined) {
    await this.market.requireInstrument(id);
    const run = await this.smc.run(id, runId);
    if (runId && !run) throw new ProblemError('NOT_FOUND', 'No such run for this instrument.');
    return run;
  }

  private static window<Q extends { from?: number; to?: number }>(q: Q): Q {
    if (q.from !== undefined && q.to !== undefined && q.to <= q.from)
      throw new ProblemError('VALIDATION_FAILED', '`to` must be after `from`.');
    return q;
  }

  @Get(':instrumentId/overlay')
  async overlay(
    @Param('instrumentId', IdPipe) id: string,
    @Query(new ZodPipe(SmcQuerySchema)) q: SmcQuery,
  ): Promise<ChartOverlay> {
    SmcController.window(q);
    const run = await this.runOf(id, q.runId);
    const to = q.to ?? Date.now();
    const from = q.from ?? to - OVERLAY_CANDLES * TF_MS[q.tf];
    const w = { from, to, limit: q.limit };
    const closures = await this.smc.closures(id, from, to);
    if (!run)
      return {
        instrumentId: id,
        tf: q.tf,
        run: null,
        swings: [],
        structure: [],
        ranges: [],
        levels: [],
        sweeps: [],
        zones: [],
        setups: [],
        closures,
      };
    const [swings, structure, ranges, levels, sweeps] = await Promise.all([
      this.smc.swings(run.id, q.tf, w),
      this.smc.structure(run.id, q.tf, w),
      this.smc.ranges(run.id, q.tf, w),
      this.smc.levels(run.id, q.tf, w),
      this.smc.sweeps(run.id, q.tf, w),
    ]);
    return {
      instrumentId: id,
      tf: q.tf,
      run,
      swings,
      structure,
      ranges,
      levels,
      sweeps,
      zones: [],
      setups: [],
      closures,
    };
  }

  @Get(':instrumentId/swings')
  async swings(
    @Param('instrumentId', IdPipe) id: string,
    @Query(new ZodPipe(SwingsQuerySchema)) q: SwingsQuery,
  ): Promise<SwingPoint[]> {
    const run = await this.runOf(id, q.runId);
    return run ? this.smc.swings(run.id, q.tf, SmcController.window(q)) : [];
  }

  @Get(':instrumentId/structure')
  async structure(
    @Param('instrumentId', IdPipe) id: string,
    @Query(new ZodPipe(SmcQuerySchema)) q: SmcQuery,
  ): Promise<StructureEvent[]> {
    const run = await this.runOf(id, q.runId);
    return run ? this.smc.structure(run.id, q.tf, SmcController.window(q)) : [];
  }

  @Get(':instrumentId/ranges')
  async ranges(
    @Param('instrumentId', IdPipe) id: string,
    @Query(new ZodPipe(SmcQuerySchema)) q: SmcQuery,
  ): Promise<TradingRange[]> {
    const run = await this.runOf(id, q.runId);
    return run ? this.smc.ranges(run.id, q.tf, SmcController.window(q)) : [];
  }

  @Get(':instrumentId/levels')
  async levels(
    @Param('instrumentId', IdPipe) id: string,
    @Query(new ZodPipe(LevelsQuerySchema)) q: LevelsQuery,
  ): Promise<LiquidityLevel[]> {
    const run = await this.runOf(id, q.runId);
    return run ? this.smc.levels(run.id, q.tf, { limit: q.limit, status: q.status, types: q.types }) : [];
  }

  @Get(':instrumentId/sweeps')
  async sweeps(
    @Param('instrumentId', IdPipe) id: string,
    @Query(new ZodPipe(SmcQuerySchema)) q: SmcQuery,
  ): Promise<Sweep[]> {
    const run = await this.runOf(id, q.runId);
    return run ? this.smc.sweeps(run.id, q.tf, SmcController.window(q)) : [];
  }
}
