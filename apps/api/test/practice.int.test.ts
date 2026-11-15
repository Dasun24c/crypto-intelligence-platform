import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import {
  DEFAULT_PRACTICE_SETTINGS,
  type Envelope,
  PRACTICE_EVENTS_STREAM,
  type PracticeAccount,
  type PracticeOrder,
  type PracticeSettings,
  type SubscribeAck,
  WS_NAMESPACE,
  WS_PATH,
} from '@cip/contracts';
import { PRACTICE_COMMANDS_STREAM } from '@cip/contracts/practice-commands';
import { createDb } from '@cip/db';
import { call, createUser, type Harness, startApi, type TestUser, tokenFor } from './harness.ts';

/** Phase 14 (REQUIREMENTS §11, ADR 021): the api's side of practice trading. No broker runs here. */
const BTC = '019a6f00-0000-7000-8000-000000000001';
const PAXG = '019a6f00-0000-7000-8000-000000000004';
const BTC_CB = '019a6f00-0000-7000-8000-000000000005';
const USDT_USD = '019a6f00-0000-7000-8000-000000000009';

let h: Harness;
const redis = new Redis(inject('redisUrl'));
const owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 2 });
const sockets: Socket[] = [];
let alice: TestUser;
let bob: TestUser;
let aliceToken: string;
let bobToken: string;
let adminToken: string;

/** A call as a user; the test clock moves on a little, as it would between requests. */
function api(method: string, path: string, token: string, body?: unknown) {
  h.clock.advance(100);
  return call(h.base, method, `/api/v1${path}`, { token, ...(body !== undefined ? { body } : {}) });
}

const order = (o: Record<string, unknown>) => ({
  clientOrderId: `t-${randomUUID()}`,
  instrumentId: BTC,
  ...o,
});

/** The ingestor's feed status: the pairs' trades and book streaming. */
async function streaming(venue: 'binance' | 'coinbase', ids: string[], state = 'connected', only?: string) {
  await redis.set(
    `feed:status:${venue}`,
    JSON.stringify({
      ts: Date.now(),
      instance: 'test',
      feeds: ids.flatMap((instrumentId) =>
        ['trades', 'depth'].map((stream) => ({
          instrumentId,
          stream,
          state: only && stream !== only ? 'connected' : state,
          lastMessageAt: Date.now(),
          detail: 'streaming',
        })),
      ),
    }),
    'PX',
    600_000,
  );
}

async function setBook(id: string, bids: [string, string][], asks: [string, string][]) {
  await redis.set(
    `book:${id}`,
    JSON.stringify({ instrumentId: id, ts: Date.now(), bids, asks, coverageBps: 50 }),
  );
}

async function lastCommand(): Promise<Record<string, string> | null> {
  const [entry] = await redis.xrevrange(PRACTICE_COMMANDS_STREAM, '+', '-', 'COUNT', 1);
  if (!entry) return null;
  const f: Record<string, string> = {};
  for (let i = 0; i < entry[1].length; i += 2) f[entry[1][i]!] = entry[1][i + 1]!;
  return f;
}

async function commandsFor(orderId: string): Promise<number> {
  const entries = await redis.xrange(PRACTICE_COMMANDS_STREAM, '-', '+');
  return entries.filter(([, fields]) => fields.includes(orderId)).length;
}

const audit = (targetId: string) =>
  owner
    .selectFrom('app.audit_log')
    .select(['action', 'actor_user_id', 'target_type', 'details'])
    .where('target_id', '=', targetId)
    .orderBy('chain_seq')
    .execute();

const storedOrders = (clientOrderId: string) =>
  owner.selectFrom('trading.orders').selectAll().where('client_order_id', '=', clientOrderId).execute();

beforeAll(async () => {
  h = await startApi();
  alice = await createUser(h, 'viewer');
  bob = await createUser(h, 'analyst');
  const admin = await createUser(h, 'admin');
  aliceToken = await tokenFor(h, alice);
  bobToken = await tokenFor(h, bob);
  adminToken = await tokenFor(h, admin);
  await owner.updateTable('market.instruments').set({ min_notional: '5' }).where('id', '=', BTC).execute();
  await streaming('binance', [BTC, PAXG]);
  await streaming('coinbase', [BTC_CB]);
  await setBook(
    BTC,
    [['99.99', '2']],
    [
      ['100.00', '1'],
      ['100.50', '2'],
    ],
  );
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await owner.updateTable('market.instruments').set({ min_notional: '0' }).where('id', '=', BTC).execute();
  await redis.del('feed:status:binance', 'feed:status:coinbase', `book:${BTC}`, `ticker:${BTC}`);
  redis.disconnect();
  await owner.destroy();
  await h.close();
});

