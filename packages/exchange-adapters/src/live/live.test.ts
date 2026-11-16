import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WsSocket, { WebSocketServer } from 'ws';
import type { MarketEvent } from '../events.js';
import { RateLimitedError, RestBudget, RestClient } from './rest.js';
import { type MinimalWebSocket, ReconnectingSocket, UncompressedWebSocket } from './socket.js';
import { BinanceVenue, CoinbaseVenue } from './venues.js';

/** A scripted WebSocket: tests open, deliver and close it by hand. */
class FakeSocket implements MinimalWebSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: MinimalWebSocket['onopen'] = null;
  onmessage: MinimalWebSocket['onmessage'] = null;
  onclose: MinimalWebSocket['onclose'] = null;
  onerror: MinimalWebSocket['onerror'] = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  deliver(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

afterEach(() => {
  FakeSocket.all = [];
  vi.useRealTimers();
});

describe('ReconnectingSocket', () => {
  it('backs off exponentially from 1 s to 8 s with jitter, so a reconnect follows the network within 10 s', () => {
    expect([0, 1, 2, 3, 9].map((n) => ReconnectingSocket.backoff(n, 1_000, undefined, () => 1))).toEqual([
      1_000, 2_000, 4_000, 8_000, 8_000,
    ]);
    expect([0, 1, 2, 5, 9].map((n) => ReconnectingSocket.backoff(n, 1_000, 30_000, () => 1))).toEqual([
      1_000, 2_000, 4_000, 30_000, 30_000,
    ]);
    expect(ReconnectingSocket.backoff(0, 1_000, 30_000, () => 0)).toBe(500);
  });

  it('reconnects after a drop and resubscribes on every open', () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const s = new ReconnectingSocket(
      () => 'wss://x',
      { onOpen: (send) => send('sub'), onMessage: () => undefined, onStatus: (st) => statuses.push(st) },
      { idleTimeoutMs: 30_000, random: () => 1, WebSocketImpl: FakeSocket },
    );
    s.start();
    FakeSocket.all[0]!.open();
    expect(s.connected).toBe(true);
    FakeSocket.all[0]!.close(1006);
    vi.advanceTimersByTime(1_000);
    FakeSocket.all[1]!.open();
    expect(FakeSocket.all.map((f) => f.sent)).toEqual([['sub'], ['sub']]);
    expect(statuses).toEqual(['connecting', 'open', 'closed', 'connecting', 'open']);
    s.stop();
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('reconnects a connection that went silent (NFR-04) and one past its lifetime', () => {
    vi.useFakeTimers();
    let now = 0;
    const statuses: string[] = [];
    const s = new ReconnectingSocket(
      () => 'wss://x',
      {
        onOpen: () => undefined,
        onMessage: () => undefined,
        onStatus: (st, d) => statuses.push(`${st}:${d}`),
      },
      {
        idleTimeoutMs: 10_000,
        maxLifetimeMs: 60_000,
        random: () => 1,
        now: () => now,
        WebSocketImpl: FakeSocket,
      },
    );
    s.start();
    FakeSocket.all[0]!.open();
    now = 11_000;
    vi.advanceTimersByTime(5_000);
    expect(statuses.some((x) => x.startsWith('closed:silent'))).toBe(true);
    vi.advanceTimersByTime(1_000);
    FakeSocket.all[1]!.open();
    now = 12_000;
    FakeSocket.all[1]!.deliver({}); // keeps it from being idle
    now = 75_000;
    FakeSocket.all[1]!.deliver({});
    vi.advanceTimersByTime(5_000);
    expect(FakeSocket.all[1]!.readyState).toBe(3); // closed for its lifetime
    s.stop();
  });
});

/** A local server that accepts permessage-deflate whenever a client offers it, like both venues. */
async function deflatingServer(): Promise<{ server: WebSocketServer; url: string }> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: true });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return { server, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function closeServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) client.terminate();
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Loopback is quick, but a refused connection takes about 2 s to fail on Windows. */
const WAIT = { timeout: 4_000, interval: 10 };

