import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type MarketEvent, parseRecording, replayEvents } from '@cip/exchange-adapters';
import { CoinbaseBookSync } from './book-sync.js';
import { crossVenueSpread, detectionParams } from './detection.js';
import {
  binFloorUsd,
  HOUR_MS,
  LargeTradeDetector,
  type LargeTrade,
  NotionalHistogram,
  notionalBin,
  type TakerOrder,
  TakerOrderGrouper,
} from './large-trades.js';
import { WallDetector, type WallEvent } from './walls.js';

/**
 * Criterion 2.9: large trades (merged per taker order) and walls on a replay fixture whose answers
 * were worked out by hand. See fixtures/exchange-flow-known.jsonl.
 */
const events = replayEvents(
  parseRecording(
    readFileSync(
      new URL('../../exchange-adapters/fixtures/exchange-flow-known.jsonl', import.meta.url),
      'utf8',
    ),
  ),
).events;

const T0 = 1794300000000; // 2026-11-10 08:40:00 UTC

function largeTrades(symbol: string, usdPerQuote: string): { orders: TakerOrder[]; large: LargeTrade[] } {
  const base = symbol.startsWith('PAXG') ? 'PAXG' : 'BTC';
  const grouper = new TakerOrderGrouper();
  const detector = new LargeTradeDetector({ floorUsd: detectionParams(base).largeTradeFloorUsd });
  detector.start();
  const orders: TakerOrder[] = [];
  const large: LargeTrade[] = [];
  const take = (o: TakerOrder | null) => {
    if (!o) return;
    orders.push(o);
    const l = detector.observe(o, usdPerQuote);
    if (l) large.push(l);
  };
  for (const e of events) if (e.type === 'trade' && e.symbol === symbol) take(grouper.add(e));
  take(grouper.flush(Number.MAX_SAFE_INTEGER));
  return { orders, large };
}

describe('large trades on the known-answer fixture', () => {
  it('Binance: merges a same-time, same-side, contiguous aggTrade sweep into one taker order', () => {
    const { orders, large } = largeTrades('BTCUSDT', '0.9995');
    expect(
      orders.map((o) => [o.grouping, o.takerSide, o.qty, o.quoteNotional, o.fillCount, o.priceLevels]),
    ).toEqual([
      ['taker_order', 'buy', '4.5', '333005.75', 6, 3], // a=100..102: one sweep over three prices
      ['single', 'sell', '0.1', '7400.25', 1, 1], // same time and contiguous, but the other side
      ['single', 'sell', '4', '296000', 1, 1], // a later trade time
      ['taker_order', 'sell', '0.7', '51799.1', 2, 2], // a=105..106
    ]);
    expect(orders[0]!.avgPrice).toBe('74001.277777777778');
    // USDT notionals converted at USDT-USD 0.9995; the BTC floor is $250,000 while the window is empty.
    expect(large.map((l) => [l.notionalUsd, l.thresholdUsd, l.grouping])).toEqual([
      ['332839.25', '250000', 'taker_order'],
      ['295852', '250000', 'single'],
    ]);
  });

  it('Coinbase: merges matches by taker order id', () => {
    const { orders, large } = largeTrades('BTC-USD', '1');
    expect(orders.map((o) => [o.grouping, o.takerSide, o.qty, o.quoteNotional, o.avgPrice])).toEqual([
      ['taker_order', 'buy', '4', '296042.5', '74010.625'], // maker side "sell": the taker bought
      ['single', 'sell', '0.01', '740', '74000'],
    ]);
    expect(large).toHaveLength(1);
    expect(large[0]).toMatchObject({ notionalUsd: '296042.5', fillCount: 3, priceLevels: 3 });
  });

  it('PAXG: the sweep that fills the bid wall is one large taker order', () => {
    const { large } = largeTrades('PAXG-USD', '1');
    expect(large).toEqual([
      expect.objectContaining({
        takerSide: 'sell',
        qty: '42.5',
        notionalUsd: '174230.5',
        avgPrice: '4099.541176470588',
        fillCount: 4,
        priceLevels: 4,
        grouping: 'taker_order',
        thresholdUsd: '50000',
      }),
    ]);
  });
});

