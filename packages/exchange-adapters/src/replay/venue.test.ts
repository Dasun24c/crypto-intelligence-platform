import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { BookDeltaEvent, MarketEvent, TradeEvent } from '../events.js';
import { parseRecording } from './recording.js';
import { ReplayVenue } from './venue.js';

const fixture = (name: string) =>
  parseRecording(readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8'));

function harness(recordings: string[], periodMs: number, startAt: number) {
  let now = startAt;
  const events: MarketEvent[] = [];
  const statuses: string[] = [];
  const venue = new ReplayVenue(
    {
      onEvent: (e) => events.push(e),
      onUnparsed: () => undefined,
      onStatus: (s) => statuses.push(s),
    },
    { recordings: recordings.map(fixture), periodMs, now: () => now, tickMs: 1_000_000 },
  );
  return {
    venue,
    events,
    statuses,
    advance(ms: number, step = 100) {
      for (let t = 0; t < ms; t += step) {
        now += step;
        venue.pump();
      }
    },
    get now() {
      return now;
    },
  };
}

describe('replay venue', () => {
  it('lists the recorded symbols with their venue format', () => {
    const h = harness(['binance-ws.jsonl', 'coinbase-l2-paxg.jsonl', 'coinbase-ws.jsonl'], 5_000, 0);
    expect(h.venue.symbols.sort((a, b) => a.symbol.localeCompare(b.symbol))).toEqual([
      { symbol: 'BTC-USD', format: 'coinbase' },
      { symbol: 'BTCUSDT', format: 'binance' },
      { symbol: 'PAXG-USD', format: 'coinbase' },
      { symbol: 'PAXGUSDT', format: 'binance' },
      { symbol: 'USDT-USD', format: 'coinbase' },
    ]);
    expect(h.venue.formatOf('BTCUSDT')).toBe('binance');
    expect(h.venue.formatOf('NOPE')).toBeNull();
  });

  it('plays Binance traffic in real time with contiguous ids across loops and a book that resyncs', async () => {
    const start = Date.UTC(2026, 10, 10, 12, 0);
    const h = harness(['binance-ws.jsonl'], 6_000, start);
    h.venue.setSymbols(['BTCUSDT']);
    expect(h.statuses).toEqual(['open']);
    h.advance(20_000); // more than three 6 s loops
    const btc = h.events.filter((e) => e.symbol === 'BTCUSDT');
    const trades = btc.filter((e): e is TradeEvent => e.type === 'trade');
    const deltas = btc.filter((e): e is BookDeltaEvent => e.type === 'book_delta');
    expect(trades.length).toBeGreaterThan(30);
    // aggTrade ids and underlying trade ids continue across loop boundaries: no false gaps.
    trades.forEach((t, i) => {
      if (i === 0) return;
      expect(t.seq).toBe(trades[i - 1]!.seq + 1);
      expect(t.fills!.first).toBe(trades[i - 1]!.fills!.last + 1);
    });
    deltas.forEach((d, i) => {
      if (i > 0) expect(d.firstUpdateId).toBe(deltas[i - 1]!.lastUpdateId! + 1);
    });
    // Times are now, not the recording's; receive times are when the replay sent them.
    expect(Math.min(...btc.map((e) => e.receivedAt))).toBeGreaterThan(start);
    expect(Math.max(...btc.map((e) => e.ts))).toBeLessThanOrEqual(h.now + 1_000);

    const snapshot = await h.venue.depthSnapshot('BTCUSDT');
    expect(snapshot.lastUpdateId).toBe(deltas.at(-1)!.lastUpdateId);
    expect(Number(snapshot.bids[0]![0])).toBeLessThan(Number(snapshot.asks[0]![0])); // not crossed
    await expect(h.venue.depthSnapshot('ETHUSDT')).rejects.toThrow(/not streaming/);
  });

  it('sends Coinbase a channel snapshot on subscribe and at each loop, with heartbeats that match the trades sent', () => {
    const h = harness(['coinbase-l2-paxg.jsonl', 'coinbase-ws.jsonl'], 5_000, Date.UTC(2026, 10, 10, 12, 0));
    h.venue.setSymbols(['PAXG-USD', 'BTC-USD']);
    h.advance(12_000);
    const paxg = h.events.filter((e) => e.symbol === 'PAXG-USD');
    expect(paxg[0]!.type).toBe('book_snapshot');
    expect(paxg.filter((e) => e.type === 'book_snapshot').length).toBeGreaterThanOrEqual(3);
    const btcTrades = h.events.filter((e): e is TradeEvent => e.type === 'trade' && e.symbol === 'BTC-USD');
    const ids = btcTrades.map((t) => t.seq);
    expect(ids.length).toBeGreaterThan(5);
    expect(ids).toEqual(ids.map((_, i) => ids[0]! + i));
    const heartbeats = h.events.filter((e) => e.type === 'heartbeat');
    for (const hb of heartbeats)
      if (hb.type === 'heartbeat') expect(hb.lastTradeId).toBeLessThanOrEqual(Math.max(...ids, 0));
    // Taker order refs are per loop, so one loop's order never merges with the next one's.
    const loops = new Set(btcTrades.map((t) => t.takerOrderRef?.split(':').at(-1)));
    expect(loops.size).toBeGreaterThanOrEqual(2);
  });

  it('joins mid-window without replaying the past as a burst, and stops cleanly', () => {
    const h = harness(['binance-ws.jsonl'], 6_000, Date.UTC(2026, 10, 10, 12, 0) + 3_000);
    h.venue.setSymbols(['BTCUSDT']);
    h.advance(100);
    expect(h.events.length).toBeLessThan(20);
    h.venue.setSymbols([]);
    expect(h.statuses).toEqual(['open', 'closed']);
    const before = h.events.length;
    h.advance(5_000);
    expect(h.events.length).toBe(before);
  });
});

describe('the demo recordings', () => {
  const demo = (name: string) =>
    parseRecording(
      gunzipSync(readFileSync(new URL(`../../fixtures/replay/${name}.jsonl.gz`, import.meta.url))).toString(
        'utf8',
      ),
    );

  it('loop every two minutes with exactly one final kline per minute, on minute boundaries', () => {
    let now = Date.UTC(2026, 10, 11, 9, 0, 30);
    const finals: number[] = [];
    let crossed = 0;
    let updates = 0;
    const books = new Map<string, { bids: Map<string, string>; asks: Map<string, string> }>();
    const venue = new ReplayVenue(
      {
        onEvent: (e) => {
          if (e.type === 'kline' && e.final && e.symbol === 'BTCUSDT') finals.push(e.openTime);
          // The full BTC-USD book is large: check crossing on the two smaller books.
          if ((e.type === 'book_snapshot' || e.type === 'book_delta') && e.symbol !== 'BTC-USD') {
            const book = books.get(e.symbol) ?? {
              bids: new Map<string, string>(),
              asks: new Map<string, string>(),
            };
            if (e.type === 'book_snapshot') {
              book.bids = new Map(e.bids);
              book.asks = new Map(e.asks);
            } else {
              for (const [p, q] of e.bids) {
                if (Number(q) === 0) book.bids.delete(p);
                else book.bids.set(p, q);
              }
              for (const [p, q] of e.asks) {
                if (Number(q) === 0) book.asks.delete(p);
                else book.asks.set(p, q);
              }
            }
            books.set(e.symbol, book);
            if (++updates % 20 !== 0 && e.type !== 'book_snapshot') return;
            const bid = Math.max(...[...book.bids.keys()].map(Number));
            const ask = Math.min(...[...book.asks.keys()].map(Number));
            if (book.bids.size > 0 && book.asks.size > 0 && bid >= ask) crossed++;
          }
        },
        onUnparsed: () => undefined,
        onStatus: () => undefined,
      },
      { recordings: [demo('binance-demo'), demo('coinbase-demo')], now: () => now, tickMs: 1_000_000 },
    );
    expect(venue.symbols.map((s) => s.symbol).sort()).toEqual([
      'BTC-USD',
      'BTCUSDT',
      'PAXG-USD',
      'PAXGUSDT',
      'USDT-USD',
    ]);
    venue.setSymbols(['BTCUSDT', 'PAXG-USD', 'BTC-USD']);
    for (let t = 0; t < 5 * 60_000; t += 200) {
      now += 200;
      venue.pump();
    }
    expect(finals.length).toBeGreaterThanOrEqual(4);
    finals.forEach((t, i) => {
      expect(t % 60_000).toBe(0);
      if (i > 0) expect(t).toBe(finals[i - 1]! + 60_000);
    });
    expect(crossed).toBe(0); // the loop boundary returns the book to its start, never crossing it
    venue.stop();
  }, 60_000);
});
