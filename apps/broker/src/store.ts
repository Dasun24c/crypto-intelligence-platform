import { type Kysely, sql } from 'kysely';
import {
  AutoRulesSchema,
  DEFAULT_AUTO_RULES,
  DEFAULT_PRACTICE_SETTINGS,
  type Pattern,
  type PracticeSettings,
  PracticeSettingsSchema,
} from '@cip/contracts';
import { availableBalances, type Database, type TradingOrderRow, type TradingStrategyRow } from '@cip/db';
import { dec, displayName } from '@cip/domain';
import {
  type AutoDay,
  type AutoDecisionRecord,
  type AutoOrderRow,
  type AutoPause,
  type AutoSnapshot,
  type AutoStrategy,
  type AutoTrade,
  DECIDED_TTL_MS,
  type EngineAccount,
  type EngineOrder,
  fillDigestLine,
  type InstrumentRules,
  type JournalInput,
  type NewOrder,
  type Outputs,
  utcDay,
} from '@cip/paper-engine';

/** A newer lease epoch has written: this instance must stop (ADR 021, fencing). */
export class LeaseLost extends Error {
  constructor() {
    super('another broker instance holds a newer lease');
  }
}

export interface InstrumentInfo extends InstrumentRules {
  role: 'monitored' | 'reference';
  enabled: boolean;
  venueStatus: 'trading' | 'halted' | 'delisted' | 'unknown';
  name: string;
  /** Tokenised gold's underlying market calendar, for the closed-market flag. */
  underlyingCalendarId: string | null;
}

export interface AccountInfo {
  userId: string;
  venue: string;
}

export interface BrokerState {
  leaseEpoch: number;
  commandsCursor: string;
  /** Its position in an:events (Phase 16). */
  setupsCursor: string;
  tradeCursors: Record<string, string>;
}

export interface Cursors {
  commands?: string;
  setups?: string;
  trades?: Record<string, string>;
}

export interface AuditEntry {
  action: string;
  /** `practice_order` unless given. */
  targetType?: 'practice_order' | 'practice_account' | 'practice_strategy';
  targetId: string;
  details: Record<string, unknown>;
}

/** What the auto-trader wrote for one input (Phase 16, ADR 022). */
export interface AutoWrites {
  /** Orders it placed: inserted as `new` before the engine's changes are applied. */
  orders: AutoOrderRow[];
  decisions: AutoDecisionRecord[];
  days: AutoDay[];
  pauses: AutoPause[];
  /** Its digest lines, journalled beside the fills'. */
  lines: string[];
}

const num = (v: string | null | undefined) => dec(v ?? '0').toString();

/** Engine order from a stored row. */
export function engineOrder(r: TradingOrderRow): EngineOrder {
  return {
    id: r.id,
    accountId: r.account_id,
    instrumentId: r.instrument_id,
    side: r.side,
    type: r.type,
    quantity: r.quantity,
    limitPrice: r.limit_price,
    stopPrice: r.stop_price,
    status: r.status,
    filled: r.filled_quantity,
    filledValue: r.filled_value,
    reserved: r.reserved,
    parentId: r.parent_id,
    ocoGroup: r.oco_group,
    acceptedAfterTrade: r.accepted_after ?? '0-0',
    seq: Number(r.seq ?? 0),
    refusalReason: r.refusal_reason as EngineOrder['refusalReason'],
    underlyingClosed: r.underlying_closed,
    fillCount: r.fill_count,
  };
}

/** A strategy row as the auto-trader reads it. Rules that no longer validate switch it off. */
export function autoStrategy(r: TradingStrategyRow, accountId: string | null): AutoStrategy {
  const parsed = AutoRulesSchema.safeParse(r.rules);
  return {
    id: r.id,
    userId: r.user_id,
    accountId,
    enabled: parsed.success && r.enabled,
    rules: parsed.success ? parsed.data : { ...DEFAULT_AUTO_RULES },
    version: r.version,
    pausedUntil: r.paused_until?.getTime() ?? null,
  };
}

/** The broker's database access, as `svc_broker` (data model §9 and §10). Every write is fenced by the lease epoch. */
export class BrokerStore {
  constructor(private readonly db: Kysely<Database>) {}

