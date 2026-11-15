export type VenueId = 'binance' | 'coinbase' | 'replay';
export type AssetClass = 'crypto' | 'tokenised_gold' | 'stablecoin';
export type InstrumentRole = 'monitored' | 'reference';
export type VenueStatus = 'trading' | 'halted' | 'delisted' | 'unknown';

/** The fields of an instrument the pure packages need (data model §4). */
export interface InstrumentRef {
  id: string;
  venue: VenueId;
  venueSymbol: string;
  base: string;
  quote: string;
  assetClass: AssetClass;
  role: InstrumentRole;
  priceTick: string;
  qtyStep: string;
  isPrimaryVenue: boolean;
  underlyingCalendarId: string | null;
}

const VENUE_NAMES: Record<VenueId, string> = { binance: 'Binance', coinbase: 'Coinbase', replay: 'Replay' };

/**
 * The label shown everywhere (GLD-05): PAXG is always "PAXG (gold-backed token)", never XAUUSD or
 * "gold", so nobody mistakes the token for spot gold.
 */
export function displayName(i: Pick<InstrumentRef, 'venue' | 'base' | 'quote' | 'assetClass'>): string {
  const asset = i.assetClass === 'tokenised_gold' ? `${i.base} (gold-backed token)` : i.base;
  return `${asset} · ${VENUE_NAMES[i.venue]} ${i.base}/${i.quote}`;
}
