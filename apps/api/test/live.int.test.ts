import { Redis } from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { type Envelope, type SubscribeAck, WS_NAMESPACE, WS_PATH } from '@cip/contracts';
import { createUser, type Harness, startApi, tokenFor } from './harness.ts';

const BTC = '019a6f00-0000-7000-8000-000000000001';
const PAXG_CB = '019a6f00-0000-7000-8000-000000000008';

let h: Harness;
let token: string;
const redis = new Redis(inject('redisUrl'));
const sockets: Socket[] = [];

beforeAll(async () => {
  h = await startApi();
  token = await tokenFor(h, await createUser(h, 'viewer'));
});
afterAll(async () => {
  for (const s of sockets) s.disconnect();
  redis.disconnect();
  await h.close();
});

function connect(auth: Record<string, unknown>): Socket {
  const socket = io(h.base + WS_NAMESPACE, {
    path: WS_PATH,
    transports: ['websocket'],
    auth,
    reconnection: false,
  });
  sockets.push(socket);
  return socket;
}

async function connected(socket: Socket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
}

function subscribe(
  socket: Socket,
  channels: string[],
  since?: Record<string, string>,
): Promise<SubscribeAck> {
  return socket.emitWithAck('subscribe', since ? { channels, since } : { channels }) as Promise<SubscribeAck>;
}

function collect(socket: Socket): Envelope[] {
  const messages: Envelope[] = [];
  socket.on('message', (m: Envelope) => messages.push(m));
  return messages;
}

const event = (type: string, data: Record<string, unknown>) =>
  redis.xadd('md:events', '*', 'type', type, 'data', JSON.stringify(data));

describe('live gateway', () => {
  it('refuses a connection without a valid access token', async () => {
    const error = await connected(connect({})).catch((e: unknown) => e as Error);
    expect((error as Error).message).toBe('AUTH_REQUIRED');
    const bad = await connected(connect({ token: 'not-a-jwt' })).catch((e: unknown) => e as Error);
    expect(bad).toBeInstanceOf(Error);
  });

  it('gives a ticker snapshot on subscribe, then forwards what the ingestor publishes', async () => {
    const ticker = {
      instrumentId: BTC,
      ts: 1,
      last: '74000',
      bid: '73999',
      ask: '74001',
      change24hPct: 0.5,
      volume24hQuote: '1',
    };
    await redis.set(`ticker:${BTC}`, JSON.stringify(ticker), 'PX', 10_000);
    const socket = connect({ token });
    await connected(socket);
    const messages = collect(socket);
    const ack = await subscribe(socket, [
      `ticker:${BTC}`,
      'ticker:not-a-channel',
      `book:00000000-0000-4000-8000-000000000000`,
    ]);
    expect(ack.ok).toBe(true);
    expect(ack.results[`ticker:${BTC}`]).toEqual({ mode: 'snapshot', snapshot: ticker });
    expect(ack.results['ticker:not-a-channel']!.error).toBe('CHANNEL_UNKNOWN');
    expect(ack.results['book:00000000-0000-4000-8000-000000000000']!.error).toBe('CHANNEL_UNKNOWN'); // no such instrument

    const update = { ch: `ticker:${BTC}`, ts: 2, type: 'ticker', data: { ...ticker, last: '74010' } };
    await expect
      .poll(async () => {
        await redis.publish(`live:ticker:${BTC}`, JSON.stringify(update));
        return messages.length;
      })
      .toBeGreaterThan(0);
    expect(messages[0]).toEqual(update);

    // A later subscriber gets the latest live message as its snapshot.
    const late = connect({ token });
    await connected(late);
    expect((await subscribe(late, [`ticker:${BTC}`])).results[`ticker:${BTC}`]!.snapshot).toMatchObject({
      last: '74010',
    });
  });

  it('delivers durable events with their stream id, and replays what a reconnecting client missed', async () => {
    const socket = connect({ token });
    await connected(socket);
    const messages = collect(socket);
    const ack = await subscribe(socket, [`market:${PAXG_CB}`, `trades:${PAXG_CB}`]);
    expect(ack.results[`market:${PAXG_CB}`]!.mode).toBe('live');

    const firstSeq = await event('wall.appeared', {
      id: 'w1',
      instrumentId: PAXG_CB,
      side: 'bid',
      price: '4099.5',
    });
    await event('trade.large', { id: 't1', instrumentId: PAXG_CB, notionalUsd: '174230.5' });
    await event('wall.appeared', { id: 'other', instrumentId: BTC }); // another instrument: not delivered
    await expect.poll(() => messages.length).toBe(2);
    expect(messages[0]).toMatchObject({ ch: `market:${PAXG_CB}`, seq: firstSeq, type: 'wall.appeared' });
    expect(messages[1]).toMatchObject({ ch: `trades:${PAXG_CB}`, type: 'trade.large' });
    socket.disconnect();

    // While disconnected: two more market events.
    await event('wall.ended', { id: 'w1', instrumentId: PAXG_CB, endedReason: 'filled' });
    await event('gap.opened', { gapId: 'g1', instrumentId: PAXG_CB, stream: 'trades' });

    const again = connect({ token });
    await connected(again);
    const replayed = collect(again);
    const resumed = await subscribe(again, [`market:${PAXG_CB}`], { [`market:${PAXG_CB}`]: firstSeq! });
    expect(resumed.results[`market:${PAXG_CB}`]!.mode).toBe('replayed');
    await expect.poll(() => replayed.map((m) => m.type)).toEqual(['wall.ended', 'gap.opened']);

    // A position older than anything the stream still holds: a snapshot replaces the local state.
    const tooOld = await subscribe(again, [`trades:${PAXG_CB}`], { [`trades:${PAXG_CB}`]: '1-0' });
    expect(tooOld.results[`trades:${PAXG_CB}`]).toMatchObject({
      mode: 'snapshot',
      snapshot: { largeTrades: [] },
    });
  });

  it('sends system health as a snapshot on subscribe', async () => {
    const socket = connect({ token });
    await connected(socket);
    const ack = await subscribe(socket, ['system:health']);
    expect(ack.results['system:health']).toMatchObject({
      mode: 'snapshot',
      snapshot: { dependencies: expect.any(Array), feeds: expect.any(Array) },
    });
  });

  it('disconnects a client whose renewal token is invalid', async () => {
    const socket = connect({ token });
    await connected(socket);
    const closed = new Promise<void>((resolve) => socket.once('disconnect', () => resolve()));
    const renewed = (await socket.emitWithAck('auth:renew', { token: 'expired-or-forged' })) as {
      ok: boolean;
    };
    expect(renewed.ok).toBe(false);
    await closed;
  });
});
