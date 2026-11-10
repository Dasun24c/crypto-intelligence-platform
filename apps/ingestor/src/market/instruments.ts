import type { Kysely } from 'kysely';
import {
  type Closure,
  generateClosures,
  GOLD_CLOSURE_RULE,
  type InstrumentRef,
  type VenueId,
} from '@cip/domain';
import type { Database } from '@cip/db';

export interface StreamedInstrument extends InstrumentRef {
  storeRawTrades: boolean;
}

/**
 * Enabled instruments that are not halted or delisted: the set the ingestor streams (architecture §5.5).
 * A halted or delisted pair stops its feed and keeps its history.
 */
export async function loadInstruments(
  db: Kysely<Database>,
  venues: readonly VenueId[] = ['binance', 'coinbase'],
): Promise<StreamedInstrument[]> {
  const rows = await db
    .selectFrom('market.instruments')
    .selectAll()
    .where('enabled', '=', true)
    .where('venue_status', 'not in', ['delisted', 'halted'])
    .where('venue_id', 'in', venues)
    .orderBy('venue_id')
    .orderBy('venue_symbol')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    venue: r.venue_id,
    venueSymbol: r.venue_symbol,
    base: r.base_asset,
    quote: r.quote_asset,
    assetClass: r.asset_class,
    role: r.role,
    priceTick: r.price_tick,
    qtyStep: r.qty_step,
    isPrimaryVenue: r.is_primary_venue,
    underlyingCalendarId: r.underlying_calendar_id,
    storeRawTrades: r.store_raw_trades,
  }));
}

/**
 * Gold-market closures for the closure flag: generated from the weekly rule, plus holidays an admin
 * entered (architecture §5.5). Covers a window around now and is refreshed hourly.
 */
export class ClosureCalendar {
  private closures: Closure[] = [];

  async refresh(db: Kysely<Database>, now: number): Promise<void> {
    const from = now - 7 * 86_400_000;
    const to = now + 8 * 7 * 86_400_000;
    const manual = await db
      .selectFrom('market.underlying_market_closures')
      .select(['starts_at', 'ends_at', 'reason'])
      .where('calendar_id', '=', 'gold')
      .where('source', '=', 'manual')
      .where('ends_at', '>', new Date(from))
      .execute();
    this.closures = [
      ...generateClosures(GOLD_CLOSURE_RULE, from, to),
      ...manual.map((m) => ({
        startsAt: m.starts_at.getTime(),
        endsAt: m.ends_at.getTime(),
        reason: m.reason,
      })),
    ];
  }

  /** The closure check for one instrument: always open unless it follows the gold calendar. */
  checkFor(instrument: InstrumentRef): (start: number, end: number) => boolean {
    if (instrument.underlyingCalendarId !== 'gold') return () => false;
    return (start, end) => this.closures.some((c) => c.startsAt < end && c.endsAt > start);
  }
}
