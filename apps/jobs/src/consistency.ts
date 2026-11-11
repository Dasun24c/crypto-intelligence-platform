import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { floorTo, normalizeDecimal, REST_SETTLE_MS, TF_MS, type Timeframe } from '@cip/domain';
import type { Database } from '@cip/db';
import type { BinanceVenue, CoinbaseVenue, RestCandle } from '@cip/exchange-adapters';
import type { Logger } from '@cip/observability';
import { findHoles, type Hole } from './gap-repairs.js';

export const CONSISTENCY_CHECK = 'consistency.check';
/** Nightly, for the previous UTC day (00:20 UTC leaves backfills of the last minutes time to finish). */
export const CONSISTENCY_PATTERN = '20 0 * * *';
const REPORT_TTL_S = 30 * 86_400;

/**
 * What is compared (architecture §5.2): Binance 1m, 1h, 4h and 1d must equal the venue's REST
 * klines exactly. Coinbase 1m, 1h and 1d are compared with REST candles: every interval with trades
 * must match, and a minute the venue omits (no trades) must be stored as a flat zero-volume candle.
 */
const PLAN: Record<'binance' | 'coinbase', { tf: Timeframe; granularity: number }[]> = {
  binance: [
    { tf: '1m', granularity: 60 },
    { tf: '1h', granularity: 3_600 },
    { tf: '4h', granularity: 14_400 },
    { tf: '1d', granularity: 86_400 },
  ],
  coinbase: [
    { tf: '1m', granularity: 60 },
    { tf: '1h', granularity: 3_600 },
    { tf: '1d', granularity: 86_400 },
  ],
};
const BINANCE_INTERVAL: Partial<Record<Timeframe, string>> = {
  '1m': '1m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
};

export interface Difference {
  t: number;
  kind: 'missing' | 'mismatch' | 'not_flat' | 'extra';
  fields?: Record<string, { stored: string | number | null; venue: string | number | null }>;
}

export interface ConsistencyResult {
  instrumentId: string;
  venue: 'binance' | 'coinbase';
  symbol: string;
  timeframe: Timeframe;
  compared: number;
  matched: number;
  /** Stored candles marked partial (incomplete aggregates): expected to differ, not counted as errors. */
  partial: number;
  differences: number;
  /** The first differences, as evidence. */
  samples: Difference[];
}

export interface ConsistencyReport {
  from: number;
  to: number;
  checkedAt: number;
  ok: boolean;
  results: ConsistencyResult[];
  /** 1m candles missing from our own history, whether or not the venue has them; each queued for repair. */
  holes: (Hole & { symbol: string; repairQueued: boolean })[];
}

export interface ConsistencyDeps {
  db: Kysely<Database>;
  redis?: Redis;
  log: Logger;
  venues: { binance: Pick<BinanceVenue, 'klines'>; coinbase: Pick<CoinbaseVenue, 'candles'> };
  now?: () => number;
  /** Records a hole as a gap and queues its backfill (gap-repairs.ts); without it holes are only reported. */
  repair?: (hole: Hole) => Promise<boolean>;
}

/** The previous UTC day. */
export function previousDay(now: number): { from: number; to: number } {
  const to = floorTo(now, '1d');
  return { from: to - TF_MS['1d'], to };
}

export async function checkConsistency(
  deps: ConsistencyDeps,
  requested: { from: number; to: number },
): Promise<ConsistencyReport> {
  // A day that has not ended (checked on demand) is checked up to the last minute the venues have
  // settled: they refuse ranges in the future, and the minute in progress has no final candle yet.
  const now = deps.now?.() ?? Date.now();
  const range = { from: requested.from, to: Math.min(requested.to, floorTo(now - REST_SETTLE_MS, '1m')) };
  const instruments = await deps.db
    .selectFrom('market.instruments')
    .select(['id', 'venue_id', 'venue_symbol'])
    .where('enabled', '=', true)
    .where('venue_id', 'in', ['binance', 'coinbase'])
    .orderBy('venue_id')
    .orderBy('venue_symbol')
    .execute();
  const results: ConsistencyResult[] = [];
  const holes: ConsistencyReport['holes'] = [];
  for (const inst of instruments) {
    const venue = inst.venue_id as 'binance' | 'coinbase';
    for (const { tf, granularity } of PLAN[venue]) {
      const venueRows = await fetchVenue(deps, venue, inst.venue_symbol, tf, granularity, range);
      results.push(await compare(deps.db, inst.id, venue, inst.venue_symbol, tf, range, venueRows));
    }
    // A missing minute is lost data even where the venue has no candle either (no trades then):
    // the comparison above cannot see it, so our own history is checked minute by minute.
    for (const hole of await findHoles(deps.db, inst.id, range.from, range.to))
      holes.push({ ...hole, symbol: inst.venue_symbol, repairQueued: (await deps.repair?.(hole)) ?? false });
  }
  const report: ConsistencyReport = {
    ...range,
    checkedAt: now,
    ok: results.every((r) => r.differences === 0) && holes.length === 0,
    results,
    holes,
  };
  const failing = results.filter((r) => r.differences > 0);
  deps.log[report.ok ? 'info' : 'warn'](
    {
      from: new Date(range.from).toISOString(),
      compared: results.reduce((a, r) => a + r.compared, 0),
      failing: failing.map((r) => `${r.venue}:${r.symbol}:${r.timeframe} (${r.differences})`),
      holes: holes.map(
        (h) => `${h.symbol} ${new Date(h.from).toISOString()} (${(h.to - h.from) / 60_000} min)`,
      ),
    },
    report.ok ? 'candles match the venues' : 'candles differ from the venues',
  );
  if (deps.redis) {
    const key = `consistency:report:${new Date(range.from).toISOString().slice(0, 10)}`;
    await deps.redis.set(key, JSON.stringify(report), 'EX', REPORT_TTL_S);
    await deps.redis.set('consistency:latest', key, 'EX', REPORT_TTL_S);
  }
  for (const r of failing)
    await deps.db
      .insertInto('market.feed_events')
      .values({
        ts: new Date(report.checkedAt),
        venue_id: r.venue,
        instrument_id: r.instrumentId,
        event: 'error',
        details: {
          check: 'consistency',
          timeframe: r.timeframe,
          from: range.from,
          to: range.to,
          differences: r.differences,
          samples: r.samples,
        },
      })
      .execute();
  return report;
}

