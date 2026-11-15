import { type Kysely, sql } from 'kysely';
import { aggregateCandles, type Candle, floorTo, TF_MS, TIMEFRAMES, type Timeframe } from '@cip/domain';
import type { CandleRow, Database, NewCandle } from './types.js';

/** Domain candle → `market.candles` row. */
export function candleToRow(instrumentId: string, c: Candle, finalizedAt: Date): NewCandle {
  return {
    instrument_id: instrumentId,
    timeframe: c.timeframe,
    open_time: new Date(c.openTime),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    quote_volume: c.quoteVolume,
    trade_count: c.tradeCount,
    taker_buy_volume: c.takerBuyVolume,
    micro_profile: c.microProfile,
    source: c.source,
    quality: c.quality,
    underlying_closed: c.underlyingClosed,
    finalized_at: finalizedAt,
  };
}

/** `market.candles` row → domain candle. */
export function rowToCandle(r: Omit<CandleRow, 'instrument_id' | 'finalized_at'>): Candle {
  return {
    timeframe: r.timeframe,
    openTime: r.open_time.getTime(),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
    quoteVolume: r.quote_volume,
    tradeCount: r.trade_count,
    takerBuyVolume: r.taker_buy_volume,
    microProfile: r.micro_profile,
    source: r.source,
    quality: r.quality,
    underlyingClosed: r.underlying_closed,
  };
}

/**
 * Recomputes every higher-timeframe candle whose period overlaps [from, to) from the stored 1m
 * candles. A candle that already exists is replaced only while it is `partial`: repairing a gap may
 * complete an aggregate, but a complete published candle never changes.
 */
export async function reaggregate(
  db: Kysely<Database>,
  instrumentId: string,
  from: number,
  to: number,
  now = new Date(),
): Promise<number> {
  let written = 0;
  for (const tf of TIMEFRAMES) {
    if (tf === '1m') continue;
    const first = floorTo(from, tf);
    const last = floorTo(to - 1, tf);
    // Only periods that have fully ended (the live writer produces the current one at its boundary).
    const end = Math.min(last + TF_MS[tf], floorTo(now.getTime(), tf));
    if (end <= first) continue;
    const minutes = await db
      .selectFrom('market.candles')
      .selectAll()
      .where('instrument_id', '=', instrumentId)
      .where('timeframe', '=', '1m')
      .where('open_time', '>=', new Date(first))
      .where('open_time', '<', new Date(end))
      .orderBy('open_time')
      .execute();
    const byPeriod = Map.groupBy(minutes, (m) => floorTo(m.open_time.getTime(), tf as Timeframe));
    for (const [openTime, rows] of byPeriod) {
      const parent = aggregateCandles(tf, openTime, rows.map(rowToCandle));
      const row = candleToRow(instrumentId, parent, now);
      await db
        .insertInto('market.candles')
        .values(row)
        .onConflict((oc) =>
          oc
            .columns(['instrument_id', 'timeframe', 'open_time'])
            .doUpdateSet(row)
            .where(sql<boolean>`market.candles.quality = 'partial'`),
        )
        .execute();
      written++;
    }
  }
  return written;
}
