import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import {
  type AutoDecision,
  AutoDecisionsQuerySchema,
  AutoSwitchOnRequestSchema,
  type Page,
  PlacePracticeOrderRequestSchema,
  type PracticeAccount,
  type PracticeAccounts,
  type PracticeFill,
  PracticeFillsQuerySchema,
  type PracticeOrder,
  PracticeOrdersQuerySchema,
  type PracticePosition,
  PracticeResetRequestSchema,
  type PracticeSettings,
  PracticeSettingsSchema,
  type PracticeStrategy,
  type UpdateAutoRulesRequest,
  UpdateAutoRulesRequestSchema,
} from '@cip/contracts';
import type { Database } from '@cip/db';
import { AuditService } from '../audit/audit.service.js';
import { Access, type ApiRequest, clientIp, userAgent } from '../common/access.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { CLOCK, type Clock, DB } from '../tokens.js';
import { AutomaticService } from './automatic.service.js';
import { PRACTICE_SETTINGS_KEY, PracticeRepository } from './practice.repository.js';
import { PracticeService, type RequestMeta } from './practice.service.js';

const IdPipe = new ZodPipe(z.uuid());

const meta = (req: ApiRequest): RequestMeta => ({ ip: clientIp(req), userAgent: userAgent(req) });

/**
 * Practice trading (API contracts §3 "Practice trading", REQUIREMENTS §11, ADR 021): simulated spot
 * orders on the signed-in user's own practice account. Every role has one; nobody, admins
 * included, reaches another user's. Nothing here reaches an exchange.
 */
@Controller('practice')
@Access('practice.own')
export class PracticeController {
  constructor(
    private readonly practice: PracticeService,
    private readonly repo: PracticeRepository,
  ) {}

  /** Balances per venue, opened with the starting balances on first use, and each venue's fees. */
  @Get('account')
  async account(@Req() req: ApiRequest): Promise<PracticeAccounts> {
    const [accounts, settings] = await Promise.all([this.repo.accounts(req.user!.id), this.repo.settings()]);
    return { accounts, fees: settings.fees };
  }

  /** 200 with the account at its starting balances, or 202 while the broker has not applied it yet. */
  @Post('account/reset')
  @HttpCode(200)
  async reset(
    @Body(new ZodPipe(PracticeResetRequestSchema)) body: z.infer<typeof PracticeResetRequestSchema>,
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PracticeAccount> {
    const { account, settled } = await this.practice.reset(req.user!, body.venue, meta(req));
    if (!settled) res.status(202);
    return account;
  }

  @Get('orders')
  orders(
    @Query(new ZodPipe(PracticeOrdersQuerySchema)) q: z.infer<typeof PracticeOrdersQuerySchema>,
    @Req() req: ApiRequest,
  ): Promise<Page<PracticeOrder>> {
    return this.repo.orders(req.user!.id, q);
  }

  /** 201 with the new order; 200 with the original for a retried submission; 422 when refused. */
  @Post('orders')
  @HttpCode(201)
  async place(
    @Body(new ZodPipe(PlacePracticeOrderRequestSchema)) body: z.infer<typeof PlacePracticeOrderRequestSchema>,
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PracticeOrder> {
    const { order, created } = await this.practice.place(req.user!, body, meta(req));
    if (!created) res.status(200);
    return order;
  }

  @Get('orders/:id')
  async order(@Param('id', IdPipe) id: string, @Req() req: ApiRequest): Promise<PracticeOrder> {
    return this.repo.orderOrThrow(req.user!.id, id);
  }

  /** 200 with the cancelled order, or 202 with it as it is while the broker has not applied it yet. */
  @Post('orders/:id/cancel')
  @HttpCode(200)
  async cancel(
    @Param('id', IdPipe) id: string,
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PracticeOrder> {
    const { order, settled } = await this.practice.cancel(req.user!, id, meta(req));
    if (!settled) res.status(202);
    return order;
  }

  @Get('fills')
  fills(
    @Query(new ZodPipe(PracticeFillsQuerySchema)) q: z.infer<typeof PracticeFillsQuerySchema>,
    @Req() req: ApiRequest,
  ): Promise<Page<PracticeFill>> {
    return this.repo.fills(req.user!.id, q);
  }

  /** What the user holds in each account's current period, with profit and loss after fees. */
  @Get('positions')
  positions(@Req() req: ApiRequest): Promise<PracticePosition[]> {
    return this.repo.positions(req.user!.id);
  }
}

/**
 * Automatic practice trading (REQUIREMENTS §11 revision 5, ADR 022): the caller's own rules, switch,
 * stop button and decision log. Every role has it for their own practice account only. It places
 * practice orders only: nothing here reaches an exchange.
 */
@Controller('practice/automatic')
@Access('practice.own')
export class PracticeAutomaticController {
  constructor(private readonly automatic: AutomaticService) {}

  @Get()
  get(@Req() req: ApiRequest): Promise<PracticeStrategy> {
    return this.automatic.get(req.user!.id);
  }

  /** 200 with the saved rules; 409 when they changed since they were read. */
  @Put()
  update(
    @Body(new ZodPipe(UpdateAutoRulesRequestSchema)) body: UpdateAutoRulesRequest,
    @Req() req: ApiRequest,
  ): Promise<PracticeStrategy> {
    return this.automatic.update(req.user!, body, meta(req));
  }

  /** Switches it on, confirming the rules at `version`; 409 when they changed since. */
  @Post('on')
  @HttpCode(200)
  on(
    @Body(new ZodPipe(AutoSwitchOnRequestSchema)) body: z.infer<typeof AutoSwitchOnRequestSchema>,
    @Req() req: ApiRequest,
  ): Promise<PracticeStrategy> {
    return this.automatic.switchOn(req.user!, body.version, meta(req));
  }

  @Post('off')
  @HttpCode(200)
  off(@Req() req: ApiRequest): Promise<PracticeStrategy> {
    return this.automatic.switchOff(req.user!, meta(req));
  }

  /** 200 once its automatic orders are cancelled, or 202 while the broker has not applied it yet. */
  @Post('stop')
  @HttpCode(200)
  async stop(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response): Promise<PracticeStrategy> {
    const { strategy, settled } = await this.automatic.stop(req.user!, meta(req));
    if (!settled) res.status(202);
    return strategy;
  }

  @Get('decisions')
  decisions(
    @Query(new ZodPipe(AutoDecisionsQuerySchema)) q: z.infer<typeof AutoDecisionsQuerySchema>,
    @Req() req: ApiRequest,
  ): Promise<Page<AutoDecision>> {
    return this.automatic.decisions(req.user!.id, q);
  }
}

/**
 * Practice fees per venue and the starting balances (ADR 021). The broker applies a change within
 * about 30 s; starting balances apply to accounts opened or reset afterwards. Audited.
 */
@Controller('admin/settings/practice')
@Access('settings.manage')
export class AdminPracticeSettingsController {
  constructor(
    private readonly repo: PracticeRepository,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get()
  get(): Promise<PracticeSettings> {
    return this.repo.settings();
  }

  @Put()
  async put(
    @Body(new ZodPipe(PracticeSettingsSchema)) body: PracticeSettings,
    @Req() req: ApiRequest,
  ): Promise<PracticeSettings> {
    const before = await this.repo.settings();
    await this.db.transaction().execute(async (trx) => {
      await this.repo.saveSettings(trx, body, req.user!.id, new Date(this.clock()));
      await this.audit.record(
        {
          actorType: 'user',
          actorUserId: req.user!.id,
          action: 'settings.updated',
          targetType: 'setting',
          targetId: PRACTICE_SETTINGS_KEY,
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
