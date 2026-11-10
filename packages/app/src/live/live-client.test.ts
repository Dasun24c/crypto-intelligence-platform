// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '@cip/contracts';
import { ackAll, type FakeSocket, fakeSockets } from '../test/fake-socket.js';
import { LiveClient, type LiveClientOptions } from './live-client.js';
import { compareSeq, maxSeq } from './seq.js';

const ID = '019a6f00-0000-7000-8000-000000000001';
const TICKER = `ticker:${ID}`;
const BOOK = `book:${ID}`;
const MARKET = `market:${ID}`;
const TRADES = `trades:${ID}`;

const ticker = (last: string) => ({
  instrumentId: ID,
  ts: 1,
  last,
  bid: last,
  ask: last,
  change24hPct: 0,
  volume24hQuote: '1',
});
const durable = (ch: string, seq: string, type = 'wall.appeared'): Envelope => ({
  ch,
  seq,
  ts: Number(seq.split('-')[0]),
  type,
  data: { instrumentId: ID },
});

/** Lets queued microtasks (flushes, the server-address lookup, acks) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function setup(overrides: Partial<LiveClientOptions> = {}) {
  const sockets = fakeSockets();
  let token: string | null = 'token-1';
  let refreshes = 0;
  const refreshToken = vi.fn(async () => {
    refreshes++;
    token = `token-${refreshes + 1}`;
    return true;
  });
  const onSessionEnded = vi.fn();
  const client = new LiveClient({
    getServerUrl: async () => '',
    getToken: () => token,
    refreshToken,
    onSessionEnded,
    createSocket: sockets.create,
    ...overrides,
  });
  const states: string[] = [];
  client.subscribeConnection(() => states.push(client.getConnection().state));
  return {
    client,
    sockets,
    refreshToken,
    onSessionEnded,
    states,
    setToken: (t: string | null) => {
      token = t;
    },
  };
}

/** Opens the connection and answers every pending subscribe like the gateway would. */
async function connect(
  sockets: ReturnType<typeof fakeSockets>,
  snapshots: Record<string, unknown> = {},
  seq = '1000-0',
): Promise<FakeSocket> {
  await settle();
  const socket = sockets.last;
  socket.open();
  await answerSubscribes(socket, snapshots, seq);
  return socket;
}

