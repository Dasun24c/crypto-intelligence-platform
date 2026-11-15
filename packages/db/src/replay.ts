import type { Kysely } from 'kysely';
import { launchProfileFor } from './profiles.js';
import type { Database } from './types.js';

/**
 * Instruments of the replay venue (architecture principle 1): recorded Binance and Coinbase traffic
 * played back for tests, CI and demos. Never seeded by a migration, so production never has them;
 * the UI labels venue "replay" as a replay wherever it appears.
 */
export const REPLAY_INSTRUMENTS = [
  {
    id: '019a6f00-0000-7000-8000-000000000101',
    symbol: 'BTCUSDT',
    base: 'BTC',
    quote: 'USDT',
    assetClass: 'crypto',
    role: 'monitored',
    tick: '0.01',
    step: '0.00001',
    gold: false,
    primary: true,
  },
  {
    id: '019a6f00-0000-7000-8000-000000000102',
    symbol: 'PAXGUSDT',
    base: 'PAXG',
    quote: 'USDT',
    assetClass: 'tokenised_gold',
    role: 'monitored',
    tick: '0.01',
    step: '0.0001',
    gold: true,
    primary: true,
  },
  {
    id: '019a6f00-0000-7000-8000-000000000103',
    symbol: 'BTC-USD',
    base: 'BTC',
    quote: 'USD',
    assetClass: 'crypto',
    role: 'monitored',
    tick: '0.01',
    step: '0.00000001',
    gold: false,
    primary: false,
  },
  {
    id: '019a6f00-0000-7000-8000-000000000104',
    symbol: 'PAXG-USD',
    base: 'PAXG',
    quote: 'USD',
    assetClass: 'tokenised_gold',
    role: 'monitored',
    tick: '0.01',
    step: '0.00001',
    gold: true,
    primary: false,
  },
  {
    id: '019a6f00-0000-7000-8000-000000000105',
    symbol: 'USDT-USD',
    base: 'USDT',
    quote: 'USD',
    assetClass: 'stablecoin',
    role: 'reference',
    tick: '0.00001',
    step: '0.01',
    gold: false,
    primary: false,
  },
] as const;

/**
 * Inserts the replay instruments (idempotent) with their launch profile, and gives a profile to
 * replay instruments seeded before profiles existed. Run as the owner role.
 */
export async function seedReplayInstruments(db: Kysely<Database>): Promise<number> {
  const result = await db
    .insertInto('market.instruments')
    .values(
      REPLAY_INSTRUMENTS.map((i) => ({
        id: i.id,
        venue_id: 'replay' as const,
        venue_symbol: i.symbol,
        base_asset: i.base,
        quote_asset: i.quote,
        asset_class: i.assetClass,
        role: i.role,
        price_tick: i.tick,
        qty_step: i.step,
        profile_id: launchProfileFor(i.assetClass),
        underlying_calendar_id: i.gold ? 'gold' : null,
        is_primary_venue: i.primary,
        venue_status: 'trading' as const,
      })),
    )
    .onConflict((oc) =>
      oc
        .columns(['venue_id', 'venue_symbol'])
        .doUpdateSet((eb) => ({ profile_id: eb.ref('excluded.profile_id') }))
        .where('market.instruments.profile_id', 'is', null),
    )
    .executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0n);
}
