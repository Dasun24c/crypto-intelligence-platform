import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import {
  channels,
  DEFAULT_PRACTICE_SETTINGS,
  type Page,
  type PracticeAccount,
  type PracticeFill,
  type PracticeOrder,
  type PracticePosition,
  type PracticeSettings,
  PracticeSettingsSchema,
  type Venue,
  VENUES,
} from '@cip/contracts';
import {
  type Database,
  fillFromRow,
  LIVE_ORDER_STATUSES,
  orderFromRow,
  practiceAccounts,
  type TradingAccountRow,
  type TradingOrderRow,
} from '@cip/db';
import { dec, type Decimal } from '@cip/domain';
import { ProblemError } from '../common/problem.js';
import type { Executor } from '../users/users.repository.js';
import { decodeCursor, encodeCursor } from '../market/market.repository.js';
import { DB, REDIS } from '../tokens.js';

/** The `app.settings` key of the practice settings (the broker reads the same). */
export const PRACTICE_SETTINGS_KEY = 'practice';
const DONE_STATUSES = ['filled', 'cancelled', 'refused'] as const;

export type OrderRowWithVenue = TradingOrderRow & { venue_id: Venue };

const byVenue = (a: { venue_id: string }, b: { venue_id: string }) =>
  VENUES.indexOf(a.venue_id as Venue) - VENUES.indexOf(b.venue_id as Venue);

/**
 * The `trading` schema as the api reads and writes it (data model §10, ADR 021): accounts opened on
 * first use, orders as submitted, and the history the broker writes. Every query is scoped to the
 * signed-in user: nobody reads another user's account (TRD-08).
 */
@Injectable()
export class PracticeRepository {
  constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Fees and starting balances: an admin's, or the defaults (ADR 021). */
  async settings(): Promise<PracticeSettings> {
    const row = await this.db
      .selectFrom('app.settings')
      .select('value')
      .where('key', '=', PRACTICE_SETTINGS_KEY)
      .executeTakeFirst();
    const parsed = row ? PracticeSettingsSchema.safeParse(row.value) : null;
    return parsed?.success ? parsed.data : DEFAULT_PRACTICE_SETTINGS;
  }

