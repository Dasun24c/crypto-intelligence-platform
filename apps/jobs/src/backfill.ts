import { UnrecoverableError } from 'bullmq';
import type { Redis } from 'ioredis';
import { type Kysely, sql } from 'kysely';
import {
  type Candle,
  flatCandle,
  floorTo,
  generateClosures,
  GOLD_CLOSURE_RULE,
  MINUTE_MS,
  mulDecimal,
  overlapsClosure,
  restSettledAt,
} from '@cip/domain';
import { candleToRow, type Database, reaggregate } from '@cip/db';
import type { BinanceVenue, CoinbaseVenue, RestCandle } from '@cip/exchange-adapters';
import type { Logger } from '@cip/observability';

export interface BackfillJob {
  id: string;
  instrumentId: string;
  stream: string;
  from: number;
  to: number;
}

/** Retrying cannot help (unknown instrument or gap): BullMQ stops at once. */
export class GapNotRepairable extends UnrecoverableError {}

/** The gap's last minute has not settled at the venue yet; the worker delays the job by `waitMs`. */
export class GapNotSettled extends Error {
  constructor(readonly waitMs: number) {
    super(`gap has not settled yet; ${waitMs} ms to go`);
  }
}

const PROFILE_BUCKETS_UNKNOWN = null;

/**
 * Repairs a recorded gap from the venue's REST candles (architecture §5.4): fetches the missing 1m
 * candles, fills the minutes Coinbase omits because nothing traded, stores what is missing (live
 * candles are kept), recomputes the higher timeframes, closes the gap and wakes the analyzer.
 * REST minutes have no micro profile: the thin-book rule treats them as unverified (rulebook §3.5).
 */
export class Backfiller {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly redis: Redis,
    private readonly log: Logger,
    private readonly venues: { binance: BinanceVenue; coinbase: CoinbaseVenue },
    private readonly profileBuckets = 24,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async run(job: BackfillJob): Promise<{ inserted: number; aggregates: number }> {
    const inst = await this.db
      .selectFrom('market.instruments')
      .selectAll()
      .where('id', '=', job.instrumentId)
      .executeTakeFirst();
    const gap = await this.db
      .selectFrom('market.data_gaps')
      .selectAll()
      .where('id', '=', job.id)
      .executeTakeFirst();
    if (!inst || !gap) throw new GapNotRepairable(`instrument or gap not found for ${job.id}`);
    if (inst.venue_id === 'replay') throw new GapNotRepairable('the replay venue has no history to fetch');
    if (gap.status === 'repaired') return { inserted: 0, aggregates: 0 };
    // Fetching before the last minute has closed would store a hole and still close the gap.
    const wait = this.waitMs(job);
    if (wait > 0) throw new GapNotSettled(wait);

    const from = floorTo(job.from, '1m');
    const to = Math.ceil(job.to / MINUTE_MS) * MINUTE_MS;
    if (to <= from) {
      await this.close(job.id, 'repaired', { note: 'nothing to fetch' });
      return { inserted: 0, aggregates: 0 };
    }
    await this.db
      .updateTable('market.data_gaps')
      .set({ status: 'backfilling' })
      .where('id', '=', job.id)
      .where('status', '=', 'open')
      .execute();

    const rows =
      inst.venue_id === 'binance'
        ? await this.fetchBinance(inst.venue_symbol, from, to)
        : inst.venue_id === 'coinbase'
          ? await this.fetchCoinbase(inst.venue_symbol, from, to)
          : [];
    if (inst.venue_id === 'binance' && rows.length === 0)
      throw new Error(`no klines returned for ${inst.venue_symbol}`);

    const closures =
      inst.underlying_calendar_id === 'gold'
        ? generateClosures(GOLD_CLOSURE_RULE, from - 86_400_000, to + 86_400_000)
        : [];
    const closed = (t: number) => overlapsClosure(t, t + MINUTE_MS, closures);
    // A gap found while streaming is a repair; history we simply had not loaded yet is plain venue data.
    const quality: Candle['quality'] = gap.detected_by === 'timer' ? 'complete' : 'repaired';
    const minutes = await this.toMinutes(
      inst.id,
      inst.venue_id === 'coinbase',
      rows,
      from,
      to,
      quality,
      closed,
    );

    let inserted = 0;
    const finalizedAt = new Date(this.now());
    for (let i = 0; i < minutes.length; i += 500) {
      const res = await this.db
        .insertInto('market.candles')
        .values(minutes.slice(i, i + 500).map((c) => candleToRow(inst.id, c, finalizedAt)))
        .onConflict((oc) => oc.doNothing())
        .executeTakeFirst();
      inserted += Number(res.numInsertedOrUpdatedRows ?? 0n);
    }
    const aggregates = await reaggregate(this.db, inst.id, from, to, finalizedAt);
    await this.close(job.id, 'repaired', { inserted, aggregates, restCandles: rows.length });
    await this.redis.xadd(
      `md:candles:${inst.id}`,
      'MAXLEN',
      '~',
      '11000',
      '*',
      'boundary',
      String(to),
      'tfs',
      'backfill',
      'from',
      String(from),
    );
    this.log.info(
      { gapId: job.id, instrument: inst.venue_symbol, from, to, inserted, aggregates },
      'gap repaired',
    );
    return { inserted, aggregates };
  }