// A full order bucket for every test: 5 per second.
beforeEach(() => h.clock.advance(1_000));

describe('practice accounts (TRD-01)', () => {
  it('opens one account per venue with the starting balances, once, however many requests race', async () => {
    const results = await Promise.all([1, 2, 3].map(() => api('GET', '/practice/account', aliceToken)));
    for (const r of results) expect(r.status).toBe(200);
    const accounts = results[0]!.body.accounts as PracticeAccount[];
    expect(accounts.map((a) => [a.venue, a.resetEpoch, a.startingBalances])).toEqual([
      ['binance', 0, { USDT: '10000' }],
      ['coinbase', 0, { USD: '10000' }],
      ['replay', 0, { USD: '10000', USDT: '10000' }],
    ]);
    expect(accounts[0]!.balances).toEqual([{ asset: 'USDT', available: '10000', reserved: '0' }]);
    expect(results[0]!.body.fees).toEqual(DEFAULT_PRACTICE_SETTINGS.fees);
    const rows = await owner
      .selectFrom('trading.accounts')
      .select('id')
      .where('user_id', '=', alice.id)
      .execute();
    expect(rows).toHaveLength(3);
    const ledger = await owner
      .selectFrom('trading.ledger')
      .select(['asset', 'amount', 'reason'])
      .where(
        'account_id',
        'in',
        rows.map((r) => r.id),
      )
      .execute();
    expect(ledger.map((l) => l.reason)).toEqual(['start', 'start', 'start', 'start']);
  });
});

describe('placing orders (TRD-02, TRD-05)', () => {
  it('accepts a market buy, hands it to the broker, and audits it', async () => {
    const res = await api(
      'POST',
      '/practice/orders',
      aliceToken,
      order({ side: 'buy', type: 'market', quantity: '0.5' }),
    );
    expect(res.status).toBe(201);
    const o = res.body as PracticeOrder;
    expect(o).toMatchObject({
      venue: 'binance',
      instrumentId: BTC,
      side: 'buy',
      type: 'market',
      quantity: '0.5',
      status: 'new',
      filledQuantity: '0',
      averagePrice: null,
      refusalReason: null,
      source: 'manual',
      underlyingClosed: false,
    });
    expect(await lastCommand()).toEqual({ type: 'place', orderId: o.id, user: alice.id });
    const entries = await audit(o.id);
    expect(entries.map((e) => [e.action, e.actor_user_id])).toEqual([['practice_order.placed', alice.id]]);
    expect(entries[0]!.details).toMatchObject({
      side: 'buy',
      type: 'market',
      quantity: '0.5',
      venue: 'binance',
    });
  });

  it('returns the same order for a retried submission and never creates a second one (14.4)', async () => {
    const body = order({ side: 'buy', type: 'limit', quantity: '0.1', limitPrice: '95' });
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() => call(h.base, 'POST', '/api/v1/practice/orders', { token: aliceToken, body })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(new Set(results.map((r) => (r.body as PracticeOrder).id)).size).toBe(1);
    expect(await storedOrders(body.clientOrderId)).toHaveLength(1);
    expect(await commandsFor((results[0]!.body as PracticeOrder).id)).toBe(1);

    h.clock.advance(1_000);
    const changed = await api('POST', '/practice/orders', aliceToken, { ...body, quantity: '0.2' });
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe('CONFLICT');
  });

  it('keeps an attached stop and target as sells that wait for the buy and cancel each other', async () => {
    const body = order({
      side: 'buy',
      type: 'limit',
      quantity: '0.1',
      limitPrice: '99.5',
      stop: '95',
      target: '110',
    });
    const res = await api('POST', '/practice/orders', aliceToken, body);
    expect(res.status).toBe(201);
    const open = await api('GET', `/practice/orders?status=open&instrumentId=${BTC}`, aliceToken);
    const mine = (open.body.items as PracticeOrder[]).filter(
      (o) => o.id === res.body.id || o.parentId === res.body.id,
    );
    const legs = mine.filter((o) => o.parentId);
    expect(legs.map((o) => [o.type, o.side, o.quantity, o.stopPrice, o.limitPrice, o.status]).sort()).toEqual(
      [
        ['stop', 'sell', '0.1', '95', null, 'new'],
        ['target', 'sell', '0.1', null, '110', 'new'],
      ],
    );
    expect(new Set(legs.map((o) => o.ocoGroup)).size).toBe(1);
    expect(legs[0]!.ocoGroup).not.toBeNull();
  });

  it('answers 400, storing nothing, for a stop above the buying price or a target below it', async () => {
    const body = order({ side: 'buy', type: 'market', quantity: '0.1', stop: '100.5', target: '99' });
    const res = await api('POST', '/practice/orders', aliceToken, body);
    expect(res.status).toBe(400);
    expect(res.body.errors.map((e: { path: string }) => e.path)).toEqual(['stop', 'target']);
    expect(await storedOrders(body.clientOrderId)).toEqual([]);
  });

  it('marks a PAXG order placed while the gold market is closed', async () => {
    const startsAt = new Date(h.clock.now - 3_600_000);
    await owner
      .insertInto('market.underlying_market_closures')
      .values({
        calendar_id: 'gold',
        starts_at: startsAt,
        ends_at: new Date(h.clock.now + 3_600_000),
        reason: 'holiday',
        source: 'manual',
      })
      .execute();
    try {
      const res = await api(
        'POST',
        '/practice/orders',
        aliceToken,
        order({ instrumentId: PAXG, side: 'buy', type: 'limit', quantity: '0.01', limitPrice: '2000' }),
      );
      expect(res.status).toBe(201);
      expect(res.body.underlyingClosed).toBe(true);
    } finally {
      await owner
        .deleteFrom('market.underlying_market_closures')
        .where('calendar_id', '=', 'gold')
        .where('starts_at', '=', startsAt)
        .execute();
    }
  });

  it('allows five orders per second per user', async () => {
    h.clock.advance(1_000);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await call(h.base, 'POST', '/api/v1/practice/orders', {
        token: bobToken,
        body: order({ side: 'buy', type: 'limit', quantity: '0.1', limitPrice: '90' }),
      });
      statuses.push(res.status);
      if (res.status === 429) expect(res.headers.get('retry-after')).toBe('1');
    }
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
  });
});

