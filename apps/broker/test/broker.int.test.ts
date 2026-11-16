import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { Redis } from 'ioredis';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  ANALYSIS_EVENTS_STREAM,
  DEFAULT_AUTO_RULES,
  DEFAULT_PRACTICE_SETTINGS,
  PRACTICE_EVENTS_STREAM,
  SETUP_DISCLAIMER,
  tradesStream,
} from '@cip/contracts';
import { PRACTICE_COMMANDS_STREAM } from '@cip/contracts/practice-commands';
import { createDb } from '@cip/db';
import { dec, positionSize } from '@cip/domain';
import { createLogger } from '@cip/observability';
import { type JournalEntry, type JournalInput, replayJournal } from '@cip/paper-engine';
import { Broker, fillId, nameId } from '../src/broker.ts';
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
      .select(['kind', 'input', 'fills', 'decisions'])
      .orderBy('seq')
      .execute();
    const instruments = await new BrokerStore(brokerDb).instruments();
    const rules = new Map(instruments.filter((i) => i.role === 'monitored').map((i) => [i.instrumentId, i]));
    const opts = {
      rules: (id: string) => rules.get(id),
      fees: (venue: string) =>
        DEFAULT_PRACTICE_SETTINGS.fees[venue as 'binance'] ?? { maker: '0', taker: '0' },
      fillId,
      nameId,
    };
    // Each instance's run starts with the state it loaded; replay each run on its own.
    const runs: JournalEntry[][] = [];
    for (const r of rows) {
      const entry = { input: r.input as unknown as JournalInput, fills: r.fills, decisions: r.decisions };
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

describe('automatic practice trading in the broker (ADR 022, Phase 16)', () => {
  const RUN = randomUUID();
  const strategyId = randomUUID();
  let broker16: Broker = first;

  /** A setup transition as the analyzer appends it to an:events. */
  function transition(
    id: string,
    o: {
      to?: 'confirmed' | 'resolved';
      resolution?: 'invalidated' | 'expired_no_entry' | null;
      score?: number;
      processedAt?: number;
    } = {},
  ) {
    const now = Date.now();
    const to = o.to ?? 'confirmed';
    return {
      id,
      instrumentId: BTC,
      runId: RUN,
      pattern: 'htf_order_block',
      variant: null,
      direction: 'bullish',
      contextTf: '1h',
      setupTf: '15m',
      state: to,
      resolution: o.resolution ?? null,
      displayLabel: to === 'resolved' ? 'Resolved' : 'Confirmed',
      levels: { entry: '99.00', invalidation: '97.00', target1: '105.00', target2: null, rr: 3 },
      score: o.score ?? 80,
      mandatoryPassed: true,
      qualityFlags: [],
      flags: [],
      createdAt: now - 3_600_000,
      updatedAt: now,
      resolvedAt: to === 'resolved' ? now : null,
      disclaimer: SETUP_DISCLAIMER,
      transition: {
        from: to === 'resolved' ? 'confirmed' : 'triggered',
        to,
        reason: 'test',
        candleTime: now - 900_000,
        decidedAt: now - 1_000,
        processedAt: o.processedAt ?? now,
        late: false,
        evidence: {},
      },
    };
  }

  const publish = (message: unknown) =>
    redis.xadd(ANALYSIS_EVENTS_STREAM, '*', 'type', 'setup', 'data', JSON.stringify(message));
  const command = (type: 'strategy' | 'stop_auto') =>
    redis.xadd(PRACTICE_COMMANDS_STREAM, '*', 'type', type, 'user', userId);
  const buyOf = (setupId: string) => nameId(`practice-auto:${strategyId}:${setupId}`);
  const decisions = (setupId: string) =>
    owner
      .selectFrom('trading.auto_decisions')
      .select(['outcome', 'reason', 'order_id', 'strategy_version', 'run_id'])
      .where('setup_id', '=', setupId)
      .orderBy('created_at')
      .execute();
  const decided = async (setupId: string, n = 1) => {
    await expect
      .poll(async () => (await decisions(setupId)).length, { timeout: 15_000, interval: 100 })
      .toBe(n);
    return decisions(setupId);
  };
  const automatic = async () =>
    (await redis.xrange(PRACTICE_EVENTS_STREAM, '-', '+'))
      .filter(([, f]) => f[1] === 'practice.automatic')
      .map(([, f]) => ({
        user: f[3],
        ...(JSON.parse(f[5]!) as { event: string; decision?: { outcome: string }; [k: string]: unknown }),
      }));
  const strategyRow = () =>
    owner.selectFrom('trading.strategies').selectAll().where('id', '=', strategyId).executeTakeFirstOrThrow();
  async function setStrategy(change: { enabled?: boolean; dailyLossPct?: number }) {
    const row = await strategyRow();
    const rules = {
      ...(row.rules as typeof DEFAULT_AUTO_RULES),
      ...(change.dailyLossPct ? { dailyLossPct: change.dailyLossPct } : {}),
    };
    await owner
      .updateTable('trading.strategies')
      .set({
        enabled: change.enabled ?? row.enabled,
        rules,
        version: row.version + 1,
        updated_at: new Date(),
      })
      .where('id', '=', strategyId)
      .execute();
  }
  async function tradeAt(price: string, qty: string) {
    await redis.xadd(
      tradesStream(BTC),
      '*',
      'id',
      randomUUID(),
      'ts',
      String(Date.now()),
      'price',
      price,
      'qty',
      qty,
      'side',
      'sell',
    );
  }

  /** The account's free USDT, exactly: the sum of its current period's ledger. */
  async function freeUsdt(): Promise<string> {
    const account = await owner
      .selectFrom('trading.accounts')
      .select('reset_epoch')
      .where('id', '=', accountId)
      .executeTakeFirstOrThrow();
    const r = await owner
      .selectFrom('trading.ledger')
      .select(sql<string>`coalesce(sum(amount), 0)::text`.as('total'))
      .where('account_id', '=', accountId)
      .where('reset_epoch', '=', account.reset_epoch)
      .where('asset', '=', 'USDT')
      .executeTakeFirstOrThrow();
    return dec(r.total).toString();
  }

  beforeAll(async () => {
    await owner
      .insertInto('trading.strategies')
      .values({
        id: strategyId,
        user_id: userId,
        enabled: true,
        // Phase 16's sizing, named: the calculator's size at the risk per trade (the default is now a fixed amount).
        rules: { ...DEFAULT_AUTO_RULES, sizing: 'risk' },
        version: 1,
        updated_by: userId,
      })
      .execute();
    await command('strategy');
  });

  it('turns a confirmed bullish setup into a labelled, audited limit buy with its stop and target, and cancels it when the setup ends first (16.1, 16.2, 16.5, 16.7)', async () => {
    const free = await freeUsdt();
    const setupId = randomUUID();
    const sent = Date.now();
    await publish(transition(setupId));
    const buy = await settled(buyOf(setupId), ['open']);
    expect(Date.now() - sent).toBeLessThan(5_000);
    // 1 % of the free balance at risk over 99 − 97, rounded down to the quantity step: the calculator's size.
    const size = positionSize({
      accountSize: free,
      riskPct: '1',
      entry: '99',
      invalidation: '97',
      qtyStep: '0.00001',
    });
    expect(dec(buy.quantity).eq(size.quantity)).toBe(true);
    expect(buy).toMatchObject({
      source: 'auto',
      setup_id: setupId,
      client_order_id: `auto:${setupId}`,
      side: 'buy',
      type: 'limit',
      limit_price: '99',
    });
    const legs = await owner
      .selectFrom('trading.orders')
      .select(['id', 'type', 'stop_price', 'limit_price', 'status', 'source'])
      .where('parent_id', '=', buy.id)
      .orderBy('type')
      .execute();
    expect(legs).toEqual([
      {
        id: nameId(`practice-auto:${strategyId}:${setupId}:stop`),
        type: 'stop',
        stop_price: '97',
        limit_price: null,
        status: 'pending',
        source: 'auto',
      },
      {
        id: nameId(`practice-auto:${strategyId}:${setupId}:target`),
        type: 'target',
        stop_price: null,
        limit_price: '105',
        status: 'pending',
        source: 'auto',
      },
    ]);
    expect(await decided(setupId)).toEqual([
      { outcome: 'placed', reason: null, order_id: buy.id, strategy_version: 1, run_id: RUN },
    ]);
    const audit = await owner
      .selectFrom('app.audit_log')
      .select(['action', 'actor_type', 'details'])
      .where('target_id', '=', buy.id)
      .where('action', '=', 'practice_order.placed')
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({
      actor_type: 'system',
      details: {
        source: 'auto',
        strategyId,
        setupId,
        runId: RUN,
        stop: '97',
        target: '105',
        limitPrice: '99',
      },
    });
    const day = await owner
      .selectFrom('trading.auto_days')
      .selectAll()
      .where('account_id', '=', accountId)
      .execute();
    expect(day.map((d) => [d.day, d.orders])).toEqual([[new Date().toISOString().slice(0, 10), 1]]);
    await expect
      .poll(
        async () =>
          (await automatic()).map((m) => [m.user, m.event, (m.decision as { outcome?: string })?.outcome]),
        { timeout: 5_000 },
      )
      .toContainEqual([userId, 'decision', 'placed']);
    const message = (await automatic()).find(
      (m) => m.event === 'decision' && (m.decision as { orderId?: string }).orderId === buy.id,
    );
    expect(message?.decision).toMatchObject({
      outcome: 'placed',
      order: { quantity: dec(buy.quantity).toString(), limitPrice: '99', stop: '97', target: '105' },
    });
    const journal = await owner
      .selectFrom('trading.journal')
      .select(['input', 'decisions'])
      .where('kind', '=', 'setup')
      .orderBy('seq', 'desc')
      .executeTakeFirstOrThrow();
    expect(journal.decisions).toContain(
      `decision|${nameId(`practice-auto-decision:${strategyId}:${setupId}:placed:`)}|placed||${buy.id}`,
    );

    // One per pair: another setup on BTC is skipped while this one is open; a weak one, for its score.
    const second = randomUUID();
    await publish(transition(second));
    expect(await decided(second)).toMatchObject([
      { outcome: 'skipped', reason: 'open_limit', order_id: null },
    ]);
    const weak = randomUUID();
    await publish(transition(weak, { score: 40 }));
    expect(await decided(weak)).toMatchObject([{ outcome: 'skipped', reason: 'score' }]);

    // The setup ends before the buy filled: the buy goes, with its stop and target.
    await publish(transition(setupId, { to: 'resolved', resolution: 'invalidated' }));
    expect(await settled(buy.id, ['cancelled'])).toMatchObject({ reserved: '0' });
    expect((await decided(setupId, 2))[1]).toMatchObject({
      outcome: 'cancelled',
      reason: 'invalidated',
      order_id: buy.id,
    });
    expect(await freeUsdt()).toBe(free);
  });

  it('stops: switched off, its live orders cancelled within 5 s (16.3)', async () => {
    const setupId = randomUUID();
    await publish(transition(setupId));
    const buy = await settled(buyOf(setupId), ['open']);
    await setStrategy({ enabled: false });
    const sent = Date.now();
    await command('stop_auto');
    expect(await settled(buy.id, ['cancelled'])).toMatchObject({ reserved: '0' });
    expect(Date.now() - sent).toBeLessThan(5_000);
    expect((await decided(setupId, 2))[1]).toMatchObject({ outcome: 'cancelled', reason: 'stopped' });
    await expect
      .poll(async () => (await automatic()).filter((m) => m.event === 'stopped'), { timeout: 5_000 })
      .toEqual([{ user: userId, event: 'stopped', cancelled: 3 }]);
    // Off: a confirmed setup is not even logged.
    const ignored = randomUUID();
    await publish(transition(ignored));
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await decisions(ignored)).toEqual([]);
  });

  it('adds up the closed trades of the day, and pauses at the daily loss limit until 00:00 UTC (16.2)', async () => {
    await setStrategy({ enabled: true, dailyLossPct: 1 });
    await command('strategy');
    const setupId = randomUUID();
    await publish(transition(setupId));
    const buy = await settled(buyOf(setupId), ['open']);
    // A trade through the entry fills the buy; the stop then sells into a falling book.
    await tradeAt('98.50', '1000');
    await settled(buy.id, ['filled']);
    await redis.set(
      `book:${BTC}`,
      JSON.stringify({
        instrumentId: BTC,
        ts: Date.now(),
        bids: [['96.00', '1000']],
        asks: [['96.50', '1000']],
        coverageBps: 50,
      }),
    );
    await tradeAt('96.90', '1');
    const stop = nameId(`practice-auto:${strategyId}:${setupId}:stop`);
    await settled(stop, ['filled']);
    const tomorrow = new Date();
    tomorrow.setUTCHours(24, 0, 0, 0);
    await expect
      .poll(async () => (await strategyRow()).paused_until?.getTime(), { timeout: 10_000 })
      .toBe(tomorrow.getTime());
    const day = await owner
      .selectFrom('trading.auto_days')
      .select(['orders', 'result'])
      .where('account_id', '=', accountId)
      .executeTakeFirstOrThrow();
    expect(Number(day.result)).toBeLessThan(-100);
    expect((await automatic()).filter((m) => m.event === 'paused')).toEqual([
      {
        user: userId,
        event: 'paused',
        at: expect.any(Number),
        until: tomorrow.getTime(),
        result: day.result,
        asset: 'USDT',
      },
    ]);
    const audit = await owner
      .selectFrom('app.audit_log')
      .select(['action', 'target_type', 'details'])
      .where('target_id', '=', strategyId)
      .execute();
    expect(audit).toEqual([
      {
        action: 'practice_auto.paused',
        target_type: 'practice_strategy',
        details: { userId, until: tomorrow.getTime(), result: day.result, asset: 'USDT' },
      },
    ]);
    // Paused: the next confirmed setup is logged as skipped.
    const next = randomUUID();
    await publish(transition(next));
    expect(await decided(next)).toMatchObject([{ outcome: 'skipped', reason: 'paused' }]);
  });

  it('recovers from a failed write: it reloads, reads the setup again, and decides it once', async () => {
    // The day's pause lifted (as at 00:00 UTC) and the limit raised to 10 %, so the day's loss so far
    // no longer reaches it; the rules read again.
    await owner
      .updateTable('trading.strategies')
      .set({ paused_until: null })
      .where('id', '=', strategyId)
      .execute();
    await setStrategy({ dailyLossPct: 10 });
    await command('strategy');
    await redis.set(
      `book:${BTC}`,
      JSON.stringify({
        instrumentId: BTC,
        ts: Date.now(),
        bids: [['98.00', '1000']],
        asks: [['100.00', '1000']],
        coverageBps: 50,
      }),
    );
    const { reset_epoch } = await owner
      .selectFrom('trading.accounts')
      .select('reset_epoch')
      .where('id', '=', accountId)
      .executeTakeFirstOrThrow();
    const setupId = randomUUID();
    // A stored order already has the client order id the automatic buy will use, so its write fails.
    const blocker = randomUUID();
    await owner
      .insertInto('trading.orders')
      .values({
        id: blocker,
        account_id: accountId,
        instrument_id: BTC,
        client_order_id: `auto:${setupId}`,
        side: 'buy',
        type: 'limit',
        quantity: '1',
        limit_price: '1',
        stop_price: null,
        status: 'cancelled',
        refusal_reason: null,
        parent_id: null,
        oco_group: null,
        source: 'manual',
        setup_id: null,
        reset_epoch,
      })
      .execute();
    await publish(transition(setupId));
    await expect.poll(() => first.probe().status, { timeout: 15_000, interval: 50 }).toBe('degraded');
    expect(await decisions(setupId)).toEqual([]);
    await owner.deleteFrom('trading.orders').where('id', '=', blocker).execute();
    const buy = await settled(buyOf(setupId), ['open']);
    expect(await decided(setupId)).toMatchObject([{ outcome: 'placed', order_id: buy.id }]);
    await expect.poll(() => first.probe().status, { timeout: 15_000 }).toBe('ok');
  });

  it('after a restart, it carries on with its open trades and never decides a setup twice; nothing for users who have not switched it on (16.4, 16.6)', async () => {
    const open = await owner
      .selectFrom('trading.orders')
      .selectAll()
      .where('source', '=', 'auto')
      .where('status', '=', 'open')
      .where('parent_id', 'is', null)
      .executeTakeFirstOrThrow();
    // Partly filled before the restart.
    await tradeAt('98.50', '1');
    await expect
      .poll(async () => (await order(open.id)).status, { timeout: 10_000 })
      .toBe('partially_filled');
    // Someone whose stored rules no longer validate: loaded switched off.
    const broken = randomUUID();
    await owner
      .insertInto('app.users')
      .values({
        id: broken,
        email: `${broken}@cip.test`,
        display_name: 'x',
        role: 'viewer',
        password_hash: 'x',
      })
      .execute();
    await owner
      .insertInto('trading.strategies')
      .values({ id: randomUUID(), user_id: broken, enabled: true, rules: { venue: 'binance' }, version: 1 })
      .execute();
    const count = async () =>
      (await owner.selectFrom('trading.auto_decisions').select('id').execute()).length;
    const before = await count();
    const earlier = await owner
      .selectFrom('trading.auto_decisions')
      .select('setup_id')
      .where('outcome', '=', 'placed')
      .orderBy('created_at')
      .executeTakeFirstOrThrow();
    const dayResult = async () =>
      (
        await owner
          .selectFrom('trading.auto_days')
          .select('result')
          .where('account_id', '=', accountId)
          .executeTakeFirstOrThrow()
      ).result;
    const resultBefore = await dayResult();

    broker16 = broker('broker-c');
    await first.stop();
    await broker16.start();
    await expect.poll(() => broker16.active, { timeout: 15_000, interval: 200 }).toBe(true);
    // A repeated confirmation of a setup it already decided; a new one on the pair it holds.
    await publish(transition(earlier.setup_id));
    const fresh = randomUUID();
    await publish(transition(fresh));
    expect(await decided(fresh)).toMatchObject([{ outcome: 'skipped', reason: 'open_limit' }]);
    expect(await count()).toBe(before + 1);

    // The open trade's setup ends: what is left of its buy goes; its stop and target keep what it bought.
    await publish(transition(open.setup_id!, { to: 'resolved', resolution: 'expired_no_entry' }));
    expect(await settled(open.id, ['cancelled'])).toMatchObject({ filled_quantity: '1' });
    const target = nameId(`practice-auto:${strategyId}:${open.setup_id}:target`);
    expect(await order(target)).toMatchObject({ status: 'open', quantity: '1' });
    // The target sells it: the trade closes with a gain, counted for the day.
    await tradeAt('105.50', '5');
    await settled(target, ['filled']);
    const maker = DEFAULT_PRACTICE_SETTINGS.fees.binance.maker;
    const gain = dec(105).minus(99).minus(dec(99).times(maker)).minus(dec(105).times(maker));
    await expect
      .poll(
        async () =>
          dec(await dayResult())
            .minus(resultBefore)
            .toString(),
        { timeout: 10_000 },
      )
      .toBe(gain.toString());

    // A user who switches on after the broker started; then a setup on a pair whose data is not live:
    // both decide, and the order checks refuse both orders.
    const late = randomUUID();
    const lateAccount = randomUUID();
    const lateStrategy = randomUUID();
    await owner
      .insertInto('app.users')
      .values({ id: late, email: `${late}@cip.test`, display_name: 'x', role: 'viewer', password_hash: 'x' })
      .execute();
    await owner
      .insertInto('trading.accounts')
      .values({ id: lateAccount, user_id: late, venue_id: 'binance', starting_balances: { USDT: '10000' } })
      .execute();
    await owner
      .insertInto('trading.ledger')
      .values({
        account_id: lateAccount,
        reset_epoch: 0,
        asset: 'USDT',
        amount: '10000',
        reason: 'start',
        order_id: null,
        fill_id: null,
      })
      .execute();
    await owner
      .insertInto('trading.strategies')
      .values({
        id: lateStrategy,
        user_id: late,
        enabled: true,
        rules: { ...DEFAULT_AUTO_RULES },
        version: 1,
      })
      .execute();
    await redis.xadd(PRACTICE_COMMANDS_STREAM, '*', 'type', 'strategy', 'user', late);
    const ethSetup = randomUUID();
    await publish({ ...transition(ethSetup), instrumentId: '019a6f00-0000-7000-8000-000000000002' });
    const both = await decided(ethSetup, 2);
    expect(both.map((d) => [d.outcome, d.reason])).toEqual([
      ['refused', 'data_delayed'],
      ['refused', 'data_delayed'],
    ]);
    // The late user's rules are the defaults: a fixed 10 USDT a buy (since 2026-11-16), so its refused
    // buy is 10 ÷ 99 rounded down to ETH's quantity step.
    const lateDecision = await owner
      .selectFrom('trading.auto_decisions')
      .select('order_id')
      .where('strategy_id', '=', lateStrategy)
      .where('setup_id', '=', ethSetup)
      .executeTakeFirstOrThrow();
    const lateBuy = await owner
      .selectFrom('trading.orders')
      .select(['quantity', 'status', 'source'])
      .where('id', '=', lateDecision.order_id!)
      .executeTakeFirstOrThrow();
    expect(lateBuy).toMatchObject({ status: 'refused', source: 'auto' });
    expect(dec(lateBuy.quantity).eq('0.101')).toBe(true);
    // An unreadable setup message is passed over.
    await redis.xadd(ANALYSIS_EVENTS_STREAM, '*', 'type', 'setup', 'data', '{"not":"a setup"}');
    await redis.xadd(ANALYSIS_EVENTS_STREAM, '*', 'type', 'setup', 'data', 'not json');
    const last = await publish(transition(randomUUID(), { score: 1 }));
    await expect
      .poll(
        async () =>
          (await owner.selectFrom('trading.broker_state').select('setups_cursor').executeTakeFirstOrThrow())
            .setups_cursor,
        { timeout: 10_000 },
      )
      .toBe(last);

    await broker16.stop();
    await first.start();
    await expect.poll(() => first.active, { timeout: 15_000, interval: 200 }).toBe(true);
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
  });

  it('replays every run of its journal with the same fills and the same decisions (16.6)', async () => {
    const rows = await owner
      .selectFrom('trading.journal')
      .select(['kind', 'input', 'fills', 'decisions'])
      .orderBy('seq')
      .execute();
    const instruments = await new BrokerStore(brokerDb).instruments();
    const rules = new Map(instruments.filter((i) => i.role === 'monitored').map((i) => [i.instrumentId, i]));
    const opts = {
      rules: (id: string) => rules.get(id),
      fees: (venue: string) =>
        DEFAULT_PRACTICE_SETTINGS.fees[venue as 'binance'] ?? { maker: '0', taker: '0' },
      fillId,
      nameId,
    };
    const runs: JournalEntry[][] = [];
    for (const r of rows) {
      const entry = { input: r.input as unknown as JournalInput, fills: r.fills, decisions: r.decisions };
      if (r.kind === 'load') runs.push([entry]);
      else runs.at(-1)?.push(entry);
    }
    const lines = rows.flatMap((r) => r.decisions);
    expect(lines.filter((l) => l.startsWith('decision|')).length).toBeGreaterThanOrEqual(8);
    expect(lines.some((l) => l.startsWith('pause|'))).toBe(true);
    expect(rows.some((r) => r.kind === 'strategy') && rows.some((r) => r.kind === 'setup')).toBe(true);
    for (const run of runs) expect(replayJournal(run, opts)).toMatchObject({ mismatchAt: null });
  });
});
