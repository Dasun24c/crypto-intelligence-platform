import { UnrecoverableError } from 'bullmq';
import type { Redis } from 'ioredis';
import { type Kysely, sql } from 'kysely';
import {
  type Candle,
  floorTo,
  generateClosures,
  GOLD_CLOSURE_RULE,
  isTimeframe,
  MINUTE_MS,
  overlapsClosure,
  restSettledAt,
  TF_MS,
  type Timeframe,
} from '@cip/domain';
import { candleToRow, type Database, type DataGapRow, type InstrumentRow, reaggregate } from '@cip/db';
import type { BinanceVenue, CoinbaseVenue, RestCandle } from '@cip/exchange-adapters';
import type { Logger } from '@cip/observability';
import { aggregateRest, type ClosureCheck, fromRest } from './rest-candles.js';

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

/** Candles per request: Binance klines allow 1,000, Coinbase candles 300. */
const BINANCE_PAGE = 1_000;
const COINBASE_PAGE = 300;
const INSERT_BATCH = 500;
const DAY_MS = 86_400_000;

/**
 * Repairs a recorded gap from the venue's REST candles (architecture §5.4): fetches the missing 1m
 * candles, fills the minutes Coinbase omits because nothing traded, stores what is missing (live
 * candles are kept), recomputes the higher timeframes, closes the gap and wakes the analyzer.
 * REST minutes have no micro profile: the thin-book rule treats them as unverified (rulebook §3.5).
 * A gap recorded for one higher timeframe (deep history, `details.timeframe`) is fetched at that
 * timeframe instead.
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
    const tf = gapTimeframe(gap);
    if (tf !== '1m') return this.fillHistory(inst, gap, tf, job);

    const from = floorTo(job.from, '1m');
    const to = Math.ceil(job.to / MINUTE_MS) * MINUTE_MS;
    if (to <= from) {
      await this.close(job.id, 'repaired', { note: 'nothing to fetch' });
      return { inserted: 0, aggregates: 0 };
    }
    await this.markBackfilling(job.id);

    const rows =
      inst.venue_id === 'binance'
        ? await this.fetchBinance(inst.venue_symbol, '1m', from, to)
        : inst.venue_id === 'coinbase'
          ? await this.fetchCoinbase(inst.venue_symbol, '1m', from, to)
          : [];
    if (inst.venue_id === 'binance' && rows.length === 0)
      throw new Error(`no klines returned for ${inst.venue_symbol}`);

    const minutes = fromRest(rows, {
      timeframe: '1m',
      from,
      to,
      fillEmpty: inst.venue_id === 'coinbase',
      previousClose: (await this.closeBefore(inst.id, '1m', from)) ?? rows[0]?.open ?? null,
      quality: qualityOf(gap),
      closed: closureCheck(inst, from, to),
      profileBuckets: this.profileBuckets,
    });

    let inserted = 0;
    const finalizedAt = new Date(this.now());
    for (let i = 0; i < minutes.length; i += INSERT_BATCH) {
      const res = await this.db
        .insertInto('market.candles')
        .values(minutes.slice(i, i + INSERT_BATCH).map((c) => candleToRow(inst.id, c, finalizedAt)))
        .onConflict((oc) => oc.doNothing())
        .executeTakeFirst();
      inserted += Number(res.numInsertedOrUpdatedRows ?? 0n);
    }
    const aggregates = await reaggregate(this.db, inst.id, from, to, finalizedAt);
    await this.close(job.id, 'repaired', { inserted, aggregates, restCandles: rows.length });
    await this.wake(inst.id, from, to);
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

  /**
   * Deep history (architecture §7 warm-up): the 1m history reaches back only BACKFILL_DAYS, too few
   * candles for the higher timeframes, so the ingestor records a gap per timeframe and it is filled
   * from the venue's candles at that timeframe. Coinbase has no 4h candles: four 1h candles make one.
   * These candles replace partial aggregates (the first one of the 1m history usually is) but never a
   * complete candle, and nothing is re-aggregated. A venue without candles for part of the range (the
   * pair was listed later) is not an error: what it has is stored and the gap is closed with a note.
   */
  private async fillHistory(
    inst: InstrumentRow,
    gap: DataGapRow,
    tf: Timeframe,
    job: BackfillJob,
  ): Promise<{ inserted: number; aggregates: number }> {
    // Whole periods only: the ingestor records the range up to the last period that has ended.
    const from = floorTo(job.from, tf);
    const to = floorTo(job.to, tf);
    if (to <= from) {
      await this.close(job.id, 'repaired', { note: 'nothing to fetch' });
      return { inserted: 0, aggregates: 0 };
    }
    await this.markBackfilling(job.id);

    const coinbase = inst.venue_id === 'coinbase';
    const fetched: Timeframe = coinbase && tf === '4h' ? '1h' : tf;
    const rows = coinbase
      ? await this.fetchCoinbase(inst.venue_symbol, fetched, from, to)
      : await this.fetchBinance(inst.venue_symbol, fetched, from, to);

    const previousClose = await this.closeBefore(inst.id, tf, from);
    // Before the venue's first candle the pair may not have been listed yet, and flat candles there
    // would invent history. Only a stored candle before the range shows that it was already trading.
    const firstRest = rows.reduce((first, r) => Math.min(first, r.openTime), to);
    const closed = closureCheck(inst, from, to);
    const built = fromRest(rows, {
      timeframe: fetched,
      from: previousClose === null ? firstRest : from,
      to,
      fillEmpty: coinbase,
      previousClose,
      quality: qualityOf(gap),
      closed,
      profileBuckets: this.profileBuckets,
    });
    const candles = fetched === tf ? built : aggregateRest(tf, built, closed);
    const inserted = await this.upsert(inst.id, candles, new Date(this.now()));

    const periods = (to - from) / TF_MS[tf];
    const note =
      candles.length === 0
        ? 'the venue has no candles for this range'
        : candles.length < periods
          ? `the venue has candles for ${candles.length} of ${periods} periods, from ${new Date(candles[0]!.openTime).toISOString()}`
          : null;
    await this.close(job.id, 'repaired', { inserted, restCandles: rows.length, ...(note ? { note } : {}) });
    await this.wake(inst.id, from, to);
    this.log.info(
      { gapId: job.id, instrument: inst.venue_symbol, timeframe: tf, from, to, inserted, note },
      'gap repaired',
    );
    return { inserted, aggregates: 0 };
  }

  /**
   * Stores candles of a higher timeframe. One that exists already is replaced only while it is
   * partial, like an aggregate of incomplete 1m history; a complete candle never changes.
   */
  private async upsert(instrumentId: string, candles: readonly Candle[], finalizedAt: Date): Promise<number> {
    let written = 0;
    for (let i = 0; i < candles.length; i += INSERT_BATCH) {
      const res = await this.db
        .insertInto('market.candles')
        .values(candles.slice(i, i + INSERT_BATCH).map((c) => candleToRow(instrumentId, c, finalizedAt)))
        .onConflict((oc) =>
          oc
            .columns(['instrument_id', 'timeframe', 'open_time'])
            .doUpdateSet((eb) => ({
              open: eb.ref('excluded.open'),
              high: eb.ref('excluded.high'),
              low: eb.ref('excluded.low'),
              close: eb.ref('excluded.close'),
              volume: eb.ref('excluded.volume'),
              quote_volume: eb.ref('excluded.quote_volume'),
              trade_count: eb.ref('excluded.trade_count'),
              taker_buy_volume: eb.ref('excluded.taker_buy_volume'),
              micro_profile: eb.ref('excluded.micro_profile'),
              source: eb.ref('excluded.source'),
              quality: eb.ref('excluded.quality'),
              underlying_closed: eb.ref('excluded.underlying_closed'),
              finalized_at: eb.ref('excluded.finalized_at'),
            }))
            .where(sql<boolean>`market.candles.quality = 'partial'`),
        )
        .executeTakeFirst();
      written += Number(res.numInsertedOrUpdatedRows ?? 0n);
    }
    return written;
  }

  private async markBackfilling(gapId: string): Promise<void> {
    await this.db
      .updateTable('market.data_gaps')
      .set({ status: 'backfilling' })
      .where('id', '=', gapId)
      .where('status', '=', 'open')
      .execute();
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

  /** Wakes the analyzer: stored candles changed before `to` (a backfill wake-up names no timeframe). */
  private async wake(instrumentId: string, from: number, to: number): Promise<void> {
    await this.redis.xadd(
      `md:candles:${instrumentId}`,
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
  }

  /** The close of the last stored `tf` candle before `t`, or null when there is none. */
  private async closeBefore(instrumentId: string, tf: Timeframe, t: number): Promise<string | null> {
    const row = await this.db
      .selectFrom('market.candles')
      .select('close')
      .where('instrument_id', '=', instrumentId)
      .where('timeframe', '=', tf)
      .where('open_time', '<', new Date(t))
      .orderBy('open_time', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row?.close ?? null;
  }

  /** Binance klines of `tf` in [from, to), 1,000 per request. */
  private async fetchBinance(symbol: string, tf: Timeframe, from: number, to: number): Promise<RestCandle[]> {
    const page = BINANCE_PAGE * TF_MS[tf];
    const out: RestCandle[] = [];
    for (let start = from; start < to; start += page) {
      out.push(...(await this.venues.binance.klines(symbol, tf, start, Math.min(to, start + page) - 1)));
    }
    return out.filter((c) => c.openTime >= from && c.openTime < to);
  }

  /** Coinbase candles of `tf` in [from, to), 300 per request; Coinbase names granularity in seconds. */
  private async fetchCoinbase(
    product: string,
    tf: Timeframe,
    from: number,
    to: number,
  ): Promise<RestCandle[]> {
    const page = COINBASE_PAGE * TF_MS[tf];
    const out: RestCandle[] = [];
    for (let start = from; start < to; start += page) {
      out.push(
        ...(await this.venues.coinbase.candles(product, TF_MS[tf] / 1000, start, Math.min(to, start + page))),
      );
    }
    return out;
  }
}

/** The timeframe a gap is fetched at: its own for a deep-history gap, 1m for every other gap. */
function gapTimeframe(gap: Pick<DataGapRow, 'details'>): Timeframe {
  const tf = gap.details['timeframe'];
  if (tf === undefined || tf === null) return '1m';
  if (typeof tf !== 'string' || !isTimeframe(tf))
    throw new GapNotRepairable(`unknown timeframe ${JSON.stringify(tf)}`);
  return tf;
}

/** A gap found while streaming is a repair; history we simply had not loaded yet is plain venue data. */
function qualityOf(gap: Pick<DataGapRow, 'detected_by'>): Candle['quality'] {
  return gap.detected_by === 'timer' ? 'complete' : 'repaired';
}

/** Gold instruments flag every candle whose period overlaps a closure (rulebook §3.6). */
function closureCheck(
  inst: Pick<InstrumentRow, 'underlying_calendar_id'>,
  from: number,
  to: number,
): ClosureCheck {
  if (inst.underlying_calendar_id !== 'gold') return () => false;
  const closures = generateClosures(GOLD_CLOSURE_RULE, from - DAY_MS, to + DAY_MS);
  return (start, end) => overlapsClosure(start, end, closures);
}