  async saveSettings(ex: Executor, value: PracticeSettings, userId: string, now: Date): Promise<void> {
    await ex
      .insertInto('app.settings')
      .values({ key: PRACTICE_SETTINGS_KEY, value, updated_by: userId, updated_at: now })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value, updated_by: userId, updated_at: now }))
      .execute();
  }

  /**
   * The user's account on each venue, opened with the starting balances the first time they are
   * needed (TRD-01). Opening is idempotent: a concurrent request opens nothing twice.
   */
  async accountRows(userId: string): Promise<TradingAccountRow[]> {
    const rows = await this.db
      .selectFrom('trading.accounts')
      .selectAll()
      .where('user_id', '=', userId)
      .execute();
    const missing = VENUES.filter((v) => !rows.some((r) => r.venue_id === v));
    if (!missing.length) return rows.sort(byVenue);
    const settings = await this.settings();
    await this.db.transaction().execute(async (trx) => {
      for (const venue of missing) {
        const starting = settings.startingBalances[venue] ?? {};
        const opened = await trx
          .insertInto('trading.accounts')
          .values({ id: uuidv7(), user_id: userId, venue_id: venue, starting_balances: starting })
          .onConflict((oc) => oc.columns(['user_id', 'venue_id']).doNothing())
          .returning('id')
          .executeTakeFirst();
        if (!opened) continue;
        for (const [asset, amount] of Object.entries(starting))
          await trx
            .insertInto('trading.ledger')
            .values({
              account_id: opened.id,
              reset_epoch: 0,
              asset,
              amount,
              reason: 'start',
              order_id: null,
              fill_id: null,
            })
            .execute();
      }
    });
    return (
      await this.db.selectFrom('trading.accounts').selectAll().where('user_id', '=', userId).execute()
    ).sort(byVenue);
  }

  async accounts(userId: string): Promise<PracticeAccount[]> {
    return practiceAccounts(this.db, await this.accountRows(userId));
  }

  async account(userId: string, venue: Venue): Promise<PracticeAccount> {
    const rows = (await this.accountRows(userId)).filter((r) => r.venue_id === venue);
    const [account] = await practiceAccounts(this.db, rows);
    return account!;
  }

  private ordersOf(userId: string) {
    return this.db
      .selectFrom('trading.orders as o')
      .innerJoin('trading.accounts as a', 'a.id', 'o.account_id')
      .selectAll('o')
      .select('a.venue_id')
      .where('a.user_id', '=', userId);
  }

  /** One of the user's orders; undefined for anyone else's. */
  order(userId: string, id: string): Promise<OrderRowWithVenue | undefined> {
    return this.ordersOf(userId).where('o.id', '=', id).executeTakeFirst();
  }

  async orderOrThrow(userId: string, id: string): Promise<PracticeOrder> {
    const row = await this.order(userId, id);
    if (!row) throw new ProblemError('NOT_FOUND', 'No such practice order.');
    return orderFromRow(row, row.venue_id);
  }

  /** The user's buy or sell with that idempotency key (not an attached stop or target). */
  orderByClientId(userId: string, clientOrderId: string): Promise<OrderRowWithVenue | undefined> {
    return this.ordersOf(userId)
      .where('o.client_order_id', '=', clientOrderId)
      .where('o.parent_id', 'is', null)
      .executeTakeFirst();
  }

  /** An order's attached stop and target. */
  legs(userId: string, parentId: string): Promise<OrderRowWithVenue[]> {
    return this.ordersOf(userId).where('o.parent_id', '=', parentId).orderBy('o.type').execute();
  }

  async orders(
    userId: string,
    q: { cursor?: string; limit: number; status: 'open' | 'done' | 'all'; instrumentId?: string },
  ): Promise<Page<PracticeOrder>> {
    let query = this.ordersOf(userId);
    if (q.status === 'open') query = query.where('o.status', 'in', [...LIVE_ORDER_STATUSES]);
    if (q.status === 'done') query = query.where('o.status', 'in', [...DONE_STATUSES]);
    if (q.instrumentId) query = query.where('o.instrument_id', '=', q.instrumentId);
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      query = query.where((eb) =>
        eb.or([
          eb('o.created_at', '<', c.ts),
          eb.and([eb('o.created_at', '=', c.ts), eb('o.id', '<', c.id)]),
        ]),
      );
    }
    const rows = await query
      .orderBy('o.created_at', 'desc')
      .orderBy('o.id', 'desc')
      .limit(q.limit + 1)
      .execute();
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => orderFromRow(r, r.venue_id)),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  /** Every order that may still change, oldest first (the `practice` channel's snapshot). */
  async openOrders(userId: string): Promise<PracticeOrder[]> {
    const rows = await this.ordersOf(userId)
      .where('o.status', 'in', [...LIVE_ORDER_STATUSES])
      .orderBy('o.created_at')
      .orderBy('o.id')
      .execute();
    return rows.map((r) => orderFromRow(r, r.venue_id));
  }

  /** Live orders on the account, attached stops and targets included (the 200-order limit). */
  async liveOrderCount(accountId: string): Promise<number> {
    const row = await this.db
      .selectFrom('trading.orders')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('account_id', '=', accountId)
      .where('status', 'in', [...LIVE_ORDER_STATUSES])
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async fills(
    userId: string,
    q: { cursor?: string; limit: number; orderId?: string },
  ): Promise<Page<PracticeFill>> {
    let query = this.db
      .selectFrom('trading.fills as f')
      .innerJoin('trading.accounts as a', 'a.id', 'f.account_id')
      .selectAll('f')
      .select('a.venue_id')
      .where('a.user_id', '=', userId);
    if (q.orderId) query = query.where('f.order_id', '=', q.orderId);
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      query = query.where((eb) =>
        eb.or([eb('f.filled_at', '<', c.ts), eb.and([eb('f.filled_at', '=', c.ts), eb('f.id', '<', c.id)])]),
      );
    }
    const rows = await query
      .orderBy('f.filled_at', 'desc')
      .orderBy('f.id', 'desc')
      .limit(q.limit + 1)
      .execute();
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => fillFromRow(r, r.venue_id)),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.filled_at, last.id) : null,
    };
  }

  /**
   * What the user holds in the current period of each account, with profit and loss (TRD-04), by
   * average cost: a buy adds its cost and fee to what is held; a sell realises its proceeds, less its
   * fee and the average cost of what it sold. Unrealised profit values what is still held at the
   * instrument's last price, against what it cost with fees; the fee of selling it is not counted
   * until it is sold. Pairs sold out in the period stay listed with their realised result.
   */
  async positions(userId: string): Promise<PracticePosition[]> {
    await this.accountRows(userId);
    const fills = await this.db
      .selectFrom('trading.fills as f')
      .innerJoin('trading.accounts as a', (j) =>
        j.onRef('a.id', '=', 'f.account_id').onRef('a.reset_epoch', '=', 'f.reset_epoch'),
      )
      .innerJoin('market.instruments as i', 'i.id', 'f.instrument_id')
      .select([
        'f.instrument_id',
        'f.side',
        'f.price',
        'f.quantity',
        'f.fee',
        'f.filled_at',
        'a.venue_id',
        'i.base_asset',
      ])
      .where('a.user_id', '=', userId)
      .orderBy('f.filled_at')
      .orderBy('f.id')
      .execute();
    // Within the same millisecond, buys before sells: a sell never runs ahead of what it sells.
    fills.sort(
      (x, y) =>
        x.filled_at.getTime() - y.filled_at.getTime() || (x.side === y.side ? 0 : x.side === 'buy' ? -1 : 1),
    );

    interface Holding {
      venue: Venue;
      instrumentId: string;
      asset: string;
      quantity: Decimal;
      cost: Decimal;
      realised: Decimal;
      fees: Decimal;
    }
    const holdings = new Map<string, Holding>();
    for (const f of fills) {
      let h = holdings.get(f.instrument_id);
      if (!h) {
        h = {
          venue: f.venue_id,
          instrumentId: f.instrument_id,
          asset: f.base_asset,
          quantity: dec(0),
          cost: dec(0),
          realised: dec(0),
          fees: dec(0),
        };
        holdings.set(f.instrument_id, h);
      }
      const q = dec(f.quantity);
      const value = q.times(f.price);
      const fee = dec(f.fee);
      h.fees = h.fees.plus(fee);
      if (f.side === 'buy') {
        h.quantity = h.quantity.plus(q);
        h.cost = h.cost.plus(value).plus(fee);
        continue;
      }
      const sold = q.gt(h.quantity) ? h.quantity : q;
      const soldCost = h.quantity.gt(0) ? h.cost.times(sold).div(h.quantity) : dec(0);
      h.realised = h.realised.plus(value).minus(fee).minus(soldCost);
      h.cost = h.cost.minus(soldCost);
      h.quantity = h.quantity.minus(sold);
      if (h.quantity.eq(0)) h.cost = dec(0);
    }

    const list = [...holdings.values()];
    const tickers = list.length
      ? await this.redis.mget(...list.map((h) => channels.ticker(h.instrumentId)))
      : [];
    return list.map((h, i): PracticePosition => {
      const last = lastPrice(tickers[i] ?? null);
      const value = last === null ? null : h.quantity.times(last);
      return {
        venue: h.venue,
        instrumentId: h.instrumentId,
        asset: h.asset,
        quantity: h.quantity.toString(),
        averageCost: h.quantity.gt(0) ? h.cost.div(h.quantity).round(12).toString() : '0',
        lastPrice: last,
        marketValue: value === null ? null : value.round(12).toString(),
        unrealisedPnl: value === null ? null : value.minus(h.cost).round(12).toString(),
        realisedPnl: h.realised.round(12).toString(),
        fees: h.fees.toString(),
      };
    });
  }
}

/** The last trade price from a `ticker:{id}` value, or null when there is none. */
function lastPrice(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as { last?: unknown };
    return typeof t.last === 'string' ? dec(t.last).toString() : null;
  } catch {
    return null;
  }
}