async function answerSubscribes(socket: FakeSocket, snapshots: Record<string, unknown> = {}, seq = '1000-0') {
  await settle();
  while (socket.pending.some((p) => p.event === 'subscribe')) {
    const req = socket.next();
    req.resolve(ackAll((req.payload as { channels: string[] }).channels, snapshots, seq));
    await settle();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('LiveClient', () => {
  it('connects on first use with the access token and subscribes all channels in one request', async () => {
    const { client, sockets, states } = setup();
    const messages: Envelope[] = [];
    const snapshots: unknown[] = [];
    client.subscribe(TICKER, { onMessage: (m) => messages.push(m), onSnapshot: (s) => snapshots.push(s) });
    client.subscribe(BOOK, {});
    expect(sockets.made).toHaveLength(0);
    await settle();
    const socket = sockets.last;
    expect(socket.url).toBe('/v1');
    expect(socket.options).toMatchObject({ path: '/socket.io', transports: ['websocket'] });
    expect(socket.token()).toBe('token-1');
    expect(client.getConnection().state).toBe('connecting');

    socket.open();
    expect(client.getConnection()).toMatchObject({ state: 'live', detail: null });
    const req = socket.next();
    expect(req.payload).toEqual({ channels: [TICKER, BOOK] });
    req.resolve(ackAll([TICKER, BOOK], { [TICKER]: ticker('74000') }));
    await settle();
    expect(snapshots).toEqual([ticker('74000')]);
    expect(client.peek(TICKER)?.status).toEqual({ state: 'live', error: null });
    expect(client.peek(BOOK)?.data).toBeNull();

    socket.send({ ch: TICKER, ts: 2, type: 'ticker', data: ticker('74010') });
    expect(messages.map((m) => (m.data as { last: string }).last)).toEqual(['74010']);
    expect(client.peek(TICKER)?.data).toMatchObject({ last: '74010' });
    expect(client.peek(TICKER)?.lastMessageAt).not.toBeNull();
    expect(states).toEqual(['connecting', 'live']);
  });

  it('subscribes once however many listen, and unsubscribes when the last listener leaves', async () => {
    const { client, sockets } = setup();
    const offA = client.subscribe(TICKER, {});
    const offB = client.subscribe(TICKER, {});
    const socket = await connect(sockets);
    expect(socket.subscribeRequests()).toEqual([{ channels: [TICKER] }]);

    offA();
    await settle();
    expect(socket.unsubscribed()).toEqual([]);
    offB();
    offB(); // idempotent
    await settle();
    expect(socket.unsubscribed()).toEqual([TICKER]);
    expect(client.peek(TICKER)).toBeNull();

    // React StrictMode: an unsubscribe and an immediate re-subscribe keep the server subscription.
    const offC = client.subscribe(BOOK, {});
    await answerSubscribes(socket);
    offC();
    client.subscribe(BOOK, {});
    await settle();
    expect(socket.unsubscribed()).toEqual([TICKER]);
    expect(socket.subscribeRequests()).toHaveLength(2);
  });

  it('gives a late listener the current value of a non-durable channel', async () => {
    const { client, sockets } = setup();
    client.subscribe(TICKER, {});
    const socket = await connect(sockets, { [TICKER]: ticker('1') });
    socket.send({ ch: TICKER, ts: 2, type: 'ticker', data: ticker('2') });
    const late = vi.fn();
    client.subscribe(TICKER, { onSnapshot: late });
    expect(client.peek(TICKER)?.data).toMatchObject({ last: '2' });
    await settle();
    expect(late).not.toHaveBeenCalled(); // no second server subscription, so no second snapshot
    expect(socket.subscribeRequests()).toHaveLength(1);
  });

  it('keeps a message that arrived while subscribing instead of the older snapshot', async () => {
    const { client, sockets } = setup();
    const onSnapshot = vi.fn();
    client.subscribe(TICKER, { onSnapshot });
    await settle();
    const socket = sockets.last;
    socket.open();
    const req = socket.next();
    socket.send({ ch: TICKER, ts: 3, type: 'ticker', data: ticker('3') });
    req.resolve(ackAll([TICKER], { [TICKER]: ticker('2') }));
    await settle();
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(client.peek(TICKER)?.data).toMatchObject({ last: '3' });
  });

  it('resubscribes durable channels with `since` after a reconnect, in order and without duplicates', async () => {
    const { client, sockets } = setup();
    const got: string[] = [];
    client.subscribe(MARKET, { onMessage: (m) => got.push(m.seq ?? m.type) });
    const socket = await connect(sockets, {}, '100-0');
    socket.send(durable(MARKET, '100-5'));
    socket.send(durable(MARKET, '101-0'));
    socket.send(durable(MARKET, '101-0')); // the same entry twice
    expect(got).toEqual(['100-5', '101-0']);

    socket.drop();
    expect(client.getConnection()).toMatchObject({ state: 'reconnecting' });
    expect(client.peek(MARKET)?.status.state).toBe('pending');
    socket.open(); // Socket.IO reconnected by itself
    const req = socket.next();
    expect(req.payload).toEqual({ channels: [MARKET], since: { [MARKET]: '101-0' } });
    // While the ack is outstanding: a live message overtakes the replay, plus copies on both sides.
    socket.send(durable(MARKET, '103-0', 'wall.ended')); // live
    socket.send(durable(MARKET, '101-0')); // already handled before the disconnect
    socket.send(durable(MARKET, '102-0', 'gap.closed')); // replayed
    socket.send(durable(MARKET, '103-0', 'wall.ended')); // replayed copy of the live one
    expect(got).toHaveLength(2);
    req.resolve({ ok: true, results: { [MARKET]: { mode: 'replayed', seq: '103-0' } } });
    await settle();
    expect(got).toEqual(['100-5', '101-0', '102-0', '103-0']);

    socket.send(durable(MARKET, '102-0', 'gap.closed')); // a lagging copy after the ack
    socket.send(durable(MARKET, '104-0'));
    socket.send({ ch: MARKET, ts: 5, type: 'spread', data: {} }); // non-durable messages carry no seq
    socket.send({ ch: MARKET, ts: 6, type: 'spread', data: {} });
    expect(got).toEqual(['100-5', '101-0', '102-0', '103-0', '104-0', 'spread', 'spread']);
  });

  it('replaces local state with a snapshot when the missed messages cannot be replayed', async () => {
    const { client, sockets } = setup();
    const events: string[] = [];
    client.subscribe(TRADES, {
      onMessage: (m) => events.push(`message ${m.seq}`),
      onSnapshot: (s) => events.push(`snapshot ${JSON.stringify(s)}`),
    });
    const socket = await connect(sockets, {}, '10-0');
    socket.send(durable(TRADES, '11-0', 'trade.large'));
    socket.drop();
    socket.open();
    const req = socket.next();
    expect(req.payload).toEqual({ channels: [TRADES], since: { [TRADES]: '11-0' } });
    socket.send(durable(TRADES, '50-0', 'trade.large')); // already part of the snapshot
    socket.send(durable(TRADES, '61-0', 'trade.large')); // newer than the snapshot
    req.resolve({
      ok: true,
      results: { [TRADES]: { mode: 'snapshot', seq: '60-0', snapshot: { largeTrades: [] } } },
    });
    await settle();
    expect(events).toEqual(['message 11-0', 'snapshot {"largeTrades":[]}', 'message 61-0']);
    socket.send(durable(TRADES, '55-0', 'trade.large'));
    expect(events).toHaveLength(3);
  });

  it('reports the connection state as it connects, drops and recovers', async () => {
    const { client, sockets, states } = setup();
    client.subscribe(TICKER, {});
    await settle();
    const socket = sockets.last;
    socket.unreachable(); // Socket.IO keeps retrying by itself
    expect(client.getConnection()).toMatchObject({
      state: 'reconnecting',
      detail: 'Cannot reach the server. Retrying.',
    });
    socket.open();
    await answerSubscribes(socket);
    socket.drop('ping timeout');
    socket.open();
    await answerSubscribes(socket);
    expect(states).toEqual(['connecting', 'reconnecting', 'live', 'reconnecting', 'live']);
    expect(socket.subscribeRequests()).toHaveLength(2);
    expect(socket.connectCalls).toBe(1);
  });

  it('reconnects by itself, with backoff, after the server closes the connection', async () => {
    vi.useFakeTimers();
    const { client, sockets } = setup();
    client.subscribe(TICKER, {});
    const socket = await connect(sockets);
    socket.drop('io server disconnect');
    expect(client.getConnection().state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(999);
    expect(socket.connectCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.connectCalls).toBe(2);
    socket.drop('io server disconnect');
    await vi.advanceTimersByTimeAsync(1_999);
    expect(socket.connectCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.connectCalls).toBe(3);
  });

  it('refreshes the access token when the handshake is refused as expired, then connects with it', async () => {
    const { client, sockets, refreshToken } = setup();
    client.subscribe(TICKER, {});
    await settle();
    const socket = sockets.last;
    expect(socket.token()).toBe('token-1');
    socket.refuse('AUTH_EXPIRED');
    await settle();
    expect(refreshToken).toHaveBeenCalledOnce();
    expect(socket.connectCalls).toBe(2);
    expect(socket.token()).toBe('token-2');
    socket.open();
    expect(client.getConnection().state).toBe('live');
  });

  it('ends the session when the token cannot be refreshed', async () => {
    const { client, sockets, onSessionEnded } = setup({ refreshToken: async () => false });
    client.subscribe(TICKER, {});
    await settle();
    sockets.last.refuse('AUTH_REQUIRED');
    await settle();
    expect(client.getConnection()).toMatchObject({
      state: 'disconnected',
      detail: 'Your session ended. Sign in again.',
    });
    expect(onSessionEnded).toHaveBeenCalledOnce();
    expect(sockets.last.connectCalls).toBe(1);
  });

  it('does not retry when the role may not receive live data', async () => {
    vi.useFakeTimers();
    const { client, sockets, refreshToken } = setup();
    client.subscribe(TICKER, {});
    await vi.advanceTimersByTimeAsync(0);
    sockets.last.refuse('FORBIDDEN');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.getConnection().state).toBe('disconnected');
    expect(refreshToken).not.toHaveBeenCalled();
    expect(sockets.last.connectCalls).toBe(1);
  });

  it('renews the token on auth:expired without reconnecting', async () => {
    const { client, sockets, refreshToken } = setup();
    client.subscribe(TICKER, {});
    const socket = await connect(sockets);
    socket.fire('auth:expired');
    await settle();
    expect(refreshToken).toHaveBeenCalledOnce();
    const renew = socket.next('auth:renew');
    expect(renew.payload).toEqual({ token: 'token-2' });
    renew.resolve({ ok: true });
    await settle();
    expect(socket.connectCalls).toBe(1);
    expect(client.getConnection().state).toBe('live');
  });

  it('marks channels the server refuses, and retries only transient refusals', async () => {
    vi.useFakeTimers();
    const { client, sockets } = setup();
    const unknown = `ticker:${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`;
    const statuses: string[] = [];
    client.subscribe(unknown, { onStatus: (s) => statuses.push(`${s.state}:${s.error}`) });
    client.subscribe(BOOK, {});
    await vi.advanceTimersByTimeAsync(0);
    const socket = sockets.last;
    socket.open();
    socket.next().resolve({
      ok: true,
      results: {
        [unknown]: { mode: 'live', error: 'CHANNEL_UNKNOWN' },
        [BOOK]: { mode: 'live', error: 'RATE_LIMITED' },
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses).toEqual(['error:CHANNEL_UNKNOWN']);
    expect(client.peek(BOOK)?.status).toEqual({ state: 'error', error: 'RATE_LIMITED' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(socket.next().payload).toEqual({ channels: [BOOK] });
  });

  it('splits large subscriptions into requests of at most 100 channels', async () => {
    const { client, sockets } = setup();
    for (let i = 0; i < 150; i++)
      client.subscribe(`ticker:019a6f00-0000-7000-8000-${String(i).padStart(12, '0')}`, {});
    await settle();
    sockets.last.open();
    expect(sockets.last.subscribeRequests().map((r) => r.channels.length)).toEqual([100, 50]);
  });

  it('resynchronises every channel on demand, for sleep and network changes', async () => {
    const { client, sockets } = setup();
    client.subscribe(MARKET, {});
    const socket = await connect(sockets, {}, '7-0');
    client.reconnect();
    expect(client.getConnection().state).toBe('reconnecting');
    expect(socket.connectCalls).toBe(2);
    socket.open();
    expect(socket.next().payload).toEqual({ channels: [MARKET], since: { [MARKET]: '7-0' } });
  });

  it('closes the connection and forgets every position on sign-out', async () => {
    const { client, sockets, setToken } = setup();
    client.subscribe(TRADES, {});
    const socket = await connect(sockets);
    socket.send(durable(TRADES, '1001-0', 'trade.large'));
    client.stop();
    expect(socket.connected).toBe(false);
    expect(client.getConnection().state).toBe('idle');
    setToken(null);
    client.subscribe(TICKER, {});
    await settle();
    expect(sockets.made).toHaveLength(1); // signed out: no new connection

    setToken('token-9');
    client.subscribe(BOOK, {});
    const next = await connect(sockets);
    expect(sockets.made).toHaveLength(2);
    // A new session starts from scratch: no `since` from the previous one.
    expect(next.subscribeRequests()[0]?.since).toBeUndefined();
  });
});

describe('seq', () => {
  it('orders stream ids numerically, part by part', () => {
    expect(compareSeq('9-0', '10-0')).toBeLessThan(0);
    expect(compareSeq('1731240000000-10', '1731240000000-9')).toBeGreaterThan(0);
    expect(compareSeq('5-1', '5-1')).toBe(0);
    expect(maxSeq(null, '1-0')).toBe('1-0');
    expect(maxSeq('2-0', '10-0')).toBe('10-0');
    expect(maxSeq('3-0', null)).toBe('3-0');
  });
});
