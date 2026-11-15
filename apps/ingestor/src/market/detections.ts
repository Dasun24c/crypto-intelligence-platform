import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import type { LargeTrade as WireLargeTrade, Wall as WireWall } from '@cip/contracts';
import type { Database } from '@cip/db';
import type { LargeTrade, Wall, WallEndReason } from '@cip/market-data';
import type { Logger } from '@cip/observability';
import { publishEvent } from './writers.js';

/**
 * Exchange-flow detections (architecture §5.6): stored, then announced on `md:events` so the API
 * gateway can deliver them on the durable `trades:{id}` and `market:{id}` channels.
 */
export class Detections {
  largeTrades = 0;
  wallsOpened = 0;
  wallsEnded = 0;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly redis: Redis,
    private readonly log: Logger,
  ) {}

  async largeTrade(instrumentId: string, t: LargeTrade): Promise<void> {
    const row: WireLargeTrade = {
      id: randomUUID(),
      instrumentId,
      ts: t.ts,
      takerSide: t.takerSide,
      avgPrice: t.avgPrice,
      qty: t.qty,
      notionalUsd: t.notionalUsd,
      grouping: t.grouping,
      fillCount: t.fillCount,
      priceLevels: t.priceLevels,
      thresholdUsd: t.thresholdUsd,
    };
    await this.db
      .insertInto('market.large_trades')
      .values({
        id: row.id,
        instrument_id: instrumentId,
        ts: new Date(t.ts),
        taker_side: t.takerSide,
        avg_price: t.avgPrice,
        qty: t.qty,
        notional_usd: t.notionalUsd,
        grouping: t.grouping,
        fill_count: t.fillCount,
        price_levels: t.priceLevels,
        threshold_usd: t.thresholdUsd,
      })
      .execute();
    await publishEvent(this.redis, 'trade.large', row);
    this.largeTrades++;
    this.log.info(
      { instrumentId, notionalUsd: t.notionalUsd, side: t.takerSide, grouping: t.grouping },
      'large trade',
    );
  }

  /** Stores a wall that has lasted long enough to report; returns its id. */
  async wallAppeared(instrumentId: string, w: Wall): Promise<string> {
    const id = randomUUID();
    await this.db
      .insertInto('market.orderbook_walls')
      .values({
        id,
        instrument_id: instrumentId,
        side: w.side,
        price: w.price,
        first_seen: new Date(w.firstSeen),
        last_seen: new Date(w.lastSeen),
        max_notional_usd: usd(w.maxNotionalUsd),
        ended_reason: null,
      })
      .execute();
    await publishEvent(this.redis, 'wall.appeared', wire(id, instrumentId, w, null));
    this.wallsOpened++;
    return id;
  }

  async wallEnded(instrumentId: string, id: string, w: Wall, reason: WallEndReason): Promise<void> {
    await this.db
      .updateTable('market.orderbook_walls')
      .set({
        last_seen: new Date(w.lastSeen),
        max_notional_usd: usd(w.maxNotionalUsd),
        ended_reason: reason,
      })
      .where('id', '=', id)
      .execute();
    await publishEvent(this.redis, 'wall.ended', wire(id, instrumentId, w, reason));
    this.wallsEnded++;
  }
}

function wire(id: string, instrumentId: string, w: Wall, reason: WallEndReason | null): WireWall {
  return {
    id,
    instrumentId,
    side: w.side,
    price: w.price,
    firstSeen: w.firstSeen,
    lastSeen: w.lastSeen,
    maxNotionalUsd: usd(w.maxNotionalUsd),
    endedReason: reason,
  };
}

/** A USD amount to the cent, in canonical decimal form. */
function usd(x: number): string {
  return String(Number(x.toFixed(2)));
}
