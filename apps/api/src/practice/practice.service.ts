import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Kysely, Selectable } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import {
  channels,
  MAX_OPEN_PRACTICE_ORDERS,
  type PlacePracticeOrderRequest,
  type PracticeAccount,
  type PracticeOrder,
  type PracticeSettings,
  REFUSAL_TEXT,
  type RefusalReason,
  type Venue,
} from '@cip/contracts';
import { PRACTICE_COMMANDS_STREAM, type PracticeCommandType } from '@cip/contracts/practice-commands';
import {
  availableBalances,
  type Database,
  LIVE_ORDER_STATUSES,
  orderFromRow,
  type TradingAccountRow,
} from '@cip/db';
import { dec } from '@cip/domain';
import {
  bestPrice,
  type Book,
  checkOrderRules,
  type Health,
  holdRate,
  type InstrumentRules,
  opposite,
  practiceHealth,
  take,
} from '@cip/paper-engine';
import { type AuditEvent, AuditService } from '../audit/audit.service.js';
import type { AuthenticatedUser } from '../common/access.js';
import { ProblemError } from '../common/problem.js';
import { type BucketSpec, RateLimiter } from '../common/rate-limiter.js';
import { CLOCK, type Clock, DB, REDIS } from '../tokens.js';
import { type OrderRowWithVenue, PracticeRepository } from './practice.repository.js';

/** API contracts §8: 5 orders per second per user. */
export const ORDER_LIMIT: BucketSpec = { capacity: 5, refillPerSecond: 5 };
/** `practice:commands` keeps about this many commands; the broker reads them within seconds. */
const COMMANDS_MAXLEN = '100000';
/** How long a cancel or reset waits for the broker to apply it before answering 202. */
const SETTLE_WAIT_MS = 2_000;
const SETTLE_POLL_MS = 50;

type InstrumentRow = Pick<
  Selectable<Database['market.instruments']>,
  | 'id'
  | 'venue_id'
  | 'base_asset'
  | 'quote_asset'
  | 'underlying_calendar_id'
  | 'role'
  | 'enabled'
  | 'venue_status'
  | 'price_tick'
  | 'qty_step'
  | 'min_notional'
>;

/** Who asked, for the audit log. */
export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isLive = (status: string) => (LIVE_ORDER_STATUSES as readonly string[]).includes(status);

/**
 * Practice orders as a person places them (REQUIREMENTS §11, ADR 021). The api checks an order
 * before accepting it (the pair's data, the venue's rules and the balance), stores it as submitted,
 * or as refused with the reason, and appends a command for the broker, which takes it up and fills
 * it from the live market. Nothing here reaches an exchange.
 */