describe('walls on the known-answer fixture', () => {
  it('reports both walls after 3 s, the ask wall pulled and the bid wall filled', () => {
    const sync = new CoinbaseBookSync();
    const walls = new WallDetector(detectionParams('PAXG').walls);
    const out: { at: number; e: WallEvent }[] = [];
    let nextScan = T0 + 20_000;
    const scanUntil = (t: number) => {
      for (; nextScan <= t; nextScan += 1_000)
        for (const e of walls.scan(sync.book, nextScan, 1)) out.push({ at: nextScan - T0, e });
    };
    const paxg = events.filter((e): e is MarketEvent => e.symbol === 'PAXG-USD');
    for (const e of paxg) {
      scanUntil(e.receivedAt);
      if (e.type === 'book_snapshot') sync.onSnapshot(e.bids, e.asks);
      else if (e.type === 'book_delta') sync.onDelta(e.bids, e.asks);
      else if (e.type === 'trade') walls.onTrade(e);
    }
    scanUntil(T0 + 26_000);

    // Median level ≈ $5.1k, so 10× is below the $100k PAXG floor: the floor decides.
    expect(
      out.map(({ at, e }) => [at, e.kind, e.wall.side, e.wall.price, e.kind === 'ended' ? e.reason : null]),
    ).toEqual([
      [23_000, 'appeared', 'bid', '4099.5', null],
      [23_000, 'appeared', 'ask', '4102', null],
      [24_000, 'ended', 'ask', '4102', 'pulled'], // removed with no trades
      [25_000, 'ended', 'bid', '4099.5', 'filled'], // 38 of 40 traded away
    ]);
    const bid = out.find(({ e }) => e.kind === 'appeared' && e.wall.side === 'bid')!.e.wall;
    expect(bid.maxNotionalUsd).toBeCloseTo(163_980, 6);
    expect(bid.firstSeen).toBe(T0 + 20_000);
  });

  it('ends every wall as unknown when the book is lost', () => {
    const sync = new CoinbaseBookSync();
    const walls = new WallDetector({ ...detectionParams('PAXG').walls, minLifetimeMs: 0 });
    const snapshot = events.find((e) => e.type === 'book_snapshot')!;
    if (snapshot.type !== 'book_snapshot') throw new Error('fixture');
    sync.onSnapshot(snapshot.bids, snapshot.asks);
    expect(walls.scan(sync.book, 1, 1).map((e) => e.kind)).toEqual(['appeared', 'appeared']);
    expect(walls.endAll(2, 'unknown').map((e) => (e.kind === 'ended' ? e.reason : null))).toEqual([
      'unknown',
      'unknown',
    ]);
    expect(walls.active).toEqual([]);
  });
});

describe('thresholds', () => {
  it('uses the 99.9th percentile of the trailing 24 h once there are enough orders', () => {
    const d = new LargeTradeDetector({ floorUsd: 1_000, minSamples: 1_000, recomputeMs: 0 });
    d.start();
    const now = 10 * HOUR_MS;
    // 999 orders: fewer than minSamples, so the percentile is not trusted and the floor alone applies.
    d.seed([{ hour: 9, bin: notionalBin(500), count: 999 }]);
    expect(d.thresholdUsd(now)).toBe(1_000);
    // 2,000 orders at $5,000 and above: the percentile lies in the $5,000 bin, above the floor.
    d.seed([{ hour: 9, bin: notionalBin(5_000), count: 2_000 }]);
    const t = d.thresholdUsd(now);
    expect(t).toBe(binFloorUsd(notionalBin(5_000)));
    expect(t).toBeGreaterThan(4_900);
    expect(t).toBeLessThanOrEqual(5_000);
    // A day later those hours have left the window: back to the floor.
    expect(d.thresholdUsd(now + 25 * HOUR_MS)).toBe(1_000);
  });

  it('does not report before start(), but still learns the window', () => {
    const d = new LargeTradeDetector({ floorUsd: 10 });
    const order: TakerOrder = {
      ts: 0,
      takerSide: 'buy',
      qty: '1',
      quoteNotional: '100',
      avgPrice: '100',
      fillCount: 1,
      priceLevels: 1,
      grouping: 'single',
    };
    expect(d.observe(order, '1')).toBeNull();
    d.start();
    expect(d.observe(order, '1')).toMatchObject({ notionalUsd: '100', thresholdUsd: '10' });
  });

  it('bins notionals logarithmically and keeps only the trailing window', () => {
    const h = new NotionalHistogram(2);
    h.add(100, 0);
    h.add(100, HOUR_MS);
    expect(h.count(HOUR_MS)).toBe(2);
    h.add(100, 2 * HOUR_MS); // hour 0 leaves a two-hour window
    expect(h.count(2 * HOUR_MS)).toBe(2);
    expect(h.quantile(0.5, 2 * HOUR_MS)).toBe(binFloorUsd(notionalBin(100)));
    expect(new NotionalHistogram().quantile(0.5, 0)).toBeNull();
    expect(notionalBin(0)).toBe(0);
    expect(notionalBin(1e15)).toBe(notionalBin(1e13));
  });

  it('groups same-side fills within 250 ms as a burst where no order id or trade ids exist', () => {
    const g = new TakerOrderGrouper();
    const fill = (ts: number, side: 'buy' | 'sell') => ({
      ts,
      receivedAt: ts,
      price: '10',
      qty: '1',
      takerSide: side,
      takerOrderRef: null,
    });
    expect(g.add(fill(0, 'buy'))).toBeNull();
    expect(g.add(fill(200, 'buy'))).toBeNull();
    expect(g.add(fill(500, 'buy'))).toMatchObject({ grouping: 'burst', qty: '2', fillCount: 2 });
    expect(g.flush(1_000)).toBeNull(); // the open order's last fill is only 500 ms old
    expect(g.flush(1_500)).toMatchObject({ grouping: 'single', qty: '1' });
    expect(g.add(fill(2_000, 'sell'))).toBeNull();
    expect(g.reset()).toMatchObject({ takerSide: 'sell' });
    expect(g.reset()).toBeNull();
  });
});

describe('cross-venue spread', () => {
  it('converts the USDT price at USDT-USD and measures the USD venue against it', () => {
    const s = crossVenueSpread(4100, 0.9995, 4100);
    expect(s.primaryUsd).toBeCloseTo(4097.95, 9);
    expect(s.spreadBps).toBeCloseTo(((4100 - 4097.95) / 4097.95) * 10_000, 9); // ≈ +5 bps
  });
});
