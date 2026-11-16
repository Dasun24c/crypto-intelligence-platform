import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDb, type NewTrade } from '@cip/db';
import { HOUR_MS, notionalBin } from '@cip/market-data';
import { orderBins, type OrderBinRow } from '../src/market/seed.ts';

// Instruments no other ingestor test writes trades for.
const SOL_BN = '019a6f00-0000-7000-8000-000000000003';
const BTC_CB = '019a6f00-0000-7000-8000-000000000005';
const ETH_CB = '019a6f00-0000-7000-8000-000000000006';
const UNTIL = Date.UTC(2026, 10, 16, 14, 42, 39); // when the 2026-11-16 restart created its pipelines

// One connection, so the settings check reads the very session the seed ran in.
const db = createDb({ connectionString: inject('dbRoleUrls').svc_ingestor, max: 1 });
const owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 1 });

const trade = (
  instrumentId: string,
  ts: number,
  id: string,
  price: string,
  qty: string,
  takerOrderRef: string | null = null,
): NewTrade => ({
  instrument_id: instrumentId,
  ts: new Date(ts),
  trade_id: id,
  price,
  qty,
  taker_side: 'buy',
  taker_order_ref: takerOrderRef,
  received_at: new Date(ts),
});

const hourOf = (ts: number) => Math.floor(ts / HOUR_MS);
const sorted = (rows: readonly OrderBinRow[]) => [...rows].sort((a, b) => a.hour - b.hour || a.bin - b.bin);

beforeAll(async () => {
  await db
    .insertInto('market.trades')
    .values([
      // Binance aggTrades: each is one taker order.
      trade(SOL_BN, UNTIL - 2 * HOUR_MS, '1', '150', '2'), // $300
      trade(SOL_BN, UNTIL - 30 * 60_000, '2', '151', '10'), // $1,510
      trade(SOL_BN, UNTIL - 25 * HOUR_MS, '3', '149', '1'), // more than a day before: outside
      trade(SOL_BN, UNTIL + 60_000, '4', '152', '100'), // after `until`, already seen live: outside
      // Coinbase fills: the fills of one taker order make one order.
      trade(ETH_CB, UNTIL - HOUR_MS, '11', '3000', '0.5', 'order-a'),
      trade(ETH_CB, UNTIL - HOUR_MS + 1, '12', '3001', '0.5', 'order-a'),
      trade(ETH_CB, UNTIL - 10 * 60_000, '13', '3002', '0.1', 'order-b'),
    ])
    .execute();
  // A busy pair's day: 200,000 fills, two per taker order.
  await sql`
    INSERT INTO market.trades (instrument_id, ts, trade_id, price, qty, taker_side, taker_order_ref, received_at)
    SELECT ${BTC_CB}::uuid, ${new Date(UNTIL)}::timestamptz - i * interval '400 milliseconds', i::text,
           90000 + i % 100, 0.001, 'buy', 'o' || i / 2, ${new Date(UNTIL)}::timestamptz
    FROM generate_series(1, 200000) AS i`.execute(owner);
});

afterAll(async () => {
  await db.destroy();
  await owner.destroy();
});

describe('orderBins (the large-trade seed)', () => {
  it('bins the day of taker orders before `until`, as notionalBin does', async () => {
    expect(sorted(await orderBins(db, SOL_BN, UNTIL, 1))).toEqual(
      sorted([
        { hour: hourOf(UNTIL - 2 * HOUR_MS), bin: notionalBin(300), count: 1 },
        { hour: hourOf(UNTIL - 30 * 60_000), bin: notionalBin(1_510), count: 1 },
      ]),
    );
    // A USDT pair is converted at the USDT-USD rate.
    expect((await orderBins(db, SOL_BN, UNTIL, 0.5)).map((r) => r.bin).sort()).toEqual(
      [notionalBin(150), notionalBin(755)].sort(),
    );
    expect(sorted(await orderBins(db, ETH_CB, UNTIL, 1))).toEqual(
      sorted([
        { hour: hourOf(UNTIL - HOUR_MS), bin: notionalBin(3_000.5), count: 1 },
        { hour: hourOf(UNTIL - 10 * 60_000), bin: notionalBin(300.2), count: 1 },
      ]),
    );
  });

  it('gives up past its timeout, and leaves the connection with its own settings either way', async () => {
    const settings = async () =>
      (
        await sql<{ parallel: string; timeout: string }>`
          SELECT current_setting('max_parallel_workers_per_gather') AS parallel,
                 current_setting('statement_timeout') AS timeout`.execute(db)
      ).rows[0];
    const before = await settings();

    const bins = await orderBins(db, BTC_CB, UNTIL, 1);
    expect(bins.reduce((n, r) => n + r.count, 0)).toBe(100_001); // 200,000 fills, two per order
    expect(await settings()).toEqual(before);

    await expect(orderBins(db, BTC_CB, UNTIL, 1, 1)).rejects.toMatchObject({ code: '57014' });
    expect(await settings()).toEqual(before);
  });
});
