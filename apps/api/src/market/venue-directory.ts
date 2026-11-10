import { BinanceVenue, CoinbaseVenue, type PairStatus, RestStatusError } from '@cip/exchange-adapters';
import { ProblemError } from '../common/problem.js';

export const VENUE_DIRECTORY = Symbol('VENUE_DIRECTORY');

/**
 * Looks a pair up on its venue's public REST API before an admin adds it: Coinbase rejects a whole
 * subscription when one product id is unknown, so a typo must never reach the ingestor. Public,
 * read-only endpoints only; no credentials.
 */
export interface VenueDirectory {
  /** The pair as the venue lists it, or null when the venue does not know it. */
  lookup(venue: 'binance' | 'coinbase', symbol: string): Promise<PairStatus | null>;
}

export function publicVenueDirectory(): VenueDirectory {
  const hooks = { onEvent: () => undefined, onUnparsed: () => undefined, onStatus: () => undefined };
  const binance = new BinanceVenue(hooks);
  const coinbase = new CoinbaseVenue(hooks);
  return {
    async lookup(venue, symbol) {
      try {
        if (venue === 'binance') return (await binance.pairStatus([symbol]))[0] ?? null;
        return await coinbase.pairStatus(symbol);
      } catch (err) {
        if (err instanceof RestStatusError && (err.status === 400 || err.status === 404)) return null;
        throw new ProblemError('UNAVAILABLE', `${venue} could not be reached to check the symbol.`);
      }
    },
  };
}
