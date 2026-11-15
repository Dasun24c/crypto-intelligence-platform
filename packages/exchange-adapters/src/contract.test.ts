import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type BookDeltaEvent,
  type BookSnapshotEvent,
  type MarketEvent,
  parseBinanceMessage,
  parseCoinbaseMessage,
  parseRecording,
  replayEvents,
  type TickerEvent,
  type TradeEvent,
} from './index.js';

/**
 * Contract tests (architecture §19): the adapters parse real venue traffic recorded on 2026-11-10
 * with tools/recorder. If a venue changes its format, these fail before production does.
 */
const fixture = (name: string) =>
  parseRecording(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const ofType = <T extends MarketEvent['type']>(events: MarketEvent[], type: T) =>
  events.filter((e): e is Extract<MarketEvent, { type: T }> => e.type === type);

describe('Binance recorded traffic', () => {
  const { events, unparsed } = replayEvents(fixture('binance-ws.jsonl'));

  it('parses every message', () => {
    expect(unparsed).toEqual([]);
    const counts = Object.fromEntries(
      ['trade', 'kline', 'book_delta', 'book_snapshot', 'ticker'].map((t) => [
        t,
        ofType(events, t as MarketEvent['type']).length,
      ]),
    );
    expect(counts).toMatchObject({ book_snapshot: 2 });
    expect(counts['trade']).toBeGreaterThan(10);
    expect(counts['book_delta']).toBeGreaterThan(50);
  });

  it('maps aggregated trades, with the taker side from `m` and contiguous ids per symbol', () => {
    const trades = ofType(events, 'trade');
    for (const t of trades) {
      expect(t.price).toMatch(/^\d+(\.\d+)?$/);
      expect(t.price).not.toMatch(/\.\d*0$/); // canonical: no trailing zeros after the point
      expect(t.fills!.last).toBeGreaterThanOrEqual(t.fills!.first);
    }
    const bySymbol = Map.groupBy(trades, (t) => t.symbol);
    for (const list of bySymbol.values()) {
      for (let i = 1; i < list.length; i++) expect(list[i]!.seq).toBe(list[i - 1]!.seq + 1);
    }
  });

  it('keeps depth update ids, which the book synchronisation relies on', () => {
    for (const d of ofType(events, 'book_delta')) {
      expect(d.lastUpdateId!).toBeGreaterThanOrEqual(d.firstUpdateId!);
    }
    const snapshot = ofType(events, 'book_snapshot').find((s) => s.symbol === 'BTCUSDT')!;
    expect(snapshot.lastUpdateId).toBeGreaterThan(0);
    expect(snapshot.bids.length).toBe(100);
  });

  it('maps the 24 h ticker and the 1m kline (empty PAXG minutes included)', () => {
    const ticker = ofType(events, 'ticker')[0]!;
    expect(Number(ticker.bid)).toBeLessThanOrEqual(Number(ticker.ask));
    expect(typeof ticker.change24hPct).toBe('number');
    for (const k of ofType(events, 'kline')) {
      expect(k.openTime % 60_000).toBe(0);
      if (k.tradeCount === 0) expect([k.open, k.high, k.low]).toEqual([k.close, k.close, k.close]);
    }
  });

  it('marks the kline the venue closed at the minute boundary as final', () => {
    const klines = ofType(replayEvents(fixture('binance-klines.jsonl')).events, 'kline');
    const closed = klines.filter((k) => k.final);
    expect(closed.map((k) => k.symbol).sort()).toEqual(['BTCUSDT', 'PAXGUSDT']);
    for (const k of closed) {
      expect(k.receivedAt).toBeGreaterThanOrEqual(k.openTime + 60_000);
      expect(k.tradeCount).toBeGreaterThan(0);
    }
  });

  it('ignores control replies and reports unknown events instead of dropping them', () => {
    expect(parseBinanceMessage({ result: null, id: 1 }, 0)).toBeNull();
    expect(parseBinanceMessage({ e: 'outboundAccountPosition' }, 0)).toMatchObject({ type: 'unparsed' });
    expect(parseBinanceMessage({ e: 'aggTrade', s: 'X' }, 0)).toMatchObject({
      type: 'unparsed',
      reason: 'expected number',
    });
  });
});

describe('Coinbase recorded traffic', () => {
  const { events, unparsed } = replayEvents([
    ...fixture('coinbase-ws.jsonl'),
    ...fixture('coinbase-l2-paxg.jsonl'),
  ]);

  it('parses every message', () => {
    expect(unparsed).toEqual([]);
    expect(ofType(events, 'trade').length).toBeGreaterThan(20);
    expect(ofType(events, 'heartbeat').length).toBeGreaterThan(10);
  });

  it('inverts the maker side to get the taker side, and keeps the taker order id', () => {
    const raw = {
      type: 'match',
      trade_id: 7,
      side: 'buy',
      size: '0.5',
      price: '100.10',
      product_id: 'BTC-USD',
      taker_order_id: 'abc',
      time: '2026-11-10T06:34:04.099158Z',
      sequence: 1,
    };
    const t = parseCoinbaseMessage(raw, 1) as TradeEvent;
    expect(t).toMatchObject({
      takerSide: 'sell',
      takerOrderRef: 'abc',
      price: '100.1',
      ts: Date.UTC(2026, 10, 10, 6, 34, 4, 99),
    });
    expect((parseCoinbaseMessage({ ...raw, side: 'sell' }, 1) as TradeEvent).takerSide).toBe('buy');
  });

  it('has no trade id gaps per product below the heartbeat last_trade_id', () => {
    const trades = ofType(events, 'trade');
    const byProduct = Map.groupBy(trades, (t) => t.symbol);
    for (const list of byProduct.values()) {
      const ids = list.map((t) => t.seq);
      for (let i = 1; i < ids.length; i++) expect(ids[i]).toBeGreaterThan(ids[i - 1]!);
    }
    const lastSeen = new Map(trades.map((t) => [t.symbol, t.seq]));
    for (const hb of ofType(events, 'heartbeat')) {
      if (lastSeen.has(hb.symbol) && hb.receivedAt > byProduct.get(hb.symbol)!.at(-1)!.receivedAt) {
        expect(hb.lastTradeId).toBeGreaterThanOrEqual(lastSeen.get(hb.symbol)!);
      }
    }
  });

  it('splits level-2 changes into bids and asks and keeps the snapshot', () => {
    const snapshot = ofType(events, 'book_snapshot')[0] as BookSnapshotEvent;
    expect(snapshot.symbol).toBe('PAXG-USD');
    expect(snapshot.bids.length).toBeGreaterThan(0);
    expect(Number(snapshot.bids[0]![0])).toBeLessThan(Number(snapshot.asks[0]![0]));
    const delta = ofType(events, 'book_delta')[0] as BookDeltaEvent;
    expect(delta.bids.length + delta.asks.length).toBeGreaterThan(0);
  });

  it('derives the 24 h change and an approximate quote volume from the ticker', () => {
    const t = ofType(events, 'ticker').find((x) => x.symbol === 'USDT-USD') as TickerEvent;
    expect(Math.abs(t.change24hPct)).toBeLessThan(5);
    expect(Number(t.volume24hQuote)).toBeGreaterThan(0);
  });

  it('ignores subscription acknowledgements and reports venue errors', () => {
    expect(parseCoinbaseMessage({ type: 'subscriptions', channels: [] }, 0)).toBeNull();
    expect(parseCoinbaseMessage({ type: 'error', message: 'Failed to subscribe' }, 0)).toMatchObject({
      type: 'unparsed',
      reason: 'venue error: Failed to subscribe',
    });
    expect(
      parseCoinbaseMessage(
        { type: 'l2update', product_id: 'X', changes: [['hold', '1', '1']], time: '2026-11-10T00:00:00Z' },
        0,
      ),
    ).toMatchObject({
      type: 'unparsed',
    });
  });
});