describe('UncompressedWebSocket (the venue sockets)', () => {
  it('does not offer permessage-deflate, so frames are parsed as they arrive (2026-11-16 Coinbase backlog)', async () => {
    const { server, url } = await deflatingServer();
    const offered: (string | undefined)[] = [];
    server.on('connection', (socket, req) => {
      offered.push(req.headers['sec-websocket-extensions']);
      socket.send('{"a":1}');
      socket.send('{"b":2}');
    });
    // The control: a client that offers compression gets it from this server.
    const compressed = new WsSocket(url);
    await new Promise((resolve) => compressed.once('open', resolve));
    expect(compressed.extensions).toContain('permessage-deflate');
    compressed.close();

    const received: unknown[] = [];
    const ws = new UncompressedWebSocket(url);
    ws.onmessage = (ev) => received.push(ev.data);
    await vi.waitFor(() => expect(received).toHaveLength(2), WAIT);
    expect(received).toEqual(['{"a":1}', '{"b":2}']);
    expect(offered[1]).toBeUndefined();
    expect(ws.extensions).toBe('');
    expect(ws.readyState).toBe(1);
    ws.close(1000, 'done');
    await closeServer(server);
  });

  it(
    'reports the close code and reason, and an error followed by a close when the connection fails',
    {
      timeout: 10_000,
    },
    async () => {
      const { server, url } = await deflatingServer();
      server.on('connection', (socket) => socket.close(4002, 'bye'));
      const events: string[] = [];
      const ws = new UncompressedWebSocket(url);
      ws.onerror = () => events.push('error');
      ws.onclose = (ev) => events.push(`close ${ev.code} ${ev.reason}`);
      await vi.waitFor(() => expect(events).toEqual(['close 4002 bye']), WAIT);
      await closeServer(server);

      // Nothing listens there any more: the reconnect logic needs the close after the error.
      const refused: string[] = [];
      const lost = new UncompressedWebSocket(url);
      lost.onerror = () => refused.push('error');
      lost.onclose = (ev) => refused.push(`close ${ev.code}`);
      await vi.waitFor(() => expect(refused).toEqual(['error', 'close 1006']), WAIT);
    },
  );

  it('is what ReconnectingSocket uses by default: subscribes on open, delivers text, reconnects after a drop', async () => {
    const { server, url } = await deflatingServer();
    const subscriptions: string[] = [];
    let connections = 0;
    server.on('connection', (socket) => {
      const n = ++connections;
      socket.on('message', (data) => {
        subscriptions.push((data as Buffer).toString('utf8')); // text frames arrive as one Buffer
        if (n === 1) {
          socket.send('{"x":1}');
          setTimeout(() => socket.terminate(), 20); // the connection drops (no close frame)
        }
      });
    });
    const statuses: string[] = [];
    const messages: string[] = [];
    const s = new ReconnectingSocket(
      () => url,
      {
        onOpen: (send) => send('sub'),
        onMessage: (data) => messages.push(data),
        onStatus: (st, detail) => statuses.push(`${st}:${detail}`),
      },
      { idleTimeoutMs: 30_000, initialBackoffMs: 10, random: () => 0 },
    );
    s.start();
    await vi.waitFor(() => expect(subscriptions).toEqual(['sub', 'sub']), WAIT);
    expect(messages).toEqual(['{"x":1}']);
    expect(statuses).toEqual([
      'connecting:connecting',
      'open:connected',
      'closed:closed (1006)',
      'connecting:reconnect attempt 1',
      'open:connected',
    ]);
    s.stop();
    await closeServer(server);
  });
});

describe('RestBudget and RestClient', () => {
  it('spends weight and pauses entirely after a 429 with Retry-After', async () => {
    let now = 0;
    const budget = new RestBudget(10, 10, () => now);
    await budget.take(10);
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 429, headers: { 'retry-after': '3' } }));
    const client = new RestClient({
      baseUrl: 'https://x',
      budget: new RestBudget(5, 5, () => now),
      fetchImpl,
    });
    await expect(client.get('/a')).rejects.toBeInstanceOf(RateLimitedError);
    await expect(client.get('/b')).rejects.toMatchObject({ retryAfterMs: 3_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // the pause blocks the second call locally
    now = 3_001;
    fetchImpl.mockResolvedValueOnce(new Response('{"ok":1}', { status: 200 }));
    await expect(client.get('/c')).resolves.toEqual({ ok: 1 });
  });

  it('fails clearly on other HTTP errors', async () => {
    const client = new RestClient({
      baseUrl: 'https://x',
      budget: new RestBudget(5, 5),
      fetchImpl: async () => new Response('', { status: 500 }),
    });
    await expect(client.get('/x')).rejects.toThrow('GET /x failed with 500');
  });
});

