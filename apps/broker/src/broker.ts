import { createHash } from 'node:crypto';
import type { Histogram, Meter } from '@opentelemetry/api';
import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { PRACTICE_COMMANDS_STREAM } from '@cip/contracts/practice-commands';
import { PRACTICE_EVENTS_STREAM, type PracticeSettings, type Venue } from '@cip/contracts';
import { type Database, fillFromRow, orderFromRow, practiceAccounts } from '@cip/db';
import { FencedLease, type HeartbeatProbe, LEASE_RENEW_MS, type Logger } from '@cip/observability';
import {
  compareStreamIds,
  type EngineAccount,
  type EngineConfig,
  type JournalInput,
  type Outputs,
  PaperEngine,
  type Trade,
} from '@cip/paper-engine';
import { MarketView } from './market.js';
import { type AccountInfo, type AuditEntry, BrokerStore, LeaseLost } from './store.js';

/** `practice:events` keeps about this many messages. */
const EVENTS_MAXLEN = '100000';
const HEALTH_EVERY_MS = 1_000;
const REFRESH_EVERY_MS = 30_000;
const CURSORS_EVERY_MS = 5_000;

/** A fill's id from its order's id and its number on that order: a UUID (name-based, SHA-1), so a replay gets the same one. */
export function fillId(orderId: string, n: number): string {
  const h = createHash('sha1').update(`practice-fill:${orderId}:${n}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

const isEmpty = (o: Outputs) => !o.orders.length && !o.fills.length && !o.ledger.length;
const streamMs = (id: string) => Number(id.split('-')[0]);

export interface BrokerOptions {
  db: Kysely<Database>;
  /** For commands, state and events. */
  redis: Redis;
  /** A second connection for blocking stream reads. */
  reader: Redis;
  log: Logger;
  meter?: Meter;
  instance: string;
  now?: () => number;
  /** How long one blocking read waits (ms). */
  blockMs?: number;
  /** How often the instruments' rules and the practice settings are read again (ms; default 30 s). */
  refreshMs?: number;
}

/**
 * The broker service (ADR 021): the only writer of practice fills and balances. One active instance
 * holds `lease:broker`; it reads `practice:commands` and the `md:trades:{id}` streams in order,
 * feeds them to the paper engine, and stores each input's outcome in one fenced transaction before
 * telling the owner on `practice:events`. It has no venue client: nothing here reaches an exchange.
 */
export class Broker {
  readonly store: BrokerStore;
  readonly market: MarketView;
  private readonly lease: FencedLease;
  private engine: PaperEngine | null = null;
  private settings: PracticeSettings | null = null;
  /** The configuration this engine run journalled last (JSON), and one waiting for its commit. */
  private journalled: string | null = null;
  private pendingConfig: string | null = null;
  private accounts = new Map<string, AccountInfo>();
  private commandsCursor = '0-0';
  private tradeCursors = new Map<string, string>();
  private dirtyTrades = new Map<string, string>();
  private timers: NodeJS.Timeout[] = [];
  private loop: Promise<void> | null = null;
  private stopping = false;
  private lastError: string | null = null;
  private readonly latency: Histogram | undefined;
  private readonly now: () => number;

  constructor(private readonly o: BrokerOptions) {
    this.store = new BrokerStore(o.db);
    this.market = new MarketView(o.redis, this.store);
    this.lease = new FencedLease(o.redis, 'lease:broker', o.instance);
    this.now = o.now ?? Date.now;
    this.latency = o.meter?.createHistogram('cip_practice_order_latency_ms', {
      description: 'Practice order submitted (command appended) to its outcome published (NFR-16)',
      unit: 'ms',
    });
  }

  get active(): boolean {
    return this.engine !== null;
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.leaseTick();
    this.timers.push(
      setInterval(() => void this.leaseTick(), LEASE_RENEW_MS),
      setInterval(() => void this.refreshHealth(), HEALTH_EVERY_MS),
      setInterval(() => void this.refreshReference(), this.o.refreshMs ?? REFRESH_EVERY_MS),
      setInterval(() => void this.flushCursors(), CURSORS_EVERY_MS),
    );
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await this.loop;
    await this.flushCursors();
    await this.lease.release();
    this.engine = null;
  }

  probe(): HeartbeatProbe {
    if (this.lastError) return { status: 'degraded', detail: this.lastError };
    return {
      status: 'ok',
      detail: this.active ? `active: ${this.tradeCursors.size} trade streams` : 'standby',
    };
  }

  // ----- lease and state -----

  private async leaseTick(): Promise<void> {
    if (this.stopping) return;
    try {
      const was = this.active;
      const held = await this.lease.refresh();
      if (held && !was) await this.takeOver();
      else if (!held && was) this.drop('the lease was lost');
    } catch (err) {
      this.o.log.error({ err }, 'broker lease check failed');
      this.drop('lease check failed');
    }
  }

  /** Loads the accounts and live orders, journals them, and starts reading. */
  private async takeOver(): Promise<void> {
    const state = await this.store.state();
    if ((this.lease.epoch ?? 0) <= state.leaseEpoch) await this.lease.bump(state.leaseEpoch);
    const epoch = this.lease.epoch!;
    await this.store.claim(epoch);
    await this.refreshReference();
    await this.refreshHealth();
    const engine = new PaperEngine({
      rules: (id) => this.market.rules(id),
      fees: (venue) => this.settings!.fees[venue as Venue] ?? { maker: '0', taker: '0' },
      fillId,
    });
    const { engine: accounts, info } = await this.store.accounts();
    const orders = await this.store.liveOrders();
    engine.load(accounts, orders);
    this.accounts = info;
    const config = this.config();
    await this.store.journalLoad(epoch, { kind: 'load', accounts, orders, config });
    this.journalled = JSON.stringify(config);
    this.commandsCursor = state.commandsCursor;
    this.tradeCursors = new Map(Object.entries(state.tradeCursors));
    for (const id of this.market.tradeInstruments())
      if (!this.tradeCursors.has(id))
        this.tradeCursors.set(id, await this.streamEnd(this.market.streamOf(id)));
    this.engine = engine;
    this.lastError = null;
    this.o.log.info({ epoch, accounts: accounts.length, orders: orders.length }, 'broker active');
    this.loop = this.run(epoch);
  }

  private drop(reason: string): void {
    if (!this.engine) return;
    this.o.log.warn({ reason }, 'broker stands down');
    this.engine = null;
  }

  private async streamEnd(stream: string): Promise<string> {
    const last = await this.o.redis.xrevrange(stream, '+', '-', 'COUNT', 1);
    return last[0]?.[0] ?? '0-0';
  }

  private async refreshReference(): Promise<void> {
    try {
      await this.market.refreshInstruments();
      this.settings = await this.store.settings();
    } catch (err) {
      this.o.log.warn({ err }, 'practice reference data refresh failed');
    }
  }

  private async refreshHealth(): Promise<void> {
    try {
      await this.market.refreshHealth();
    } catch (err) {
      this.o.log.warn({ err }, 'practice health refresh failed');
    }
  }

  private async flushCursors(): Promise<void> {
    if (!this.active || !this.dirtyTrades.size || this.lease.epoch === null) return;
    const trades = Object.fromEntries(this.dirtyTrades);
    this.dirtyTrades.clear();
    try {
      await this.store.saveCursors(this.lease.epoch, { trades });
    } catch (err) {
      if (err instanceof LeaseLost) this.drop('a newer broker holds the lease');
      else this.o.log.warn({ err }, 'saving trade positions failed');
    }
  }

  // ----- the input loop -----

  private async run(epoch: number): Promise<void> {
    while (!this.stopping && this.engine && this.lease.epoch === epoch) {
      const instruments = this.market.tradeInstruments();
      for (const id of instruments)
        if (!this.tradeCursors.has(id))
          this.tradeCursors.set(id, await this.streamEnd(this.market.streamOf(id)));
      const streams = [PRACTICE_COMMANDS_STREAM, ...instruments.map((id) => this.market.streamOf(id))];
      const ids = [this.commandsCursor, ...instruments.map((id) => this.tradeCursors.get(id)!)];
      let res: [string, [string, string[]][]][] | null;
      try {
        res = await this.o.reader.xread(
          'COUNT',
          200,
          'BLOCK',
          this.o.blockMs ?? 1_000,
          'STREAMS',
          ...streams,
          ...ids,
        );
      } catch (err) {
        this.o.log.warn({ err }, 'reading practice streams failed');
        await sleep(1_000);
        continue;
      }
      if (!res) continue;
      // One order across streams: Valkey's stream ids share one clock. Commands first on a tie.
      const entries = res
        .flatMap(([stream, list]) => list.map(([id, fields]) => ({ stream, id, fields: toFields(fields) })))
        .sort((a, b) => compareStreamIds(a.id, b.id) || (a.stream === PRACTICE_COMMANDS_STREAM ? -1 : 1));
      for (const e of entries) {
        if (!this.engine || this.stopping) break;
        try {
          await this.handle(epoch, e.stream, e.id, e.fields);
          this.lastError = null;
        } catch (err) {
          if (err instanceof LeaseLost) {
            this.drop('a newer broker holds the lease');
            return;
          }
          // The engine may have changed while the database did not: reload, and read the input again.
          this.lastError = 'a practice update failed; reloaded';
          this.o.log.error({ err, stream: e.stream, id: e.id }, 'practice input failed; reloading');
          await this.reload(epoch);
          break;
        }
      }
    }
  }

  private async reload(epoch: number): Promise<void> {
    if (!this.engine) return;
    const state = await this.store.state();
    const { engine: accounts, info } = await this.store.accounts();
    const orders = await this.store.liveOrders();
    const engine = new PaperEngine({
      rules: (id) => this.market.rules(id),
      fees: (venue) => this.settings!.fees[venue as Venue] ?? { maker: '0', taker: '0' },
      fillId,
    });
    engine.load(accounts, orders);
    const config = this.config();
    await this.store.journalLoad(epoch, { kind: 'load', accounts, orders, config });
    this.journalled = JSON.stringify(config);
    this.pendingConfig = null;
    this.engine = engine;
    this.accounts = info;
    this.commandsCursor = state.commandsCursor;
    this.tradeCursors = new Map(Object.entries(state.tradeCursors));
    this.dirtyTrades.clear();
    await sleep(500);
  }

  private async handle(epoch: number, stream: string, id: string, f: Record<string, string>): Promise<void> {
    const engine = this.engine!;
    if (stream === PRACTICE_COMMANDS_STREAM) {
      await this.command(epoch, engine, id, f);
      return;
    }
    const instrumentId = stream.slice('md:trades:'.length);
    const trade: Trade = {
      instrumentId,
      id: f['id'] ?? id,
      streamId: id,
      ts: Number(f['ts']),
      price: f['price'] ?? '0',
      quantity: f['qty'] ?? '0',
    };
    this.tradeCursors.set(instrumentId, id);
    if (!(Number(trade.price) > 0) || !(Number(trade.quantity) > 0)) {
      this.dirtyTrades.set(instrumentId, id);
      return;
    }
    const ctx = {
      health: this.market.healthOf(instrumentId),
      book: engine.needsBook(instrumentId) ? await this.market.book(instrumentId) : null,
    };
    const config = this.config();
    const outputs = engine.trade(trade, ctx);
    if (isEmpty(outputs)) {
      this.dirtyTrades.set(instrumentId, id);
      return;
    }
    this.dirtyTrades.delete(instrumentId);
    await this.commit(
      epoch,
      this.withConfig({ kind: 'trade', trade, ctx }, config),
      outputs,
      { trades: { [instrumentId]: id } },
      [],
      null,
    );
  }

  private async command(
    epoch: number,
    engine: PaperEngine,
    id: string,
    f: Record<string, string>,
  ): Promise<void> {
    const type = f['type'];
    let input: JournalInput | null = null;
    let outputs: Outputs | null = null;
    let config: EngineConfig | null = null;
    const resets: { accountId: string; epoch: number; starting: Record<string, string> }[] = [];
    if (type === 'place' && f['orderId']) {
      const order = await this.store.newOrder(f['orderId']);
      if (order) {
        const loaded = await this.ensureAccount(engine, order.accountId);
        const ctx = {
          now: this.now(),
          health: this.market.healthOf(order.instrumentId),
          book: await this.market.book(order.instrumentId),
          lastTrade: this.tradeCursors.get(order.instrumentId) ?? '0-0',
        };
        config = this.config();
        outputs = engine.place(order, ctx);
        input = { kind: 'place', order, ctx, ...(loaded ? { accounts: [loaded] } : {}) };
      }
    } else if (type === 'cancel' && f['orderId']) {
      config = this.config();
      outputs = engine.cancel(f['orderId']);
      input = { kind: 'cancel', orderId: f['orderId'] };
    } else if (type === 'reset' && f['accountId']) {
      const accountId = f['accountId'];
      const loaded = await this.ensureAccount(engine, accountId);
      const venue = this.accounts.get(accountId)?.venue;
      if (venue) {
        const starting = { ...(this.settings!.startingBalances[venue as Venue] ?? {}) };
        config = this.config();
        outputs = engine.reset(accountId, starting);
        resets.push({ accountId, epoch: engine.account(accountId).epoch, starting });
        input = { kind: 'reset', accountId, starting, ...(loaded ? { accounts: [loaded] } : {}) };
      }
    }
    if (!input || !outputs || (isEmpty(outputs) && !resets.length)) {
      // Nothing to do (already taken up, unknown, or a cancel of a finished order): move on.
      this.commandsCursor = id;
      await this.store.saveCursors(epoch, { commands: id });
      return;
    }
    await this.commit(
      epoch,
      // Every command that made an input read the configuration just before the engine did.
      this.withConfig(input, config!),
      outputs,
      { commands: id },
      resets,
      streamMs(id),
    );
    this.commandsCursor = id;
  }

  /** The rules and fees the engine reads now. */
  private config(): EngineConfig {
    return {
      rules: this.market.rulesList(),
      fees: Object.fromEntries(Object.entries(this.settings?.fees ?? {})),
    };
  }

  /**
   * The input with the configuration attached when it differs from what this run journalled last,
   * so a replay applies the same rules and fees from the same input on (criterion 14.3).
   */
  private withConfig(input: JournalInput, config: EngineConfig): JournalInput {
    const json = JSON.stringify(config);
    if (json === this.journalled) return input;
    this.pendingConfig = json;
    return { ...input, config };
  }

  /** Loads an account the engine has not met yet; returns it, to journal with the input. */
  private async ensureAccount(engine: PaperEngine, accountId: string): Promise<EngineAccount | null> {
    if (engine.hasAccount(accountId)) return null;
    const { engine: rows, info } = await this.store.accounts([accountId]);
    const account = rows[0];
    if (!account) return null;
    engine.load([account]);
    for (const [k, v] of info) this.accounts.set(k, v);
    return account;
  }

  private async commit(
    epoch: number,
    input: JournalInput,
    outputs: Outputs,
    cursors: { commands?: string; trades?: Record<string, string> },
    resets: { accountId: string; epoch: number; starting: Record<string, string> }[],
    submittedAt: number | null,
  ): Promise<void> {
    const engine = this.engine!;
    const audit: AuditEntry[] = [
      ...outputs.fills.map((f) => ({
        action: 'practice_order.filled',
        targetId: f.orderId,
        details: {
          fillId: f.id,
          price: f.price,
          quantity: f.quantity,
          fee: f.fee,
          liquidity: f.liquidity,
          flags: f.flags,
        },
      })),
      ...outputs.orders
        .filter((o) => o.status === 'refused')
        .map((o) => ({
          action: 'practice_order.refused',
          targetId: o.id,
          details: { reason: o.refusalReason, by: 'broker' },
        })),
      // `cause`: the user's cancel, a reset, a trade (the other half of a stop and target filled),
      // or the placing itself (what a market order's book could not fill).
      ...outputs.orders
        .filter((o) => o.status === 'cancelled')
        .map((o) => ({
          action: 'practice_order.cancelled',
          targetId: o.id,
          details: { cause: input.kind, filledQuantity: o.filled },
        })),
      ...resets.map((r) => ({
        action: 'practice_account.reset',
        targetType: 'practice_account' as const,
        targetId: r.accountId,
        details: { resetEpoch: r.epoch, startingBalances: r.starting },
      })),
    ];
    await this.store.apply({
      epoch,
      input,
      outputs,
      epochOf: (accountId) => engine.account(accountId).epoch,
      resets,
      cursors,
      audit,
      now: this.now(),
    });
    if (this.pendingConfig !== null) {
      this.journalled = this.pendingConfig;
      this.pendingConfig = null;
    }
    await this.publish(
      outputs,
      resets.map((r) => r.accountId),
    );
    if (submittedAt !== null) this.latency?.record(Math.max(0, this.now() - submittedAt));
  }

  /** Tells each owner what changed: orders, fills and balances, on `practice:events`. */
  private async publish(outputs: Outputs, resetAccounts: string[]): Promise<void> {
    const orderIds = [
      ...new Set([...outputs.orders.map((o) => o.id), ...outputs.fills.map((f) => f.orderId)]),
    ];
    const rows = new Map((await this.store.orders(orderIds)).map((r) => [r.id, r]));
    const accountIds = new Set([...outputs.ledger.map((l) => l.accountId), ...resetAccounts]);
    for (const r of rows.values()) accountIds.add(r.account_id);
    const venueOf = (accountId: string) => (this.accounts.get(accountId)?.venue ?? 'binance') as Venue;
    const userOf = (accountId: string) => this.accounts.get(accountId)?.userId;
    const pipe = this.o.redis.pipeline();
    const add = (user: string | undefined, type: string, data: unknown) => {
      if (user)
        pipe.xadd(
          PRACTICE_EVENTS_STREAM,
          'MAXLEN',
          '~',
          EVENTS_MAXLEN,
          '*',
          'type',
          type,
          'user',
          user,
          'data',
          JSON.stringify(data),
        );
    };
    for (const r of rows.values())
      add(userOf(r.account_id), 'practice.order', { order: orderFromRow(r, venueOf(r.account_id)) });
    for (const f of outputs.fills) {
      const order = rows.get(f.orderId);
      if (!order) continue;
      const fill = fillFromRow(
        {
          id: f.id,
          order_id: f.orderId,
          account_id: f.accountId,
          instrument_id: f.instrumentId,
          side: f.side,
          price: f.price,
          quantity: f.quantity,
          fee: f.fee,
          fee_asset: f.feeAsset,
          liquidity: f.liquidity,
          flags: f.flags,
          basis: f.basis,
          reset_epoch: 0,
          filled_at: new Date(f.at),
          created_at: new Date(f.at),
        },
        venueOf(f.accountId),
      );
      add(userOf(f.accountId), 'practice.fill', { fill, order: orderFromRow(order, venueOf(f.accountId)) });
    }
    if (accountIds.size) {
      const accountRows = await this.o.db
        .selectFrom('trading.accounts')
        .selectAll()
        .where('id', 'in', [...accountIds])
        .execute();
      for (const account of await practiceAccounts(this.o.db, accountRows))
        add(userOf(account.id), 'practice.account', { account });
    }
    await pipe.exec();
  }
}

function toFields(list: string[]): Record<string, string> {
  const f: Record<string, string> = {};
  for (let i = 0; i + 1 < list.length; i += 2) f[list[i]!] = list[i + 1]!;
  return f;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
