import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import {
  type BookMetrics,
  BookQuerySchema,
  type BookSnapshot,
  BookSnapshotSchema,
  type Candle,
  type CandlesQuery,
  CandlesQuerySchema,
  type Closure,
  type ClosuresQuery,
  ClosuresQuerySchema,
  type CrossVenueSpread,
  type DataGap,
  type GapsQuery,
  GapsQuerySchema,
  type Instrument,
  type LargeTrade,
  type LargeTradesQuery,
  LargeTradesQuerySchema,
  type Page,
  type RangeQuery,
  RangeQuerySchema,
  type Ticker,
  TickerSchema,
  type Wall,
  type WallsQuery,
  WallsQuerySchema,
} from '@cip/contracts';
import { Access } from '../common/access.js';
import { ProblemError } from '../common/problem.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { CLOCK, type Clock, REDIS } from '../tokens.js';
import { MarketRepository } from './market.repository.js';

const IdPipe = new ZodPipe(z.uuid());
const BasePipe = new ZodPipe(z.string().regex(/^[A-Z0-9]{2,10}$/, 'an asset symbol such as PAXG'));
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Resolves an optional [from, to) with a default span ending now, and refuses spans above `max`. */
function range(q: { from?: number; to?: number }, now: number, span: number, max: number) {
  const to = q.to ?? (q.from !== undefined ? Math.min(now, q.from + span) : now);
  const from = q.from ?? to - span;
  if (to <= from) throw new ProblemError('VALIDATION_FAILED', '`to` must be after `from`.');
  if (to - from > max)
    throw new ProblemError('VALIDATION_FAILED', `The range may span at most ${max / HOUR} h.`);
  return { from, to };
}

/** Market data (API contracts §3): stored history from PostgreSQL, live values from Redis. */
@Controller()
@Access('dashboards.view')
export class MarketController {
  constructor(
    private readonly market: MarketRepository,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get('instruments')
  instruments(): Promise<Instrument[]> {
    return this.market.instruments({ includeDisabled: false });
  }

  @Get('market/gaps')
  gaps(@Query(new ZodPipe(GapsQuerySchema)) q: GapsQuery): Promise<Page<DataGap>> {
    return this.market.gaps(q);
  }

  @Get('market/closures')
  closures(@Query(new ZodPipe(ClosuresQuerySchema)) q: ClosuresQuery): Promise<Closure[]> {
    const now = this.clock();
    const { from, to } = range(
      { from: q.from ?? now - 7 * DAY, to: q.to ?? now + 56 * DAY },
      now,
      63 * DAY,
      120 * DAY,
    );
    return this.market.closures(q.calendar, from, to);
  }

  @Get('market/spreads/:baseAsset')
  spreads(
    @Param('baseAsset', BasePipe) baseAsset: string,
    @Query(new ZodPipe(RangeQuerySchema)) q: RangeQuery,
  ): Promise<CrossVenueSpread[]> {
    const { from, to } = range(q, this.clock(), HOUR, DAY);
    return this.market.spreads(baseAsset, from, to);
  }

  @Get('market/:instrumentId/candles')
  async candles(
    @Param('instrumentId', IdPipe) id: string,
    @Query(new ZodPipe(CandlesQuerySchema)) q: CandlesQuery,
  ): Promise<Candle[]> {
    await this.market.requireInstrument(id);
    if (q.from !== undefined && q.to !== undefined && q.to <= q.from)
      throw new ProblemError('VALIDATION_FAILED', '`to` must be after `from`.');
    return this.market.candles(id, q.tf, q);
  }

  @Get('market/:instrumentId/ticker')
  async ticker(@Param('instrumentId', IdPipe) id: string): Promise<Ticker> {
    await this.market.requireInstrument(id);
    return TickerSchema.parse(await this.live(`ticker:${id}`));
  }

  @Get('market/:instrumentId/book')
  async book(
    @Param('instrumentId', IdPipe) id: string,
    @Query(new ZodPipe(BookQuerySchema)) q: { depth: number },
  ): Promise<BookSnapshot> {
    await this.market.requireInstrument(id);
    const book = BookSnapshotSchema.parse(await this.live(`book:${id}`));
    return { ...book, bids: book.bids.slice(0, q.depth), asks: book.asks.slice(0, q.depth) };
  }

  @Get('market/:instrumentId/book/metrics')
  async bookMetrics(
    @Param('instrumentId', IdPipe) id: string,
    @Query(new ZodPipe(RangeQuerySchema)) q: RangeQuery,
  ): Promise<BookMetrics[]> {
    await this.market.requireInstrument(id);
    const { from, to } = range(q, this.clock(), 15 * MINUTE, 6 * HOUR);
    return this.market.bookMetrics(id, from, to);
  }

  @Get('market/:instrumentId/large-trades')
  async largeTrades(
    @Param('instrumentId', IdPipe) id: string,
    @Query(new ZodPipe(LargeTradesQuerySchema)) q: LargeTradesQuery,
  ): Promise<Page<LargeTrade>> {
    await this.market.requireInstrument(id);
    return this.market.largeTrades(id, q);
  }

  @Get('market/:instrumentId/walls')
  async walls(
    @Param('instrumentId', IdPipe) id: string,
    @Query(new ZodPipe(WallsQuerySchema)) q: WallsQuery,
  ): Promise<Wall[]> {
    await this.market.requireInstrument(id);
    const { from, to } = range(q, this.clock(), DAY, 7 * DAY);
    return this.market.walls(id, { from, to, ...(q.active !== undefined ? { active: q.active } : {}) });
  }

  /** The ingestor's latest value; absent when the feed is not streaming (keys expire within 60 s). */
  private async live(key: string): Promise<unknown> {
    const raw = await this.redis.get(key);
    if (raw === null)
      throw new ProblemError('UNAVAILABLE', 'No live data for this instrument: its feed is not streaming.');
    return JSON.parse(raw) as unknown;
  }
}
