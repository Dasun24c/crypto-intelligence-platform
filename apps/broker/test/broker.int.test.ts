import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { DEFAULT_PRACTICE_SETTINGS, PRACTICE_EVENTS_STREAM, tradesStream } from '@cip/contracts';
import { PRACTICE_COMMANDS_STREAM } from '@cip/contracts/practice-commands';
import { createDb } from '@cip/db';
import { createLogger } from '@cip/observability';
import { type JournalEntry, type JournalInput, replayJournal } from '@cip/paper-engine';
import { Broker, fillId } from '../src/broker.ts';
import { BrokerStore, LeaseLost } from '../src/store.ts';

const BTC = '019a6f00-0000-7000-8000-000000000001';
/**
 * Every outgoing connection this process opens while the broker runs (pg, Valkey, and any HTTP or
 * TLS client all connect through net.Socket), for criterion 14.10.
 */
const connections: { host: string; port: number }[] = [];
const socketConnect = Object.getOwnPropertyDescriptor(net.Socket.prototype, 'connect')!.value as (
  this: net.Socket,
  ...args: unknown[]
) => net.Socket;
function recordingConnect(this: net.Socket, ...args: unknown[]): net.Socket {
  const [first, second] = args;
  if (typeof first === 'object' && first !== null && 'port' in first) {
    const host = 'host' in first && typeof first.host === 'string' ? first.host : 'localhost';
    connections.push({ host, port: Number(first.port) });
  } else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first)))
    connections.push({ host: typeof second === 'string' ? second : 'localhost', port: Number(first) });
  return socketConnect.apply(this, args);
}
Object.defineProperty(net.Socket.prototype, 'connect', {
  value: recordingConnect,
  writable: true,
  configurable: true,
});

const owner = createDb({ connectionString: inject('dbOwnerUrl'), max: 2 });
const brokerDb = createDb({ connectionString: inject('dbRoleUrls').svc_broker, max: 4 });
const redis = new Redis(inject('redisUrl'));
const log = createLogger({ service: 'broker', instance: 'test', level: 'silent' });
const userId = randomUUID();
const accountId = randomUUID();
const readers: Redis[] = [];

function broker(instance: string): Broker {
  const reader = new Redis(inject('redisUrl'));
  readers.push(reader);
  return new Broker({ db: brokerDb, redis, reader, log, instance, blockMs: 100, refreshMs: 500 });
}

async function feeds(state: 'connected' | 'degraded') {
  await redis.set(
    'feed:status:binance',
    JSON.stringify({
      ts: Date.now(),
      instance: 'test',
      feeds: ['trades', 'depth'].map((stream) => ({
        instrumentId: BTC,
        stream,
        state,
        lastMessageAt: Date.now(),
      })),
    }),
  );
}

/** Stores an order as the api would (status `new`), with an optional stop and target, and sends the command. */
async function place(o: {
  side?: 'buy' | 'sell';
  type?: 'market' | 'limit';
  quantity: string;
  limitPrice?: string;
  stop?: string;
  target?: string;
}): Promise<string> {
  const id = randomUUID();
  const group = o.stop || o.target ? randomUUID() : null;
  const base = {
    account_id: accountId,
    instrument_id: BTC,
    source: 'manual' as const,
    setup_id: null,
    reset_epoch: 0,
    status: 'new' as const,
    refusal_reason: null,
    stop_price: null,
  };
  await owner
    .insertInto('trading.orders')
    .values({
      ...base,
      id,
      client_order_id: id,
      side: o.side ?? 'buy',
      type: o.type ?? 'market',
      quantity: o.quantity,
      limit_price: o.limitPrice ?? null,
      parent_id: null,
      oco_group: null,
    })
    .execute();
  for (const [type, price] of [
    ['stop', o.stop],
    ['target', o.target],
  ] as const)
    if (price)
      await owner
        .insertInto('trading.orders')
        .values({
          ...base,
          id: randomUUID(),
          client_order_id: `${id}:${type}`,
          side: 'sell',
          type,
          quantity: o.quantity,
          limit_price: type === 'target' ? price : null,
          stop_price: type === 'stop' ? price : null,
          parent_id: id,
          oco_group: group,
        })
        .execute();
  await redis.xadd(PRACTICE_COMMANDS_STREAM, '*', 'type', 'place', 'orderId', id, 'user', userId);
  return id;
}

