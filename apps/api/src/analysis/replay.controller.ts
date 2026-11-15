import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { type ReplayRequest, ReplayRequestSchema, type ReplayStatus } from '@cip/contracts';
import { AuditService } from '../audit/audit.service.js';
import { Access, type ApiRequest, clientIp, userAgent } from '../common/access.js';
import { ProblemError } from '../common/problem.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { MarketRepository } from '../market/market.repository.js';
import { ReplayService } from './replay.service.js';

/** `POST /replays`, `GET /replays/{runId}` (API contracts §3 "Setups and replays"). */
@Controller('replays')
export class ReplayController {
  constructor(
    private readonly replays: ReplayService,
    private readonly market: MarketRepository,
    private readonly audit: AuditService,
  ) {}

  /** Queues a replay of a stored period with the instrument's profile; the analyzer runs it. */
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
      details: { runId, from: body.from, to: body.to },
    });
    return { runId };
  }

  @Get(':runId')
  @Access('dashboards.view')
  async get(@Param('runId', new ZodPipe(z.uuid())) runId: string): Promise<ReplayStatus> {
    return this.replays.status(runId);
  }
}
