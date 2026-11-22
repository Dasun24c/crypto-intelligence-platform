import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import {
  type ReplayBaseQuery,
  ReplayBaseQuerySchema,
  type ReplayBaseSettings,
  type ReplayRequest,
  ReplayRequestSchema,
  type ReplayStatus,
  type ReplayStatusQuery,
  ReplayStatusQuerySchema,
  type ReplaySummary,
  type ReplaysQuery,
  ReplaysQuerySchema,
} from '@cip/contracts';
import { AuditService } from '../audit/audit.service.js';
import { Access, type ApiRequest, clientIp, userAgent } from '../common/access.js';
import { ProblemError } from '../common/problem.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { MarketRepository } from '../market/market.repository.js';
import { ReplayService } from './replay.service.js';

/** `POST /replays`, `GET /replays`, `GET /replays/{runId}` (API contracts §3 "Setups and replays"). */
@Controller('replays')
export class ReplayController {
  constructor(
    private readonly replays: ReplayService,
    private readonly market: MarketRepository,
    private readonly audit: AuditService,
  ) {}

  /**
   * Queues a replay of a stored period, with the settings of the live run that covers it (else the
   * instrument's profile), some of which it may change for itself; the analyzer runs it.
   */
  @Post()
  @HttpCode(202)
  @Access('replays.run')
  async create(
    @Body(new ZodPipe(ReplayRequestSchema)) body: ReplayRequest,
    @Req() req: ApiRequest,
  ): Promise<{ runId: string }> {
    await this.market.requireInstrument(body.instrumentId);
    if (body.to > Date.now())
      throw new ProblemError(
        'VALIDATION_FAILED',
        'A replay reads stored history: `to` cannot be in the future.',
      );
    const runId = await this.replays.request(body, req.user!.id);
    await this.audit.record({
      actorType: 'user',
      actorUserId: req.user!.id,
      action: 'replay.requested',
      targetType: 'instrument',
      targetId: body.instrumentId,
      ip: clientIp(req),
      userAgent: userAgent(req),
      details: { runId, from: body.from, to: body.to, ...(body.settings ? { settings: body.settings } : {}) },
    });
    return { runId };
  }

  @Get()
  @Access('dashboards.view')
  async list(
    @Query(new ZodPipe(ReplaysQuerySchema)) q: ReplaysQuery,
    @Req() req: ApiRequest,
  ): Promise<ReplaySummary[]> {
    if (q.instrumentId) await this.market.requireInstrument(q.instrumentId);
    return this.replays.list(q, req.user!.id);
  }

  /** What a replay of the instrument starts from: its profile's values of the settings a replay may change. */
  @Get('settings')
  @Access('dashboards.view')
  async settings(@Query(new ZodPipe(ReplayBaseQuerySchema)) q: ReplayBaseQuery): Promise<ReplayBaseSettings> {
    await this.market.requireInstrument(q.instrumentId);
    return this.replays.baseSettings(q.instrumentId);
  }

  /** The replay, compared with the live run it started from, or with the run `compareWith` names. */
  @Get(':runId')
  @Access('dashboards.view')
  async get(
    @Param('runId', new ZodPipe(z.uuid())) runId: string,
    @Query(new ZodPipe(ReplayStatusQuerySchema)) q: ReplayStatusQuery,
  ): Promise<ReplayStatus> {
    return this.replays.status(runId, q.compareWith);
  }
}