async function fetchVenue(
  deps: ConsistencyDeps,
  venue: 'binance' | 'coinbase',
  symbol: string,
  tf: Timeframe,
  granularity: number,
  range: { from: number; to: number },
): Promise<RestCandle[]> {
  const step = TF_MS[tf];
  const out: RestCandle[] = [];
  if (venue === 'binance') {
    for (let start = range.from; start < range.to; start += 1_000 * step)
      out.push(
        ...(await deps.venues.binance.klines(
          symbol,
          BINANCE_INTERVAL[tf]!,
          start,
          Math.min(range.to, start + 1_000 * step) - 1,
        )),
      );
  } else {
    for (let start = range.from; start < range.to; start += 300 * step)
      out.push(
        ...(await deps.venues.coinbase.candles(
          symbol,
          granularity,
          start,
          Math.min(range.to, start + 300 * step),
        )),
      );
  }
  // Only periods that have ended: the venue also returns the one in progress.
  return out.filter((c) => c.openTime >= range.from && c.openTime + step <= range.to);
}

async function compare(
  db: Kysely<Database>,
  instrumentId: string,
  venue: 'binance' | 'coinbase',
  symbol: string,
  tf: Timeframe,
  range: { from: number; to: number },
  venueRows: RestCandle[],
): Promise<ConsistencyResult> {
  const stored = await db
    .selectFrom('market.candles')
    .select(['open_time', 'open', 'high', 'low', 'close', 'volume', 'quote_volume', 'trade_count', 'quality'])
    .where('instrument_id', '=', instrumentId)
    .where('timeframe', '=', tf)
    .where('open_time', '>=', new Date(range.from))
    .where('open_time', '<=', new Date(range.to - TF_MS[tf]))
    .execute();
  const byTime = new Map(stored.map((s) => [s.open_time.getTime(), s]));
  const venueTimes = new Set(venueRows.map((v) => v.openTime));
  const result: ConsistencyResult = {
    instrumentId,
    venue,
    symbol,
    timeframe: tf,
    compared: 0,
    matched: 0,
    partial: 0,
    differences: 0,
    samples: [],
  };
  const differ = (d: Difference) => {
    result.differences++;
    if (result.samples.length < 10) result.samples.push(d);
  };

  for (const v of venueRows) {
    result.compared++;
    const s = byTime.get(v.openTime);
    if (!s) {
      differ({ t: v.openTime, kind: 'missing' });
      continue;
    }
    if (s.quality === 'partial') {
      result.partial++;
      continue;
    }
    const fields: Difference['fields'] = {};
    const check = (
      name: string,
      mine: string | number | null,
      theirs: string | number | null | undefined,
    ) => {
      if (theirs === undefined) return; // the venue does not publish it (Coinbase quote volume, trade count)
      const a = typeof mine === 'string' ? normalizeDecimal(mine) : mine;
      const b = typeof theirs === 'string' ? normalizeDecimal(theirs) : theirs;
      if (a !== b) fields[name] = { stored: a, venue: b };
    };
    check('open', s.open, v.open);
    check('high', s.high, v.high);
    check('low', s.low, v.low);
    check('close', s.close, v.close);
    check('volume', s.volume, v.volume);
    if (venue === 'binance') {
      check('quoteVolume', s.quote_volume, v.quoteVolume);
      check('tradeCount', s.trade_count, v.tradeCount);
    }
    if (Object.keys(fields).length > 0) differ({ t: v.openTime, kind: 'mismatch', fields });
    else result.matched++;
  }

  // Coinbase omits intervals without trades: those must be stored flat with zero volume.
  for (const s of stored) {
    const t = s.open_time.getTime();
    if (venueTimes.has(t)) continue;
    if (
      venue === 'coinbase' &&
      normalizeDecimal(s.volume) === '0' &&
      s.open === s.close &&
      s.high === s.low
    ) {
      result.matched++;
      result.compared++;
    } else if (venue === 'coinbase') {
      result.compared++;
      differ({ t, kind: 'not_flat', fields: { volume: { stored: s.volume, venue: '0' } } });
    } else {
      result.compared++;
      differ({ t, kind: 'extra' });
    }
  }
  return result;
}
