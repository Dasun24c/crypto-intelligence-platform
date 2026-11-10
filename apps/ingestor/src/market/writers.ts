import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { aggregateCandles, type Candle, floorTo, TF_MS, timeframesClosingAt } from '@cip/domain';
import { candleToRow, type Database, rowToCandle } from '@cip/db';
import type { Logger } from '@cip/observability';

/** Redis stream names (architecture §6). */
export const candleStream = (instrumentId: string) => `md:candles:${instrumentId}`;
export const MD_EVENTS = 'md:events';
// About seven days of entries: one per minute per instrument, and a generous bound for md:events.
const CANDLE_STREAM_MAXLEN = 11_000;
const EVENTS_MAXLEN = 200_000;

/**
 * Stores final candles (architecture §5.2): the 1m candle and every higher timeframe that closes at
 * the same boundary, aggregated from the stored 1m candles, in one transaction; then a wake-up entry
 * on `md:candles:{id}`. Live writes never overwrite an existing candle: published candles don't change.
 */
export class CandleWriter {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly redis: Redis,
    private readonly log: Logger,
  ) {}

  /** Returns the 1m candle and the aggregates computed with it (for `candle.closed` messages). */
  async writeMinute(instrumentId: string, minute: Candle, now = Date.now()): Promise<Candle[]> {
    if (minute.timeframe !== '1m') throw new Error('writeMinute takes 1m candles');
    const boundary = minute.openTime + TF_MS['1m'];
    const closing = timeframesClosingAt(boundary);
    const finalizedAt = new Date(now);
    const written: Candle[] = [minute];
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('market.candles')
        .values(candleToRow(instrumentId, minute, finalizedAt))
        .onConflict((oc) => oc.doNothing())
        .execute();
      for (const tf of closing) {
        if (tf === '1m') continue;
        const openTime = floorTo(minute.openTime, tf);
        const rows = await trx
          .selectFrom('market.candles')
          .selectAll()
          .where('instrument_id', '=', instrumentId)
          .where('timeframe', '=', '1m')
          .where('open_time', '>=', new Date(openTime))
          .where('open_time', '<', new Date(boundary))
          .execute();
        const parent = aggregateCandles(tf, openTime, rows.map(rowToCandle));
        written.push(parent);
        await trx
          .insertInto('market.candles')
          .values(candleToRow(instrumentId, parent, finalizedAt))
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
    });
    await this.redis.xadd(
      candleStream(instrumentId),
      'MAXLEN',
      '~',
      String(CANDLE_STREAM_MAXLEN),
      '*',
      'boundary',
      String(boundary),
      'tfs',
      closing.join(','),
    );
    this.log.debug({ instrumentId, boundary, closing }, 'candles final');
    return written;
  }

  /** Stored 1m candles from `from`, oldest first (to seed the candles in progress after a start). */
  async minutesSince(instrumentId: string, from: number): Promise<Candle[]> {
    const rows = await this.db
      .selectFrom('market.candles')
      .selectAll()
      .where('instrument_id', '=', instrumentId)
      .where('timeframe', '=', '1m')
      .where('open_time', '>=', new Date(from))
      .orderBy('open_time')
      .execute();
    return rows.map(rowToCandle);
  }

  async lastClose(instrumentId: string): Promise<{ close: string; openTime: number } | null> {
    const row = await this.db
      .selectFrom('market.candles')
      .select(['close', 'open_time'])
      .where('instrument_id', '=', instrumentId)
      .where('timeframe', '=', '1m')
      .orderBy('open_time', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row ? { close: row.close, openTime: row.open_time.getTime() } : null;
  }
}

/** Appends to `md:events` (gaps, feed status, large trades, walls, spreads). */
export async function publishEvent(
  redis: Redis,
  type: string,
  payload: Record<string, unknown>,
): Promise<string | null> {
  return redis.xadd(
    MD_EVENTS,
    'MAXLEN',
    '~',
    String(EVENTS_MAXLEN),
    '*',
    'type',
    type,
    'data',
    JSON.stringify(payload),
  );
}

/** Collects rows and inserts them in batches every `intervalMs` (trades, book metrics, snapshots). */
export class BatchWriter<Row> {
  private rows: Row[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  written = 0;
  failed = 0;

  constructor(
    private readonly insert: (rows: Row[]) => Promise<void>,
    private readonly log: Logger,
    private readonly name: string,
    private readonly intervalMs = 1_000,
    private readonly maxPending = 50_000,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.flush(), this.intervalMs);
    this.timer.unref();
  }

  add(row: Row): void {
    if (this.rows.length >= this.maxPending) this.rows.shift();
    this.rows.push(row);
  }

  async flush(): Promise<void> {
    if (this.rows.length === 0) return;
    const batch = this.rows;
    this.rows = [];
    try {
      for (let i = 0; i < batch.length; i += 1_000) await this.insert(batch.slice(i, i + 1_000));
      this.written += batch.length;
    } catch (err) {
      this.failed += batch.length;
      this.log.error({ err, writer: this.name, rows: batch.length }, 'batch insert failed');
    }
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }
}

export type GapStream = 'trades' | 'depth' | 'kline' | 'ticker';
export type GapDetector = 'sequence' | 'heartbeat' | 'timer' | 'reconnect' | 'consistency_check';

/** Records data gaps (architecture §5.4) and announces them; backfill picks them up from the queue. */
export class GapRecorder {
  openGaps = 0;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly redis: Redis,
    private readonly log: Logger,
    private readonly enqueueBackfill: (gap: {
      id: string;
      instrumentId: string;
      stream: GapStream;
      from: number;
      to: number;
    }) => Promise<void>,
  ) {}

  async record(gap: {
    instrumentId: string;
    stream: GapStream;
    from: number;
    to: number | null;
    detectedBy: GapDetector;
    details?: Record<string, unknown>;
    now?: number;
  }): Promise<string> {
    const id = randomUUID();
    const now = gap.now ?? Date.now();
    await this.db
      .insertInto('market.data_gaps')
      .values({
        id,
        instrument_id: gap.instrumentId,
        stream: gap.stream,
        gap_start: new Date(gap.from),
        gap_end: gap.to === null ? null : new Date(gap.to),
        detected_at: new Date(now),
        detected_by: gap.detectedBy,
        status: 'open',
        details: gap.details ?? {},
      })
      .execute();
    this.openGaps++;
    await publishEvent(this.redis, 'gap.opened', {
      gapId: id,
      instrumentId: gap.instrumentId,
      stream: gap.stream,
      from: gap.from,
      to: gap.to,
      detectedBy: gap.detectedBy,
    });
    this.log.warn({ gapId: id, ...gap }, 'data gap recorded');
    await this.enqueueBackfill({
      id,
      instrumentId: gap.instrumentId,
      stream: gap.stream,
      from: gap.from,
      to: gap.to ?? now,
    }).catch((err: unknown) => this.log.error({ err, gapId: id }, 'could not enqueue backfill'));
    return id;
  }
}
