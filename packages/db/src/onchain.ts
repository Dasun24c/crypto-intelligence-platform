import type { Kysely } from 'kysely';
import {
  type Chain,
  type ExchangeLabel,
  flowOf,
  type OnchainEvent,
  type OnchainEventKind,
  type OnchainAsset,
} from '@cip/contracts';
import type { Database, NewOnchainEvent, OnchainEventRow, OnchainLabelRow } from './types.js';

/** A large transfer, mint or burn as a watcher detected it, before it is stored. */
export interface DetectedOnchainEvent {
  chain: Chain;
  asset: OnchainAsset;
  kind: OnchainEventKind;
  txHash: string;
  position: number;
  blockNumber: number;
  blockTime: number;
  from: string | null;
  to: string | null;
  /** In the asset's units, as a decimal string. */
  amount: string;
  priceUsd: string | null;
  usdValue: string | null;
  provider: string;
  details?: Record<string, unknown>;
}

/**
 * Stores detected events; one already stored (the same chain, transaction and position) is left as
 * it is. Returns the events that were new, so only they are announced.
 */
export async function insertOnchainEvents(
  db: Kysely<Database>,
  events: readonly (DetectedOnchainEvent & { id: string; receivedAt: number })[],
): Promise<string[]> {
  if (events.length === 0) return [];
  const rows: NewOnchainEvent[] = events.map((e) => ({
    id: e.id,
    chain: e.chain,
    asset: e.asset,
    kind: e.kind,
    tx_hash: e.txHash,
    position: e.position,
    block_number: e.blockNumber,
    block_time: new Date(e.blockTime),
    from_address: e.from,
    to_address: e.to,
    amount: e.amount,
    price_usd: e.priceUsd,
    usd_value: e.usdValue,
    provider: e.provider,
    details: e.details ?? {},
    received_at: new Date(e.receivedAt),
  }));
  const inserted = await db
    .insertInto('onchain.events')
    .values(rows)
    .onConflict((oc) => oc.columns(['chain', 'tx_hash', 'asset', 'position']).doNothing())
    .returning('id')
    .execute();
  return inserted.map((r) => r.id);
}

/** Removes the events of a transaction whose block was replaced (an Ethereum reorg). */
export async function deleteOnchainEvents(
  db: Kysely<Database>,
  chain: Chain,
  txHash: string,
  position?: number,
): Promise<number> {
  let q = db.deleteFrom('onchain.events').where('chain', '=', chain).where('tx_hash', '=', txHash);
  if (position !== undefined) q = q.where('position', '=', position);
  const r = await q.executeTakeFirst();
  return Number(r.numDeletedRows);
}

/** The last block (or slot) a chain's watcher finished, or null before its first. */
export async function onchainCursor(db: Kysely<Database>, chain: Chain): Promise<number | null> {
  const row = await db
    .selectFrom('onchain.cursors')
    .select('block_number')
    .where('chain', '=', chain)
    .executeTakeFirst();
  return row ? Number(row.block_number) : null;
}

/** Moves a chain's cursor forward (never back). */
export async function advanceOnchainCursor(
  db: Kysely<Database>,
  chain: Chain,
  blockNumber: number,
): Promise<void> {
  await db
    .insertInto('onchain.cursors')
    .values({ chain, block_number: blockNumber })
    .onConflict((oc) =>
      oc.column('chain').doUpdateSet((eb) => ({
        block_number: eb.fn('greatest', ['onchain.cursors.block_number', eb.ref('excluded.block_number')]),
        updated_at: new Date(),
      })),
    )
    .execute();
}

/** Every listed exchange address, or one chain's. */
export async function exchangeLabelRows(db: Kysely<Database>, chain?: Chain): Promise<OnchainLabelRow[]> {
  let q = db.selectFrom('onchain.labels').selectAll().orderBy('owner').orderBy('chain').orderBy('address');
  if (chain) q = q.where('chain', '=', chain);
  return q.execute();
}

export function exchangeLabelFromRow(r: OnchainLabelRow): ExchangeLabel {
  return {
    id: r.id,
    chain: r.chain,
    address: r.address,
    owner: r.owner,
    wallet: r.wallet,
    source: r.source,
    createdAt: r.created_at.getTime(),
    updatedAt: r.updated_at.getTime(),
  };
}

/** A stored event in its API form; the owners come from the labels joined at read time. */
export function onchainEventFromRow(
  r: OnchainEventRow & { from_owner: string | null; to_owner: string | null },
): OnchainEvent {
  return {
    id: r.id,
    chain: r.chain,
    asset: r.asset,
    kind: r.kind,
    txHash: r.tx_hash,
    position: r.position,
    blockNumber: Number(r.block_number),
    blockTime: r.block_time.getTime(),
    from: r.from_address,
    to: r.to_address,
    fromOwner: r.from_owner,
    toOwner: r.to_owner,
    flow: r.kind === 'transfer' ? flowOf(r.from_owner, r.to_owner) : 'other',
    amount: r.amount,
    usdValue: r.usd_value,
    provider: r.provider,
    receivedAt: r.received_at.getTime(),
  };
}