  /** How long until the gap can be fetched: its last minute closed and settled (0 when ready). */
  waitMs(job: Pick<BackfillJob, 'to'>): number {
    return Math.max(0, restSettledAt(job.to) - this.now());
  }

  async markUnrepairable(gapId: string, reason: string): Promise<void> {
    await this.close(gapId, 'unrepairable', { reason });
  }

  private async close(
    gapId: string,
    status: 'repaired' | 'unrepairable',
    details: Record<string, unknown>,
  ): Promise<void> {
    const row = await this.db
      .updateTable('market.data_gaps')
      // Merged, so the reason the gap was recorded with is kept next to the outcome.
      .set({
        status,
        resolved_at: new Date(this.now()),
        details: sql<Record<string, unknown>>`details || ${JSON.stringify(details)}::jsonb`,
      })
      .where('id', '=', gapId)
      .returning('instrument_id')
      .executeTakeFirst();
    await this.redis.xadd(
      'md:events',
      'MAXLEN',
      '~',
      '200000',
      '*',
      'type',
      'gap.closed',
      'data',
      JSON.stringify({ gapId, instrumentId: row?.instrument_id ?? null, status, ...details }),
    );
  }

  private async fetchBinance(symbol: string, from: number, to: number): Promise<RestCandle[]> {
    const out: RestCandle[] = [];
    for (let start = from; start < to; start += 1_000 * MINUTE_MS) {
      out.push(
        ...(await this.venues.binance.klines(
          symbol,
          '1m',
          start,
          Math.min(to, start + 1_000 * MINUTE_MS) - 1,
        )),
      );
    }
    return out.filter((c) => c.openTime >= from && c.openTime < to);
  }

  private async fetchCoinbase(product: string, from: number, to: number): Promise<RestCandle[]> {
    const out: RestCandle[] = [];
    for (let start = from; start < to; start += 300 * MINUTE_MS) {
      out.push(
        ...(await this.venues.coinbase.candles(product, 60, start, Math.min(to, start + 300 * MINUTE_MS))),
      );
    }
    return out;
  }

  /** REST rows → 1m candles; Coinbase omits minutes without trades, which become flat candles. */
  private async toMinutes(
    instrumentId: string,
    fillEmpty: boolean,
    rows: RestCandle[],
    from: number,
    to: number,
    quality: Candle['quality'],
    closed: (t: number) => boolean,
  ): Promise<Candle[]> {
    const byTime = new Map(rows.map((r) => [r.openTime, r]));
    let previousClose =
      (
        await this.db
          .selectFrom('market.candles')
          .select('close')
          .where('instrument_id', '=', instrumentId)
          .where('timeframe', '=', '1m')
          .where('open_time', '<', new Date(from))
          .orderBy('open_time', 'desc')
          .limit(1)
          .executeTakeFirst()
      )?.close ??
      rows[0]?.open ??
      null;
    const out: Candle[] = [];
    for (let t = from; t < to; t += MINUTE_MS) {
      const r = byTime.get(t);
      if (r) {
        out.push({
          timeframe: '1m',
          openTime: t,
          open: r.open,
          high: r.high,
          low: r.low,
          close: r.close,
          volume: r.volume,
          // Coinbase REST candles carry no quote volume: volume × close stands in, on these repaired minutes only.
          quoteVolume: r.quoteVolume ?? mulDecimal(r.volume, r.close),
          tradeCount: r.tradeCount ?? null,
          takerBuyVolume: r.takerBuyVolume ?? null,
          microProfile: PROFILE_BUCKETS_UNKNOWN,
          source: 'rest',
          quality,
          underlyingClosed: closed(t),
        });
        previousClose = r.close;
      } else if (fillEmpty && previousClose !== null) {
        // Coinbase omits exactly the minutes without trades, so "no volume" is known here.
        out.push(
          flatCandle(t, previousClose, {
            source: 'rest',
            quality,
            underlyingClosed: closed(t),
            profileBuckets: this.profileBuckets,
          }),
        );
      }
    }
    return out;
  }
}