describe('venues', () => {
  it('Binance streams every channel for every symbol over one combined connection', () => {
    const events: MarketEvent[] = [];
    const v = new BinanceVenue(
      { onEvent: (e) => events.push(e), onUnparsed: () => undefined, onStatus: () => undefined },
      { WebSocketImpl: FakeSocket },
    );
    v.setSymbols(['PAXGUSDT', 'BTCUSDT']);
    const url = FakeSocket.all[0]!.url;
    expect(url).toContain(
      '/stream?streams=btcusdt@aggTrade/btcusdt@kline_1m/btcusdt@depth@100ms/btcusdt@ticker/paxgusdt@aggTrade',
    );
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.deliver({
      stream: 'btcusdt@aggTrade',
      data: { e: 'aggTrade', s: 'BTCUSDT', a: 1, p: '1.0', q: '2', f: 1, l: 1, T: 5, m: true },
    });
    expect(events).toMatchObject([{ type: 'trade', takerSide: 'sell', price: '1' }]);
    v.setSymbols(['BTCUSDT', 'PAXGUSDT']); // same set: nothing to do
    expect(FakeSocket.all).toHaveLength(1);
    // A changed set is a live (un)subscribe on the open connection: no reconnect, no gap for the others.
    v.setSymbols(['BTCUSDT', 'XRPUSDT']);
    expect(FakeSocket.all).toHaveLength(1);
    expect(FakeSocket.all[0]!.sent.map((m) => JSON.parse(m) as { method: string; params: string[] })).toEqual(
      [
        {
          method: 'UNSUBSCRIBE',
          params: ['paxgusdt@aggTrade', 'paxgusdt@kline_1m', 'paxgusdt@depth@100ms', 'paxgusdt@ticker'],
          id: 1,
        },
        {
          method: 'SUBSCRIBE',
          params: ['xrpusdt@aggTrade', 'xrpusdt@kline_1m', 'xrpusdt@depth@100ms', 'xrpusdt@ticker'],
          id: 2,
        },
      ],
    );
    // While disconnected it reconnects instead, and the URL carries the new set.
    FakeSocket.all[0]!.readyState = 3;
    v.setSymbols(['BTCUSDT']);
    v.stop();
  });

  it('Coinbase subscribes to the four public channels on open', () => {
    const v = new CoinbaseVenue(
      { onEvent: () => undefined, onUnparsed: () => undefined, onStatus: () => undefined },
      { WebSocketImpl: FakeSocket },
    );
    v.setProducts(['PAXG-USD', 'BTC-USD']);
    FakeSocket.all[0]!.open();
    expect(JSON.parse(FakeSocket.all[0]!.sent[0]!)).toEqual({
      type: 'subscribe',
      product_ids: ['BTC-USD', 'PAXG-USD'],
      channels: ['matches', 'heartbeat', 'ticker', 'level2_batch'],
    });
    v.setProducts(['BTC-USD', 'USDT-USD']);
    expect(FakeSocket.all).toHaveLength(1);
    expect(
      FakeSocket.all[0]!.sent.slice(1).map((m) => JSON.parse(m) as { type: string; product_ids: string[] }),
    ).toEqual([
      expect.objectContaining({ type: 'unsubscribe', product_ids: ['PAXG-USD'] }),
      expect.objectContaining({ type: 'subscribe', product_ids: ['USDT-USD'] }),
    ]);
    v.stop();
  });

  it('maps REST candles and pair status from both venues', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (u.includes('/klines'))
        return Response.json([[60_000, '1.10', '2', '1', '1.5', '3', 119_999, '4.5', 7, '1', '1.5', '0']]);
      if (u.includes('/exchangeInfo'))
        return Response.json({
          symbols: [
            {
              symbol: 'PAXGUSDT',
              status: 'BREAK',
              filters: [
                { filterType: 'PRICE_FILTER', tickSize: '0.01000000' },
                { filterType: 'LOT_SIZE', stepSize: '0.00010000' },
                { filterType: 'NOTIONAL', minNotional: '5.00000000' },
              ],
            },
          ],
        });
      if (u.includes('/candles'))
        return Response.json([
          [180, 1, 3, 2, 2.5, 10],
          [120, 1, 2, 1.5, 1.8, 4],
        ]);
      return Response.json({
        id: 'PAXG-USD',
        status: 'online',
        trading_disabled: false,
        cancel_only: true,
        quote_increment: '0.01',
        base_increment: '0.00001',
        min_market_funds: '1',
      });
    });
    const hooks = { onEvent: () => undefined, onUnparsed: () => undefined, onStatus: () => undefined };
    const b = new BinanceVenue(hooks, {
      WebSocketImpl: FakeSocket,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await b.klines('PAXGUSDT', '1m', 0, 200_000)).toEqual([
      {
        openTime: 60_000,
        open: '1.1',
        high: '2',
        low: '1',
        close: '1.5',
        volume: '3',
        quoteVolume: '4.5',
        tradeCount: 7,
        takerBuyVolume: '1',
      },
    ]);
    expect(await b.pairStatus(['PAXGUSDT'])).toEqual([
      { symbol: 'PAXGUSDT', status: 'halted', priceTick: '0.01', qtyStep: '0.0001', minNotional: '5' },
    ]);
    const c = new CoinbaseVenue(hooks, {
      WebSocketImpl: FakeSocket,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect((await c.candles('PAXG-USD', 60, 120_000, 240_000)).map((x) => x.openTime)).toEqual([
      120_000, 180_000,
    ]);
    expect((await c.pairStatus('PAXG-USD')).status).toBe('halted');
    expect((await c.pairStatus('PAXG-USD')).minNotional).toBe('1');
  });
});