describe('refused orders (14.5, TRD-07)', () => {
  async function refused(token: string, body: ReturnType<typeof order>, reason: string) {
    const before = await lastCommand();
    const res = await api('POST', '/practice/orders', token, body);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body).toMatchObject({ code: 'ORDER_REFUSED', status: 422, reason });
    expect(res.body.detail).toEqual(expect.any(String));
    const [row] = await storedOrders(body.clientOrderId);
    expect(row).toMatchObject({ status: 'refused', refusal_reason: reason });
    const entries = await audit(row!.id);
    expect(entries.map((e) => e.action)).toEqual(['practice_order.refused']);
    expect(entries[0]!.details).toMatchObject({ reason, by: 'api' });
    expect(await lastCommand()).toEqual(before);
    return row!;
  }

  it('refuses orders that break the venue rules or the balance, with the reason, and keeps them', async () => {
    await refused(
      aliceToken,
      order({ side: 'buy', type: 'limit', quantity: '0.1', limitPrice: '99.995' }),
      'price_step',
    );
    await refused(
      aliceToken,
      order({ side: 'buy', type: 'limit', quantity: '0.000001', limitPrice: '99' }),
      'quantity_step',
    );
    await refused(
      aliceToken,
      order({ side: 'buy', type: 'limit', quantity: '0.01', limitPrice: '99' }),
      'min_value',
    );
    await refused(
      aliceToken,
      order({ side: 'buy', type: 'limit', quantity: '200', limitPrice: '100' }),
      'insufficient_balance',
    );
    await refused(
      aliceToken,
      order({ side: 'sell', type: 'market', quantity: '0.5' }),
      'insufficient_balance',
    );
    await refused(
      aliceToken,
      order({ instrumentId: USDT_USD, side: 'buy', type: 'market', quantity: '10' }),
      'not_practice_pair',
    );
    await redis.del(`book:${BTC_CB}`);
    await refused(
      aliceToken,
      order({ instrumentId: BTC_CB, side: 'buy', type: 'market', quantity: '0.01' }),
      'no_market',
    );
  });

  it('refuses a retried refused submission again, with the same reason, without a second order', async () => {
    const body = order({ side: 'buy', type: 'limit', quantity: '0.1', limitPrice: '99.995' });
    await refused(aliceToken, body, 'price_step');
    const again = await api('POST', '/practice/orders', aliceToken, body);
    expect(again.status).toBe(422);
    expect(again.body.reason).toBe('price_step');
    expect(await storedOrders(body.clientOrderId)).toHaveLength(1);
  });

  it('refuses orders while the pair’s data is delayed or has a gap, or the pair is halted', async () => {
    try {
      await streaming('binance', [BTC, PAXG], 'degraded', 'trades');
      await refused(aliceToken, order({ side: 'buy', type: 'market', quantity: '0.1' }), 'data_delayed');
      await redis.del('feed:status:binance');
      await refused(aliceToken, order({ side: 'buy', type: 'market', quantity: '0.1' }), 'data_delayed');
      await streaming('binance', [BTC, PAXG]);

      const gap = await owner
        .insertInto('market.data_gaps')
        .values({
          id: randomUUID(),
          instrument_id: BTC,
          stream: 'depth',
          gap_start: new Date(h.clock.now - 60_000),
          gap_end: null,
          detected_at: new Date(h.clock.now - 60_000),
          detected_by: 'sequence',
          status: 'open',
          resolved_at: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await refused(aliceToken, order({ side: 'buy', type: 'market', quantity: '0.1' }), 'data_gap');
      await owner.deleteFrom('market.data_gaps').where('id', '=', gap.id).execute();

      await owner
        .updateTable('market.instruments')
        .set({ venue_status: 'halted' })
        .where('id', '=', BTC)
        .execute();
      await refused(aliceToken, order({ side: 'buy', type: 'market', quantity: '0.1' }), 'pair_halted');
    } finally {
      await owner
        .updateTable('market.instruments')
        .set({ venue_status: 'trading' })
        .where('id', '=', BTC)
        .execute();
      await streaming('binance', [BTC, PAXG]);
    }
  });
});

describe('cancelling orders', () => {
  async function placed(token: string): Promise<PracticeOrder> {
    const res = await api(
      'POST',
      '/practice/orders',
      token,
      order({ side: 'buy', type: 'limit', quantity: '0.1', limitPrice: '90' }),
    );
    expect(res.status).toBe(201);
    return res.body as PracticeOrder;
  }

  it('asks the broker to cancel, answering 202 while it has not applied it yet, and audits the request', async () => {
    const o = await placed(aliceToken);
    const res = await api('POST', `/practice/orders/${o.id}/cancel`, aliceToken);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ id: o.id, status: 'new' });
    expect(await lastCommand()).toEqual({ type: 'cancel', orderId: o.id, user: alice.id });
    expect((await audit(o.id)).map((e) => e.action)).toEqual([
      'practice_order.placed',
      'practice_order.cancel_requested',
    ]);
  });

  it('answers 200 with the cancelled order once the broker has cancelled it, and 409 after', async () => {
    const o = await placed(aliceToken);
    const broker = new Promise<void>((resolve) =>
      setTimeout(() => {
        void owner
          .updateTable('trading.orders')
          .set({ status: 'cancelled', updated_at: new Date() })
          .where('id', '=', o.id)
          .execute()
          .then(() => resolve());
      }, 300),
    );
    const res = await api('POST', `/practice/orders/${o.id}/cancel`, aliceToken);
    await broker;
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    const again = await api('POST', `/practice/orders/${o.id}/cancel`, aliceToken);
    expect(again.status).toBe(409);
  });

  it('lets nobody reach another user’s orders or account (TRD-08)', async () => {
    const o = await placed(aliceToken);
    expect((await api('GET', `/practice/orders/${o.id}`, aliceToken)).status).toBe(200);
    expect((await api('GET', `/practice/orders/${o.id}`, bobToken)).status).toBe(404);
    expect((await api('POST', `/practice/orders/${o.id}/cancel`, bobToken)).status).toBe(404);
    expect((await api('POST', `/practice/orders/${o.id}/cancel`, adminToken)).status).toBe(404);
    const bobs = await api('GET', '/practice/orders?limit=1000', bobToken);
    expect((bobs.body.items as PracticeOrder[]).some((x) => x.id === o.id)).toBe(false);
    const bobAccount = (await api('GET', '/practice/account', bobToken)).body.accounts as PracticeAccount[];
    const aliceAccount = (await api('GET', '/practice/account', aliceToken)).body
      .accounts as PracticeAccount[];
    expect(new Set([...bobAccount, ...aliceAccount].map((a) => a.id)).size).toBe(6);
  });
});

