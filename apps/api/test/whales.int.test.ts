import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { ONCHAIN_STATUS_KEY, type OnchainStatus } from '@cip/contracts';
import { createDb } from '@cip/db';
import { REDIS } from '../src/tokens.ts';
import { call, createUser, type Harness, startApi, tokenFor, type TestUser } from './harness.ts';

const SOL_BN = '019a6f00-0000-7000-8000-000000000003';
const ETH_CB = '019a6f00-0000-7000-8000-000000000006';

let h: Harness;
let viewer: string;
let admin: string;
let adminUser: TestUser;
const owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 2 });

beforeAll(async () => {
  h = await startApi();
  viewer = await tokenFor(h, await createUser(h, 'viewer'));
  adminUser = await createUser(h, 'admin');
  admin = await tokenFor(h, adminUser);
});
afterAll(async () => {
  await h.close();
  await owner.destroy();
});

const get = (path: string, token = viewer) => call(h.base, 'GET', `/api/v1${path}`, { token });
const HOUR = 3_600_000;

describe('Whale Tracker: exchange flow (criterion 11.1)', () => {
  // A window of its own, far from the other suites' rows.
  const from = Date.UTC(2026, 6, 1, 12);
  const to = from + HOUR;

  const trade = (instrument: string, at: number, side: 'buy' | 'sell', usd: string) => ({
    id: randomUUID(),
    instrument_id: instrument,
    ts: new Date(at),
    taker_side: side,
    avg_price: '100',
    qty: String(Number(usd) / 100),
    notional_usd: usd,
    grouping: 'taker_order' as const,
    fill_count: 2,
    price_levels: 1,
    threshold_usd: '100000',
  });
  const wall = (instrument: string, firstSeen: number, ended: 'filled' | 'pulled' | null) => ({
    id: randomUUID(),
    instrument_id: instrument,
    side: 'bid' as const,
    price: '150',
    first_seen: new Date(firstSeen),
    last_seen: new Date(firstSeen + 60_000),
    max_notional_usd: '900000',
    ended_reason: ended,
  });

  beforeAll(async () => {
    await owner
      .insertInto('market.large_trades')
      .values([
        trade(SOL_BN, from + 1_000, 'buy', '300000'),
        trade(SOL_BN, from + 2_000, 'buy', '500000'),
        trade(SOL_BN, from + 3_000, 'sell', '200000'),
        trade(ETH_CB, from + 4_000, 'buy', '150000'),
        trade(SOL_BN, to + 1_000, 'buy', '999999'), // after the window
      ])
      .execute();
    await owner
      .insertInto('market.orderbook_walls')
      .values([
        wall(SOL_BN, from + 10_000, 'filled'),
        wall(SOL_BN, from + 20_000, 'pulled'),
        wall(SOL_BN, from - 5 * HOUR, null), // standing, first seen before the window
      ])
      .execute();
  });

  it('totals each instrument and lists every large trade and wall in the window', async () => {
    const res = await get(`/whales/exchange?from=${from}&to=${to}`);
    expect(res.status).toBe(200);
    const sol = res.body.instruments.find((i: { instrumentId: string }) => i.instrumentId === SOL_BN);
    expect(sol).toEqual({
      instrumentId: SOL_BN,
      largeTrades: 3,
      buys: 2,
      sells: 1,
      boughtUsd: '800000',
      soldUsd: '200000',
      netUsd: '600000',
      largestUsd: '500000',
      wallsAppeared: 2,
      wallsFilled: 1,
      wallsPulled: 1,
      wallsStanding: expect.any(Number),
    });
    expect(sol.wallsStanding).toBeGreaterThanOrEqual(1);
    // By most large-trade USD: SOL (1,000,000) before ETH (150,000).
    const order = res.body.instruments.map((i: { instrumentId: string }) => i.instrumentId);
    expect(order.indexOf(SOL_BN)).toBeLessThan(order.indexOf(ETH_CB));
    const inWindow = res.body.largeTrades.filter((t: { ts: number }) => t.ts >= from && t.ts < to);
    expect(inWindow.map((t: { notionalUsd: string }) => t.notionalUsd)).toEqual([
      '150000',
      '200000',
      '500000',
      '300000',
    ]);
    expect(res.body.largeTradesTotal).toBe(
      res.body.instruments.reduce((n: number, i: { largeTrades: number }) => n + i.largeTrades, 0),
    );
    // Standing walls first, then the window's.
    const walls = res.body.walls.filter((w: { instrumentId: string }) => w.instrumentId === SOL_BN);
    expect(walls[0].endedReason).toBeNull();
    expect(
      walls
        .filter((w: { endedReason: string | null }) => w.endedReason !== null)
        .map((w: { endedReason: string }) => w.endedReason),
    ).toEqual(['pulled', 'filled']);
  });

  it('narrows to one instrument, and refuses windows over 7 days', async () => {
    const one = await get(`/whales/exchange?instrumentId=${ETH_CB}&from=${from}&to=${to}`);
    expect(one.body.instruments.map((i: { instrumentId: string }) => i.instrumentId)).toEqual([ETH_CB]);
    expect(one.body.largeTrades).toHaveLength(1);
    expect((await get(`/whales/exchange?from=${from - 8 * 24 * HOUR}&to=${to}`)).status).toBe(400);
    expect((await call(h.base, 'GET', '/api/v1/whales/exchange')).status).toBe(401);
  });
});

