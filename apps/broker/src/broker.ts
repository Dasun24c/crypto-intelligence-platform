import { createHash } from 'node:crypto';
import type { Histogram, Meter } from '@opentelemetry/api';
import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { PRACTICE_COMMANDS_STREAM } from '@cip/contracts/practice-commands';
import {
  ANALYSIS_EVENTS_STREAM,
  type AutoDecision,
  PRACTICE_EVENTS_STREAM,
  type PracticeAutomaticMessage,
  type PracticeSettings,
  SetupTransitionMessageSchema,
  type Venue,
} from '@cip/contracts';
import { type Database, fillFromRow, orderFromRow, practiceAccounts } from '@cip/db';
import { dec } from '@cip/domain';
import { FencedLease, type HeartbeatProbe, LEASE_RENEW_MS, type Logger } from '@cip/observability';
import {
  type AutoContext,
  autoDigestLines,
  type AutoResult,
  type AutoSetup,
  autoSetup,
  AutoTrader,
  compareStreamIds,
  type EngineAccount,
  type EngineConfig,
  type JournalInput,
  type Outputs,
  PaperEngine,
  type Trade,
} from '@cip/paper-engine';
import { MarketView } from './market.js';
import { type AccountInfo, type AuditEntry, BrokerStore, type Cursors, LeaseLost } from './store.js';

/** `practice:events` keeps about this many messages. */
const EVENTS_MAXLEN = '100000';
const HEALTH_EVERY_MS = 1_000;
const REFRESH_EVERY_MS = 30_000;
const CURSORS_EVERY_MS = 5_000;