describe('pages of orders and fills', () => {
  it('pages the user’s orders newest first, by status', async () => {
    const first = await api('GET', '/practice/orders?limit=2', aliceToken);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await api('GET', `/practice/orders?limit=2&cursor=${first.body.nextCursor}`, aliceToken);
    const ids = [...first.body.items, ...second.body.items].map((o: PracticeOrder) => o.id);
    expect(new Set(ids).size).toBe(4);
    const times = [...first.body.items, ...second.body.items].map((o: PracticeOrder) => o.createdAt);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    const done = await api('GET', '/practice/orders?status=done&limit=1000', aliceToken);
    expect(
      (done.body.items as PracticeOrder[]).every((o) =>
        ['filled', 'cancelled', 'refused'].includes(o.status),
      ),
    ).toBe(true);
    expect((done.body.items as PracticeOrder[]).some((o) => o.status === 'refused')).toBe(true);
  });
});

describe('resetting an account', () => {
  it('asks the broker to reset, answering 202 until it has, and audits the request', async () => {
    const res = await api('POST', '/practice/account/reset', aliceToken, { venue: 'coinbase' });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ venue: 'coinbase', resetEpoch: 0 });
    expect(await lastCommand()).toEqual({ type: 'reset', accountId: res.body.id, user: alice.id });
    expect((await audit(res.body.id)).map((e) => [e.action, e.target_type])).toEqual([
      ['practice_account.reset_requested', 'practice_account'],
    ]);
    expect((await api('POST', '/practice/account/reset', aliceToken, { venue: 'nasdaq' })).status).toBe(400);
  });

  it('answers 200 with the account once the broker has started its next period', async () => {
    const accounts = (await api('GET', '/practice/account', aliceToken)).body.accounts as PracticeAccount[];
    const replay = accounts.find((a) => a.venue === 'replay')!;
    const broker = new Promise<void>((resolve) =>
      setTimeout(() => {
        void owner
          .updateTable('trading.accounts')
          .set({ reset_epoch: 1 })
          .where('id', '=', replay.id)
          .execute()
          .then(() => resolve());
      }, 300),
    );
    const res = await api('POST', '/practice/account/reset', aliceToken, { venue: 'replay' });
    await broker;
    expect(res.status).toBe(200);
    expect(res.body.resetEpoch).toBe(1);
  });
});

