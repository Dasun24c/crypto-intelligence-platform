import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type BookDeltaEvent,
  type BookSnapshotEvent,
  parseRecording,
  replayEvents,
} from '@cip/exchange-adapters';
import { BinanceBookSync, CoinbaseBookSync } from './book-sync.js';
import { OrderBook } from './order-book.js';

const recording = (name: string) =>
  replayEvents(
    parseRecording(
      readFileSync(new URL(`../../exchange-adapters/fixtures/${name}`, import.meta.url), 'utf8'),
    ),
  ).events;

describe('OrderBook', () => {
  it('keeps best prices first and removes zero-quantity levels', () => {
    const b = new OrderBook();
    b.reset(
      [
        ['99', '1'],
        ['100', '2'],
      ],
      [
        ['101', '1'],
        ['102', '3'],
      ],
    );
    b.apply(
      [
        ['100', '0'],
        ['99.5', '4'],
      ],
      [['100.5', '1']],
    );
    expect(b.top(2)).toEqual({
      bids: [
        ['99.5', '4'],
        ['99', '1'],
      ],
      asks: [
        ['100.5', '1'],
        ['101', '1'],
      ],
    });
    expect(b.depth).toEqual({ bids: 2, asks: 3 });
    expect(b.crossed()).toBe(false);
    b.apply([['101', '1']], []);
    expect(b.crossed()).toBe(true);
    expect(b.metrics()).toBeNull();
  });

  it('measures spread, depth bands, imbalance and coverage (architecture §5.3)', () => {
    const b = new OrderBook();
    b.reset(
      [
        ['99.95', '10'],
        ['99.5', '10'],
        ['98', '100'],
      ],
      [
        ['100.05', '5'],
        ['100.8', '20'],
      ],
    );
    const m = b.metrics()!;
    expect(m.mid).toBe(100);
    expect(m.spreadBps).toBeCloseTo(10);
    expect(m.bidUsd10bp).toBeCloseTo(999.5);
    expect(m.askUsd10bp).toBeCloseTo(500.25);
    expect(m.bidUsd50bp).toBeCloseTo(999.5 + 995);
    expect(m.askUsd100bp).toBeCloseTo(500.25 + 2016);
    expect(m.imbalance10bp).toBeCloseTo((999.5 - 500.25) / (999.5 + 500.25));
    expect(m.coverageBps).toBeCloseTo(80); // asks reach 100.8: the shorter side
  });
});