  async instruments(): Promise<InstrumentInfo[]> {
    const rows = await this.db
      .selectFrom('market.instruments')
      .select([
        'id',
        'venue_id',
        'base_asset',
        'quote_asset',
        'asset_class',
        'price_tick',
        'qty_step',
        'min_notional',
        'role',
        'enabled',
        'venue_status',
        'underlying_calendar_id',
      ])
      .execute();
    return rows.map((r) => ({
      instrumentId: r.id,
      venue: r.venue_id,
      base: r.base_asset,
      quote: r.quote_asset,
      priceTick: r.price_tick,
      qtyStep: r.qty_step,
      minNotional: r.min_notional,
      role: r.role,
      enabled: r.enabled,
      venueStatus: r.venue_status,
      underlyingCalendarId: r.underlying_calendar_id,
      name: displayName({
        venue: r.venue_id,
        base: r.base_asset,
        quote: r.quote_asset,
        assetClass: r.asset_class,
      }),
    }));
  }

  /** The admins' practice settings, or the defaults (ADR 021). */
  async settings(): Promise<PracticeSettings> {
    const row = await this.db
      .selectFrom('app.settings')
      .select('value')
      .where('key', '=', 'practice')
      .executeTakeFirst();
    const parsed = row ? PracticeSettingsSchema.safeParse(row.value) : null;
    return parsed?.success ? parsed.data : DEFAULT_PRACTICE_SETTINGS;
  }

  /** Streams with an open gap, by instrument. */
  async openGaps(): Promise<Map<string, string[]>> {
    const rows = await this.db
      .selectFrom('market.data_gaps')
      .select(['instrument_id', 'stream'])
      .where('status', 'in', ['open', 'backfilling'])
      .execute();
    const out = new Map<string, string[]>();
    for (const r of rows) out.set(r.instrument_id, [...(out.get(r.instrument_id) ?? []), r.stream]);
    return out;
  }

  /** Whether the underlying market of a calendar is closed at `now` (tokenised gold at the weekend). */
  async underlyingClosed(calendarId: string, now: number): Promise<boolean> {
    const row = await this.db
      .selectFrom('market.underlying_market_closures')
      .select('calendar_id')
      .where('calendar_id', '=', calendarId)
      .where('starts_at', '<=', new Date(now))
      .where('ends_at', '>', new Date(now))
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Accounts with their current period's available and starting balances; all of them when `ids` is omitted. */
  async accounts(
    ids?: readonly string[],
  ): Promise<{ engine: EngineAccount[]; info: Map<string, AccountInfo> }> {
    let q = this.db
      .selectFrom('trading.accounts')
      .select(['id', 'user_id', 'venue_id', 'reset_epoch', 'starting_balances']);
    if (ids) {
      if (!ids.length) return { engine: [], info: new Map() };
      q = q.where('id', 'in', ids);
    }
    const rows = await q.execute();
    const balances = await availableBalances(
      this.db,
      rows.map((r) => r.id),
    );
    return {
      engine: rows.map((r) => ({
        id: r.id,
        venue: r.venue_id,
        epoch: r.reset_epoch,
        available: balances.get(r.id) ?? {},
        starting: { ...r.starting_balances },
      })),
      info: new Map(rows.map((r) => [r.id, { userId: r.user_id, venue: r.venue_id }])),
    };
  }

  /** Orders the engine holds: taken up and not finished. */
  async liveOrders(): Promise<EngineOrder[]> {
    const rows = await this.db
      .selectFrom('trading.orders')
      .selectAll()
      .where('status', 'in', ['pending', 'open', 'partially_filled'])
      .orderBy('seq')
      .execute();
    return rows.map(engineOrder);
  }

  /** An order the api stored and has not been taken up yet, with its stop and target. */
  async newOrder(id: string): Promise<NewOrder | null> {
    const row = await this.db
      .selectFrom('trading.orders')
      .selectAll()
      .where('id', '=', id)
      .where('status', '=', 'new')
      .where('parent_id', 'is', null)
      .executeTakeFirst();
    if (!row || (row.type !== 'market' && row.type !== 'limit')) return null;
    const legs = await this.db.selectFrom('trading.orders').selectAll().where('parent_id', '=', id).execute();
    const stop = legs.find((l) => l.type === 'stop');
    const target = legs.find((l) => l.type === 'target');
    return {
      id: row.id,
      accountId: row.account_id,
      instrumentId: row.instrument_id,
      side: row.side,
      type: row.type,
      quantity: row.quantity,
      limitPrice: row.limit_price,
      underlyingClosed: row.underlying_closed,
      stop: stop ? { id: stop.id, price: stop.stop_price! } : null,
      target: target ? { id: target.id, price: target.limit_price! } : null,
      ocoGroup: legs[0]?.oco_group ?? null,
    };
  }

  async orders(ids: readonly string[]): Promise<TradingOrderRow[]> {
    if (!ids.length) return [];
    return this.db.selectFrom('trading.orders').selectAll().where('id', 'in', ids).execute();
  }

  /** Buys with their stops and targets. */
  async withLegs(ids: readonly string[]): Promise<TradingOrderRow[]> {
    if (!ids.length) return [];
    return this.db
      .selectFrom('trading.orders')
      .selectAll()
      .where((eb) => eb.or([eb('id', 'in', ids), eb('parent_id', 'in', ids)]))
      .execute();
  }

  // ----- automatic trading (Phase 16) -----

  /** A user's strategy, with their account on its venue: a `strategy` command reads it again. */
  async strategyFor(userId: string): Promise<AutoStrategy | null> {
    const row = await this.db
      .selectFrom('trading.strategies')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!row) return null;
    const venue = autoStrategy(row, null).rules.venue;
    const account = await this.db
      .selectFrom('trading.accounts')
      .select('id')
      .where('user_id', '=', userId)
      .where('venue_id', '=', venue)
      .executeTakeFirst();
    return autoStrategy(row, account?.id ?? null);
  }

