import { Inject, Injectable } from '@nestjs/common';
import type { Kysely, Selectable } from 'kysely';
import {
  type BookMetrics,
  type Candle,
  type Closure,
  type CrossVenueSpread,
  type DataGap,
  type GapsQuery,
  type Instrument,
  type LargeTrade,
  type LargeTradesQuery,
  type Page,
  type Tf,
  type Wall,
} from '@cip/contracts';
import { displayName } from '@cip/domain';
import type { Database, InstrumentRow } from '@cip/db';
import { ProblemError } from '../common/problem.js';
import { DB } from '../tokens.js';

type ProfileRef = { profile_name: string | null; profile_version: number | null };

export function toInstrument(r: InstrumentRow & ProfileRef): Instrument {
  return {
    id: r.id,
    venue: r.venue_id,
    venueSymbol: r.venue_symbol,
    base: r.base_asset,
    quote: r.quote_asset,
    assetClass: r.asset_class,
    role: r.role,
    displayName: displayName({
      venue: r.venue_id,
      base: r.base_asset,
      quote: r.quote_asset,
      assetClass: r.asset_class,
    }),
    priceTick: r.price_tick,
    qtyStep: r.qty_step,
    isPrimaryVenue: r.is_primary_venue,
    venueStatus: r.venue_status,
    enabled: r.enabled,
    storeRawTrades: r.store_raw_trades,
    profile:
      r.profile_name !== null && r.profile_version !== null
        ? { name: r.profile_name, version: r.profile_version }
        : null,
    underlyingCalendar: r.underlying_calendar_id === 'gold' ? 'gold' : null,
  };
}

/** Keyset cursor for newest-first pages: "<epoch ms>_<uuid>". */
export function encodeCursor(ts: Date, id: string): string {
  return `${ts.getTime()}_${id}`;
}

export function decodeCursor(cursor: string): { ts: Date; id: string } {
  const match = /^(\d{1,15})_([0-9a-f-]{36})$/.exec(cursor);
  if (!match) throw new ProblemError('VALIDATION_FAILED', 'Invalid cursor.');
  return { ts: new Date(Number(match[1])), id: match[2]! };
}

/** Read access to stored market data (data model §4). Live values come from Redis, not from here. */
@Injectable()
export class MarketRepository {
  constructor(@Inject(DB) private readonly db: Kysely<Database>) {}

  private instrumentQuery() {
    return this.db
      .selectFrom('market.instruments as i')
      .leftJoin('market.instrument_profiles as p', 'p.id', 'i.profile_id')
      .selectAll('i')
      .select(['p.name as profile_name', 'p.version as profile_version']);
  }

  async instruments(opts: { includeDisabled: boolean }): Promise<Instrument[]> {
    let q = this.instrumentQuery().orderBy('i.venue_id').orderBy('i.venue_symbol');
    if (!opts.includeDisabled) q = q.where('i.enabled', '=', true);
    return (await q.execute()).map(toInstrument);
  }

  async instrument(id: string): Promise<Instrument | null> {
    const row = await this.instrumentQuery().where('i.id', '=', id).executeTakeFirst();
    return row ? toInstrument(row) : null;
  }

  /** The instrument, or a 404 problem. */
  async requireInstrument(id: string): Promise<Instrument> {
    const instrument = await this.instrument(id);
    if (!instrument) throw new ProblemError('NOT_FOUND', 'No such instrument.');
    return instrument;
  }

  /**
   * Candles oldest first. With `from`, the first `limit` from there; otherwise the latest `limit`
   * before `to` (or now).
   */
  async candles(id: string, tf: Tf, q: { from?: number; to?: number; limit: number }): Promise<Candle[]> {
    let query = this.db
      .selectFrom('market.candles')
      .select([
        'open_time',
        'open',
        'high',
        'low',
        'close',
        'volume',
        'quote_volume',
        'trade_count',
        'quality',
        'underlying_closed',
      ])
      .where('instrument_id', '=', id)
      .where('timeframe', '=', tf);
    if (q.from !== undefined) query = query.where('open_time', '>=', new Date(q.from));
    if (q.to !== undefined) query = query.where('open_time', '<', new Date(q.to));
    const ascending = q.from !== undefined;
    const rows = await query
      .orderBy('open_time', ascending ? 'asc' : 'desc')
      .limit(q.limit)
      .execute();
    if (!ascending) rows.reverse();
    return rows.map((r) => ({
      t: r.open_time.getTime(),
      o: r.open,
      h: r.high,
      l: r.low,
      c: r.close,
      v: r.volume,
      qv: r.quote_volume,
      n: r.trade_count,
      quality: r.quality,
      underlyingClosed: r.underlying_closed,
    }));
  }

  async bookMetrics(id: string, from: number, to: number): Promise<BookMetrics[]> {
    const rows = await this.db
      .selectFrom('market.orderbook_metrics')
      .selectAll()
      .where('instrument_id', '=', id)
      .where('ts', '>=', new Date(from))
      .where('ts', '<', new Date(to))
      .orderBy('ts')
      .execute();
    return rows.map((r) => ({
      ts: r.ts.getTime(),
      mid: r.mid,
      spreadBps: r.spread_bps,
      bidDepth10bp: r.bid_usd_10bp,
      askDepth10bp: r.ask_usd_10bp,
      bidDepth50bp: r.bid_usd_50bp,
      askDepth50bp: r.ask_usd_50bp,
      bidDepth100bp: r.bid_usd_100bp,
      askDepth100bp: r.ask_usd_100bp,
      imbalance10bp: r.imbalance_10bp,
      imbalance50bp: r.imbalance_50bp,
      imbalance100bp: r.imbalance_100bp,
      coverageBps: r.coverage_bps,
    }));
  }

