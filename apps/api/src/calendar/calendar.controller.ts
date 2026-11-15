import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Injectable,
  type OnModuleDestroy,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import {
  CALENDAR_MAX_WINDOW_MS,
  CALENDAR_SYNC_JOB,
  type CalendarEventsQuery,
  CalendarEventsQuerySchema,
  type CalendarStatus,
  type CalendarUpdated,
  CONFIG_CHANNELS,
  type CreateEconomicEventRequest,
  CreateEconomicEventRequestSchema,
  type EconomicEvent,
  type UpdateEconomicEventRequest,
  UpdateEconomicEventRequestSchema,
} from '@cip/contracts';
import type { Database, EconomicEventRow } from '@cip/db';
import { type AuditEvent, AuditService } from '../audit/audit.service.js';
import { Access, type ApiRequest, clientIp, userAgent } from '../common/access.js';
import { ProblemError } from '../common/problem.js';
import { ZodPipe } from '../common/zod.pipe.js';
import type { ApiConfig } from '../config.js';
import { API_CONFIG, CLOCK, type Clock, DB, REDIS } from '../tokens.js';
import { CalendarRepository, toEconomicEvent } from './calendar.repository.js';

const DAY_MS = 86_400_000;
/** The jobs service's maintenance queue, which runs the calendar sync. */
const MAINTENANCE_QUEUE = 'maintenance';

/** Puts a calendar sync on the jobs service's queue; one waiting request at a time. */
@Injectable()
export class CalendarSyncQueue implements OnModuleDestroy {
  private readonly connection: Redis;
  private readonly queue: Queue;

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    this.connection = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: null,
      connectionName: 'cip-api-calendar',
      lazyConnect: true,
    });
    this.queue = new Queue(MAINTENANCE_QUEUE, { connection: this.connection, prefix: config.QUEUE_PREFIX });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    this.connection.disconnect();
  }

  async request(): Promise<void> {
    await this.queue.add(
      CALENDAR_SYNC_JOB,
      {},
      { jobId: 'calendar-sync-requested', attempts: 1, removeOnComplete: true, removeOnFail: 100 },
    );
  }
}

function event(
  req: ApiRequest,
  action: string,
  targetId: string,
  details: Record<string, unknown>,
): AuditEvent {
  return {
    actorType: 'user',
    actorUserId: req.user?.id ?? null,
    action,
    targetType: 'economic_event',
    targetId,
    ip: clientIp(req),
    userAgent: userAgent(req),
    details,
  };
}

const IdPipe = new ZodPipe(z.uuid());

/**
 * The economic calendar (API contracts §3 "Calendar"; Phase 7). Anyone who sees dashboards reads it;
 * admins enter what no source publishes (FOMC statements) and correct their own entries. Synced
 * events follow their source. Rows are kept for the engine's history: removing an entry cancels it.
 */
@Controller('calendar')
@Access('dashboards.view')
export class CalendarController {
  constructor(
    private readonly calendar: CalendarRepository,
    private readonly syncQueue: CalendarSyncQueue,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** By default the last day and the next 60. */
  @Get('events')
  async events(
    @Query(new ZodPipe(CalendarEventsQuerySchema)) q: CalendarEventsQuery,
  ): Promise<EconomicEvent[]> {
    const now = this.clock();
    const from = q.from ?? (q.to !== undefined ? q.to - 61 * DAY_MS : now - DAY_MS);
    const to = q.to ?? from + 61 * DAY_MS;
    if (to - from > CALENDAR_MAX_WINDOW_MS)
      throw new ProblemError('VALIDATION_FAILED', 'The window may cover at most 400 days.');
    return this.calendar.events(from, to, q.minImpact);
  }

  @Get('status')
  status(): Promise<CalendarStatus> {
    return this.calendar.status(this.clock());
  }

  @Post('events')
  @HttpCode(201)
  @Access('settings.manage')
  async create(
    @Body(new ZodPipe(CreateEconomicEventRequestSchema)) body: CreateEconomicEventRequest,
    @Req() req: ApiRequest,
  ): Promise<EconomicEvent> {
    const row = await this.db.transaction().execute(async (trx) => {
      const created = await this.calendar.create(trx, body, req.user!.id);
      await this.audit.record(event(req, 'calendar_event.created', created.id, describe(created)), trx);
      return created;
    });
    await this.announce();
    return toEconomicEvent(row);
  }

  @Patch('events/:id')
  @Access('settings.manage')
  async update(
    @Param('id', IdPipe) id: string,
    @Body(new ZodPipe(UpdateEconomicEventRequestSchema)) body: UpdateEconomicEventRequest,
    @Req() req: ApiRequest,
  ): Promise<EconomicEvent> {
    const before = await this.manual(id);
    const row = await this.db.transaction().execute(async (trx) => {
      const updated = await this.calendar.update(trx, id, body);
      await this.audit.record(
        event(req, 'calendar_event.updated', id, { before: describe(before), after: describe(updated) }),
        trx,
      );
      return updated;
    });
    await this.announce();
    return toEconomicEvent(row);
  }

  @Delete('events/:id')
  @HttpCode(204)
  @Access('settings.manage')
  async remove(@Param('id', IdPipe) id: string, @Req() req: ApiRequest): Promise<void> {
    const before = await this.manual(id);
    await this.db.transaction().execute(async (trx) => {
      await this.calendar.cancel(trx, id);
      await this.audit.record(event(req, 'calendar_event.cancelled', id, describe(before)), trx);
    });
    await this.announce();
  }

  /** Queues a sync now (the jobs service runs it); the result shows in `GET /calendar/status`. */
  @Post('sync')
  @HttpCode(202)
  @Access('settings.manage')
  async sync(@Req() req: ApiRequest): Promise<{ queued: true }> {
    await this.syncQueue.request();
    await this.audit.record(event(req, 'calendar.sync_requested', 'calendar', {}));
    return { queued: true };
  }

  /** An admin's own entry that is still on the calendar. */
  private async manual(id: string): Promise<EconomicEventRow> {
    const row = await this.calendar.find(id);
    if (!row || row.status === 'cancelled') throw new ProblemError('NOT_FOUND', 'No such calendar entry.');
    if (row.source !== 'manual')
      throw new ProblemError(
        'CONFLICT',
        `This entry is synced from ${row.source === 'fred' ? 'FRED' : 'BEA'} and follows its source.`,
      );
    return row;
  }

  /** The analyzer reloads the calendar; the API tells clients on the `calendar` channel. */
  private async announce(): Promise<void> {
    const message: CalendarUpdated = { at: this.clock(), reason: 'manual', changed: 1 };
    await this.redis.publish(CONFIG_CHANNELS.calendar, JSON.stringify(message));
  }
}

function describe(r: EconomicEventRow): Record<string, unknown> {
  return {
    title: r.title,
    release: r.release,
    impact: r.impact,
    scheduledAt: r.scheduled_at.getTime(),
    timeConfirmed: r.time_confirmed,
    currency: r.currency,
  };
}