/** A name-based UUID (SHA-1, version 5 layout): the same name always gives the same id, so a replay does too. */
export function nameId(name: string): string {
  const h = createHash('sha1').update(name).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** A fill's id from its order's id and its number on that order. */
export function fillId(orderId: string, n: number): string {
  return nameId(`practice-fill:${orderId}:${n}`);
}

const isEmpty = (o: Outputs) => !o.orders.length && !o.fills.length && !o.ledger.length;
const streamMs = (id: string) => Number(id.split('-')[0]);
/** On a tie of stream ids: commands, then setups, then trades. */
const rank = (stream: string) =>
  stream === PRACTICE_COMMANDS_STREAM ? 0 : stream === ANALYSIS_EVENTS_STREAM ? 1 : 2;

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
 * holds `lease:broker`; it reads `practice:commands`, the setups on `an:events` (automatic practice
 * trading, ADR 022) and the `md:trades:{id}` streams in order, feeds them to the paper engine and
 * the auto-trader, and stores each input's outcome in one fenced transaction before telling the
 * owner on `practice:events`. It has no venue client: nothing here reaches an exchange.
 */
export class Broker {
  readonly store: BrokerStore;
  readonly market: MarketView;
  private readonly lease: FencedLease;
  private engine: PaperEngine | null = null;
  private trader: AutoTrader | null = null;
  private settings: PracticeSettings | null = null;
  /** The configuration this engine run journalled last (JSON), and one waiting for its commit. */
  private journalled: string | null = null;
  private pendingConfig: string | null = null;
  private accounts = new Map<string, AccountInfo>();
  private commandsCursor = '0-0';
  private setupsCursor = '0-0';
  private dirtySetups: string | null = null;
  private tradeCursors = new Map<string, string>();
  private dirtyTrades = new Map<string, string>();
  private timers: NodeJS.Timeout[] = [];
  private loop: Promise<void> | null = null;
  private stopping = false;
  private lastError: string | null = null;
  private readonly latency: Histogram | undefined;
  private readonly autoLatency: Histogram | undefined;
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
    this.autoLatency = o.meter?.createHistogram('cip_practice_auto_latency_ms', {
      description: 'Setup transition on an:events to the automatic practice order published (NFR-17)',
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
    this.trader = null;
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

  /** Loads the accounts, live orders and automatic trading, journals them, and starts reading. */
  private async takeOver(): Promise<void> {
    const state = await this.store.state();
    if ((this.lease.epoch ?? 0) <= state.leaseEpoch) await this.lease.bump(state.leaseEpoch);
    const epoch = this.lease.epoch!;
    await this.store.claim(epoch);
    await this.refreshReference();
    await this.refreshHealth();
    await this.loadState(epoch);
    this.commandsCursor = state.commandsCursor;
    // The first time it reads setups it starts at the end: earlier ones are history, not decisions.
    this.setupsCursor = state.setupsCursor;
    if (this.setupsCursor === '0-0') {
      this.setupsCursor = await this.streamEnd(ANALYSIS_EVENTS_STREAM);
      await this.store.saveCursors(epoch, { setups: this.setupsCursor });
    }
    this.tradeCursors = new Map(Object.entries(state.tradeCursors));
    for (const id of this.market.tradeInstruments())
      if (!this.tradeCursors.has(id))
        this.tradeCursors.set(id, await this.streamEnd(this.market.streamOf(id)));
    this.lastError = null;
    this.o.log.info(
      { epoch, accounts: this.accounts.size, orders: this.engine?.liveOrders().length ?? 0 },
      'broker active',
    );
    this.loop = this.run(epoch);
  }

  /** A fresh engine and auto-trader from what is stored, journalled as a `load` entry. */
  private async loadState(epoch: number): Promise<void> {
    const engine = new PaperEngine({
      rules: (id) => this.market.rules(id),
      fees: (venue) => this.settings!.fees[venue as Venue] ?? { maker: '0', taker: '0' },
      fillId,
    });
    const { engine: accounts, info } = await this.store.accounts();
    const orders = await this.store.liveOrders();
    engine.load(accounts, orders);
    const trader = new AutoTrader(engine, { nameId });
    const auto = await this.store.autoSnapshot(info, this.now());
    trader.load(auto);
    const config = this.config();
    await this.store.journalLoad(epoch, { kind: 'load', accounts, orders, auto, config });
    this.journalled = JSON.stringify(config);
    this.pendingConfig = null;
    this.accounts = info;
    this.engine = engine;
    this.trader = trader;
  }

  private drop(reason: string): void {
    if (!this.engine) return;
    this.o.log.warn({ reason }, 'broker stands down');
    this.engine = null;
    this.trader = null;
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
    if (!this.active || (!this.dirtyTrades.size && !this.dirtySetups) || this.lease.epoch === null) return;
    const cursors: Cursors = {
      ...(this.dirtyTrades.size ? { trades: Object.fromEntries(this.dirtyTrades) } : {}),
      ...(this.dirtySetups ? { setups: this.dirtySetups } : {}),
    };
    this.dirtyTrades.clear();
    this.dirtySetups = null;
    try {
      await this.store.saveCursors(this.lease.epoch, cursors);
    } catch (err) {
      if (err instanceof LeaseLost) this.drop('a newer broker holds the lease');
      else this.o.log.warn({ err }, 'saving stream positions failed');
    }
  }

  // ----- the input loop -----

  private async run(epoch: number): Promise<void> {
    while (!this.stopping && this.engine && this.lease.epoch === epoch) {
      const instruments = this.market.tradeInstruments();
      for (const id of instruments)
        if (!this.tradeCursors.has(id))
          this.tradeCursors.set(id, await this.streamEnd(this.market.streamOf(id)));
      const streams = [
        PRACTICE_COMMANDS_STREAM,
        ANALYSIS_EVENTS_STREAM,
        ...instruments.map((id) => this.market.streamOf(id)),
      ];
      const ids = [
        this.commandsCursor,
        this.setupsCursor,
        ...instruments.map((id) => this.tradeCursors.get(id)!),
      ];
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
      // One order across streams: Valkey's stream ids share one clock.
      const entries = res
        .flatMap(([stream, list]) => list.map(([id, fields]) => ({ stream, id, fields: toFields(fields) })))
        .sort((a, b) => compareStreamIds(a.id, b.id) || rank(a.stream) - rank(b.stream));
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
    await this.loadState(epoch);
    this.commandsCursor = state.commandsCursor;
    this.setupsCursor = state.setupsCursor;
    this.dirtySetups = null;
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
    if (stream === ANALYSIS_EVENTS_STREAM) {
      await this.analysisEvent(epoch, id, f);
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
    const auto = this.trader!.observe(outputs, trade.ts);
    await this.commit(
      epoch,
      this.withConfig({ kind: 'trade', trade, ctx }, config),
      outputs,
      { trades: { [instrumentId]: id } },
      [],
      { submittedAt: null, auto },
    );
  }

  /**
   * One `an:events` entry. Only setup transitions the auto-trader can act on are journalled: a
   * confirmed bullish setup while a strategy is on, or the end of a setup with an unfilled buy.
   */
  private async analysisEvent(epoch: number, id: string, f: Record<string, string>): Promise<void> {
    this.setupsCursor = id;
    const trader = this.trader!;
    const setup = f['type'] === 'setup' ? this.parseSetup(f['data'], id) : null;
    if (!setup || !trader.wants(setup)) {
      this.dirtySetups = id;
      return;
    }
    const placing = setup.to === 'confirmed';
    const ctx: AutoContext = {
      now: this.now(),
      health: this.market.healthOf(setup.instrumentId),
      book: placing ? await this.market.book(setup.instrumentId) : null,
      lastTrade: this.tradeCursors.get(setup.instrumentId) ?? '0-0',
      underlyingClosed: placing ? await this.underlyingClosed(setup.instrumentId) : false,
    };
    const config = this.config();
    const auto = trader.setup(setup, ctx);
    this.dirtySetups = null;
    await this.commit(
      epoch,
      this.withConfig({ kind: 'setup', setup, ctx }, config),
      auto.outputs,
      { setups: id },
      [],
      { submittedAt: null, auto, setupAt: auto.orders.length ? streamMs(id) : null },
    );
  }

  private parseSetup(data: string | undefined, id: string): AutoSetup | null {
    try {
      const parsed = SetupTransitionMessageSchema.safeParse(JSON.parse(data ?? ''));
      if (parsed.success) return autoSetup(parsed.data);
      this.o.log.warn({ id, issues: parsed.error.issues.slice(0, 3) }, 'unreadable setup transition skipped');
    } catch {
      this.o.log.warn({ id }, 'unreadable setup transition skipped');
    }
    return null;
  }

  private async underlyingClosed(instrumentId: string): Promise<boolean> {
    const calendar = this.market.info(instrumentId)?.underlyingCalendarId;
    return calendar ? this.store.underlyingClosed(calendar, this.now()) : false;
  }

  private async command(
    epoch: number,
    engine: PaperEngine,
    id: string,
    f: Record<string, string>,
  ): Promise<void> {
    const type = f['type'];
    const trader = this.trader!;
    let input: JournalInput | null = null;
    let outputs: Outputs | null = null;
    let config: EngineConfig | null = null;
    let auto: AutoResult | null = null;
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
        auto = trader.observe(outputs, ctx.now);
        input = { kind: 'place', order, ctx, ...(loaded ? { accounts: [loaded] } : {}) };
      }
    } else if (type === 'cancel' && f['orderId']) {
      const at = this.now();
      config = this.config();
      outputs = engine.cancel(f['orderId']);
      auto = trader.observe(outputs, at);
      input = { kind: 'cancel', orderId: f['orderId'], at };
    } else if (type === 'reset' && f['accountId']) {
      const accountId = f['accountId'];
      const loaded = await this.ensureAccount(engine, accountId);
      const venue = this.accounts.get(accountId)?.venue;
      if (venue) {
        const at = this.now();
        const starting = { ...(this.settings!.startingBalances[venue as Venue] ?? {}) };
        config = this.config();
        outputs = engine.reset(accountId, starting);
        auto = trader.observe(outputs, at);
        resets.push({ accountId, epoch: engine.account(accountId).epoch, starting });
        input = { kind: 'reset', accountId, starting, at, ...(loaded ? { accounts: [loaded] } : {}) };
      }
    } else if ((type === 'strategy' || type === 'stop_auto') && f['user']) {
      // A user's automatic trading changed (ADR 022): read it again, in order with everything else.
      const strategy = await this.store.strategyFor(f['user']);
      if (strategy) {
        const loaded = strategy.accountId ? await this.ensureAccount(engine, strategy.accountId) : null;
        const at = this.now();
        const stop = type === 'stop_auto';
        config = this.config();
        auto = trader.setStrategy(strategy, stop, at);
        outputs = auto.outputs;
        input = { kind: 'strategy', strategy, stop, at, ...(loaded ? { accounts: [loaded] } : {}) };
      }
    }
    // A strategy change is journalled even when it changed no order: the auto-trader's state did.
    if (!input || !outputs || (isEmpty(outputs) && !resets.length && input.kind !== 'strategy')) {
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
      { submittedAt: input.kind === 'strategy' ? null : streamMs(id), auto },
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
    cursors: Cursors,
    resets: { accountId: string; epoch: number; starting: Record<string, string> }[],
    o: {
      /** When the command was appended (NFR-16). */
      submittedAt: number | null;
      auto: AutoResult | null;
      /** When the setup transition was appended, for an input that placed automatic orders (NFR-17). */
      setupAt?: number | null;
    },
  ): Promise<void> {
    const engine = this.engine!;
    const auto = o.auto;
    const placedBy = new Map(
      (auto?.decisions ?? []).filter((d) => d.outcome === 'placed').map((d) => [d.orderId, d]),
    );
    const audit: AuditEntry[] = [
      // Every automatic order is audited as placed, by the user's automatic trading (TRD-10).
      ...(auto?.orders ?? [])
        .filter((r) => placedBy.has(r.id))
        .map((r) => {
          const d = placedBy.get(r.id)!;
          const legs = auto!.orders.filter((l) => l.parentId === r.id);
          return {
            action: 'practice_order.placed',
            targetId: r.id,
            details: {
              source: 'auto',
              userId: d.userId,
              strategyId: d.strategyId,
              strategyVersion: d.strategyVersion,
              setupId: d.setupId,
              runId: d.runId,
              instrumentId: r.instrumentId,
              side: r.side,
              type: r.type,
              quantity: r.quantity,
              limitPrice: r.limitPrice,
              stop: legs.find((l) => l.type === 'stop')?.stopPrice ?? null,
              target: legs.find((l) => l.type === 'target')?.limitPrice ?? null,
            },
          };
        }),
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
      // the placing itself (what a market order's book could not fill), a setup that ended, or a stop.
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
      ...(auto?.pauses ?? []).map((p) => ({
        action: 'practice_auto.paused',
        targetType: 'practice_strategy' as const,
        targetId: p.strategyId,
        details: { userId: p.userId, until: p.until, result: p.result, asset: p.asset },
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
      auto: auto
        ? {
            orders: auto.orders,
            decisions: auto.decisions,
            days: auto.days,
            pauses: auto.pauses,
            lines: autoDigestLines(auto),
          }
        : null,
      now: this.now(),
    });
    if (this.pendingConfig !== null) {
      this.journalled = this.pendingConfig;
      this.pendingConfig = null;
    }
    await this.publish(
      outputs,
      resets.map((r) => r.accountId),
      auto,
    );
    if (o.submittedAt !== null) this.latency?.record(Math.max(0, this.now() - o.submittedAt));
    const setupAt = o.setupAt ?? null;
    if (setupAt !== null) this.autoLatency?.record(Math.max(0, this.now() - setupAt));
  }

  /** Tells each owner what changed: orders, fills, balances and automatic trading, on `practice:events`. */
  private async publish(outputs: Outputs, resetAccounts: string[], auto: AutoResult | null): Promise<void> {
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
    const automatic = (user: string, m: PracticeAutomaticMessage) => add(user, 'practice.automatic', m);
    const decisions = auto?.decisions ?? [];
    const trees = await this.store.withLegs(
      decisions.map((d) => d.orderId).filter((id): id is string => id !== null),
    );
    for (const d of decisions) {
      const decision: AutoDecision = {
        id: d.id,
        setupId: d.setupId,
        instrumentId: d.instrumentId,
        pattern: d.pattern,
        outcome: d.outcome,
        reason: d.reason,
        orderId: d.orderId,
        order: d.orderId ? autoOrderOf(d.orderId, trees) : null,
        strategyVersion: d.strategyVersion,
        decidedAt: d.decidedAt,
      };
      automatic(d.userId, { event: 'decision', decision });
    }
    for (const p of auto?.pauses ?? [])
      automatic(p.userId, { event: 'paused', at: p.at, until: p.until, result: p.result, asset: p.asset });
    if (auto?.stopped)
      automatic(auto.stopped.userId, { event: 'stopped', cancelled: auto.stopped.cancelled });
    await pipe.exec();
  }
}

/** A buy's size and its three prices, from it and its legs. */
export function autoOrderOf(
  buyId: string,
  rows: readonly {
    id: string;
    parent_id: string | null;
    type: string;
    quantity: string;
    limit_price: string | null;
    stop_price: string | null;
  }[],
): AutoDecision['order'] {
  const buy = rows.find((r) => r.id === buyId);
  if (!buy?.limit_price) return null;
  const leg = (type: string) => rows.find((r) => r.parent_id === buyId && r.type === type);
  const n = (v: string | null | undefined) => (v === null || v === undefined ? null : dec(v).toString());
  return {
    quantity: dec(buy.quantity).toString(),
    limitPrice: dec(buy.limit_price).toString(),
    stop: n(leg('stop')?.stop_price),
    target: n(leg('target')?.limit_price),
  };
}

function toFields(list: string[]): Record<string, string> {
  const f: Record<string, string> = {};
  for (let i = 0; i + 1 < list.length; i += 2) f[list[i]!] = list[i + 1]!;
  return f;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