  /** Newest first. */
  async largeTrades(id: string, q: LargeTradesQuery): Promise<Page<LargeTrade>> {
    let query = this.db.selectFrom('market.large_trades').selectAll().where('instrument_id', '=', id);
    if (q.from !== undefined) query = query.where('ts', '>=', new Date(q.from));
    if (q.to !== undefined) query = query.where('ts', '<', new Date(q.to));
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      query = query.where((eb) =>
        eb.or([eb('ts', '<', c.ts), eb.and([eb('ts', '=', c.ts), eb('id', '<', c.id)])]),
      );
    }
    const rows = await query
      .orderBy('ts', 'desc')
      .orderBy('id', 'desc')
      .limit(q.limit + 1)
      .execute();
    const items = rows.slice(0, q.limit);
    const last = items.at(-1);
    return {
      items: items.map((r) => ({
        id: r.id,
        instrumentId: r.instrument_id,
        ts: r.ts.getTime(),
        takerSide: r.taker_side,
        avgPrice: r.avg_price,
        qty: r.qty,
        notionalUsd: r.notional_usd,
        grouping: r.grouping,
        fillCount: r.fill_count,
        priceLevels: r.price_levels,
        thresholdUsd: r.threshold_usd,
      })),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.ts, last.id) : null,
    };
  }

  /** Walls first seen in [from, to), or (active) every wall still standing; newest first. */
  async walls(id: string, q: { from: number; to: number; active?: boolean }): Promise<Wall[]> {
    let query = this.db.selectFrom('market.orderbook_walls').selectAll().where('instrument_id', '=', id);
    if (q.active === true) query = query.where('ended_reason', 'is', null);
    else {
      query = query.where('first_seen', '>=', new Date(q.from)).where('first_seen', '<', new Date(q.to));
      if (q.active === false) query = query.where('ended_reason', 'is not', null);
    }
    const rows = await query.orderBy('first_seen', 'desc').limit(1_000).execute();
    return rows.map((r) => ({
      id: r.id,
      instrumentId: r.instrument_id,
      side: r.side,
      price: r.price,
      firstSeen: r.first_seen.getTime(),
      lastSeen: r.last_seen.getTime(),
      maxNotionalUsd: r.max_notional_usd,
      endedReason: r.ended_reason,
    }));
  }

  async spreads(baseAsset: string, from: number, to: number): Promise<CrossVenueSpread[]> {
    const rows = await this.db
      .selectFrom('market.cross_venue_spreads')
      .selectAll()
      .where('base_asset', '=', baseAsset)
      .where('ts', '>=', new Date(from))
      .where('ts', '<', new Date(to))
      .orderBy('ts')
      .execute();
    return rows.map((r) => ({
      baseAsset: r.base_asset,
      ts: r.ts.getTime(),
      primaryInstrumentId: r.primary_instrument_id,
      secondaryInstrumentId: r.secondary_instrument_id,
      primaryUsd: r.primary_usd,
      secondaryUsd: r.secondary_usd,
      usdtUsd: r.usdt_usd,
      spreadBps: r.spread_bps,
    }));
  }

  /** Newest first by detection time. */
  async gaps(q: GapsQuery): Promise<Page<DataGap>> {
    let query = this.db.selectFrom('market.data_gaps').selectAll();
    if (q.instrumentId) query = query.where('instrument_id', '=', q.instrumentId);
    if (q.status) query = query.where('status', '=', q.status);
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      query = query.where((eb) =>
        eb.or([eb('detected_at', '<', c.ts), eb.and([eb('detected_at', '=', c.ts), eb('id', '<', c.id)])]),
      );
    }
    const rows = await query
      .orderBy('detected_at', 'desc')
      .orderBy('id', 'desc')
      .limit(q.limit + 1)
      .execute();
    const items = rows.slice(0, q.limit);
    const last = items.at(-1);
    return {
      items: items.map(toGap),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.detected_at, last.id) : null,
    };
  }

  /** Open (or backfilling) gaps per instrument and stream, for feed status. */
  async openGapCounts(): Promise<Map<string, number>> {
    const rows = await this.db
      .selectFrom('market.data_gaps')
      .select(['instrument_id', 'stream'])
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('status', 'in', ['open', 'backfilling'])
      .groupBy(['instrument_id', 'stream'])
      .execute();
    return new Map(rows.map((r) => [`${r.instrument_id}:${r.stream}`, Number(r.n)]));
  }

  async closures(calendar: 'gold', from: number, to: number): Promise<Closure[]> {
    const rows = await this.db
      .selectFrom('market.underlying_market_closures')
      .selectAll()
      .where('calendar_id', '=', calendar)
      .where('ends_at', '>', new Date(from))
      .where('starts_at', '<', new Date(to))
      .orderBy('starts_at')
      .execute();
    return rows.map((r) => ({
      calendar,
      from: r.starts_at.getTime(),
      to: r.ends_at.getTime(),
      reason: r.reason,
      source: r.source,
    }));
  }
}

function toGap(r: Selectable<Database['market.data_gaps']>): DataGap {
  return {
    id: r.id,
    instrumentId: r.instrument_id,
    stream: r.stream,
    from: r.gap_start.getTime(),
    to: r.gap_end?.getTime() ?? null,
    detectedAt: r.detected_at.getTime(),
    detectedBy: r.detected_by,
    status: r.status,
    resolvedAt: r.resolved_at?.getTime() ?? null,
    details: r.details,
  };
}
