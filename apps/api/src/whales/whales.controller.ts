import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import {
  type CreateExchangeLabel,
  CreateExchangeLabelSchema,
  DEFAULT_ONCHAIN_THRESHOLDS_USD,
  type ExchangeFlow,
  type ExchangeFlowQuery,
  ExchangeFlowQuerySchema,
  type ExchangeLabel,
  ExchangeLabelsQuerySchema,
  ONCHAIN_STATUS_KEY,
  ONCHAIN_STATUS_STALE_MS,
  type OnchainPage,
  type OnchainQuery,
  OnchainQuerySchema,
  type OnchainStatusResponse,
  OnchainStatusSchema,
  WHALES_DEFAULT_WINDOW_MS,
  WHALES_MAX_WINDOW_MS,
} from '@cip/contracts';
import { type Database, exchangeLabelFromRow, type OnchainLabelRow } from '@cip/db';
import { AuditService } from '../audit/audit.service.js';
import { Access, type ApiRequest, clientIp, userAgent } from '../common/access.js';
import { ProblemError } from '../common/problem.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { range } from '../market/market.controller.js';
import { CLOCK, type Clock, DB, REDIS } from '../tokens.js';
import { WhalesRepository } from './whales.repository.js';

/**
 * The Whale Tracker (API contracts §3 "whales"; Phase 11, ADR 025). Exchange flow and on-chain are
 * separate endpoints and never mixed (criterion 11.3).
 */
@Controller('whales')
@Access('dashboards.view')
export class WhalesController {
  constructor(
    private readonly whales: WhalesRepository,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Large trades and walls, per instrument and listed (criterion 11.1). */
  @Get('exchange')
  exchange(@Query(new ZodPipe(ExchangeFlowQuerySchema)) q: ExchangeFlowQuery): Promise<ExchangeFlow> {
    const w = range(q, this.clock(), WHALES_DEFAULT_WINDOW_MS, WHALES_MAX_WINDOW_MS);
    return this.whales.exchangeFlow(w, q.instrumentId);
  }

  /** Large transfers, and PAXG mints and burns, with each asset's totals (criterion 11.2). */
  @Get('onchain')
  onchain(@Query(new ZodPipe(OnchainQuerySchema)) q: OnchainQuery): Promise<OnchainPage> {
    const w = range(q, this.clock(), WHALES_DEFAULT_WINDOW_MS, WHALES_MAX_WINDOW_MS);
    return this.whales.onchain(q, w);
  }

  /** Each chain's source, as the jobs service last reported it. */
  @Get('onchain/status')
  async status(): Promise<OnchainStatusResponse> {
    const raw = await this.redis.get(ONCHAIN_STATUS_KEY);
    const parsed = raw ? OnchainStatusSchema.safeParse(JSON.parse(raw)) : null;
    if (!parsed?.success)
      return { updatedAt: 0, sources: [], thresholdsUsd: DEFAULT_ONCHAIN_THRESHOLDS_USD, stale: true };
    return { ...parsed.data, stale: this.clock() - parsed.data.updatedAt > ONCHAIN_STATUS_STALE_MS };
  }
}

function labelEvent(req: ApiRequest, action: string, row: OnchainLabelRow) {
  return {
    actorType: 'user' as const,
    actorUserId: req.user?.id ?? null,
    action,
    targetType: 'onchain_label',
    targetId: row.id,
    ip: clientIp(req),
    userAgent: userAgent(req),
    details: {
      chain: row.chain,
      address: row.address,
      owner: row.owner,
      wallet: row.wallet,
      source: row.source,
    },
  };
}

/** The exchange addresses on-chain transfers are labelled with: admins curate them (proposal 003). */
@Controller('admin/whales/labels')
@Access('settings.manage')
export class AdminWhaleLabelsController {
  constructor(
    private readonly whales: WhalesRepository,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Kysely<Database>,
  ) {}

  @Get()
  list(
    @Query(new ZodPipe(ExchangeLabelsQuerySchema)) q: { chain?: ExchangeLabel['chain'] },
  ): Promise<ExchangeLabel[]> {
    return this.whales.labels(q.chain);
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body(new ZodPipe(CreateExchangeLabelSchema)) body: CreateExchangeLabel,
    @Req() req: ApiRequest,
  ): Promise<ExchangeLabel> {
    const row = await this.db.transaction().execute(async (trx) => {
      const created = await this.whales.createLabel(trx, body, req.user!.id);
      if (created) await this.audit.record(labelEvent(req, 'onchain_label.created', created), trx);
      return created;
    });
    if (!row) throw new ProblemError('CONFLICT', 'That address is already listed for this chain.');
    return exchangeLabelFromRow(row);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', new ZodPipe(z.uuid())) id: string, @Req() req: ApiRequest): Promise<void> {
    const before = await this.whales.label(id);
    if (!before) throw new ProblemError('NOT_FOUND', 'No such label.');
    await this.db.transaction().execute(async (trx) => {
      await this.whales.deleteLabel(trx, id);
      await this.audit.record(labelEvent(req, 'onchain_label.deleted', before), trx);
    });
  }
}
