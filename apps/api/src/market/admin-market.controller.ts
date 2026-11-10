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
import {
  CONFIG_CHANNELS,
  type Closure,
  type CreateClosureRequest,
  CreateClosureRequestSchema,
  type CreateInstrumentRequest,
  CreateInstrumentRequestSchema,
  DeleteClosureQuerySchema,
  type Instrument,
  type UpdateInstrumentRequest,
  UpdateInstrumentRequestSchema,
} from '@cip/contracts';
import type { Database, InstrumentRow } from '@cip/db';
import { AuditService, type AuditEvent } from '../audit/audit.service.js';
import { Access, type ApiRequest, clientIp, userAgent } from '../common/access.js';
import { ProblemError } from '../common/problem.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { CLOCK, type Clock, DB, REDIS } from '../tokens.js';
import { MarketRepository } from './market.repository.js';
import { VENUE_DIRECTORY, type VenueDirectory } from './venue-directory.js';

const IdPipe = new ZodPipe(z.uuid());

function event(
  req: ApiRequest,
  action: string,
  targetType: string,
  targetId: string,
  details: Record<string, unknown>,
): AuditEvent {
  return {
    actorType: 'user',
    actorUserId: req.user?.id ?? null,
    action,
    targetType,
    targetId,
    ip: clientIp(req),
    userAgent: userAgent(req),
    details,
  };
}

const isUniqueViolation = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';

/**
 * Instrument administration (MD-02, MD-07): adding one streams it without a restart and backfills
 * its history; disabling it stops its feed. Every change is audited in the same transaction.
 */
