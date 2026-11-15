import { type Kysely, sql } from 'kysely';
import type { FillFlag, PracticeAccount, PracticeFill, PracticeOrder, RefusalReason } from '@cip/contracts';
import { dec } from '@cip/domain';
import type { Database, TradingAccountRow, TradingFillRow, TradingOrderRow } from './types.js';

/**
 * Practice trading (data model §10, ADR 021): row mappings and balance queries shared by the api
 * and the broker, so both describe orders, fills and accounts the same way.
 */

/** Statuses of an order that may still change. */
export const LIVE_ORDER_STATUSES = ['new', 'pending', 'open', 'partially_filled'] as const;

const ms = (d: Date) => d.getTime();

/** Volume-weighted fill price, normalised; null before the first fill. */
export function averagePrice(filledValue: string, filledQuantity: string): string | null {
  const q = dec(filledQuantity);
  return q.gt(0) ? dec(filledValue).div(q).toString() : null;
}

export function orderFromRow(r: TradingOrderRow, venue: PracticeOrder['venue']): PracticeOrder {
  return {
    id: r.id,
    clientOrderId: r.client_order_id,
    venue,
    instrumentId: r.instrument_id,
    side: r.side,
    type: r.type,
    quantity: dec(r.quantity).toString(),
    limitPrice: r.limit_price === null ? null : dec(r.limit_price).toString(),
    stopPrice: r.stop_price === null ? null : dec(r.stop_price).toString(),
    filledQuantity: dec(r.filled_quantity).toString(),
    averagePrice: averagePrice(r.filled_value, r.filled_quantity),
    status: r.status,
    refusalReason: r.refusal_reason as RefusalReason | null,
    parentId: r.parent_id,
    ocoGroup: r.oco_group,
    source: r.source,
    setupId: r.setup_id,
    underlyingClosed: r.underlying_closed,
    createdAt: ms(r.created_at),
    updatedAt: ms(r.updated_at),
  };
}

export function fillFromRow(r: TradingFillRow, venue: PracticeFill['venue']): PracticeFill {
  return {
    id: r.id,
    orderId: r.order_id,
    venue,
    instrumentId: r.instrument_id,
    side: r.side,
    price: dec(r.price).toString(),
    quantity: dec(r.quantity).toString(),
    fee: dec(r.fee).toString(),
    feeAsset: r.fee_asset,
    liquidity: r.liquidity,
    flags: r.flags as FillFlag[],
    basis: r.basis,
    filledAt: ms(r.filled_at),
  };
}

/** Available balances of the accounts' current periods: the sums of their ledger entries. */
export async function availableBalances(
  db: Kysely<Database>,
  accountIds: readonly string[],
): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>(accountIds.map((id) => [id, {}]));
  if (!accountIds.length) return out;
  const rows = await db
    .selectFrom('trading.ledger as l')
    .innerJoin('trading.accounts as a', (j) =>
      j.onRef('a.id', '=', 'l.account_id').onRef('a.reset_epoch', '=', 'l.reset_epoch'),
    )
    .select(['l.account_id', 'l.asset', sql<string>`sum(l.amount)`.as('total')])
    .where('l.account_id', 'in', accountIds)
    .groupBy(['l.account_id', 'l.asset'])
    .execute();
  for (const r of rows) out.get(r.account_id)![r.asset] = dec(r.total).toString();
  return out;
}

/** What the accounts' live orders hold, by asset: quote for buys, base for sells. */
export async function reservedBalances(
  db: Kysely<Database>,
  accountIds: readonly string[],
): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>(accountIds.map((id) => [id, {}]));
  if (!accountIds.length) return out;
  const rows = await db
    .selectFrom('trading.orders as o')
    .innerJoin('market.instruments as i', 'i.id', 'o.instrument_id')
    .select([
      'o.account_id',
      sql<string>`CASE WHEN o.side = 'buy' THEN i.quote_asset ELSE i.base_asset END`.as('asset'),
      sql<string>`sum(o.reserved)`.as('total'),
    ])
    .where('o.account_id', 'in', accountIds)
    .where('o.status', 'in', [...LIVE_ORDER_STATUSES])
    .where('o.reserved', '>', '0')
    .groupBy(['o.account_id', 'asset'])
    .execute();
  for (const r of rows) out.get(r.account_id)![r.asset] = dec(r.total).toString();
  return out;
}

/** An account as the api and the `practice` channel describe it. */
export function accountFrom(
  a: TradingAccountRow,
  available: Record<string, string>,
  reserved: Record<string, string>,
): PracticeAccount {
  const assets = [
    ...new Set([...Object.keys(a.starting_balances), ...Object.keys(available), ...Object.keys(reserved)]),
  ].sort();
  return {
    id: a.id,
    venue: a.venue_id,
    startingBalances: a.starting_balances,
    resetEpoch: a.reset_epoch,
    balances: assets.map((asset) => ({
      asset,
      available: dec(available[asset] ?? '0').toString(),
      reserved: dec(reserved[asset] ?? '0').toString(),
    })),
  };
}

/** The accounts with their balances. */
export async function practiceAccounts(
  db: Kysely<Database>,
  rows: readonly TradingAccountRow[],
): Promise<PracticeAccount[]> {
  const ids = rows.map((r) => r.id);
  const [available, reserved] = await Promise.all([availableBalances(db, ids), reservedBalances(db, ids)]);
  return rows.map((r) => accountFrom(r, available.get(r.id) ?? {}, reserved.get(r.id) ?? {}));
}