async function order(id: string) {
  return owner.selectFrom('trading.orders').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}

async function settled(
  id: string,
  statuses: string[] = ['open', 'partially_filled', 'filled', 'cancelled', 'refused'],
) {
  await expect
    .poll(async () => statuses.includes((await order(id)).status), { timeout: 15_000, interval: 100 })
    .toBe(true);
  return order(id);
}

async function balances(): Promise<Record<string, string>> {
  const account = await owner
    .selectFrom('trading.accounts')
    .select('reset_epoch')
    .where('id', '=', accountId)
    .executeTakeFirstOrThrow();
  const rows = await owner
    .selectFrom('trading.ledger')
    .select(['asset', (eb) => eb.fn.sum<string>('amount').as('total')])
    .where('account_id', '=', accountId)
    .where('reset_epoch', '=', account.reset_epoch)
    .groupBy('asset')
    .execute();
  return Object.fromEntries(rows.map((r) => [r.asset, String(Number(r.total))]));
}

const first = broker('broker-a');

/** Waits for `check` outside a test (expect.poll works only inside one). */
async function until(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting');
}

beforeAll(async () => {
  await owner
    .insertInto('app.users')
    .values({
      id: userId,
      email: `${userId}@cip.test`,
      display_name: 'x',
      role: 'viewer',
      password_hash: 'x',
    })
    .execute();
  await owner
    .insertInto('trading.accounts')
    .values({ id: accountId, user_id: userId, venue_id: 'binance', starting_balances: { USDT: '10000' } })
    .execute();
  await owner
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
  await feeds('connected');
  await redis.set(
    `book:${BTC}`,
    JSON.stringify({
      instrumentId: BTC,
      ts: Date.now(),
      bids: [['99.90', '5']],
      asks: [['100.00', '5']],
      coverageBps: 50,
    }),
  );
  await first.start();
  await until(() => first.active);
});

afterAll(async () => {
  await first.stop();
  for (const r of readers) r.disconnect();
  redis.disconnect();
  await brokerDb.destroy();
  await owner.destroy();
});

