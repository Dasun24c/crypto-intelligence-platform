import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { floorTo, MINUTE_MS, restSettledAt } from '@cip/domain';
import type { Database } from '@cip/db';
import type { BackfillJob } from './backfill.js';

export const HOLE_SWEEP = 'candles.holes';
/** Every 10 minutes: a lost minute holds analysis back (ADR 005) only until the next sweep and its repair. */
export const HOLE_SWEEP_EVERY_MS = 10 * 60_000;
const SWEEP_WINDOW_MS = 24 * 60 * 60_000;

/** A run of 1m candles missing from an instrument's stored history: [from, to). */
export interface Hole {
  instrumentId: string;
  from: number;
  to: number;
}

/**
 * The runs of 1m candles missing inside [from, to), within the span the instrument has history for
 * (nothing before its first stored minute or after its last counts). Every minute in that span must
 * exist: a minute without trades is stored flat, so a missing one is lost data.
 */
export async function findHoles(
  db: Kysely<Database>,
  instrumentId: string,
  from: number,
  to: number,
): Promise<Hole[]> {
  const span = await db
    .selectFrom('market.candles')
    .select((eb) => [eb.fn.min('open_time').as('first'), eb.fn.max('open_time').as('last')])
    .where('instrument_id', '=', instrumentId)
    .where('timeframe', '=', '1m')
    .executeTakeFirst();
  if (!span?.first || !span.last) return [];
  const start = Math.max(from, new Date(span.first).getTime());
  const end = Math.min(to, new Date(span.last).getTime() + MINUTE_MS);
  if (end <= start) return [];
  const stored = await db
    .selectFrom('market.candles')
    .select('open_time')
    .where('instrument_id', '=', instrumentId)
    .where('timeframe', '=', '1m')
    .where('open_time', '>=', new Date(start))
    .where('open_time', '<', new Date(end))
    .orderBy('open_time')
    .execute();
  const holes: Hole[] = [];
  let expected = start;
  for (const { open_time } of [...stored, { open_time: new Date(end) }]) {
    const t = open_time.getTime();
    if (t > expected) holes.push({ instrumentId, from: expected, to: t });
    expected = t + MINUTE_MS;
  }
  return holes;
}

/**
 * Records a hole as a data gap (detected by the consistency check) and queues its backfill, as the
 * ingestor does for the gaps it detects (architecture §5.4). Without this a minute lost before
 * anything noticed (an ingestor bug, a crash) would never be repaired, and analysis would wait at
 * it for ever (ADR 005). A hole that an open gap already covers is left to that gap.
 * Returns whether a gap was recorded.
 */
export function gapRepairer(
  db: Kysely<Database>,
  redis: Redis,
  queue: Pick<Queue<BackfillJob>, 'add'>,
  now: () => number = () => Date.now(),
): (hole: Hole) => Promise<boolean> {
  return async (hole) => {
    const open = await db
      .selectFrom('market.data_gaps')
      .select('id')
      .where('instrument_id', '=', hole.instrumentId)
      .where('stream', '=', 'kline')
      .where('status', 'in', ['open', 'backfilling'])
      .where('gap_start', '<', new Date(hole.to))
      .where((eb) => eb.or([eb('gap_end', 'is', null), eb('gap_end', '>', new Date(hole.from))]))
      .executeTakeFirst();
    if (open) return false;
    const id = randomUUID();
    const minutes = (hole.to - hole.from) / MINUTE_MS;
    await db
      .insertInto('market.data_gaps')
      .values({
        id,
        instrument_id: hole.instrumentId,
        stream: 'kline',
        gap_start: new Date(hole.from),
        gap_end: new Date(hole.to),
        detected_at: new Date(now()),
        detected_by: 'consistency_check',
        status: 'open',
        details: { reason: 'missing candles', minutes },
      })
      .execute();
    await redis.xadd(
      'md:events',
      'MAXLEN',
      '~',
      '200000',
      '*',
      'type',
      'gap.opened',
      'data',
      JSON.stringify({
        gapId: id,
        instrumentId: hole.instrumentId,
        stream: 'kline',
        from: hole.from,
        to: hole.to,
        detectedBy: 'consistency_check',
      }),
    );
    await queue.add(
      'gap',
      { id, instrumentId: hole.instrumentId, stream: 'kline', from: hole.from, to: hole.to },
      {
        jobId: `backfill:${hole.instrumentId}:${id}`,
        delay: Math.max(0, restSettledAt(hole.to) - now()),
        attempts: 8,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    );
    return true;
  };
}

/**
 * Checks the last 24 hours of every enabled venue instrument for holes and queues each one's repair.
 * The nightly consistency check does the same for the whole previous day; this catches a lost
 * minute within minutes, so analysis waiting at it resumes soon. Returns the gaps recorded.
 */
export async function sweepHoles(
  db: Kysely<Database>,
  repair: (hole: Hole) => Promise<boolean>,
  now: number,
): Promise<number> {
  const instruments = await db
    .selectFrom('market.instruments')
    .select('id')
    .where('enabled', '=', true)
    .where('venue_id', 'in', ['binance', 'coinbase'])
    .execute();
  // Up to the minute before the one in progress: the ingestor may still be writing the latest.
  const to = floorTo(now, '1m') - MINUTE_MS;
  let recorded = 0;
  for (const { id } of instruments)
    for (const hole of await findHoles(db, id, to - SWEEP_WINDOW_MS, to)) if (await repair(hole)) recorded++;
  return recorded;
}
