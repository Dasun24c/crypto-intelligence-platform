import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Candle } from '@cip/domain';
import { createDb } from './client.js';
import { candleToRow, reaggregate, rowToCandle } from './market.js';
import { REPLAY_INSTRUMENTS, seedReplayInstruments } from './replay.js';
import type { Database } from './types.js';

const SOL = '019a6f00-0000-7000-8000-000000000003';
const H = Date.UTC(2026, 10, 4, 10, 0); // a Wednesday hour: one 1h period, twelve 5m periods

let owner: Kysely<Database>;
let jobs: Kysely<Database>;

beforeAll(() => {
  owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 2 });
  jobs = createDb({ connectionString: inject('dbRoleUrls').svc_jobs, max: 2 });
});
afterAll(async () => {
  await owner.destroy();
  await jobs.destroy();
});

function minute(i: number, close: string): Candle {
  return {
    timeframe: '1m',
    openTime: H + i * 60_000,
    open: close,
    high: close,
    low: close,
    close,
    volume: '1',
    quoteVolume: close,
    tradeCount: 2,
    takerBuyVolume: '0.5',
    microProfile: [1, 0],
    source: 'exchange_kline',
    quality: 'complete',
    underlyingClosed: false,
  };
}

describe('candle rows', () => {
  it('round-trips a candle through its table row unchanged', async () => {
    const c = minute(0, '150.25');
    await jobs
      .insertInto('market.candles')
      .values(candleToRow(SOL, c, new Date(H + 61_000)))
      .execute();
    const row = await owner
      .selectFrom('market.candles')
      .selectAll()
      .where('instrument_id', '=', SOL)
      .where('timeframe', '=', '1m')
      .where('open_time', '=', new Date(H))
      .executeTakeFirstOrThrow();
    expect(rowToCandle(row)).toEqual(c);
    expect(row.finalized_at.getTime()).toBe(H + 61_000);
  });
});

describe('reaggregate', () => {
  it('builds the higher timeframes of ended periods from stored minutes, completing partial ones only', async () => {
    // Minutes 1–4 arrive after minute 0 (stored above): the 10:00 5m candle was partial, now complete.
    await owner
      .insertInto('market.candles')
      .values({
        ...candleToRow(SOL, { ...minute(0, '1'), timeframe: '5m', quality: 'partial' }, new Date(H)),
      })
      .execute();
    for (const i of [1, 2, 3, 4])
      await jobs
        .insertInto('market.candles')
        .values(candleToRow(SOL, minute(i, String(150 + i)), new Date()))
        .execute();

    const now = new Date(H + 7 * 60_000);
    const written = await reaggregate(jobs, SOL, H, H + 5 * 60_000, now);
    expect(written).toBe(1); // only 5m has ended by 10:07; 15m, 1h, 4h and 1d have not
    const five = await owner
      .selectFrom('market.candles')
      .select(['open', 'high', 'low', 'close', 'volume', 'quality', 'source'])
      .where('instrument_id', '=', SOL)
      .where('timeframe', '=', '5m')
      .where('open_time', '=', new Date(H))
      .executeTakeFirstOrThrow();
    expect(five).toEqual({
      open: '150.25',
      high: '154',
      low: '150.25',
      close: '154',
      volume: '5',
      quality: 'complete',
      source: 'aggregated',
    });

    // A complete published candle is never rewritten, even if its minutes change later.
    await owner
      .updateTable('market.candles')
      .set({ close: '999' })
      .where('instrument_id', '=', SOL)
      .where('timeframe', '=', '1m')
      .where('open_time', '=', new Date(H + 4 * 60_000))
      .execute();
    await reaggregate(jobs, SOL, H, H + 5 * 60_000, now);
    const again = await owner
      .selectFrom('market.candles')
      .select('close')
      .where('instrument_id', '=', SOL)
      .where('timeframe', '=', '5m')
      .where('open_time', '=', new Date(H))
      .executeTakeFirstOrThrow();
    expect(again.close).toBe('154');
    expect(await reaggregate(jobs, SOL, H, H, now)).toBe(0); // an empty range writes nothing
  });
});

describe('replay instruments', () => {
  it('are seeded idempotently on the replay venue, never as live instruments', async () => {
    expect(await seedReplayInstruments(owner)).toBe(REPLAY_INSTRUMENTS.length);
    expect(await seedReplayInstruments(owner)).toBe(0);
    const rows = await owner
      .selectFrom('market.instruments')
      .select(['venue_id', 'venue_symbol', 'is_primary_venue', 'underlying_calendar_id'])
      .where('venue_id', '=', 'replay')
      .orderBy('venue_symbol')
      .execute();
    expect(rows.map((r) => r.venue_symbol)).toEqual([
      'BTC-USD',
      'BTCUSDT',
      'PAXG-USD',
      'PAXGUSDT',
      'USDT-USD',
    ]);
    expect(rows.find((r) => r.venue_symbol === 'PAXGUSDT')).toMatchObject({
      is_primary_venue: true,
      underlying_calendar_id: 'gold',
    });
  });
});
