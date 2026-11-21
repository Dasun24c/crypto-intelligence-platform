import { Inject, Injectable } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import {
  type Chain,
  type CreateExchangeLabel,
  EXCHANGE_FLOW_MAX_TRADES,
  type ExchangeFlow,
  type ExchangeFlowInstrument,
  type ExchangeLabel,
  ONCHAIN_ASSETS,
  type OnchainAssetSummary,
  type OnchainPage,
  type OnchainQuery,
} from '@cip/contracts';
import {
  type Database,
  exchangeLabelFromRow,
  exchangeLabelRows,
  type OnchainLabelRow,
  onchainEventFromRow,
} from '@cip/db';
import { decodeCursor, encodeCursor } from '../market/market.repository.js';
import { DB } from '../tokens.js';

export interface Window {
  from: number;
  to: number;
}

/** Walls listed at most (standing ones first). */
const MAX_WALLS = 500;

/** The Whale Tracker's reads (Phase 11, ADR 025): exchange flow and on-chain, never mixed. */
@Injectable()
export class WhalesRepository {
  constructor(@Inject(DB) private readonly db: Kysely<Database>) {}

  // ── Exchange flow ───────────────────────────────────────────────────────────────────────────

  /**
   * Large trades in [from, to), and walls first seen in it or standing now (the semantics of
   * `GET /market/{id}/walls`), per instrument and listed (criterion 11.1).
   */
  async exchangeFlow(w: Window, instrumentId?: string): Promise<ExchangeFlow> {
    const from = new Date(w.from);
    const to = new Date(w.to);
    let trades = this.db
      .selectFrom('market.large_trades')
      .select([
        'instrument_id',
        sql<string>`count(*)`.as('n'),
        sql<string>`count(*) filter (where taker_side = 'buy')`.as('buys'),
        sql<string>`count(*) filter (where taker_side = 'sell')`.as('sells'),
        sql<string>`coalesce(sum(notional_usd) filter (where taker_side = 'buy'), 0)`.as('bought'),
        sql<string>`coalesce(sum(notional_usd) filter (where taker_side = 'sell'), 0)`.as('sold'),
        sql<string>`coalesce(sum(case when taker_side = 'buy' then notional_usd else -notional_usd end), 0)`.as(
          'net',
        ),
        sql<string | null>`max(notional_usd)`.as('largest'),
      ])
      .where('ts', '>=', from)
      .where('ts', '<', to)
      .groupBy('instrument_id');
    if (instrumentId) trades = trades.where('instrument_id', '=', instrumentId);

    const inWindow = sql<boolean>`first_seen >= ${from} and first_seen < ${to}`;
    let walls = this.db
      .selectFrom('market.orderbook_walls')
      .select([
        'instrument_id',
        sql<string>`count(*) filter (where ${inWindow})`.as('appeared'),
        sql<string>`count(*) filter (where ${inWindow} and ended_reason = 'filled')`.as('filled'),
        sql<string>`count(*) filter (where ${inWindow} and ended_reason = 'pulled')`.as('pulled'),
        sql<string>`count(*) filter (where ended_reason is null)`.as('standing'),
      ])
      .where((eb) =>
        eb.or([
          eb('ended_reason', 'is', null),
          eb.and([eb('first_seen', '>=', from), eb('first_seen', '<', to)]),
        ]),
      )
      .groupBy('instrument_id');
    if (instrumentId) walls = walls.where('instrument_id', '=', instrumentId);

    let list = this.db
      .selectFrom('market.large_trades')
      .selectAll()
      .where('ts', '>=', from)
      .where('ts', '<', to)
      .orderBy('ts', 'desc')
      .orderBy('id', 'desc')
      .limit(EXCHANGE_FLOW_MAX_TRADES);
    if (instrumentId) list = list.where('instrument_id', '=', instrumentId);

    let wallList = this.db
      .selectFrom('market.orderbook_walls')
      .selectAll()
      .where((eb) =>
        eb.or([
          eb('ended_reason', 'is', null),
          eb.and([eb('first_seen', '>=', from), eb('first_seen', '<', to)]),
        ]),
      )
      // Standing walls first, then the rest; newest first within each.
      .orderBy(sql`ended_reason is null`, 'desc')
      .orderBy('first_seen', 'desc')
      .orderBy('id', 'desc')
      .limit(MAX_WALLS);
    if (instrumentId) wallList = wallList.where('instrument_id', '=', instrumentId);

    const [tradeRows, wallRows, tradeItems, wallItems] = await Promise.all([
      trades.execute(),
      walls.execute(),
      list.execute(),
      wallList.execute(),
    ]);

    const byInstrument = new Map<string, ExchangeFlowInstrument>();
    const entry = (id: string): ExchangeFlowInstrument => {
      let e = byInstrument.get(id);
      if (!e) {
        e = {
          instrumentId: id,
          largeTrades: 0,
          buys: 0,
          sells: 0,
          boughtUsd: '0',
          soldUsd: '0',
          netUsd: '0',
          largestUsd: null,
          wallsAppeared: 0,
          wallsFilled: 0,
          wallsPulled: 0,
          wallsStanding: 0,
        };
        byInstrument.set(id, e);
      }
      return e;
    };
    for (const r of tradeRows) {
      Object.assign(entry(r.instrument_id), {
        largeTrades: Number(r.n),
        buys: Number(r.buys),
        sells: Number(r.sells),
        boughtUsd: r.bought,
        soldUsd: r.sold,
        netUsd: r.net,
        largestUsd: r.largest,
      });
    }
    for (const r of wallRows) {
      Object.assign(entry(r.instrument_id), {
        wallsAppeared: Number(r.appeared),
        wallsFilled: Number(r.filled),
        wallsPulled: Number(r.pulled),
        wallsStanding: Number(r.standing),
      });
    }
    const usd = (e: ExchangeFlowInstrument) => Number(e.boughtUsd) + Number(e.soldUsd);
    const instruments = [...byInstrument.values()].sort(
      (a, b) =>
        usd(b) - usd(a) ||
        b.wallsAppeared + b.wallsStanding - (a.wallsAppeared + a.wallsStanding) ||
        a.instrumentId.localeCompare(b.instrumentId),
    );

    return {
      from: w.from,
      to: w.to,
      instruments,
      largeTrades: tradeItems.map((r) => ({
        id: r.id,
        instrumentId: r.instrument_id,
        ts: r.ts.getTime(),
        takerSide: r.taker_side,
        avgPrice: r.avg_price,
        qty: r.qty,
        notionalUsd: r.notional_usd,
        grouping: r.grouping,
        fillCount: r.fill_count,
        priceLevels: r.price_levels,
        thresholdUsd: r.threshold_usd,
      })),
      largeTradesTotal: instruments.reduce((n, e) => n + e.largeTrades, 0),
      walls: wallItems.map((r) => ({
        id: r.id,
        instrumentId: r.instrument_id,
        side: r.side,
        price: r.price,
        firstSeen: r.first_seen.getTime(),
        lastSeen: r.last_seen.getTime(),
        maxNotionalUsd: r.max_notional_usd,
        endedReason: r.ended_reason,
      })),
    };
  }