describe('Whale Tracker: on-chain (criteria 11.2 and 11.3)', () => {
  const from = Date.UTC(2026, 6, 2, 12);
  const to = from + HOUR;
  const binanceBtc = 'bc1qtestexchangewallet0000000000000000000';
  const coinbaseEth = '0x' + 'c'.repeat(40);

  const event = (over: Record<string, unknown>) => ({
    id: randomUUID(),
    chain: 'bitcoin' as const,
    asset: 'BTC' as const,
    kind: 'transfer' as const,
    tx_hash: randomUUID(),
    position: 0,
    block_number: 900_000,
    block_time: new Date(from + 1_000),
    from_address: 'bc1qsomeonesaddress000000000000000000000',
    to_address: binanceBtc,
    amount: '20',
    price_usd: '65000',
    usd_value: '1300000',
    provider: 'mempool.space',
    received_at: new Date(from + 61_000),
    ...over,
  });

  beforeAll(async () => {
    await owner
      .insertInto('onchain.events')
      .values([
        event({}),
        event({
          chain: 'ethereum',
          asset: 'ETH',
          tx_hash: '0x' + 'e'.repeat(64),
          block_time: new Date(from + 2_000),
          from_address: coinbaseEth,
          to_address: '0x' + 'd'.repeat(40),
          amount: '500',
          price_usd: '3200',
          usd_value: '1600000',
          provider: 'alchemy',
        }),
        event({
          chain: 'ethereum',
          asset: 'PAXG',
          kind: 'mint',
          tx_hash: '0x' + 'f'.repeat(64),
          position: 132,
          block_time: new Date(from + 3_000),
          from_address: null,
          to_address: '0x' + 'a'.repeat(40),
          amount: '62.9874',
          price_usd: null,
          usd_value: null,
          provider: 'alchemy',
        }),
        event({
          chain: 'ethereum',
          asset: 'PAXG',
          kind: 'burn',
          tx_hash: '0x' + '9'.repeat(64),
          position: 164,
          block_time: new Date(from + 4_000),
          from_address: '0x' + 'b'.repeat(40),
          to_address: null,
          amount: '3.2',
          price_usd: null,
          usd_value: null,
          provider: 'alchemy',
        }),
        event({ block_time: new Date(to + 1_000) }), // after the window
      ])
      .execute();
  });

  it('keeps the exchange addresses for admins only, audited, and refuses malformed or repeated ones', async () => {
    const body = {
      chain: 'bitcoin',
      address: binanceBtc,
      owner: 'Binance',
      wallet: 'cold',
      source: 'https://www.binance.com/en/proof-of-reserves',
    };
    expect((await call(h.base, 'POST', '/api/v1/admin/whales/labels', { token: viewer, body })).status).toBe(
      403,
    );
    expect((await get('/admin/whales/labels')).status).toBe(403);
    const created = await call(h.base, 'POST', '/api/v1/admin/whales/labels', { token: admin, body });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      chain: 'bitcoin',
      address: binanceBtc,
      owner: 'Binance',
      wallet: 'cold',
    });
    expect((await call(h.base, 'POST', '/api/v1/admin/whales/labels', { token: admin, body })).status).toBe(
      409,
    );
    const bad = await call(h.base, 'POST', '/api/v1/admin/whales/labels', {
      token: admin,
      body: { ...body, chain: 'ethereum', address: '0x123' },
    });
    expect(bad.status).toBe(400);
    // Ethereum addresses are stored lowercased.
    const eth = await call(h.base, 'POST', '/api/v1/admin/whales/labels', {
      token: admin,
      body: {
        ...body,
        chain: 'ethereum',
        address: coinbaseEth.toUpperCase().replace('0X', '0x'),
        owner: 'Coinbase',
        wallet: 'hot',
      },
    });
    expect(eth.body.address).toBe(coinbaseEth);
    const audit = await owner
      .selectFrom('app.audit_log')
      .select(['action', 'actor_user_id'])
      .where('target_type', '=', 'onchain_label')
      .where('target_id', '=', created.body.id)
      .execute();
    expect(audit).toEqual([{ action: 'onchain_label.created', actor_user_id: adminUser.id }]);
  });

  it('lists the window newest first with each address owner and exchange flow, and totals each asset', async () => {
    const res = await get(`/whales/onchain?from=${from}&to=${to}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((e: { kind: string; asset: string }) => `${e.asset} ${e.kind}`)).toEqual([
      'PAXG burn',
      'PAXG mint',
      'ETH transfer',
      'BTC transfer',
    ]);
    const [burn, mint, eth, btc] = res.body.items;
    expect(btc).toMatchObject({
      toOwner: 'Binance',
      fromOwner: null,
      flow: 'to_exchange',
      amount: '20',
      usdValue: '1300000',
    });
    expect(btc.receivedAt - btc.blockTime).toBe(60_000);
    expect(eth).toMatchObject({ fromOwner: 'Coinbase', flow: 'from_exchange' });
    expect(mint).toMatchObject({ from: null, flow: 'other', amount: '62.9874' });
    expect(burn).toMatchObject({ to: null, amount: '3.2' });
    const byAsset = Object.fromEntries(
      res.body.summary.map((s: { asset: string }) => [s.asset, s]),
    ) as Record<string, Record<string, unknown>>;
    expect(byAsset.BTC).toMatchObject({
      transfers: 1,
      transferUsd: '1300000',
      toExchangeUsd: '1300000',
      fromExchangeUsd: '0',
    });
    expect(byAsset.ETH).toMatchObject({ transfers: 1, fromExchangeUsd: '1600000' });
    expect(byAsset.PAXG).toMatchObject({
      transfers: 0,
      mints: 1,
      burns: 1,
      minted: '62.9874',
      burned: '3.2',
    });
    expect(byAsset.SOL).toMatchObject({ transfers: 0, transferUsd: '0' });
  });

  it('filters by asset and kind, and pages with a cursor', async () => {
    const paxg = await get(`/whales/onchain?asset=PAXG&kind=mint&from=${from}&to=${to}`);
    expect(paxg.body.items).toHaveLength(1);
    const first = await get(`/whales/onchain?limit=3&from=${from}&to=${to}`);
    expect(first.body.items).toHaveLength(3);
    const second = await get(`/whales/onchain?limit=3&from=${from}&to=${to}&cursor=${first.body.nextCursor}`);
    expect(second.body.items.map((e: { asset: string }) => e.asset)).toEqual(['BTC']);
    expect(second.body.nextCursor).toBeNull();
  });

  it('reports the sources as the jobs service last wrote them, stale once it stops', async () => {
    const redis = h.app.get<Redis>(REDIS);
    await redis.del(ONCHAIN_STATUS_KEY);
    expect((await get('/whales/onchain/status')).body).toMatchObject({ sources: [], stale: true });
    const status: OnchainStatus = {
      updatedAt: h.clock.now,
      sources: [
        {
          chain: 'bitcoin',
          provider: 'mempool.space',
          state: 'connected',
          detail: 'connected',
          lastBlock: 976_172,
          lastBlockTime: h.clock.now - 60_000,
          watching: null,
        },
        {
          chain: 'ethereum',
          provider: 'alchemy',
          state: 'no_key',
          detail: 'no Alchemy key',
          lastBlock: null,
          lastBlockTime: null,
          watching: null,
        },
      ],
      thresholdsUsd: { BTC: '1000000', ETH: '1000000', SOL: '1000000', PAXG: '250000' },
    };
    await redis.set(ONCHAIN_STATUS_KEY, JSON.stringify(status));
    expect((await get('/whales/onchain/status')).body).toEqual({ ...status, stale: false });
    h.clock.advance(61_000);
    expect((await get('/whales/onchain/status')).body.stale).toBe(true);
    await redis.del(ONCHAIN_STATUS_KEY);
  });
});