  /**
   * Everything the auto-trader holds, from what is stored: the strategies, the automatic trades with a
   * live order (with their fills so far), today's figures, and the setups decided in the last week.
   */
  async autoSnapshot(info: ReadonlyMap<string, AccountInfo>, now: number): Promise<AutoSnapshot> {
    const rows = await this.db.selectFrom('trading.strategies').selectAll().orderBy('id').execute();
    const accountOf = (userId: string, venue: string) =>
      [...info].find(([, a]) => a.userId === userId && a.venue === venue)?.[0] ?? null;
    const strategies = rows.map((r) => {
      const s = autoStrategy(r, null);
      return { ...s, accountId: accountOf(s.userId, s.rules.venue) };
    });
    const [trades, days, decided] = await Promise.all([
      this.autoTrades(info, strategies),
      this.db
        .selectFrom('trading.auto_days')
        .select(['account_id', 'day', 'orders', 'result'])
        .where('day', '>=', utcDay(now))
        .orderBy('account_id')
        .orderBy('day')
        .execute(),
      this.db
        .selectFrom('trading.auto_decisions')
        .select(['strategy_id', 'setup_id', sql<Date>`min(decided_at)`.as('at')])
        .where('decided_at', '>=', new Date(now - DECIDED_TTL_MS))
        .groupBy(['strategy_id', 'setup_id'])
        .orderBy('strategy_id')
        .orderBy('setup_id')
        .execute(),
    ]);
    const latest = new Map<string, AutoDay>();
    for (const d of days)
      latest.set(d.account_id, {
        accountId: d.account_id,
        day: d.day,
        orders: d.orders,
        result: num(d.result),
      });
    return {
      strategies,
      trades,
      days: [...latest.values()],
      decided: decided.map((d) => ({
        strategyId: d.strategy_id,
        setupId: d.setup_id,
        at: new Date(d.at).getTime(),
      })),
    };
  }

