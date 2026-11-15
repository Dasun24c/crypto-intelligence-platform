import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { dryRun, ruleFromRow } from '@cip/alerts';
import {
  ALERTS_STREAM,
  AlertEventsQuerySchema,
  type AlertEvent,
  type AlertRule,
  AlertRulesQuerySchema,
  AlertRuleTestQuerySchema,
  type AlertRuleTestResult,
  can,
  CreateAlertRuleRequestSchema,
  type Notification,
  type NotificationReadMessage,
  NotificationsQuerySchema,
  type Page,
  ReadAllRequestSchema,
  type UpdateAlertRuleRequest,
  UpdateAlertRuleRequestSchema,
} from '@cip/contracts';
import type { AlertRuleRow, Database } from '@cip/db';
import { type AuditEvent, AuditService } from '../audit/audit.service.js';
import { Access, type ApiRequest, clientIp, userAgent } from '../common/access.js';
import { ProblemError } from '../common/problem.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { CLOCK, type Clock, DB, REDIS } from '../tokens.js';
import { historySources } from './alert-history.js';
import { AlertsRepository, MAX_RULES_PER_USER } from './alerts.repository.js';

const HOUR_MS = 3_600_000;
/** `alerts:events` keeps about this many messages (as the jobs service writes them). */
const ALERTS_STREAM_MAXLEN = 100_000;
const IdPipe = new ZodPipe(z.uuid());

function audit(
  req: ApiRequest,
  action: string,
  targetId: string,
  details: Record<string, unknown>,
): AuditEvent {
  return {
    actorType: 'user',
    actorUserId: req.user?.id ?? null,
    action,
    targetType: 'alert_rule',
    targetId,
    ip: clientIp(req),
    userAgent: userAgent(req),
    details,
  };
}

function describe(r: AlertRule): Record<string, unknown> {
  return {
    name: r.name,
    enabled: r.enabled,
    kind: r.condition.kind,
    condition: r.condition,
    scope: r.scope,
    severity: r.severity,
    cooldownSec: r.cooldownSec,
    channels: r.channels,
    quietHours: r.quietHours,
  };
}

function toRule(row: AlertRuleRow): AlertRule {
  const rule = ruleFromRow(row);
  // Rules are validated before they are written; one that no longer parses is a server fault.
  if (!rule) throw new ProblemError('INTERNAL', 'This rule can no longer be read.');
  return rule;
}

/**
 * A user's alert rules (API contracts §3 "Alerts"; ADR 020). Every role has its own; nobody reads
 * or changes another's, except that admins may list them. Changes are audited, and the analyzer
 * picks them up within about 5 s.
 */
