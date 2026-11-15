import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { CONFIG_CHANNELS } from '@cip/contracts';
import { generateClosures, GOLD_CLOSURE_RULE } from '@cip/domain';
import type { Database } from '@cip/db';
import {
  type BinanceVenue,
  type CoinbaseVenue,
  type PairStatus,
  RestStatusError,
} from '@cip/exchange-adapters';
import type { Logger } from '@cip/observability';

export const PAIR_STATUS = 'pair-status.refresh';
export const PAIR_STATUS_EVERY_MS = 5 * 60_000;
export const GENERATE_CLOSURES = 'closures.generate';
export const GENERATE_CLOSURES_EVERY_MS = 24 * 3_600_000;
/** Generated closures reach this far ahead (architecture §5.5: 8 weeks). */
const CLOSURE_HORIZON_MS = 56 * 86_400_000;

export interface MarketJobDeps {
  db: Kysely<Database>;
  redis: Redis;
  log: Logger;
  venues: { binance: Pick<BinanceVenue, 'pairStatus'>; coinbase: Pick<CoinbaseVenue, 'pairStatus'> };
  now?: () => number;
}

const unknownToVenue = (err: unknown) =>
  err instanceof RestStatusError && (err.status === 400 || err.status === 404);

/**
 * Pair status (architecture §5.5, MD-07), every 5 minutes: venue status, price tick and quantity
 * step from the venues' public REST APIs. A pair the venue no longer lists is delisted. A halted
 * or delisted pair stops its feed (the ingestor reloads on `config:instruments`), keeps its history,
 * and raises a health alert through a feed event.
 */
export async function refreshPairStatus(
  deps: MarketJobDeps,
): Promise<{ checked: number; changed: string[] }> {
  const { db, redis, log, venues } = deps;
  const now = deps.now?.() ?? Date.now();
  const rows = await db
    .selectFrom('market.instruments')
    .select(['id', 'venue_id', 'venue_symbol', 'venue_status', 'price_tick', 'qty_step'])
    .where('enabled', '=', true)
    .where('venue_id', 'in', ['binance', 'coinbase'])
    .execute();

  const found = new Map<string, PairStatus | null>();
  const binance = rows.filter((r) => r.venue_id === 'binance').map((r) => r.venue_symbol);
  if (binance.length > 0) {
    try {
      for (const s of await venues.binance.pairStatus(binance)) found.set(`binance:${s.symbol}`, s);
    } catch (err) {
      if (!unknownToVenue(err)) throw err;
      // One unknown symbol fails the whole batch: ask one by one to find it.
      for (const symbol of binance) {
        try {
          found.set(`binance:${symbol}`, (await venues.binance.pairStatus([symbol]))[0] ?? null);
        } catch (e) {
          if (!unknownToVenue(e)) throw e;
          found.set(`binance:${symbol}`, null);
        }
      }
    }
  }
  for (const r of rows.filter((x) => x.venue_id === 'coinbase')) {
    try {
      found.set(`coinbase:${r.venue_symbol}`, await venues.coinbase.pairStatus(r.venue_symbol));
    } catch (err) {
      if (!unknownToVenue(err)) throw err;
      found.set(`coinbase:${r.venue_symbol}`, null);
    }
  }

  const changed: string[] = [];
  let statusChanged = false;
  for (const r of rows) {
    const key = `${r.venue_id}:${r.venue_symbol}`;
    if (!found.has(key)) continue; // Binance answered for the batch but omitted it: try next time
    const pair = found.get(key) ?? null;
    const status = pair?.status ?? 'delisted';
    const tick = pair?.priceTick ?? r.price_tick;
    const step = pair?.qtyStep ?? r.qty_step;
    if (
      status === r.venue_status &&
      Number(tick) === Number(r.price_tick) &&
      Number(step) === Number(r.qty_step)
    )
      continue;
    changed.push(key);
    await db
      .updateTable('market.instruments')
      .set({ venue_status: status, price_tick: tick, qty_step: step, updated_at: new Date(now) })
      .where('id', '=', r.id)
      .execute();
    // The first confirmation of a new pair is not news; any other status change is.
    if (status === r.venue_status || (r.venue_status === 'unknown' && status === 'trading')) continue;
    statusChanged = true;
    log.warn({ instrument: key, from: r.venue_status, to: status }, 'pair status changed');
    await db
      .insertInto('market.feed_events')
      .values({
        ts: new Date(now),
        venue_id: r.venue_id,
        instrument_id: r.id,
        event: 'status_change',
        details: { from: r.venue_status, to: status },
      })
      .execute();
    await redis.xadd(
      'md:events',
      'MAXLEN',
      '~',
      '200000',
      '*',
      'type',
      'feed.status',
      'data',
      JSON.stringify({
        instrumentId: r.id,
        stream: 'trades',
        state: status === 'trading' ? 'connected' : 'disconnected',
        detail: status,
        previous: r.venue_status,
      }),
    );
  }
  if (statusChanged) await redis.publish(CONFIG_CHANNELS.instruments, 'pair-status');
  return { checked: rows.length, changed };
}

/**
 * The gold-market closure calendar (architecture §5.5, GLD-02): the weekly rule in America/New_York
 * written out 8 weeks ahead (and the past week), daily. Idempotent; admin holidays (source "manual") are left alone.
 */
export async function generateGoldClosures(db: Kysely<Database>, now = Date.now()): Promise<number> {
  // The trailing week too: charts shade recent closures, and flags are checked against them.
  const closures = generateClosures(GOLD_CLOSURE_RULE, now - 8 * 86_400_000, now + CLOSURE_HORIZON_MS);
  if (closures.length === 0) return 0;
  const result = await db
    .insertInto('market.underlying_market_closures')
    .values(
      closures.map((c) => ({
        calendar_id: 'gold',
        starts_at: new Date(c.startsAt),
        ends_at: new Date(c.endsAt),
        reason: c.reason,
        source: 'generated' as const,
      })),
    )
    .onConflict((oc) => oc.columns(['calendar_id', 'starts_at']).doNothing())
    .executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0n);
}
