import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import {
  type AiAnalysesQuery,
  AiAnalysesQuerySchema,
  type AiAnalysisDetail,
  type AiAnalysisSummary,
  type AiRequest,
  AiRequestSchema,
  type AiSettings,
  AiSettingsSchema,
  type AiUsage,
  AiUsageQuerySchema,
  type Page,
} from '@cip/contracts';
import { AI_SETTINGS_KEY, type Database } from '@cip/db';
import { AuditService } from '../audit/audit.service.js';
import { Access, type ApiRequest, clientIp, userAgent } from '../common/access.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { CLOCK, type Clock, DB } from '../tokens.js';
import { AiRepository } from './ai.repository.js';
import { AiService } from './ai.service.js';

const IdPipe = new ZodPipe(z.uuid());

/**
 * AI analyses (API contracts §3 "Calendar, AI, alerts", ADR 023): the history every viewer may read,
 * with what was sent and received, and on-demand requests for analysts and admins. Observations
 * from the platform's own data: never advice, never a prediction.
 */
@Controller('ai')
@Access('dashboards.view')
export class AiController {
  constructor(
    private readonly repo: AiRepository,
    private readonly ai: AiService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get('analyses')
  list(@Query(new ZodPipe(AiAnalysesQuerySchema)) q: AiAnalysesQuery): Promise<Page<AiAnalysisSummary>> {
    return this.repo.list(q);
  }

  @Get('analyses/:id')
  detail(@Param('id', IdPipe) id: string): Promise<AiAnalysisDetail> {
    return this.repo.detail(id);
  }

  /** 202 with the id the analysis will have; its progress comes on the `ai` channel. Audited. */
  @Post('analyses')
  @HttpCode(202)
  @Access('ai.request')
  request(
    @Body(new ZodPipe(AiRequestSchema)) body: AiRequest,
    @Req() req: ApiRequest,
  ): Promise<{ analysisId: string }> {
    return this.ai.request(req.user!, body, { ip: clientIp(req), userAgent: userAgent(req) });
  }

  @Get('usage')
  usage(@Query(new ZodPipe(AiUsageQuerySchema)) q: z.infer<typeof AiUsageQuerySchema>): Promise<AiUsage> {
    return this.repo.usage(q, this.clock());
  }
}

/**
 * The AI settings (ADR 023): on/off, the model and its fallback, the reasoning effort, the token
 * limits, the daily and monthly caps and the prices. The jobs service reads them before each call.
 * Audited.
 */
@Controller('admin/settings/ai')
@Access('settings.manage')
export class AdminAiSettingsController {
  constructor(
    private readonly repo: AiRepository,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get()
  get(): Promise<AiSettings> {
    return this.repo.settings();
  }

  @Put()
  async put(
    @Body(new ZodPipe(AiSettingsSchema)) body: AiSettings,
    @Req() req: ApiRequest,
  ): Promise<AiSettings> {
    const before = await this.repo.settings();
    await this.db.transaction().execute(async (trx) => {
      await this.repo.saveSettings(trx, body, req.user!.id, new Date(this.clock()));
      await this.audit.record(
        {
          actorType: 'user',
          actorUserId: req.user!.id,
          action: 'settings.updated',
          targetType: 'setting',
          targetId: AI_SETTINGS_KEY,
          ip: clientIp(req),
          userAgent: userAgent(req),
          details: { before, after: body },
        },
        trx,
      );
    });
    return body;
  }
}