describe('the broker (ADR 021, Phase 14)', () => {
  it('takes up a market order, fills it from the book, and settles the account (14.1, NFR-16)', async () => {
    const sent = Date.now();
    const id = await place({ quantity: '0.5' });
    const o = await settled(id, ['filled']);
    expect(Date.now() - sent).toBeLessThan(5_000);
    expect(o).toMatchObject({ filled_quantity: '0.5', filled_value: '50', reserved: '0' });
    const fills = await owner.selectFrom('trading.fills').selectAll().where('order_id', '=', id).execute();
    expect(fills.map((f) => [f.price, f.quantity, f.fee, f.liquidity])).toEqual([
      ['100', '0.5', '0.05', 'taker'],
    ]);
    expect(fills[0]!.id).toBe(fillId(id, 1));
    expect(fills[0]!.basis).toEqual({ book: { ts: expect.any(Number), levels: [['100', '0.5']] } });
    expect(await balances()).toEqual({ USDT: '9949.95', BTC: '0.5' });
    const audit = await owner
      .selectFrom('app.audit_log')
      .select(['action', 'actor_type'])
      .where('target_id', '=', id)
      .execute();
    expect(audit).toEqual([{ action: 'practice_order.filled', actor_type: 'system' }]);
    // The owner hears of the order, the fill and the account (published just after the commit).
    const events = async () =>
      (await redis.xrange(PRACTICE_EVENTS_STREAM, '-', '+')).map(([, f]) => [f[1], f[3]]);
    await expect.poll(events, { timeout: 5_000, interval: 100 }).toEqual(
      expect.arrayContaining([
        ['practice.order', userId],
        ['practice.fill', userId],
        ['practice.account', userId],
      ]),
    );
  });

  it('rests a limit order, and fills it only on a trade through its price (14.2)', async () => {
    const id = await place({ type: 'limit', limitPrice: '99.00', quantity: '1' });
    expect(await settled(id)).toMatchObject({ status: 'open', reserved: '99.099' });
    await redis.xadd(
      tradesStream(BTC),
      '*',
      'id',
      't1',
      'ts',
      String(Date.now()),
      'price',
      '99.00',
      'qty',
      '5',
      'side',
      'sell',
    );
    await redis.xadd(
      tradesStream(BTC),
      '*',
      'id',
      't2',
      'ts',
      String(Date.now()),
      'price',
      '98.50',
      'qty',
      '0.4',
      'side',
      'sell',
    );
    await expect.poll(async () => (await order(id)).filled_quantity, { timeout: 10_000 }).toBe('0.4');
    await redis.xadd(
      tradesStream(BTC),
      '*',
      'id',
      't3',
      'ts',
      String(Date.now()),
      'price',
      '98.00',
      'qty',
      '5',
      'side',
      'sell',
    );
    expect(await settled(id, ['filled'])).toMatchObject({ reserved: '0' });
    const fills = await owner
      .selectFrom('trading.fills')
      .select(['price', 'quantity', 'liquidity'])
      .where('order_id', '=', id)
      .orderBy('filled_at')
      .execute();
    expect(fills).toEqual([
      { price: '99.00', quantity: '0.4', liquidity: 'maker' },
      { price: '99.00', quantity: '0.6', liquidity: 'maker' },
    ]);
  });

  it('refuses orders while the data is not sound, and says why (14.5)', async () => {
    await feeds('degraded');
    await expect.poll(() => first.market.healthOf(BTC), { timeout: 5_000 }).toBe('data_delayed');
    const id = await place({ quantity: '0.1' });
    expect(await settled(id, ['refused'])).toMatchObject({ refusal_reason: 'data_delayed' });
    const audit = await owner
      .selectFrom('app.audit_log')
      .select(['action', 'details'])
      .where('target_id', '=', id)
      .execute();
    expect(audit).toEqual([
      { action: 'practice_order.refused', details: { reason: 'data_delayed', by: 'broker' } },
    ]);
    await feeds('connected');
    await expect.poll(() => first.market.healthOf(BTC), { timeout: 5_000 }).toBe('ok');
  });

  it('arms a stop and a target, and the stop sells against the book when a trade reaches it', async () => {
    const id = await place({ quantity: '0.2', stop: '95.00', target: '110.00' });
    await settled(id, ['filled']);
    const legs = await owner.selectFrom('trading.orders').selectAll().where('parent_id', '=', id).execute();
    expect(legs.map((l) => [l.type, l.status, l.quantity]).sort()).toEqual([
      ['stop', 'open', '0.2'],
      ['target', 'open', '0.2'],
    ]);
    await redis.xadd(
      tradesStream(BTC),
      '*',
      'id',
      't4',
      'ts',
      String(Date.now()),
      'price',
      '94.00',
      'qty',
      '1',
      'side',
      'sell',
    );
    const stop = legs.find((l) => l.type === 'stop')!;
    const target = legs.find((l) => l.type === 'target')!;
    await settled(stop.id, ['filled']);
    expect((await order(target.id)).status).toBe('cancelled');
    // The target was cancelled by the trade that filled its stop (one-cancels-other), and audited so.
    const audit = await owner
      .selectFrom('app.audit_log')
      .select(['action', 'details'])
      .where('target_id', '=', target.id)
      .execute();
    expect(audit).toEqual([
      { action: 'practice_order.cancelled', details: { cause: 'trade', filledQuantity: '0' } },
    ]);
  });

  it('cancels and resets through commands', async () => {
    const id = await place({ type: 'limit', limitPrice: '90.00', quantity: '1' });
    await settled(id, ['open']);
    await redis.xadd(PRACTICE_COMMANDS_STREAM, '*', 'type', 'cancel', 'orderId', id, 'user', userId);
    expect(await settled(id, ['cancelled'])).toMatchObject({ reserved: '0' });
    await redis.xadd(PRACTICE_COMMANDS_STREAM, '*', 'type', 'reset', 'accountId', accountId, 'user', userId);
    await expect
      .poll(
        async () =>
          (
            await owner
              .selectFrom('trading.accounts')
              .select('reset_epoch')
              .where('id', '=', accountId)
              .executeTakeFirstOrThrow()
          ).reset_epoch,
        {
          timeout: 10_000,
        },
      )
      .toBe(1);
    expect(await balances()).toEqual({ USDT: DEFAULT_PRACTICE_SETTINGS.startingBalances.binance['USDT'] });
    const cancelled = await owner
      .selectFrom('app.audit_log')
      .select(['action', 'details'])
      .where('target_id', '=', id)
      .execute();
    expect(cancelled.map((a) => [a.action, a.details])).toContainEqual([
      'practice_order.cancelled',
      { cause: 'cancel', filledQuantity: '0' },
    ]);
    const reset = await owner
      .selectFrom('app.audit_log')
      .select(['action', 'target_type', 'actor_type', 'details'])
      .where('target_id', '=', accountId)
      .where('action', '=', 'practice_account.reset')
      .execute();
    expect(reset).toEqual([
      {
        action: 'practice_account.reset',
        target_type: 'practice_account',
        actor_type: 'system',
        details: { resetEpoch: 1, startingBalances: DEFAULT_PRACTICE_SETTINGS.startingBalances.binance },
      },
    ]);
  });

  it('moves past inputs that change nothing, and says in its probe whether it is active', async () => {
    expect(first.probe()).toMatchObject({
      status: 'ok',
      detail: expect.stringMatching(/^active: \d+ trade streams$/),
    });
    expect(broker('broker-idle').probe()).toEqual({ status: 'ok', detail: 'standby' });
    const cursor = async () =>
      (await owner.selectFrom('trading.broker_state').select('commands_cursor').executeTakeFirstOrThrow())
        .commands_cursor;
    const journalled = async () =>
      Number(
        (
          await owner
            .selectFrom('trading.journal')
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .executeTakeFirstOrThrow()
        ).n,
      );
    const before = await journalled();
    // No stored order, nothing to cancel, no such account: each command is read and passed over.
    const nobody = randomUUID();
    await redis.xadd(PRACTICE_COMMANDS_STREAM, '*', 'type', 'place', 'orderId', nobody, 'user', userId);
    await redis.xadd(PRACTICE_COMMANDS_STREAM, '*', 'type', 'cancel', 'orderId', nobody, 'user', userId);
    const last = await redis.xadd(
      PRACTICE_COMMANDS_STREAM,
      '*',
      'type',
      'reset',
      'accountId',
      nobody,
      'user',
      userId,
    );
    await expect.poll(cursor, { timeout: 10_000, interval: 100 }).toBe(last);
    // A trade without a price or a quantity is skipped.
    await redis.xadd(tradesStream(BTC), '*', 'ts', String(Date.now()), 'side', 'buy');
    const resting = await place({ type: 'limit', limitPrice: '99.00', quantity: '0.1' });
    await settled(resting, ['open']);
    await redis.xadd(
      tradesStream(BTC),
      '*',
      'id',
      'zero',
      'ts',
      String(Date.now()),
      'price',
      '0',
      'qty',
      '1',
      'side',
      'sell',
    );
    await new Promise((r) => setTimeout(r, 500));
    expect((await order(resting)).status).toBe('open');
    // Only the order placed made a journal entry.
    expect(await journalled()).toBe(before + 1);
    await redis.xadd(PRACTICE_COMMANDS_STREAM, '*', 'type', 'cancel', 'orderId', resting, 'user', userId);
    await settled(resting, ['cancelled']);
  });

  it('journals changed fees with the next input, so a replay uses the fees the live engine used (14.3)', async () => {
    const dearer = {
      ...DEFAULT_PRACTICE_SETTINGS,
      fees: { ...DEFAULT_PRACTICE_SETTINGS.fees, binance: { maker: '0.002', taker: '0.002' } },
    };
    await owner
      .insertInto('app.settings')
      .values({ key: 'practice', value: dearer })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: dearer }))
      .execute();
    try {
      await new Promise((r) => setTimeout(r, 1_500)); // the broker reads the settings every 500 ms here
      const id = await place({ quantity: '0.1' });
      await settled(id, ['filled']);
      const fills = await owner
        .selectFrom('trading.fills')
        .select('fee')
        .where('order_id', '=', id)
        .execute();
      expect(fills.map((f) => f.fee)).toEqual(['0.02']); // 0.1 at 100, at 0.2 %
      const entry = await owner
        .selectFrom('trading.journal')
        .select('input')
        .where('kind', '=', 'place')
        .orderBy('seq', 'desc')
        .executeTakeFirstOrThrow();
      expect((entry.input as unknown as JournalInput).config?.fees['binance']).toEqual(dearer.fees.binance);
    } finally {
      await owner.deleteFrom('app.settings').where('key', '=', 'practice').execute();
      await new Promise((r) => setTimeout(r, 1_500));
    }
  });

  it('a second instance waits, then takes over where the first stopped; the first can no longer write (4.4-style fencing)', async () => {
    const second = broker('broker-b');
    await second.start();
    expect(second.active).toBe(false);
    const oldEpoch = (await new BrokerStore(brokerDb).state()).leaseEpoch;
    await first.stop();
    await expect.poll(() => second.active, { timeout: 15_000, interval: 200 }).toBe(true);
    const id = await place({ quantity: '0.1' });
    expect(await settled(id, ['filled'])).toMatchObject({ filled_quantity: '0.1' });
    await expect(new BrokerStore(brokerDb).claim(oldEpoch)).rejects.toBeInstanceOf(LeaseLost);
    await second.stop();
    await first.start(); // for afterAll
    await expect.poll(() => first.active, { timeout: 15_000, interval: 200 }).toBe(true);
  });

  it('replays its journal with the same fills (14.3)', async () => {
    const rows = await owner
      .selectFrom('trading.journal')
      .select(['kind', 'input', 'fills'])
      .orderBy('seq')
      .execute();
    const instruments = await new BrokerStore(brokerDb).instruments();
    const rules = new Map(instruments.filter((i) => i.role === 'monitored').map((i) => [i.instrumentId, i]));
    const opts = {
      rules: (id: string) => rules.get(id),
      fees: (venue: string) =>
        DEFAULT_PRACTICE_SETTINGS.fees[venue as 'binance'] ?? { maker: '0', taker: '0' },
      fillId,
    };
    // Each instance's run starts with the state it loaded; replay each run on its own.
    const runs: JournalEntry[][] = [];
    for (const r of rows) {
      const entry = { input: r.input as unknown as JournalInput, fills: r.fills };
      if (r.kind === 'load') runs.push([entry]);
      else runs.at(-1)?.push(entry);
    }
    expect(runs.length).toBeGreaterThanOrEqual(2);
    // Each run journalled the rules and fees it started with.
    for (const run of runs) {
      const config = run[0]!.input.config;
      expect(config?.rules.map((r) => r.instrumentId)).toContain(BTC);
      expect(config?.fees['binance']).toEqual(DEFAULT_PRACTICE_SETTINGS.fees.binance);
    }
    const fills = runs.flatMap((run) => run.flatMap((e) => e.fills));
    expect(fills.length).toBeGreaterThanOrEqual(6);
    for (const run of runs) expect(replayJournal(run, opts)).toMatchObject({ mismatchAt: null });
  });

  it('opened connections only to the database and Valkey while it worked (14.10)', () => {
    const allowed = new Set(
      [inject('dbOwnerUrl'), inject('dbRoleUrls').svc_broker, inject('redisUrl')].map((u) => {
        const url = new URL(u);
        return `${url.hostname.replace(/^\[|\]$/g, '')}:${url.port}`;
      }),
    );
    expect(connections.length).toBeGreaterThan(0);
    const elsewhere = connections.filter((c) => !allowed.has(`${c.host}:${c.port}`));
    expect(elsewhere).toEqual([]);
  });

  it('holds no venue client: nothing in the broker can reach an exchange (14.10)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies)).not.toContain('@cip/exchange-adapters');
    expect(Object.keys(pkg.dependencies).filter((d) => /binance|coinbase|ccxt|exchange/i.test(d))).toEqual(
      [],
    );
  });
});