  // ── On-chain ────────────────────────────────────────────────────────────────────────────────

  /** Events in [from, to), newest first, with the listed owners of their addresses. */
  async onchain(q: OnchainQuery, w: Window): Promise<OnchainPage> {
    const from = new Date(w.from);
    const to = new Date(w.to);
    let query = this.db
      .selectFrom('onchain.events as e')
      .leftJoin('onchain.labels as fl', (j) =>
        j.onRef('fl.chain', '=', 'e.chain').onRef('fl.address', '=', 'e.from_address'),
      )
      .leftJoin('onchain.labels as tl', (j) =>
        j.onRef('tl.chain', '=', 'e.chain').onRef('tl.address', '=', 'e.to_address'),
      )
      .selectAll('e')
      .select(['fl.owner as from_owner', 'tl.owner as to_owner'])
      .where('e.block_time', '>=', from)
      .where('e.block_time', '<', to);
    if (q.asset) query = query.where('e.asset', '=', q.asset);
    if (q.kind) query = query.where('e.kind', '=', q.kind);
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      query = query.where((eb) =>
        eb.or([
          eb('e.block_time', '<', c.ts),
          eb.and([eb('e.block_time', '=', c.ts), eb('e.id', '<', c.id)]),
        ]),
      );
    }
    const rows = await query
      .orderBy('e.block_time', 'desc')
      .orderBy('e.id', 'desc')
      .limit(q.limit + 1)
      .execute();
    const items = rows.slice(0, q.limit);
    const last = items.at(-1);
    return {
      from: w.from,
      to: w.to,
      items: items.map((r) => onchainEventFromRow(r)),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.block_time, last.id) : null,
      summary: await this.onchainSummary(w),
    };
  }

  /** Every asset's events in the window; exchange flows from the listed addresses. */
  async onchainSummary(w: Window): Promise<OnchainAssetSummary[]> {
    const rows = await this.db
      .selectFrom('onchain.events as e')
      .leftJoin('onchain.labels as fl', (j) =>
        j.onRef('fl.chain', '=', 'e.chain').onRef('fl.address', '=', 'e.from_address'),
      )
      .leftJoin('onchain.labels as tl', (j) =>
        j.onRef('tl.chain', '=', 'e.chain').onRef('tl.address', '=', 'e.to_address'),
      )
      .select([
        'e.asset',
        sql<string>`count(*) filter (where e.kind = 'transfer')`.as('transfers'),
        sql<string>`coalesce(sum(e.usd_value) filter (where e.kind = 'transfer'), 0)`.as('transfer_usd'),
        sql<string>`coalesce(sum(e.usd_value) filter (where e.kind = 'transfer' and tl.owner is not null and fl.owner is null), 0)`.as(
          'to_exchange_usd',
        ),
        sql<string>`coalesce(sum(e.usd_value) filter (where e.kind = 'transfer' and fl.owner is not null and tl.owner is null), 0)`.as(
          'from_exchange_usd',
        ),
        sql<string>`coalesce(sum(e.amount) filter (where e.kind = 'mint'), 0)`.as('minted'),
        sql<string>`coalesce(sum(e.amount) filter (where e.kind = 'burn'), 0)`.as('burned'),
        sql<string>`count(*) filter (where e.kind = 'mint')`.as('mints'),
        sql<string>`count(*) filter (where e.kind = 'burn')`.as('burns'),
      ])
      .where('e.block_time', '>=', new Date(w.from))
      .where('e.block_time', '<', new Date(w.to))
      .groupBy('e.asset')
      .execute();
    const byAsset = new Map(rows.map((r) => [r.asset, r]));
    return ONCHAIN_ASSETS.map((asset) => {
      const r = byAsset.get(asset);
      return {
        asset,
        transfers: Number(r?.transfers ?? 0),
        transferUsd: r?.transfer_usd ?? '0',
        toExchangeUsd: r?.to_exchange_usd ?? '0',
        fromExchangeUsd: r?.from_exchange_usd ?? '0',
        minted: r?.minted ?? '0',
        burned: r?.burned ?? '0',
        mints: Number(r?.mints ?? 0),
        burns: Number(r?.burns ?? 0),
      };
    });
  }

  // ── Exchange labels ─────────────────────────────────────────────────────────────────────────

  async labels(chain?: Chain): Promise<ExchangeLabel[]> {
    return (await exchangeLabelRows(this.db, chain)).map(exchangeLabelFromRow);
  }

  async label(id: string): Promise<OnchainLabelRow | undefined> {
    return this.db.selectFrom('onchain.labels').selectAll().where('id', '=', id).executeTakeFirst();
  }

  /** null when the chain already lists that address. */
  async createLabel(
    db: Kysely<Database>,
    body: CreateExchangeLabel,
    userId: string,
  ): Promise<OnchainLabelRow | null> {
    const row = await db
      .insertInto('onchain.labels')
      .values({
        id: uuidv7(),
        chain: body.chain,
        address: body.address,
        owner: body.owner,
        wallet: body.wallet,
        source: body.source,
        created_by: userId,
      })
      .onConflict((oc) => oc.columns(['chain', 'address']).doNothing())
      .returningAll()
      .executeTakeFirst();
    return row ?? null;
  }

  async deleteLabel(db: Kysely<Database>, id: string): Promise<boolean> {
    const r = await db.deleteFrom('onchain.labels').where('id', '=', id).executeTakeFirst();
    return Number(r.numDeletedRows) > 0;
  }
}