describe('BinanceBookSync on recorded traffic', () => {
  const events = recording('binance-ws.jsonl').filter((e) => e.symbol === 'BTCUSDT');
  const deltas = events.filter((e): e is BookDeltaEvent => e.type === 'book_delta');
  const snapshot = events.find((e): e is BookSnapshotEvent => e.type === 'book_snapshot')!;
  const asDelta = (d: BookDeltaEvent) => ({
    firstUpdateId: d.firstUpdateId!,
    lastUpdateId: d.lastUpdateId!,
    bids: d.bids,
    asks: d.asks,
  });

  it('synchronises the snapshot with the buffered diff stream and stays consistent', () => {
    const sync = new BinanceBookSync();
    const before = deltas.filter((d) => d.receivedAt <= snapshot.receivedAt);
    const after = deltas.filter((d) => d.receivedAt > snapshot.receivedAt);
    for (const d of before) expect(sync.onDelta(asDelta(d)).kind).toBe('buffered');
    expect(
      sync.onSnapshot({ lastUpdateId: snapshot.lastUpdateId!, bids: snapshot.bids, asks: snapshot.asks })
        .kind,
    ).toBe('applied');
    expect(sync.status).toBe('synced');
    const outcomes = after.map((d) => sync.onDelta(asDelta(d)).kind);
    expect(outcomes).not.toContain('resync');
    expect(outcomes.filter((k) => k === 'applied').length).toBeGreaterThan(10);
    expect(sync.book.crossed()).toBe(false);
    expect(sync.book.metrics()!.spreadBps).toBeLessThan(5);
  });

  it('detects an injected gap and asks for a new snapshot (criterion 2.3)', () => {
    const sync = new BinanceBookSync();
    for (const d of deltas.filter((x) => x.receivedAt <= snapshot.receivedAt)) sync.onDelta(asDelta(d));
    sync.onSnapshot({ lastUpdateId: snapshot.lastUpdateId!, bids: snapshot.bids, asks: snapshot.asks });
    const after = deltas.filter((d) => d.receivedAt > snapshot.receivedAt && d.lastUpdateId! > sync.updateId);
    sync.onDelta(asDelta(after[0]!));
    const outcome = sync.onDelta(asDelta(after[2]!)); // after[1] "lost"
    expect(outcome).toMatchObject({
      kind: 'resync',
      reason: 'update id gap',
      gotFirstId: after[2]!.firstUpdateId,
    });
    expect(sync.status).toBe('awaiting_snapshot');
    expect(sync.book.depth).toEqual({ bids: 0, asks: 0 });
  });

  it('refuses a snapshot older than the buffered events, and ignores stale updates', () => {
    const sync = new BinanceBookSync();
    sync.onDelta({ firstUpdateId: 100, lastUpdateId: 105, bids: [], asks: [] });
    expect(sync.onSnapshot({ lastUpdateId: 50, bids: [], asks: [] })).toMatchObject({ kind: 'resync' });
    const s2 = new BinanceBookSync();
    s2.onDelta({ firstUpdateId: 100, lastUpdateId: 105, bids: [['1', '1']], asks: [['2', '1']] });
    expect(s2.onSnapshot({ lastUpdateId: 101, bids: [['1', '2']], asks: [['2', '2']] }).kind).toBe('applied');
    expect(s2.onDelta({ firstUpdateId: 90, lastUpdateId: 104, bids: [], asks: [] }).kind).toBe('ignored');
    expect(s2.onDelta({ firstUpdateId: 106, lastUpdateId: 106, bids: [['3', '1']], asks: [] })).toMatchObject(
      { kind: 'resync', reason: 'crossed book' },
    );
    s2.reset();
    expect(s2.status).toBe('awaiting_snapshot');
  });

  it('refuses a first event that does not continue the snapshot', () => {
    const sync = new BinanceBookSync();
    sync.onDelta({ firstUpdateId: 100, lastUpdateId: 104, bids: [], asks: [] }); // contained in the snapshot
    sync.onDelta({ firstUpdateId: 110, lastUpdateId: 120, bids: [], asks: [] }); // 106..109 missing
    expect(sync.onSnapshot({ lastUpdateId: 105, bids: [], asks: [] })).toMatchObject({
      kind: 'resync',
      reason: 'first event does not continue the snapshot',
      expectedFirstId: 106,
      gotFirstId: 110,
    });
  });
});

describe('CoinbaseBookSync on recorded PAXG level 2', () => {
  it('applies the channel snapshot and batched changes to a consistent book', () => {
    const events = recording('coinbase-l2-paxg.jsonl');
    const sync = new CoinbaseBookSync();
    expect(sync.onDelta([], []).kind).toBe('ignored');
    for (const e of events) {
      if (e.type === 'book_snapshot') sync.onSnapshot(e.bids, e.asks);
      if (e.type === 'book_delta') expect(sync.onDelta(e.bids, e.asks).kind).toBe('applied');
    }
    const m = sync.book.metrics()!;
    expect(m.spreadBps).toBeGreaterThan(0);
    expect(m.spreadBps).toBeLessThan(50);
    expect(sync.status).toBe('synced');
    expect(sync.onDelta([['999999', '1']], []).kind).toBe('resync');
    expect(sync.status).toBe('awaiting_snapshot');
  });
});

