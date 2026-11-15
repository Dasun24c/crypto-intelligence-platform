import { type Kysely, sql } from 'kysely';
import { DEFAULT_PRACTICE_SETTINGS, type PracticeSettings, PracticeSettingsSchema } from '@cip/contracts';
import { availableBalances, type Database, type TradingOrderRow } from '@cip/db';
import { displayName } from '@cip/domain';
import {
  type EngineAccount,
  type EngineOrder,
  fillDigestLine,
  type InstrumentRules,
  type JournalInput,
  type NewOrder,
  type Outputs,
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
}

export interface AccountInfo {
  userId: string;
  venue: string;
}

export interface BrokerState {
  leaseEpoch: number;
  commandsCursor: string;
  tradeCursors: Record<string, string>;
}

export interface AuditEntry {
  action: string;
  /** `practice_order` unless given. */
  targetType?: 'practice_order' | 'practice_account';
  targetId: string;
  details: Record<string, unknown>;
}

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

  /** Accounts with their current period's available balances; all of them when `ids` is omitted. */
  async accounts(
    ids?: readonly string[],
  ): Promise<{ engine: EngineAccount[]; info: Map<string, AccountInfo> }> {
    let q = this.db.selectFrom('trading.accounts').select(['id', 'user_id', 'venue_id', 'reset_epoch']);
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

  async state(): Promise<BrokerState> {
    const r = await this.db
      .selectFrom('trading.broker_state')
      .selectAll()
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    return {
      leaseEpoch: Number(r.lease_epoch),
      commandsCursor: r.commands_cursor,
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

  /** Moves the stream positions without other changes (trades that changed nothing). */
  async saveCursors(
    epoch: number,
    cursors: { commands?: string; trades?: Record<string, string> },
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await fence(trx, epoch);
      await writeCursors(trx, cursors);
    });
  }

  /**
   * Writes one input's outcome in one transaction: the orders, fills and ledger entries, any reset,
   * the journal entry, the stream positions and the audit rows. Fenced: a former holder fails.
   */
  async apply(a: {
    epoch: number;
    input: JournalInput;
    outputs: Outputs;
    epochOf: (accountId: string) => number;
    resets: { accountId: string; epoch: number; starting: Record<string, string> }[];
    cursors: { commands?: string; trades?: Record<string, string> };
    audit: AuditEntry[];
    now: number;
  }): Promise<void> {
    const at = new Date(a.now);
    await this.db.transaction().execute(async (trx) => {
      await fence(trx, a.epoch);
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
      await trx
        .insertInto('trading.journal')
        .values({
          kind: a.input.kind,
          input: a.input as unknown as Record<string, unknown>,
          fills: a.outputs.fills.map(fillDigestLine),
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

async function writeCursors(
  trx: Kysely<Database>,
  cursors: { commands?: string; trades?: Record<string, string> },
): Promise<void> {
  if (!cursors.commands && !cursors.trades) return;
  await trx
    .updateTable('trading.broker_state')
    .set({
      ...(cursors.commands ? { commands_cursor: cursors.commands } : {}),
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