describe('positions and profit and loss (TRD-04)', () => {
  it('values holdings at average cost with fees, realised and unrealised, for the current period only', async () => {
    const carol = await createUser(h, 'viewer');
    const token = await tokenFor(h, carol);
    const accounts = (await api('GET', '/practice/account', token)).body.accounts as PracticeAccount[];
    const binance = accounts.find((a) => a.venue === 'binance')!;
    // What the broker would have written: two buys and a sell.
    const fills: [string, string, string, string][] = [
      ['buy', '100', '0.5', '0.05'],
      ['buy', '110', '0.5', '0.055'],
      ['sell', '120', '0.4', '0.048'],
    ];
    const t0 = h.clock.now - 60_000;
    for (const [i, [side, price, quantity, fee]] of fills.entries()) {
      const orderId = randomUUID();
      await owner
        .insertInto('trading.orders')
        .values({
          id: orderId,
          account_id: binance.id,
          instrument_id: BTC,
          client_order_id: orderId,
          side: side as 'buy' | 'sell',
          type: 'market',
          quantity,
          limit_price: null,
          stop_price: null,
          status: 'filled',
          refusal_reason: null,
          filled_quantity: quantity,
          filled_value: String(Number(price) * Number(quantity)),
          parent_id: null,
          oco_group: null,
          source: 'manual',
          setup_id: null,
          reset_epoch: 0,
        })
        .execute();
      await owner
        .insertInto('trading.fills')
        .values({
          id: randomUUID(),
          order_id: orderId,
          account_id: binance.id,
          instrument_id: BTC,
          side: side as 'buy' | 'sell',
          price,
          quantity,
          fee,
          fee_asset: 'USDT',
          liquidity: 'taker',
          flags: [],
          basis: { book: [[price, quantity]] },
          reset_epoch: 0,
          filled_at: new Date(t0 + i * 1_000),
        })
        .execute();
    }
    await redis.set(
      `ticker:${BTC}`,
      JSON.stringify({
        instrumentId: BTC,
        ts: h.clock.now,
        last: '130',
        bid: '129.9',
        ask: '130.1',
        change24hPct: 0,
        volume24hQuote: '0',
      }),
    );

    // Bought 1 for 105.105 with fees; sold 0.4 for 48 less 0.048, against 42.042 of cost.
    const positions = await api('GET', '/practice/positions', token);
    expect(positions.status).toBe(200);
    expect(positions.body).toEqual([
      {
        venue: 'binance',
        instrumentId: BTC,
        asset: 'BTC',
        quantity: '0.6',
        averageCost: '105.105',
        lastPrice: '130',
        marketValue: '78',
        unrealisedPnl: '14.937',
        realisedPnl: '5.91',
        fees: '0.153',
      },
    ]);
    const page = await api('GET', '/practice/fills', token);
    expect(page.body.items.map((f: { side: string; price: string }) => [f.side, f.price])).toEqual([
      ['sell', '120'],
      ['buy', '110'],
      ['buy', '100'],
    ]);
    expect(page.body.items[0].basis).toEqual({ book: [['120', '0.4']] });

    // The rule test (criterion 8.6) lists what a practice rule would have raised: the two buys and the sell.
    const rule = await api('POST', '/alerts/rules', token, {
      name: 'Practice fills',
      condition: { kind: 'practice_order_filled' },
      cooldownSec: 0,
    });
    expect(rule.status).toBe(201);
    const dry = await api('POST', `/alerts/rules/${rule.body.id}/test?hours=24`, token);
    expect(dry.status).toBe(200);
    expect(dry.body.wouldHaveFired.map((m: { title: string }) => m.title).sort()).toEqual([
      'BTC · Binance BTC/USDT: practice buy filled',
      'BTC · Binance BTC/USDT: practice buy filled',
      'BTC · Binance BTC/USDT: practice sell filled',
    ]);
    // Bob's rule of the same kind sees none of Carol's orders.
    const bobsRule = await api('POST', '/alerts/rules', bobToken, {
      name: 'Practice fills',
      condition: { kind: 'practice_order_filled' },
      cooldownSec: 0,
    });
    expect(
      (await api('POST', `/alerts/rules/${bobsRule.body.id}/test?hours=24`, bobToken)).body.wouldHaveFired,
    ).toEqual([]);

    // A reset starts a new period: earlier fills stay in the history but hold nothing now.
    await owner
      .updateTable('trading.accounts')
      .set({ reset_epoch: 1 })
      .where('id', '=', binance.id)
      .execute();
    expect((await api('GET', '/practice/positions', token)).body).toEqual([]);
    expect((await api('GET', '/practice/fills', token)).body.items).toHaveLength(3);
  });
});