describe('coverage of a partial snapshot (Binance sends the best N levels)', () => {
  const lvl = (p: number, q = 1): [string, string] => [String(p), String(q)];

  it('knows depth only as far as the snapshot reached, and says so instead of undercounting', () => {
    const sync = new BinanceBookSync();
    // Best levels from 99.95 down to 99.6 and from 100.05 up to 100.3: complete within about ±30 bps.
    expect(
      sync.onSnapshot({
        lastUpdateId: 10,
        bids: [lvl(99.95), lvl(99.8), lvl(99.6)],
        asks: [lvl(100.05), lvl(100.2), lvl(100.3)],
      }).kind,
    ).toBe('applied');
    // A later diff shows one far level that changed; the levels around it remain unknown.
    sync.onDelta({ firstUpdateId: 11, lastUpdateId: 11, bids: [lvl(99.2, 50)], asks: [] });
    const m = sync.book.metrics()!;
    expect(m.coverageBps).toBeCloseTo(30, 5);
    expect(m.bidUsd10bp).not.toBeNull();
    expect(m.bidUsd50bp).toBeNull(); // 99.5 lies beyond what the snapshot covered
    expect(m.imbalance50bp).toBeNull();
    expect(m.askUsd100bp).toBeNull();
    // Walls are looked for only inside the covered range.
    expect(sync.book.near(100)!.bids.map((e) => e.price)).toEqual(['99.95', '99.8']);
  });

  it('refreshes in the background: the live book keeps updating and is replaced only when the new one has caught up', () => {
    const sync = new BinanceBookSync();
    sync.onSnapshot({ lastUpdateId: 10, bids: [lvl(99.9)], asks: [lvl(100.1)] });
    const narrow = sync.book.coverage()!;
    sync.beginRefresh();
    expect(sync.refreshing).toBe(true);
    // Updates keep flowing into the live book during the refresh.
    expect(sync.onDelta({ firstUpdateId: 11, lastUpdateId: 11, bids: [lvl(99.95, 2)], asks: [] }).kind).toBe(
      'applied',
    );
    expect(sync.onDelta({ firstUpdateId: 12, lastUpdateId: 12, bids: [], asks: [lvl(100.05, 3)] }).kind).toBe(
      'applied',
    );
    // The refresh snapshot was taken at id 11 and reaches much further from mid.
    const outcome = sync.onRefreshSnapshot({
      lastUpdateId: 11,
      bids: [lvl(99.95, 2), lvl(99.9), lvl(98)],
      asks: [lvl(100.1), lvl(102)],
    });
    expect(outcome.kind).toBe('applied');
    expect(sync.refreshing).toBe(false);
    expect(sync.book.coverage()!).toBeGreaterThan(narrow);
    expect(sync.book.top(1)).toEqual({ bids: [['99.95', '2']], asks: [['100.05', '3']] }); // id 12 re-applied
    expect(sync.onDelta({ firstUpdateId: 13, lastUpdateId: 13, bids: [], asks: [] }).kind).toBe('applied');
  });

  it('keeps the live book when a refresh snapshot does not line up with it', () => {
    const sync = new BinanceBookSync();
    sync.onSnapshot({ lastUpdateId: 10, bids: [lvl(99.9)], asks: [lvl(100.1)] });
    sync.beginRefresh();
    sync.onDelta({ firstUpdateId: 11, lastUpdateId: 11, bids: [lvl(99.95)], asks: [] });
    // A snapshot newer than anything the live book has seen cannot be checked against it.
    expect(sync.onRefreshSnapshot({ lastUpdateId: 50, bids: [lvl(1)], asks: [lvl(1000)] }).kind).toBe(
      'ignored',
    );
    expect(sync.book.top(1).bids).toEqual([['99.95', '1']]);
    expect(sync.onRefreshSnapshot({ lastUpdateId: 11, bids: [], asks: [] }).kind).toBe('ignored'); // none pending
  });
});
