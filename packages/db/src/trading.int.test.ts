import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDb } from './client.js';
import {
  accountFrom,
  availableBalances,
  averagePrice,
  fillFromRow,
  orderFromRow,
  practiceAccounts,
  reservedBalances,
} from './trading.js';
import type { Database, NewTradingOrder } from './types.js';

/** Practice trading in the database (migration 0012, data model §10, ADR 021). */
const BTC = '019a6f00-0000-7000-8000-000000000001';

let owner: Kysely<Database>;
let api: Kysely<Database>;
let broker: Kysely<Database>;
let analyzer: Kysely<Database>;
let jobs: Kysely<Database>;
const userId = randomUUID();
const accountId = randomUUID();

beforeAll(async () => {
  owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 2 });
  api = createDb({ connectionString: inject('dbRoleUrls').svc_api, max: 2 });
  broker = createDb({ connectionString: inject('dbRoleUrls').svc_broker, max: 2 });
  analyzer = createDb({ connectionString: inject('dbRoleUrls').svc_analyzer, max: 2 });
  jobs = createDb({ connectionString: inject('dbRoleUrls').svc_jobs, max: 2 });
  await owner
    .insertInto('app.users')
    .values({
      id: userId,
      email: `${userId}@cip.test`,
      display_name: 'Practice',
      role: 'viewer',
      password_hash: 'x',
    })
    .execute();
  // Opened by the api, as on first use.
  await api
    .insertInto('trading.accounts')
    .values({ id: accountId, user_id: userId, venue_id: 'binance', starting_balances: { USDT: '10000' } })
    .execute();
  await api
    .insertInto('trading.ledger')
    .values({
      account_id: accountId,
      reset_epoch: 0,
      asset: 'USDT',
      amount: '10000',
      reason: 'start',
      order_id: null,
      fill_id: null,
    })
    .execute();
});

afterAll(async () => {
  for (const db of [owner, api, broker, analyzer, jobs]) await db.destroy();
});

async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

const newOrder = (extra: Partial<NewTradingOrder> = {}): NewTradingOrder => {
  const id = randomUUID();
  return {
    id,
    account_id: accountId,
    instrument_id: BTC,
    client_order_id: id,
    side: 'buy',
    type: 'limit',
    quantity: '0.50',
    limit_price: '100.00',
    stop_price: null,
    status: 'new',
    refusal_reason: null,
    parent_id: null,
    oco_group: null,
    source: 'manual',
    setup_id: null,
    reset_epoch: 0,
    ...extra,
  };
};

describe('practice trading rows (migration 0012)', () => {
  it('describes orders and fills the way the api and the broker do, with exact decimals', async () => {
    const order = newOrder();
    await api.insertInto('trading.orders').values(order).execute();
    await broker
      .updateTable('trading.orders')
      .set({ status: 'partially_filled', filled_quantity: '0.2', filled_value: '19.98', reserved: '30.03' })
      .where('id', '=', order.id)
      .execute();
    const row = await owner
      .selectFrom('trading.orders')
      .selectAll()
      .where('id', '=', order.id)
      .executeTakeFirstOrThrow();
    expect(orderFromRow(row, 'binance')).toMatchObject({
      id: order.id,
      venue: 'binance',
      quantity: '0.5',
      limitPrice: '100',
      filledQuantity: '0.2',
      averagePrice: '99.9',
      status: 'partially_filled',
      refusalReason: null,
      source: 'manual',
      underlyingClosed: false,
    });
    expect(averagePrice('0', '0')).toBeNull();

    const fillId = randomUUID();
    await broker
      .insertInto('trading.fills')
      .values({
        id: fillId,
        order_id: order.id,
        account_id: accountId,
        instrument_id: BTC,
        side: 'buy',
        price: '99.90',
        quantity: '0.20',
        fee: '0.01998',
        fee_asset: 'USDT',
        liquidity: 'maker',
        flags: ['thin_book'],
        basis: { trade: { id: 't1', price: '99.8' } },
        reset_epoch: 0,
        filled_at: new Date(Date.UTC(2026, 10, 15, 6, 0)),
      })
      .execute();
    const fill = await owner
      .selectFrom('trading.fills')
      .selectAll()
      .where('id', '=', fillId)
      .executeTakeFirstOrThrow();
    expect(fillFromRow(fill, 'binance')).toEqual({
      id: fillId,
      orderId: order.id,
      venue: 'binance',
      instrumentId: BTC,
      side: 'buy',
      price: '99.9',
      quantity: '0.2',
      fee: '0.01998',
      feeAsset: 'USDT',
      liquidity: 'maker',
      flags: ['thin_book'],
      basis: { trade: { id: 't1', price: '99.8' } },
      filledAt: Date.UTC(2026, 10, 15, 6, 0),
    });
  });

  it("sums the current period's ledger for what is free, and live orders for what is held", async () => {
    const holder = randomUUID();
    await owner
      .insertInto('trading.accounts')
      .values({
        id: holder,
        user_id: userId,
        venue_id: 'coinbase',
        starting_balances: { USD: '500' },
        reset_epoch: 1,
      })
      .execute();
    // The earlier period's entries no longer count.
    await owner
      .insertInto('trading.ledger')
      .values([
        {
          account_id: holder,
          reset_epoch: 0,
          asset: 'USD',
          amount: '9999',
          reason: 'start',
          order_id: null,
          fill_id: null,
        },
        {
          account_id: holder,
          reset_epoch: 1,
          asset: 'USD',
          amount: '500',
          reason: 'start',
          order_id: null,
          fill_id: null,
        },
        {
          account_id: holder,
          reset_epoch: 1,
          asset: 'USD',
          amount: '-100.5',
          reason: 'reserve',
          order_id: null,
          fill_id: null,
        },
        {
          account_id: holder,
          reset_epoch: 1,
          asset: 'BTC',
          amount: '0.25',
          reason: 'fill',
          order_id: null,
          fill_id: null,
        },
      ])
      .execute();
    const CB_BTC = '019a6f00-0000-7000-8000-000000000005';
    await owner
      .insertInto('trading.orders')
      .values([
        newOrder({
          account_id: holder,
          instrument_id: CB_BTC,
          status: 'open',
          reserved: '100.5',
          reset_epoch: 1,
        }),
        newOrder({
          account_id: holder,
          instrument_id: CB_BTC,
          side: 'sell',
          status: 'open',
          reserved: '0.1',
          reset_epoch: 1,
        }),
        // Finished orders hold nothing, whatever their column says.
        newOrder({
          account_id: holder,
          instrument_id: CB_BTC,
          status: 'cancelled',
          reserved: '7',
          reset_epoch: 1,
        }),
      ])
      .execute();
    expect((await availableBalances(api, [holder])).get(holder)).toEqual({ USD: '399.5', BTC: '0.25' });
    expect((await reservedBalances(api, [holder])).get(holder)).toEqual({ USD: '100.5', BTC: '0.1' });
    expect(await availableBalances(api, [])).toEqual(new Map());
    expect(await reservedBalances(api, [])).toEqual(new Map());

    const row = await api
      .selectFrom('trading.accounts')
      .selectAll()
      .where('id', '=', holder)
      .executeTakeFirstOrThrow();
    const [account] = await practiceAccounts(api, [row]);
    expect(account).toEqual({
      id: holder,
      venue: 'coinbase',
      startingBalances: { USD: '500' },
      resetEpoch: 1,
      balances: [
        { asset: 'BTC', available: '0.25', reserved: '0.1' },
        { asset: 'USD', available: '399.5', reserved: '100.5' },
      ],
    });
    // An asset only in the starting balances still shows, at zero.
    expect(accountFrom({ ...row, starting_balances: { USD: '500', USDT: '1' } }, {}, {}).balances).toEqual([
      { asset: 'USD', available: '0', reserved: '0' },
      { asset: 'USDT', available: '0', reserved: '0' },
    ]);
  });
});