@Controller('alerts')
@Access('alerts.own')
export class AlertRulesController {
  constructor(
    private readonly alerts: AlertsRepository,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get('rules')
  async list(
    @Query(new ZodPipe(AlertRulesQuerySchema)) q: z.infer<typeof AlertRulesQuerySchema>,
    @Req() req: ApiRequest,
  ): Promise<AlertRule[]> {
    const user = req.user!;
    const owner = q.ownerId ?? user.id;
    if (owner !== user.id && !can(user.role, 'users.manage'))
      throw new ProblemError('FORBIDDEN', 'Only admins can list another user’s rules.');
    return (await this.alerts.rules(owner)).map(toRule);
  }

  @Post('rules')
  @HttpCode(201)
  async create(
    @Body(new ZodPipe(CreateAlertRuleRequestSchema)) body: z.output<typeof CreateAlertRuleRequestSchema>,
    @Req() req: ApiRequest,
  ): Promise<AlertRule> {
    const user = req.user!;
    if ((await this.alerts.countRules(user.id)) >= MAX_RULES_PER_USER)
      throw new ProblemError('CONFLICT', `You can have at most ${MAX_RULES_PER_USER} alert rules.`);
    const rule = await this.db.transaction().execute(async (trx) => {
      const created = toRule(await this.alerts.create(trx, uuidv7(), user.id, body, this.clock()));
      await this.audit.record(audit(req, 'alert_rule.created', created.id, describe(created)), trx);
      return created;
    });
    return rule;
  }

  @Get('rules/:id')
  async get(@Param('id', IdPipe) id: string, @Req() req: ApiRequest): Promise<AlertRule> {
    return toRule(await this.own(id, req));
  }

  @Patch('rules/:id')
  async update(
    @Param('id', IdPipe) id: string,
    @Body(new ZodPipe(UpdateAlertRuleRequestSchema)) body: UpdateAlertRuleRequest,
    @Req() req: ApiRequest,
  ): Promise<AlertRule> {
    const before = toRule(await this.own(id, req));
    return this.db.transaction().execute(async (trx) => {
      const row = await this.alerts.update(trx, id, body, this.clock());
      if (!row)
        throw new ProblemError(
          'CONFLICT',
          `This rule was changed meanwhile (now version ${before.version}). Reload it and try again.`,
        );
      const after = toRule(row);
      await this.audit.record(
        audit(req, 'alert_rule.updated', id, { before: describe(before), after: describe(after) }),
        trx,
      );
      return after;
    });
  }

  /** Removes the rule; its alerts stay in the inbox. */
  @Delete('rules/:id')
  @HttpCode(204)
  async remove(@Param('id', IdPipe) id: string, @Req() req: ApiRequest): Promise<void> {
    const before = toRule(await this.own(id, req));
    await this.db.transaction().execute(async (trx) => {
      await this.alerts.remove(trx, id, this.clock());
      await this.audit.record(audit(req, 'alert_rule.deleted', id, describe(before)), trx);
    });
  }

  /** What the rule would have fired over the last `hours` (criterion 8.6): the live evaluator on stored history. */
  @Post('rules/:id/test')
  @HttpCode(200)
  async test(
    @Param('id', IdPipe) id: string,
    @Query(new ZodPipe(AlertRuleTestQuerySchema)) q: z.infer<typeof AlertRuleTestQuerySchema>,
    @Req() req: ApiRequest,
  ): Promise<AlertRuleTestResult> {
    const rule = toRule(await this.own(id, req));
    const to = this.clock();
    const from = to - q.hours * HOUR_MS;
    const { sources, note } = await historySources(this.db, rule, from, to);
    const result = await dryRun(rule, sources);
    return {
      ruleId: rule.id,
      from,
      to,
      evaluated: result.evaluated,
      suppressed: result.suppressed,
      wouldHaveFired: result.wouldHaveFired
        .filter((m) => m.at >= from && m.at <= to)
        .map((m) => ({
          at: m.at,
          title: m.title,
          body: m.body,
          dedupeKey: m.dedupeKey,
          instrumentId: m.instrumentId,
          sourceRefs: m.sourceRefs,
        })),
      note,
    };
  }

  /** The caller's own rule; another user's reads as not found. */
  private async own(id: string, req: ApiRequest): Promise<AlertRuleRow> {
    const row = await this.alerts.rule(id);
    if (!row || row.owner_id !== req.user!.id) throw new ProblemError('NOT_FOUND', 'No such alert rule.');
    return row;
  }
}

/** Fired alerts of the user's rules. */
@Controller('alerts')
@Access('alerts.own')
export class AlertEventsController {
  constructor(private readonly alerts: AlertsRepository) {}

  @Get('events')
  events(
    @Query(new ZodPipe(AlertEventsQuerySchema)) q: z.infer<typeof AlertEventsQuerySchema>,
    @Req() req: ApiRequest,
  ): Promise<Page<AlertEvent>> {
    return this.alerts.events(req.user!.id, q);
  }
}

/** The user's inbox. Reading an item tells the user's other open apps (`notification.read`). */
@Controller('notifications')
@Access('alerts.own')
export class NotificationsController {
  constructor(
    private readonly alerts: AlertsRepository,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get()
  list(
    @Query(new ZodPipe(NotificationsQuerySchema)) q: z.infer<typeof NotificationsQuerySchema>,
    @Req() req: ApiRequest,
  ): Promise<Page<Notification> & { unread: number }> {
    return this.alerts.notifications(req.user!.id, q);
  }

  @Post('read-all')
  @HttpCode(200)
  async readAll(
    @Body(new ZodPipe(ReadAllRequestSchema)) body: z.infer<typeof ReadAllRequestSchema>,
    @Req() req: ApiRequest,
  ): Promise<{ read: number }> {
    const now = this.clock();
    const before = body.before ?? now;
    const read = await this.alerts.markAllRead(req.user!.id, before, now);
    if (read > 0) await this.announce(req.user!.id, { all: true, before });
    return { read };
  }

  @Post(':id/read')
  @HttpCode(204)
  async read(@Param('id', IdPipe) id: string, @Req() req: ApiRequest): Promise<void> {
    const changed = await this.alerts.markRead(req.user!.id, [id], this.clock());
    if (changed.length) await this.announce(req.user!.id, { ids: changed });
  }

  private async announce(userId: string, data: NotificationReadMessage): Promise<void> {
    await this.redis.xadd(
      ALERTS_STREAM,
      'MAXLEN',
      '~',
      ALERTS_STREAM_MAXLEN,
      '*',
      'type',
      'notification.read',
      'user',
      userId,
      'data',
      JSON.stringify(data),
    );
  }
}