@Controller('admin/instruments')
@Access('instruments.manage')
export class AdminInstrumentsController {
  constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(VENUE_DIRECTORY) private readonly venues: VenueDirectory,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly market: MarketRepository,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(): Promise<Instrument[]> {
    return this.market.instruments({ includeDisabled: true });
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body(new ZodPipe(CreateInstrumentRequestSchema)) body: CreateInstrumentRequest,
    @Req() req: ApiRequest,
  ): Promise<Instrument> {
    const pair = await this.venues.lookup(body.venue, body.venueSymbol);
    if (!pair)
      throw new ProblemError('VALIDATION_FAILED', `${body.venue} does not list ${body.venueSymbol}.`);
    if (pair.status !== 'trading')
      throw new ProblemError('CONFLICT', `${body.venueSymbol} is ${pair.status} on ${body.venue}.`);
    const id = uuidv7();
    try {
      await this.db.transaction().execute(async (trx) => {
        if (body.isPrimaryVenue) await this.clearPrimary(trx, body.base, null);
        await trx
          .insertInto('market.instruments')
          .values({
            id,
            venue_id: body.venue,
            venue_symbol: pair.symbol,
            base_asset: body.base,
            quote_asset: body.quote,
            asset_class: body.assetClass,
            role: body.role,
            price_tick: pair.priceTick,
            qty_step: pair.qtyStep,
            profile_id: null,
            underlying_calendar_id: body.underlyingCalendar,
            is_primary_venue: body.isPrimaryVenue,
            store_raw_trades: body.storeRawTrades,
            venue_status: 'trading',
          })
          .execute();
        await this.audit.record(
          event(req, 'instrument.created', 'instrument', id, {
            venue: body.venue,
            venueSymbol: pair.symbol,
            base: body.base,
            quote: body.quote,
            role: body.role,
            isPrimaryVenue: body.isPrimaryVenue,
          }),
          trx,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ProblemError('CONFLICT', `${body.venueSymbol} on ${body.venue} already exists.`);
      throw err;
    }
    await this.redis.publish(CONFIG_CHANNELS.instruments, id);
    return this.market.requireInstrument(id);
  }

  @Patch(':id')
  async update(
    @Param('id', IdPipe) id: string,
    @Body(new ZodPipe(UpdateInstrumentRequestSchema)) body: UpdateInstrumentRequest,
    @Req() req: ApiRequest,
  ): Promise<Instrument> {
    await this.db.transaction().execute(async (trx) => {
      const before = await trx
        .selectFrom('market.instruments')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!before) throw new ProblemError('NOT_FOUND', 'No such instrument.');
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const set: Partial<Pick<InstrumentRow, 'enabled' | 'is_primary_venue' | 'role' | 'store_raw_trades'>> =
        {};
      const change = <K extends keyof typeof set>(key: K, name: string, to: InstrumentRow[K] | undefined) => {
        if (to === undefined || to === before[key]) return;
        set[key] = to;
        changes[name] = { from: before[key], to };
      };
      change('enabled', 'enabled', body.enabled);
      change('is_primary_venue', 'isPrimaryVenue', body.isPrimaryVenue);
      change('role', 'role', body.role);
      change('store_raw_trades', 'storeRawTrades', body.storeRawTrades);
      if (Object.keys(set).length === 0) return;
      if (set.is_primary_venue) await this.clearPrimary(trx, before.base_asset, id);
      await trx
        .updateTable('market.instruments')
        .set({ ...set, updated_at: new Date(this.clock()) })
        .where('id', '=', id)
        .execute();
      await this.audit.record(
        event(req, 'instrument.updated', 'instrument', id, { venueSymbol: before.venue_symbol, changes }),
        trx,
      );
    });
    await this.redis.publish(CONFIG_CHANNELS.instruments, id);
    return this.market.requireInstrument(id);
  }

  /** One primary venue per base asset: making one primary demotes the others. */
  private async clearPrimary(trx: Kysely<Database>, base: string, except: string | null): Promise<void> {
    let q = trx
      .updateTable('market.instruments')
      .set({ is_primary_venue: false, updated_at: new Date(this.clock()) })
      .where('base_asset', '=', base)
      .where('is_primary_venue', '=', true);
    if (except) q = q.where('id', '!=', except);
    await q.execute();
  }
}

/** Gold-market holidays (GLD-02); the weekly rule is generated by the jobs service. */
@Controller('admin/closures')
@Access('settings.manage')
export class AdminClosuresController {
  constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @HttpCode(201)
  async create(
    @Body(new ZodPipe(CreateClosureRequestSchema)) body: CreateClosureRequest,
    @Req() req: ApiRequest,
  ): Promise<Closure> {
    try {
      await this.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('market.underlying_market_closures')
          .values({
            calendar_id: body.calendar,
            starts_at: new Date(body.from),
            ends_at: new Date(body.to),
            reason: 'holiday',
            source: 'manual',
          })
          .execute();
        await this.audit.record(
          event(req, 'closure.created', 'closure', `${body.calendar}:${body.from}`, {
            from: body.from,
            to: body.to,
          }),
          trx,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ProblemError('CONFLICT', 'A closure already starts at that time.');
      throw err;
    }
    await this.redis.publish(CONFIG_CHANNELS.closures, body.calendar);
    return { calendar: body.calendar, from: body.from, to: body.to, reason: 'holiday', source: 'manual' };
  }

  @Delete()
  @HttpCode(204)
  async remove(
    @Query(new ZodPipe(DeleteClosureQuerySchema)) q: { calendar: 'gold'; from: number },
    @Req() req: ApiRequest,
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const deleted = await trx
        .deleteFrom('market.underlying_market_closures')
        .where('calendar_id', '=', q.calendar)
        .where('starts_at', '=', new Date(q.from))
        .where('source', '=', 'manual')
        .returning(['starts_at', 'ends_at'])
        .executeTakeFirst();
      if (!deleted) throw new ProblemError('NOT_FOUND', 'No holiday starts at that time.');
      await this.audit.record(
        event(req, 'closure.deleted', 'closure', `${q.calendar}:${q.from}`, {
          from: deleted.starts_at.getTime(),
          to: deleted.ends_at.getTime(),
        }),
        trx,
      );
    });
    await this.redis.publish(CONFIG_CHANNELS.closures, q.calendar);
  }
}