@Injectable()
export class PracticeService {
  constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly repo: PracticeRepository,
    private readonly audit: AuditService,
    private readonly limiter: RateLimiter,
  ) {}

  /**
   * Places an order and its attached stop and target. Returns the order, and whether it is new; a
   * retried submission (the same `clientOrderId`) returns the order it created the first time.
   * Throws ORDER_REFUSED, with the reason, for an order the checks refuse; it is kept in the
   * history.
   */
  async place(
    user: AuthenticatedUser,
    body: PlacePracticeOrderRequest,
    meta: RequestMeta,
  ): Promise<{ order: PracticeOrder; created: boolean }> {
    const decision = await this.limiter.take(`practice-orders:${user.id}`, ORDER_LIMIT, this.clock());
    if (!decision.allowed)
      throw new ProblemError('RATE_LIMITED', 'At most 5 practice orders per second.', {
        headers: { 'retry-after': String(decision.retryAfterSeconds) },
      });

    const existing = await this.repo.orderByClientId(user.id, body.clientOrderId);
    if (existing) return { order: sameOrder(existing, body), created: false };

    const instrument = await this.db
      .selectFrom('market.instruments')
      .select([
        'id',
        'venue_id',
        'base_asset',
        'quote_asset',
        'underlying_calendar_id',
        'role',
        'enabled',
        'venue_status',
        'price_tick',
        'qty_step',
        'min_notional',
      ])
      .where('id', '=', body.instrumentId)
      .executeTakeFirst();
    if (!instrument) throw new ProblemError('NOT_FOUND', 'Unknown instrument.');
    if (body.setupId) {
      const setup = await this.db
        .selectFrom('analysis.setups')
        .select('instrument_id')
        .where('id', '=', body.setupId)
        .executeTakeFirst();
      if (setup?.instrument_id !== instrument.id)
        throw new ProblemError('VALIDATION_FAILED', 'That setup is not on this pair.', {
          errors: [{ path: 'setupId', message: 'Unknown setup for this pair.' }],
        });
    }

    const account = (await this.repo.accountRows(user.id)).find((a) => a.venue_id === instrument.venue_id);
    if (!account) throw new ProblemError('INTERNAL', 'No practice account for this venue.');
    const settings = await this.repo.settings();
    const now = this.clock();
    const refusal = await this.check(account, instrument, body, settings);
    const underlyingClosed = await this.underlyingClosed(instrument.underlying_calendar_id, now);

    const id = uuidv7();
    const group = body.stop || body.target ? uuidv7() : null;
    const status = refusal ? ('refused' as const) : ('new' as const);
    const base = {
      account_id: account.id,
      instrument_id: instrument.id,
      source: body.setupId ? ('setup' as const) : ('manual' as const),
      setup_id: body.setupId ?? null,
      underlying_closed: underlyingClosed,
      reset_epoch: account.reset_epoch,
      status,
      refusal_reason: refusal?.reason ?? null,
      created_at: new Date(now),
      updated_at: new Date(now),
    };
    const legs = [
      ...(body.stop ? [{ type: 'stop' as const, stop_price: body.stop, limit_price: null }] : []),
      ...(body.target ? [{ type: 'target' as const, stop_price: null, limit_price: body.target }] : []),
    ];
    try {
      await this.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('trading.orders')
          .values({
            ...base,
            id,
            client_order_id: body.clientOrderId,
            side: body.side,
            type: body.type,
            quantity: body.quantity,
            limit_price: body.limitPrice ?? null,
            stop_price: null,
            parent_id: null,
            oco_group: null,
          })
          .execute();
        for (const leg of legs)
          await trx
            .insertInto('trading.orders')
            .values({
              ...base,
              ...leg,
              id: uuidv7(),
              client_order_id: `${body.clientOrderId}:${leg.type}`,
              side: 'sell',
              quantity: body.quantity,
              parent_id: id,
              oco_group: group,
            })
            .execute();
        await this.audit.record(
          event(user, meta, refusal ? 'practice_order.refused' : 'practice_order.placed', id, {
            venue: instrument.venue_id,
            instrumentId: instrument.id,
            side: body.side,
            type: body.type,
            quantity: body.quantity,
            limitPrice: body.limitPrice ?? null,
            stop: body.stop ?? null,
            target: body.target ?? null,
            setupId: body.setupId ?? null,
            ...(refusal ? { reason: refusal.reason, by: 'api' } : {}),
          }),
          trx,
        );
      });
    } catch (err) {
      // A concurrent retry of the same submission won the race: answer with its order.
      if (!isUniqueViolation(err)) throw err;
      const winner = await this.repo.orderByClientId(user.id, body.clientOrderId);
      if (!winner) throw new ProblemError('CONFLICT', 'This clientOrderId is already used.');
      return { order: sameOrder(winner, body), created: false };
    }

    if (refusal) throw refused(refusal.reason, refusal.detail);
    await this.command('place', { orderId: id, user: user.id });
    const row = (await this.repo.order(user.id, id))!;
    return { order: orderFromRow(row, row.venue_id), created: true };
  }

  /**
   * Asks the broker to cancel what is left of an order (an attached stop or target takes its pair
   * with it). Waits briefly for the broker; `settled` is false when it has not applied it yet, and
   * the `practice` channel brings the outcome.
   */
  async cancel(
    user: AuthenticatedUser,
    id: string,
    meta: RequestMeta,
  ): Promise<{ order: PracticeOrder; settled: boolean }> {
    const row = await this.repo.order(user.id, id);
    if (!row) throw new ProblemError('NOT_FOUND', 'No such practice order.');
    if (!isLive(row.status))
      throw new ProblemError(
        'CONFLICT',
        `This order is already ${row.status}; there is nothing left to cancel.`,
      );
    await this.audit.record(event(user, meta, 'practice_order.cancel_requested', id, { status: row.status }));
    await this.command('cancel', { orderId: id, user: user.id });
    const settled = await this.waitFor(async () => {
      const r = await this.repo.order(user.id, id);
      return r && !isLive(r.status) ? r : null;
    });
    const latest = settled ?? (await this.repo.order(user.id, id))!;
    return { order: orderFromRow(latest, latest.venue_id), settled: settled !== null };
  }

  /**
   * Asks the broker to start the account's next period: its open orders are cancelled and its
   * balances start again from the starting balances. Earlier periods' history stays.
   */
  async reset(
    user: AuthenticatedUser,
    venue: Venue,
    meta: RequestMeta,
  ): Promise<{ account: PracticeAccount; settled: boolean }> {
    const before = (await this.repo.accountRows(user.id)).find((a) => a.venue_id === venue);
    if (!before) throw new ProblemError('NOT_FOUND', 'No practice account for this venue.');
    await this.db.transaction().execute(async (trx) => {
      await this.audit.record(
        {
          ...event(user, meta, 'practice_account.reset_requested', before.id, {
            venue,
            resetEpoch: before.reset_epoch,
          }),
          targetType: 'practice_account',
        },
        trx,
      );
    });
    await this.command('reset', { accountId: before.id, user: user.id });
    const settled = await this.waitFor(async () => {
      const r = await this.db
        .selectFrom('trading.accounts')
        .select('reset_epoch')
        .where('id', '=', before.id)
        .executeTakeFirst();
      return r && r.reset_epoch > before.reset_epoch ? r : null;
    });
    return { account: await this.repo.account(user.id, venue), settled: settled !== null };
  }

  /**
   * The checks the broker makes again when it takes the order up (ADR 021), in the same order, so
   * the reason matches: the pair, its live data, the open-order limit, a market to fill against,
   * the venue's rules, and the balance with fees. A stop and target on the wrong side of the price
   * are a mistake in the request, not a refusal.
   */
  private async check(
    account: TradingAccountRow,
    instrument: InstrumentRow,
    body: PlacePracticeOrderRequest,
    settings: PracticeSettings,
  ): Promise<{ reason: RefusalReason; detail: string } | null> {
    const refuse = (reason: RefusalReason, detail: string = REFUSAL_TEXT[reason]) => ({ reason, detail });
    if (instrument.role !== 'monitored') return refuse('not_practice_pair');
    const health = await this.health(instrument);
    if (health !== 'ok') return refuse(health);
    const legs = (body.stop ? 1 : 0) + (body.target ? 1 : 0);
    if ((await this.repo.liveOrderCount(account.id)) + 1 + legs > MAX_OPEN_PRACTICE_ORDERS)
      return refuse('too_many_open_orders');

    const book = body.type === 'market' ? await this.book(instrument.id) : null;
    const reference = body.type === 'limit' ? body.limitPrice! : bestPrice(book, body.side);
    if (reference === null) return refuse('no_market');
    bracket(body, reference);

    const rules: InstrumentRules = {
      instrumentId: instrument.id,
      venue: instrument.venue_id,
      base: instrument.base_asset,
      quote: instrument.quote_asset,
      priceTick: instrument.price_tick,
      qtyStep: instrument.qty_step,
      minNotional: instrument.min_notional,
    };
    const ruleBreak = checkOrderRules(rules, {
      quantity: body.quantity,
      prices: [body.limitPrice ?? null, body.stop ?? null, body.target ?? null],
      referencePrice: reference,
    });
    if (ruleBreak === 'price_step')
      return refuse(ruleBreak, `Prices on this pair go in steps of ${dec(rules.priceTick).toString()}.`);
    if (ruleBreak === 'quantity_step')
      return refuse(ruleBreak, `Quantities on this pair go in steps of ${dec(rules.qtyStep).toString()}.`);
    if (ruleBreak === 'min_value')
      return refuse(
        ruleBreak,
        `The smallest order on this pair is worth ${dec(rules.minNotional).toString()} ${rules.quote}.`,
      );

    const fees = settings.fees[instrument.venue_id];
    const available = (await availableBalances(this.db, [account.id])).get(account.id) ?? {};
    const have = (asset: string) => dec(available[asset] ?? '0');
    const quantity = dec(body.quantity);
    let need = quantity;
    if (body.type === 'market') {
      const taken = take(opposite(book!, body.side), body.side, quantity, null);
      if (taken.filled.lte(0)) return refuse('no_market');
      if (body.side === 'buy') need = taken.value.times(holdRate(fees));
    } else if (body.side === 'buy') need = quantity.times(body.limitPrice!).times(holdRate(fees));
    const asset = body.side === 'buy' ? rules.quote : rules.base;
    if (have(asset).lt(need))
      return refuse(
        'insufficient_balance',
        `The order needs ${need.round(8, 3).toString()} ${asset} with fees; the practice balance has ${have(asset).toString()} ${asset} free.`,
      );
    return null;
  }

  /** The pair's market data as the broker sees it (TRD-07). */
  private async health(instrument: InstrumentRow): Promise<Health> {
    const [raw, gaps] = await Promise.all([
      this.redis.get(`feed:status:${instrument.venue_id}`),
      this.db
        .selectFrom('market.data_gaps')
        .select('stream')
        .where('instrument_id', '=', instrument.id)
        .where('status', 'in', ['open', 'backfilling'])
        .execute(),
    ]);
    let feeds: { stream: string; state: 'connected' | 'degraded' | 'disconnected' }[] = [];
    try {
      const status = raw
        ? (JSON.parse(raw) as {
            feeds?: {
              instrumentId: string;
              stream: string;
              state: 'connected' | 'degraded' | 'disconnected';
            }[];
          })
        : null;
      feeds = (status?.feeds ?? []).filter((f) => f.instrumentId === instrument.id);
    } catch {
      // A malformed status counts as none: the order waits for data.
    }
    return practiceHealth({
      enabled: instrument.enabled,
      venueStatus: instrument.venue_status,
      feeds,
      openGaps: gaps.map((g) => g.stream),
    });
  }

  private async book(instrumentId: string): Promise<Book | null> {
    const raw = await this.redis.get(channels.book(instrumentId));
    if (!raw) return null;
    try {
      const b = JSON.parse(raw) as { ts: number; bids: [string, string][]; asks: [string, string][] };
      return { instrumentId, ts: b.ts, bids: b.bids, asks: b.asks };
    } catch {
      return null;
    }
  }

  /** Whether the underlying market (gold, for PAXG) is closed now. */
  private async underlyingClosed(calendarId: string | null, now: number): Promise<boolean> {
    if (!calendarId) return false;
    const row = await this.db
      .selectFrom('market.underlying_market_closures')
      .select('calendar_id')
      .where('calendar_id', '=', calendarId)
      .where('starts_at', '<=', new Date(now))
      .where('ends_at', '>', new Date(now))
      .executeTakeFirst();
    return row !== undefined;
  }

  private async command(type: PracticeCommandType, fields: Record<string, string>): Promise<void> {
    const args = Object.entries(fields).flat();
    await this.redis.xadd(
      PRACTICE_COMMANDS_STREAM,
      'MAXLEN',
      '~',
      COMMANDS_MAXLEN,
      '*',
      'type',
      type,
      ...args,
    );
  }

  private async waitFor<T>(check: () => Promise<T | null>): Promise<T | null> {
    const end = Date.now() + SETTLE_WAIT_MS;
    for (;;) {
      const got = await check();
      if (got !== null || Date.now() >= end) return got;
      await sleep(SETTLE_POLL_MS);
    }
  }
}

