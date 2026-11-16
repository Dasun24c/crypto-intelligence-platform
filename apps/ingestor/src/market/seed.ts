import { type Kysely, sql } from 'kysely';
import type { Database } from '@cip/db';
import { type LargeTradeDetector, NOTIONAL_BIN_RATIO } from '@cip/market-data';
import type { Logger } from '@cip/observability';

/** Taker orders in one hour and one log-notional bin: what `LargeTradeDetector.seed` takes. */
export interface OrderBinRow {
  hour: number;
  bin: number;
  count: number;
}

/** A seed that has not finished by then is abandoned: the detector starts on its floor instead. */
export const SEED_TIMEOUT_MS = 120_000;
const DAY_MS = 86_400_000;

/**
 * Hourly log-binned counts of taker-order notional over the day of stored trades before `until`,
 * binned exactly as `notionalBin` does. Coinbase fills are grouped by taker order; a Binance aggTrade
 * is already one taker order at one price (sweeps are not merged here: a small low bias that leaves
 * the window within a day). `usdPerQuote` converts USDT at the USDT-USD rate.
 *
 * A busy pair has millions of trades a day (Coinbase BTC-USD: 2.7M, about 20 s with five parallel
 * workers and 1 GB of temporary files on 2026-11-16). It runs as a background read: no parallel
 * workers and a statement timeout, both set for this transaction only, so the pooled connection keeps
 * its defaults.
 */
export async function orderBins(
  db: Kysely<Database>,
  instrumentId: string,
  until: number,
  usdPerQuote: number,
  timeoutMs = SEED_TIMEOUT_MS,
): Promise<OrderBinRow[]> {
  const since = new Date(until - DAY_MS);
  const end = new Date(until);
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('max_parallel_workers_per_gather', '0', true),
                     set_config('statement_timeout', ${String(timeoutMs)}, true)`.execute(trx);
    const { rows } = await sql<OrderBinRow>`
      WITH orders AS (
        SELECT ts, price * qty AS notional FROM market.trades
        WHERE instrument_id = ${instrumentId} AND ts > ${since} AND ts <= ${end} AND taker_order_ref IS NULL
        UNION ALL
        SELECT min(ts), sum(price * qty) FROM market.trades
        WHERE instrument_id = ${instrumentId} AND ts > ${since} AND ts <= ${end} AND taker_order_ref IS NOT NULL
        GROUP BY taker_order_ref
      )
      SELECT floor(extract(epoch FROM ts) / 3600)::int AS hour,
             greatest(0, floor(ln(greatest(notional * ${usdPerQuote}, 1)) / ln(${NOTIONAL_BIN_RATIO})))::int AS bin,
             count(*)::int AS count
      FROM orders GROUP BY 1, 2`.execute(trx);
    return rows;
  });
}

/**
 * Seeds the large-trade detectors from stored trades, one instrument at a time. A start used to run
 * every instrument's seed at once through the write pool. On 2026-11-16 nine of them held all four
 * write connections for minutes, so 187 batch inserts failed and the database ran at about 300% CPU.
 */
export class LargeTradeSeeder {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly bins: (
      instrumentId: string,
      until: number,
      usdPerQuote: number,
    ) => Promise<OrderBinRow[]>,
    private readonly log: Logger,
  ) {}

  /**
   * Queues one detector's seed behind the others. The window ends at `until`, when the pipeline
   * started observing live orders, so a seed that waits its turn does not count them twice. The USD
   * rate is read when the seed runs. The detector starts once its seed is in, or has failed (then its
   * floor applies until live orders fill the window). The returned promise never rejects.
   */
  add(
    instrument: { id: string; venueSymbol: string },
    detector: Pick<LargeTradeDetector, 'seed' | 'start'>,
    until: number,
    usdPerQuote: () => number,
  ): Promise<void> {
    this.queue = this.queue.then(async () => {
      try {
        detector.seed(await this.bins(instrument.id, until, usdPerQuote()));
      } catch (err) {
        this.log.warn({ err, instrument: instrument.venueSymbol }, 'large-trade seed failed');
      } finally {
        detector.start();
      }
    });
    return this.queue;
  }
}