describe('practice settings (admin)', () => {
  it('reads the defaults, saves a change with an audit entry, and opens new accounts with it', async () => {
    const before = await api('GET', '/admin/settings/practice', adminToken);
    expect(before.status).toBe(200);
    expect(before.body).toEqual(DEFAULT_PRACTICE_SETTINGS);
    const changed: PracticeSettings = {
      ...DEFAULT_PRACTICE_SETTINGS,
      fees: { ...DEFAULT_PRACTICE_SETTINGS.fees, binance: { maker: '0.00075', taker: '0.00075' } },
      startingBalances: { ...DEFAULT_PRACTICE_SETTINGS.startingBalances, binance: { USDT: '5000' } },
    };
    try {
      const put = await api('PUT', '/admin/settings/practice', adminToken, changed);
      expect(put.status).toBe(200);
      expect((await api('GET', '/admin/settings/practice', adminToken)).body).toEqual(changed);
      const [entry] = await audit('practice');
      expect(entry).toMatchObject({ action: 'settings.updated', target_type: 'setting' });
      expect(entry!.details).toEqual({ before: DEFAULT_PRACTICE_SETTINGS, after: changed });

      const dave = await createUser(h, 'viewer');
      const accounts = (await api('GET', '/practice/account', await tokenFor(h, dave))).body
        .accounts as PracticeAccount[];
      expect(accounts.find((a) => a.venue === 'binance')!.balances).toEqual([
        { asset: 'USDT', available: '5000', reserved: '0' },
      ]);
      const bad = await api('PUT', '/admin/settings/practice', adminToken, {
        ...changed,
        startingBalances: { ...changed.startingBalances, binance: { USDT: '-1' } },
      });
      expect(bad.status).toBe(400);
    } finally {
      await api('PUT', '/admin/settings/practice', adminToken, DEFAULT_PRACTICE_SETTINGS);
    }
  });
});