  private async autoTrades(
    info: ReadonlyMap<string, AccountInfo>,
    strategies: readonly AutoStrategy[],
  ): Promise<AutoTrade[]> {
    const live = await this.db
      .selectFrom('trading.orders')
      .select(['account_id', 'setup_id'])
      .where('source', '=', 'auto')
      .where('status', 'in', ['new', 'pending', 'open', 'partially_filled'])
      .execute();
    const setupIds = [...new Set(live.map((r) => r.setup_id).filter((x): x is string => x !== null))];
    if (!setupIds.length) return [];
    const rows = await this.db
      .selectFrom('trading.orders')
      .selectAll()
      .where('source', '=', 'auto')
      .where('setup_id', 'in', setupIds)
      .execute();
    const orderIds = rows.map((r) => r.id);
    const [fees, placed] = await Promise.all([
      this.db
        .selectFrom('trading.fills')
        .select(['order_id', sql<string>`sum(fee)`.as('fee')])
        .where('order_id', 'in', orderIds)
        .groupBy('order_id')
        .execute(),
      this.db
        .selectFrom('trading.auto_decisions')
        .select(['order_id', 'run_id', 'pattern'])
        .where('outcome', '=', 'placed')
        .where('order_id', 'in', orderIds)
        .execute(),
    ]);
    const feeOf = new Map(fees.map((f) => [f.order_id, f.fee]));
    const placedOf = new Map(placed.map((p) => [p.order_id, p]));
    const groups = new Map<string, TradingOrderRow[]>();
    for (const r of rows) {
      const key = `${r.account_id}|${r.setup_id}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    const keys = [...new Set(live.map((r) => `${r.account_id}|${r.setup_id}`))].sort();
    const trades: AutoTrade[] = [];
    for (const key of keys) {
      const group = groups.get(key) ?? [];
      const buy = group.find((o) => o.parent_id === null);
      const stop = group.find((o) => o.type === 'stop');
      const target = group.find((o) => o.type === 'target');
      const userId = buy ? info.get(buy.account_id)?.userId : undefined;
      const strategy = strategies.find((s) => s.userId === userId);
      const decision = buy ? placedOf.get(buy.id) : undefined;
      if (!buy || !stop || !target || !strategy || !decision) continue;
      const legs = [stop, target];
      trades.push({
        strategyId: strategy.id,
        setupId: buy.setup_id!,
        runId: decision.run_id,
        pattern: decision.pattern as Pattern,
        accountId: buy.account_id,
        instrumentId: buy.instrument_id,
        buyId: buy.id,
        stopId: stop.id,
        targetId: target.id,
        bought: num(buy.filled_quantity),
        cost: num(buy.filled_value),
        buyFees: num(feeOf.get(buy.id)),
        sold: legs.reduce((a, o) => a.plus(o.filled_quantity), dec(0)).toString(),
        proceeds: legs.reduce((a, o) => a.plus(o.filled_value), dec(0)).toString(),
        sellFees: legs.reduce((a, o) => a.plus(feeOf.get(o.id) ?? '0'), dec(0)).toString(),
      });
    }
    return trades;
  }

  async state(): Promise<BrokerState> {
    const r = await this.db
      .selectFrom('trading.broker_state')
      .selectAll()
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    return {
      leaseEpoch: Number(r.lease_epoch),
      commandsCursor: r.commands_cursor,
      setupsCursor: r.setups_cursor,
      tradeCursors: r.trade_cursors,
    };
  }

  /** Records `epoch` as the newest, or fails if a newer one has written. */
  async claim(epoch: number): Promise<void> {
    const r = await this.db
      .updateTable('trading.broker_state')
      .set({ lease_epoch: epoch, updated_at: new Date() })
      .where('id', '=', 1)
      .where('lease_epoch', '<=', String(epoch))
      .executeTakeFirst();
    if (Number(r.numUpdatedRows) !== 1) throw new LeaseLost();
  }

  /** The state the engine loaded when this instance took the lease: the first entry a replay starts from. */
  async journalLoad(epoch: number, input: Extract<JournalInput, { kind: 'load' }>): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await fence(trx, epoch);
      await trx.insertInto('trading.journal').values({ kind: 'load', input, fills: [] }).execute();
    });
  }

  /** Moves the stream positions without other changes (inputs that changed nothing). */
  async saveCursors(epoch: number, cursors: Cursors): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await fence(trx, epoch);
      await writeCursors(trx, cursors);
    });
  }

  /**
   * Writes one input's outcome in one transaction: the orders the auto-trader placed, the orders'
   * changes, fills and ledger entries, any reset, the auto-trader's decisions, day figures and
   * pauses, the journal entry, the stream positions and the audit rows. Fenced: a former holder fails.
   */
  async apply(a: {
    epoch: number;
    input: JournalInput;
    outputs: Outputs;
    epochOf: (accountId: string) => number;
    resets: { accountId: string; epoch: number; starting: Record<string, string> }[];
    cursors: Cursors;
    audit: AuditEntry[];
    auto?: AutoWrites | null;
    now: number;
  }): Promise<void> {
    const at = new Date(a.now);
    await this.db.transaction().execute(async (trx) => {
      await fence(trx, a.epoch);
      for (const o of a.auto?.orders ?? [])
        await trx
          .insertInto('trading.orders')
          .values({
            id: o.id,
            account_id: o.accountId,
            instrument_id: o.instrumentId,
            client_order_id: o.clientOrderId,
            side: o.side,
            type: o.type,
            quantity: o.quantity,
            limit_price: o.limitPrice,
            stop_price: o.stopPrice,
            status: 'new',
            refusal_reason: null,
            parent_id: o.parentId,
            oco_group: o.ocoGroup,
            source: 'auto',
            setup_id: o.setupId,
            underlying_closed: o.underlyingClosed,
            reset_epoch: a.epochOf(o.accountId),
            created_at: at,
            updated_at: at,
          })
          .execute();
      for (const o of a.outputs.orders)
        await trx
          .updateTable('trading.orders')
          .set({
            status: o.status,
            refusal_reason: o.refusalReason,
            quantity: o.quantity,
            filled_quantity: o.filled,
            filled_value: o.filledValue,
            reserved: o.reserved,
            seq: o.seq,
            accepted_after: o.acceptedAfterTrade,
            fill_count: o.fillCount,
            updated_at: at,
          })
          .where('id', '=', o.id)
          .execute();
      if (a.outputs.fills.length)
        await trx
          .insertInto('trading.fills')
          .values(
            a.outputs.fills.map((f) => ({
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
              reset_epoch: a.epochOf(f.accountId),
              filled_at: new Date(f.at),
            })),
          )
          .execute();
      if (a.outputs.ledger.length)
        await trx
          .insertInto('trading.ledger')
          .values(
            a.outputs.ledger.map((l) => ({
              account_id: l.accountId,
              reset_epoch: l.epoch,
              asset: l.asset,
              amount: l.amount,
              reason: l.reason,
              order_id: l.orderId,
              fill_id: l.fillId,
            })),
          )
          .execute();
      for (const r of a.resets)
        await trx
          .updateTable('trading.accounts')
          .set({ reset_epoch: r.epoch, starting_balances: r.starting, updated_at: at })
          .where('id', '=', r.accountId)
          .execute();
      if (a.auto?.decisions.length)
        await trx
          .insertInto('trading.auto_decisions')
          .values(
            a.auto.decisions.map((d) => ({
              id: d.id,
              strategy_id: d.strategyId,
              user_id: d.userId,
              setup_id: d.setupId,
              run_id: d.runId,
              instrument_id: d.instrumentId,
              pattern: d.pattern,
              outcome: d.outcome,
              reason: d.reason,
              order_id: d.orderId,
              strategy_version: d.strategyVersion,
              decided_at: new Date(d.decidedAt),
            })),
          )
          .onConflict((oc) => oc.column('id').doNothing())
          .execute();
      for (const d of a.auto?.days ?? [])
        await trx
          .insertInto('trading.auto_days')
          .values({ account_id: d.accountId, day: d.day, orders: d.orders, result: d.result, updated_at: at })
          .onConflict((oc) =>
            oc
              .columns(['account_id', 'day'])
              .doUpdateSet({ orders: d.orders, result: d.result, updated_at: at }),
          )
          .execute();
      for (const p of a.auto?.pauses ?? [])
        await trx
          .updateTable('trading.strategies')
          .set({ paused_until: new Date(p.until), updated_at: at })
          .where('id', '=', p.strategyId)
          .execute();
      await trx
        .insertInto('trading.journal')
        .values({
          kind: a.input.kind,
          input: a.input as unknown as Record<string, unknown>,
          fills: a.outputs.fills.map(fillDigestLine),
          decisions: a.auto?.lines ?? [],
        })
        .execute();
      await writeCursors(trx, a.cursors);
      for (const e of a.audit)
        await trx
          .insertInto('app.audit_log')
          .values({
            actor_type: 'system',
            actor_user_id: null,
            action: e.action,
            target_type: e.targetType ?? 'practice_order',
            target_id: e.targetId,
            ip: null,
            user_agent: null,
            details: e.details,
          })
          .execute();
    });
  }
}

async function fence(trx: Kysely<Database>, epoch: number): Promise<void> {
  const row = await trx
    .selectFrom('trading.broker_state')
    .select('lease_epoch')
    .where('id', '=', 1)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (Number(row.lease_epoch) > epoch) throw new LeaseLost();
}

async function writeCursors(trx: Kysely<Database>, cursors: Cursors): Promise<void> {
  if (!cursors.commands && !cursors.setups && !cursors.trades) return;
  await trx
    .updateTable('trading.broker_state')
    .set({
      ...(cursors.commands ? { commands_cursor: cursors.commands } : {}),
      ...(cursors.setups ? { setups_cursor: cursors.setups } : {}),
      ...(cursors.trades
        ? {
            trade_cursors: sql<
              Record<string, string>
            >`trade_cursors || ${JSON.stringify(cursors.trades)}::jsonb`,
          }
        : {}),
      updated_at: new Date(),
    })
    .where('id', '=', 1)
    .execute();
}