function event(
  user: AuthenticatedUser,
  meta: RequestMeta,
  action: string,
  targetId: string,
  details: Record<string, unknown>,
): AuditEvent {
  return {
    actorType: 'user',
    actorUserId: user.id,
    action,
    targetType: 'practice_order',
    targetId,
    ip: meta.ip,
    userAgent: meta.userAgent,
    details,
  };
}

function refused(reason: RefusalReason, detail: string): ProblemError {
  return new ProblemError('ORDER_REFUSED', detail, { reason });
}

/**
 * A retried submission must describe the same order: the same key for a different order is a
 * client mistake. A refused order is refused again, with its reason.
 */
function sameOrder(row: OrderRowWithVenue, body: PlacePracticeOrderRequest): PracticeOrder {
  const same =
    row.instrument_id === body.instrumentId &&
    row.side === body.side &&
    row.type === body.type &&
    dec(row.quantity).eq(body.quantity) &&
    (row.limit_price === null
      ? body.limitPrice === undefined
      : body.limitPrice !== undefined && dec(row.limit_price).eq(body.limitPrice));
  if (!same) throw new ProblemError('CONFLICT', 'This clientOrderId was used for a different order.');
  if (row.status === 'refused') {
    const reason = row.refusal_reason as RefusalReason;
    throw refused(reason, REFUSAL_TEXT[reason]);
  }
  return orderFromRow(row, row.venue_id);
}

/** For a buy: the stop below the price it buys at, and the target above it. */
function bracket(body: PlacePracticeOrderRequest, reference: string): void {
  const errors: { path: string; message: string }[] = [];
  const price = dec(reference);
  if (body.stop !== undefined && dec(body.stop).gte(price))
    errors.push({ path: 'stop', message: `The stop must be below the buying price (${price.toString()}).` });
  if (body.target !== undefined && dec(body.target).lte(price))
    errors.push({
      path: 'target',
      message: `The target must be above the buying price (${price.toString()}).`,
    });
  if (errors.length)
    throw new ProblemError('VALIDATION_FAILED', 'The stop and target must be on either side of the price.', {
      errors,
    });
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}