describe('the audit trail (criterion 14.8)', () => {
  it('records every practice action, and the hash chain verifies', async () => {
    const actions = await owner
      .selectFrom('app.audit_log')
      .select('action')
      .distinct()
      .where('action', 'like', 'practice%')
      .execute();
    expect(actions.map((a) => a.action).sort()).toEqual([
      'practice_account.reset_requested',
      'practice_order.cancel_requested',
      'practice_order.placed',
      'practice_order.refused',
    ]);
    const verify = await api('GET', '/admin/audit/verify', adminToken);
    expect(verify.status).toBe(200);
    expect(verify.body).toMatchObject({ ok: true, firstBrokenSeq: null });
  });
});

describe('the practice channel (criterion 14.9)', () => {
  function connect(token: string): Socket {
    const socket = io(h.base + WS_NAMESPACE, {
      path: WS_PATH,
      transports: ['websocket'],
      auth: { token },
      reconnection: false,
    });
    sockets.push(socket);
    return socket;
  }
  const connected = (socket: Socket) =>
    new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
  const subscribe = (socket: Socket, since?: string) =>
    socket.emitWithAck(
      'subscribe',
      since ? { channels: ['practice'], since: { practice: since } } : { channels: ['practice'] },
    ) as Promise<SubscribeAck>;
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 50));
  };

  it('delivers each user only their own updates, and their balances and open orders after a reconnect', async () => {
    const a = connect(aliceToken);
    const b = connect(bobToken);
    await Promise.all([connected(a), connected(b)]);
    const got: Record<string, Envelope[]> = { a: [], b: [] };
    a.on('message', (m: Envelope) => got['a']!.push(m));
    b.on('message', (m: Envelope) => got['b']!.push(m));
    const [ackA] = await Promise.all([subscribe(a), subscribe(b)]);
    expect(ackA.results['practice']).toMatchObject({ mode: 'live' });

    await redis.xadd(
      PRACTICE_EVENTS_STREAM,
      '*',
      'type',
      'practice.order',
      'user',
      alice.id,
      'data',
      JSON.stringify({ order: { id: 'x' } }),
    );
    // Not a practice message type: never delivered on this channel.
    await redis.xadd(PRACTICE_EVENTS_STREAM, '*', 'type', 'alert.fired', 'user', alice.id, 'data', '{}');
    await redis.xadd(
      PRACTICE_EVENTS_STREAM,
      '*',
      'type',
      'practice.fill',
      'user',
      bob.id,
      'data',
      JSON.stringify({ fill: { id: 'y' } }),
    );
    await until(() => got['a']!.length === 1 && got['b']!.length === 1);
    expect(got['a']!.map((m) => [m.ch, m.type, m.data])).toEqual([
      ['practice', 'practice.order', { order: { id: 'x' } }],
    ]);
    expect(got['b']!.map((m) => [m.ch, m.type])).toEqual([['practice', 'practice.fill']]);

    // Too old to replay: the balances and the open orders instead.
    const s = connect(aliceToken);
    await connected(s);
    const result = (await subscribe(s, '0-1')).results['practice'] as {
      mode: string;
      snapshot: { accounts: PracticeAccount[]; openOrders: PracticeOrder[] };
    };
    expect(result.mode).toBe('snapshot');
    expect(result.snapshot.accounts.map((x) => x.venue)).toEqual(['binance', 'coinbase', 'replay']);
    expect(result.snapshot.openOrders.length).toBeGreaterThan(0);
    expect(
      result.snapshot.openOrders.every((o) =>
        ['new', 'pending', 'open', 'partially_filled'].includes(o.status),
      ),
    ).toBe(true);
  });
});