describe('who may write what (migration 0012)', () => {
  it('lets the api store orders only as submitted or refused, and ledger entries only for starting balances', async () => {
    expect(
      await sqlState(
        api
          .insertInto('trading.orders')
          .values(newOrder({ status: 'refused', refusal_reason: 'data_delayed' }))
          .execute(),
      ),
    ).toBeUndefined();
    // Row-level security: nothing filled, held or past "new".
    expect(
      await sqlState(
        api
          .insertInto('trading.orders')
          .values(newOrder({ status: 'open' }))
          .execute(),
      ),
    ).toBe('42501');
    expect(
      await sqlState(
        api
          .insertInto('trading.orders')
          .values(newOrder({ filled_quantity: '0.1' }))
          .execute(),
      ),
    ).toBe('42501');
    expect(
      await sqlState(
        api
          .insertInto('trading.orders')
          .values(newOrder({ reserved: '1' }))
          .execute(),
      ),
    ).toBe('42501');
    expect(
      await sqlState(
        api
          .insertInto('trading.ledger')
          .values({
            account_id: accountId,
            reset_epoch: 0,
            asset: 'USDT',
            amount: '5',
            reason: 'fill',
            order_id: null,
            fill_id: null,
          })
          .execute(),
      ),
    ).toBe('42501');
    // Fills, order changes and the journal belong to the broker.
    expect(
      await sqlState(
        api
          .updateTable('trading.orders')
          .set({ status: 'filled' })
          .where('account_id', '=', accountId)
          .execute(),
      ),
    ).toBe('42501');
    expect(await sqlState(api.selectFrom('trading.journal').select('seq').execute())).toBe('42501');
  });

  it('lets the broker fill, settle and journal, but not open accounts or store orders', async () => {
    expect(await sqlState(broker.insertInto('trading.orders').values(newOrder()).execute())).toBe('42501');
    expect(
      await sqlState(
        broker
          .insertInto('trading.accounts')
          .values({ id: randomUUID(), user_id: userId, venue_id: 'replay', starting_balances: {} })
          .execute(),
      ),
    ).toBe('42501');
    expect(
      await sqlState(
        broker
          .insertInto('trading.ledger')
          .values({
            account_id: accountId,
            reset_epoch: 0,
            asset: 'USDT',
            amount: '-1',
            reason: 'fee',
            order_id: null,
            fill_id: null,
          })
          .execute(),
      ),
    ).toBeUndefined();
    expect(
      await sqlState(
        broker
          .insertInto('trading.journal')
          .values({ kind: 'cancel', input: { kind: 'cancel', orderId: 'x' } })
          .execute(),
      ),
    ).toBeUndefined();
    expect(
      await sqlState(
        broker
          .updateTable('trading.broker_state')
          .set({ commands_cursor: '1-0' })
          .where('id', '=', 1)
          .execute(),
      ),
    ).toBeUndefined();
  });

  it('gives the analyzer and the jobs service no access to practice trading at all', async () => {
    for (const db of [analyzer, jobs]) {
      expect(await sqlState(db.selectFrom('trading.orders').select('id').execute())).toBe('42501');
      expect(await sqlState(db.selectFrom('trading.accounts').select('id').execute())).toBe('42501');
    }
    // The pair-status job keeps the minimum order value.
    expect(
      await sqlState(
        jobs.updateTable('market.instruments').set({ min_notional: '5' }).where('id', '=', BTC).execute(),
      ),
    ).toBeUndefined();
  });
});
