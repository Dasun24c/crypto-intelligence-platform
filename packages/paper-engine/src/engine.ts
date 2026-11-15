import { type FillFlag, MAX_OPEN_PRACTICE_ORDERS, type RefusalReason } from '@cip/contracts';
import { dec, type Decimal } from '@cip/domain';
import { bestPrice, isThin, opposite, type Part, take } from './book.js';
import { checkOrderRules, compareStreamIds } from './rules.js';
import type {
  Book,
  EngineAccount,
  EngineFill,
  EngineOptions,
  EngineOrder,
  FeeRates,
  Health,
  InstrumentRules,
  LedgerEntry,
  NewOrder,
  Outputs,
  Trade,
} from './types.js';

const LIVE = new Set(['new', 'pending', 'open', 'partially_filled']);

interface AccountState {
  id: string;
  venue: string;
  epoch: number;
  available: Map<string, Decimal>;
  starting: Record<string, string> | null;
}

/** Collects what one input changed; each order once, as it ends up. */
class Changes {
  readonly orders = new Map<string, EngineOrder>();
  readonly fills: EngineFill[] = [];
  readonly ledger: LedgerEntry[] = [];
  touch(order: EngineOrder): void {
    this.orders.set(order.id, order);
  }
  outputs(): Outputs {
    return {
      orders: [...this.orders.values()].map((o) => ({ ...o })),
      fills: this.fills,
      ledger: this.ledger,
    };
  }
}

/** What a buy holds per unit of value: 1 plus the higher of the maker and taker fees. */
export function holdRate(fees: FeeRates): Decimal {
  const maker = dec(fees.maker);
  const taker = dec(fees.taker);
  return dec(1).plus(maker.gt(taker) ? maker : taker);
}

/**
 * The practice-trading engine (ADR 021): a deterministic reducer over order commands and market
 * data. It holds the practice accounts' available balances and the live orders, and turns each
 * input into order changes, fills and ledger entries. It does no I/O: the broker service feeds it
 * and stores what it returns, and a replay of the same inputs gives the same outputs.
 *
 * Fills, conservatively:
 * - a market order walks the book; a limit order that can trade at once takes from the book up to its limit;
 * - a resting limit order fills only when a trade prints through its price (strictly better), at its
 *   price, up to the traded quantity;
 * - a stop triggers on a trade at or through its price, then walks the book like a market order;
 * - a target is a resting sell limit. A stop and a target cancel each other: when one fills, even in part.
 *
 * Amounts are exact decimals, so balances never drift; a buy holds its limit value plus the higher
 * fee, so a fill never takes more than was held.
 */
export class PaperEngine {
  private readonly accounts = new Map<string, AccountState>();
  private readonly live = new Map<string, EngineOrder>();
  private seq = 0;

  constructor(private readonly opts: EngineOptions) {}

  /** Loads accounts and their live orders (on start, or when the broker meets an account). */
  load(accounts: readonly EngineAccount[], orders: readonly EngineOrder[] = []): void {
    for (const a of accounts) {
      this.accounts.set(a.id, {
        id: a.id,
        venue: a.venue,
        epoch: a.epoch,
        available: new Map(Object.entries(a.available).map(([asset, v]) => [asset, dec(v)])),
        starting: a.starting ? { ...a.starting } : null,
      });
    }
    for (const o of orders) {
      if (!LIVE.has(o.status)) continue;
      this.live.set(o.id, { ...o });
      this.seq = Math.max(this.seq, o.seq);
    }
  }

  hasAccount(id: string): boolean {
    return this.accounts.has(id);
  }

  account(id: string): EngineAccount {
    const a = this.mustAccount(id);
    return {
      id: a.id,
      venue: a.venue,
      epoch: a.epoch,
      available: Object.fromEntries([...a.available].map(([asset, v]) => [asset, v.toString()])),
      ...(a.starting ? { starting: { ...a.starting } } : {}),
    };
  }

  /** The pair's order rules, as the engine reads them. */
  rulesOf(instrumentId: string): InstrumentRules | undefined {
    return this.opts.rules(instrumentId);
  }

  /** The venue's fees, as the engine reads them. */
  feesOf(venue: string): FeeRates {
    return this.opts.fees(venue);
  }

  /** Whether the order is live: taken up and not finished. */
  isLive(orderId: string): boolean {
    return this.live.has(orderId);
  }

  liveOrders(): EngineOrder[] {
    return [...this.live.values()].map((o) => ({ ...o })).sort((a, b) => a.seq - b.seq);
  }

  /** Whether a trade on the instrument may need the book: a live stop could trigger. */
  needsBook(instrumentId: string): boolean {
    for (const o of this.live.values())
      if (o.instrumentId === instrumentId && o.type === 'stop' && o.status === 'open') return true;
    return false;
  }

  /** Takes up an order the api accepted, with its attached stop and target. */
  place(o: NewOrder, ctx: { now: number; health: Health; book: Book | null; lastTrade: string }): Outputs {
    const ch = new Changes();
    const account = this.mustAccount(o.accountId);
    const order: EngineOrder = {
      id: o.id,
      accountId: o.accountId,
      instrumentId: o.instrumentId,
      side: o.side,
      type: o.type,
      quantity: o.quantity,
      limitPrice: o.limitPrice,
      stopPrice: null,
      status: 'new',
      filled: '0',
      filledValue: '0',
      reserved: '0',
      parentId: null,
      ocoGroup: null,
      acceptedAfterTrade: ctx.lastTrade,
      seq: ++this.seq,
      refusalReason: null,
      underlyingClosed: o.underlyingClosed,
      fillCount: 0,
    };
    const legs: EngineOrder[] = [];
    if (o.stop)
      legs.push(
        this.leg(order, o.stop.id, 'stop', { stopPrice: o.stop.price, limitPrice: null }, o.ocoGroup),
      );
    if (o.target)
      legs.push(
        this.leg(order, o.target.id, 'target', { stopPrice: null, limitPrice: o.target.price }, o.ocoGroup),
      );
    const refuse = (reason: RefusalReason): Outputs => {
      for (const x of [order, ...legs]) {
        x.status = 'refused';
        x.refusalReason = reason;
        ch.touch(x);
      }
      return ch.outputs();
    };

    const rules = this.opts.rules(o.instrumentId);
    if (!rules || rules.venue !== account.venue) return refuse('not_practice_pair');
    if (ctx.health !== 'ok') return refuse(ctx.health);
    const open = [...this.live.values()].filter((x) => x.accountId === o.accountId).length;
    if (open + 1 + legs.length > (this.opts.maxOpenOrders ?? MAX_OPEN_PRACTICE_ORDERS))
      return refuse('too_many_open_orders');
    const reference = o.type === 'limit' ? o.limitPrice : bestPrice(ctx.book, o.side);
    if (reference === null) return refuse('no_market');
    const ruleBreak = checkOrderRules(rules, {
      quantity: o.quantity,
      prices: [o.limitPrice, o.stop?.price ?? null, o.target?.price ?? null],
      referencePrice: reference,
    });
    if (ruleBreak) return refuse(ruleBreak);
    const fees = this.opts.fees(rules.venue);
    const quantity = dec(o.quantity);

    if (o.type === 'market') {
      const levels = opposite(ctx.book!, o.side);
      const taken = take(levels, o.side, quantity, null);
      if (taken.filled.lte(0)) return refuse('no_market');
      const enough =
        o.side === 'buy'
          ? this.available(account, rules.quote).gte(taken.value.times(holdRate(fees)))
          : this.available(account, rules.base).gte(quantity);
      if (!enough) return refuse('insufficient_balance');
      ch.touch(order);
      this.liveAdd(order, legs);
      const flags = this.flags(order, isThin(levels, o.side, quantity, taken.exhausted));
      this.fillTaken(ch, account, rules, fees, order, taken.parts, flags, ctx.now, {
        book: this.basisBook(ctx.book!, taken.parts),
      });
      // What the book could not fill is cancelled, as on the venues.
      this.finish(ch, account, rules, order, 'cancelled');
      this.settleLegs(ch, account, rules, order, legs);
      return ch.outputs();
    }

    // A limit order holds what it may cost (a buy) or the base it sells (a sell).
    const limit = dec(o.limitPrice!);
    const hold = o.side === 'buy' ? quantity.times(limit).times(holdRate(fees)) : quantity;
    const asset = o.side === 'buy' ? rules.quote : rules.base;
    if (this.available(account, asset).lt(hold)) return refuse('insufficient_balance');
    order.status = 'open';
    this.liveAdd(order, legs);
    this.reserve(ch, account, asset, hold, order);
    ch.touch(order);
    if (ctx.book) {
      const levels = opposite(ctx.book, o.side);
      const taken = take(levels, o.side, quantity, limit);
      if (taken.parts.length) {
        const flags = this.flags(order, isThin(levels, o.side, taken.filled, false));
        this.fillTaken(ch, account, rules, fees, order, taken.parts, flags, ctx.now, {
          book: this.basisBook(ctx.book, taken.parts),
        });
      }
    }
    this.settleLegs(ch, account, rules, order, legs);
    return ch.outputs();
  }

  /** Cancels what is left of an order. Cancelling a stop or a target cancels its pair. */
  cancel(orderId: string): Outputs {
    const ch = new Changes();
    const order = this.live.get(orderId);
    if (!order) return ch.outputs();
    const account = this.mustAccount(order.accountId);
    const rules = this.mustRules(order.instrumentId);
    if (order.parentId && order.ocoGroup) {
      for (const leg of this.groupLegs(order.ocoGroup)) this.finish(ch, account, rules, leg, 'cancelled');
      return ch.outputs();
    }
    this.finish(ch, account, rules, order, 'cancelled');
    // A buy that never filled takes its stop and target with it; once it has filled, they protect what it bought.
    if (dec(order.filled).eq(0))
      for (const leg of this.legsOf(order.id)) this.finish(ch, account, rules, leg, 'cancelled');
    return ch.outputs();
  }

  /**
   * Starts the account's next period: its live orders are cancelled, and its balances start again
   * at `starting`. Earlier periods keep their history.
   */
  reset(accountId: string, starting: Readonly<Record<string, string>>): Outputs {
    const ch = new Changes();
    const account = this.mustAccount(accountId);
    for (const { id } of this.liveOrders()) {
      const order = this.live.get(id);
      if (order?.accountId === accountId)
        this.finish(ch, account, this.mustRules(order.instrumentId), order, 'cancelled');
    }
    account.epoch += 1;
    account.available = new Map();
    account.starting = { ...starting };
    for (const [asset, amount] of Object.entries(starting)) {
      account.available.set(asset, dec(amount));
      ch.ledger.push(this.entry(account, asset, dec(amount), 'start', null, null));
    }
    return ch.outputs();
  }

  /** Applies one live trade to the instrument's resting orders and stops. */
  trade(t: Trade, ctx: { health: Health; book: Book | null }): Outputs {
    const ch = new Changes();
    if (ctx.health !== 'ok') return ch.outputs();
    const candidates = [...this.live.values()].filter(
      (o) =>
        o.instrumentId === t.instrumentId &&
        (o.status === 'open' || o.status === 'partially_filled') &&
        compareStreamIds(t.streamId, o.acceptedAfterTrade) > 0,
    );
    if (!candidates.length) return ch.outputs();
    const price = dec(t.price);
    const basis = {
      trade: { id: t.id, streamId: t.streamId, ts: t.ts, price: t.price, quantity: t.quantity },
    };

    // Resting buys fill when a trade prints below their limit; sells (limits and targets) above it.
    // Each side takes at most the traded quantity, best price first, then time.
    const buys = candidates
      .filter((o) => o.side === 'buy' && o.type === 'limit' && price.lt(o.limitPrice!))
      .sort((a, b) => dec(b.limitPrice!).cmp(a.limitPrice!) || a.seq - b.seq);
    const sells = candidates
      .filter(
        (o) => o.side === 'sell' && (o.type === 'limit' || o.type === 'target') && price.gt(o.limitPrice!),
      )
      .sort((a, b) => dec(a.limitPrice!).cmp(b.limitPrice!) || a.seq - b.seq);
    for (const orders of [buys, sells]) {
      let left = dec(t.quantity);
      for (const order of orders) {
        if (left.lte(0)) break;
        if (!this.live.has(order.id)) continue;
        const remaining = this.remaining(order);
        const q = remaining.lt(left) ? remaining : left;
        if (q.lte(0)) continue;
        left = left.minus(q);
        const account = this.mustAccount(order.accountId);
        const rules = this.mustRules(order.instrumentId);
        const part: Part = { price: order.limitPrice!, quantity: q.toString() };
        this.fill(
          ch,
          account,
          rules,
          this.opts.fees(rules.venue),
          order,
          part,
          'maker',
          this.flags(order, false),
          t.ts,
          basis,
        );
      }
    }

    // Stops at or through the trade price become market sells against the book.
    const stops = candidates
      .filter((o) => o.type === 'stop' && price.lte(o.stopPrice!))
      .sort((a, b) => a.seq - b.seq);
    for (const stop of stops) {
      if (!ctx.book || !this.live.has(stop.id)) continue;
      const account = this.mustAccount(stop.accountId);
      const rules = this.mustRules(stop.instrumentId);
      const quantity = this.remaining(stop);
      const taken = take(ctx.book.bids, 'sell', quantity, null);
      if (taken.filled.lte(0)) continue;
      const flags = this.flags(stop, isThin(ctx.book.bids, 'sell', quantity, taken.exhausted));
      this.fillTaken(ch, account, rules, this.opts.fees(rules.venue), stop, taken.parts, flags, t.ts, {
        ...basis,
        book: this.basisBook(ctx.book, taken.parts),
      });
      this.finish(ch, account, rules, stop, 'cancelled');
    }
    return ch.outputs();
  }

  // ----- internals -----

  private leg(
    parent: EngineOrder,
    id: string,
    type: 'stop' | 'target',
    prices: { stopPrice: string | null; limitPrice: string | null },
    ocoGroup: string | null,
  ): EngineOrder {
    return {
      ...parent,
      id,
      side: 'sell',
      type,
      quantity: '0',
      limitPrice: prices.limitPrice,
      stopPrice: prices.stopPrice,
      status: 'pending',
      parentId: parent.id,
      ocoGroup,
      seq: ++this.seq,
    };
  }

  private mustAccount(id: string): AccountState {
    const a = this.accounts.get(id);
    if (!a) throw new Error(`practice account ${id} is not loaded`);
    return a;
  }

  private mustRules(instrumentId: string): InstrumentRules {
    const r = this.opts.rules(instrumentId);
    if (!r) throw new Error(`no order rules for instrument ${instrumentId}`);
    return r;
  }

  private available(account: AccountState, asset: string): Decimal {
    return account.available.get(asset) ?? dec(0);
  }

  private remaining(order: EngineOrder): Decimal {
    return dec(order.quantity).minus(order.filled);
  }

  private liveAdd(order: EngineOrder, legs: readonly EngineOrder[]): void {
    this.live.set(order.id, order);
    for (const leg of legs) this.live.set(leg.id, leg);
  }

  /** A buy's live stop and target. */
  private legsOf(parentId: string): EngineOrder[] {
    return [...this.live.values()].filter((o) => o.parentId === parentId).sort((a, b) => a.seq - b.seq);
  }

  /** A pair's live legs. */
  private groupLegs(group: string): EngineOrder[] {
    return [...this.live.values()]
      .filter((o) => o.ocoGroup === group && o.parentId)
      .sort((a, b) => a.seq - b.seq);
  }

  /** The leg that holds a pair's base: the target while it is live, otherwise the stop. */
  private holder(group: string): EngineOrder | undefined {
    const legs = this.groupLegs(group);
    return legs.find((l) => l.type === 'target') ?? legs[0];
  }

  private flags(order: EngineOrder, thin: boolean): FillFlag[] {
    const flags: FillFlag[] = [];
    if (thin) flags.push('thin_book');
    if (order.underlyingClosed) flags.push('underlying_closed');
    return flags;
  }

  private basisBook(book: Book, parts: readonly Part[]): Record<string, unknown> {
    return { ts: book.ts, levels: parts.map((p) => [p.price, p.quantity]) };
  }

  private entry(
    account: AccountState,
    asset: string,
    amount: Decimal,
    reason: LedgerEntry['reason'],
    orderId: string | null,
    fillId: string | null,
  ): LedgerEntry {
    return {
      accountId: account.id,
      epoch: account.epoch,
      asset,
      amount: amount.toString(),
      reason,
      orderId,
      fillId,
    };
  }

  private credit(
    ch: Changes,
    account: AccountState,
    asset: string,
    amount: Decimal,
    reason: LedgerEntry['reason'],
    orderId: string | null,
    fillId: string | null,
  ): void {
    if (amount.eq(0)) return;
    account.available.set(asset, this.available(account, asset).plus(amount));
    ch.ledger.push(this.entry(account, asset, amount, reason, orderId, fillId));
  }

  private reserve(
    ch: Changes,
    account: AccountState,
    asset: string,
    amount: Decimal,
    order: EngineOrder,
  ): void {
    order.reserved = dec(order.reserved).plus(amount).toString();
    this.credit(ch, account, asset, amount.neg(), 'reserve', order.id, null);
    ch.touch(order);
  }

  /** Releases up to `amount` of what `order` holds back to the available balance. */
  private release(
    ch: Changes,
    account: AccountState,
    asset: string,
    amount: Decimal,
    order: EngineOrder,
  ): void {
    const r = amount.gt(order.reserved) ? dec(order.reserved) : amount;
    order.reserved = dec(order.reserved).minus(r).toString();
    this.credit(ch, account, asset, r, 'release', order.id, null);
    ch.touch(order);
  }

  /** Book parts (a market order, a limit that trades at once, a triggered stop) as taker fills. */
  private fillTaken(
    ch: Changes,
    account: AccountState,
    rules: InstrumentRules,
    fees: FeeRates,
    order: EngineOrder,
    parts: readonly Part[],
    flags: FillFlag[],
    at: number,
    basis: Record<string, unknown>,
  ): void {
    for (const part of parts) {
      if (!this.live.has(order.id)) break;
      this.fill(ch, account, rules, fees, order, part, 'taker', flags, at, basis);
    }
  }

  /** One fill: the order's quantities, the hold it used, the assets and the fee; then its consequences. */
  private fill(
    ch: Changes,
    account: AccountState,
    rules: InstrumentRules,
    fees: FeeRates,
    order: EngineOrder,
    part: Part,
    liquidity: 'maker' | 'taker',
    flags: FillFlag[],
    at: number,
    basis: Record<string, unknown>,
  ): void {
    const q = dec(part.quantity);
    const value = q.times(part.price);
    const fee = value.times(liquidity === 'maker' ? fees.maker : fees.taker);
    order.fillCount += 1;
    const id = this.opts.fillId(order.id, order.fillCount);
    order.filled = dec(order.filled).plus(q).toString();
    order.filledValue = dec(order.filledValue).plus(value).toString();

    if (order.side === 'buy') {
      if (order.type === 'limit')
        this.release(ch, account, rules.quote, q.times(order.limitPrice!).times(holdRate(fees)), order);
      this.credit(ch, account, rules.quote, value.neg(), 'fill', order.id, id);
      this.credit(ch, account, rules.base, q, 'fill', order.id, id);
    } else {
      // A plain sell holds its own base; a stop or target uses the base its pair holds.
      const holder = order.parentId && order.ocoGroup ? this.holder(order.ocoGroup) : order;
      if (holder) this.release(ch, account, rules.base, q, holder);
      this.credit(ch, account, rules.base, q.neg(), 'fill', order.id, id);
      this.credit(ch, account, rules.quote, value, 'fill', order.id, id);
    }
    this.credit(ch, account, rules.quote, fee.neg(), 'fee', order.id, id);
    ch.fills.push({
      id,
      orderId: order.id,
      accountId: account.id,
      instrumentId: order.instrumentId,
      side: order.side,
      price: part.price,
      quantity: q.toString(),
      fee: fee.toString(),
      feeAsset: rules.quote,
      liquidity,
      flags,
      basis,
      at,
    });
    if (order.status === 'open' || order.status === 'new') order.status = 'partially_filled';
    ch.touch(order);

    if (order.side === 'buy') {
      this.armLegs(ch, account, rules, order);
    } else if (order.parentId && order.ocoGroup) {
      // One-cancels-other: the leg that filled keeps the pair's held base; the other is cancelled.
      for (const other of this.groupLegs(order.ocoGroup)) {
        if (other.id === order.id) continue;
        order.reserved = dec(order.reserved).plus(other.reserved).toString();
        other.reserved = '0';
        this.finish(ch, account, rules, other, 'cancelled');
      }
    }
    if (this.remaining(order).lte(0)) this.finish(ch, account, rules, order, 'filled');
  }

  /** Brings a buy's stop and target up to what the buy has filled, holding that much base for them. */
  private armLegs(ch: Changes, account: AccountState, rules: InstrumentRules, parent: EngineOrder): void {
    const legs = this.legsOf(parent.id);
    const group = legs[0]?.ocoGroup;
    if (!group) return;
    const filled = dec(parent.filled);
    let sold = dec(0);
    for (const leg of legs) {
      sold = sold.plus(leg.filled);
      if (dec(leg.quantity).lt(filled)) {
        leg.quantity = filled.toString();
        if (leg.status === 'pending') leg.status = 'open';
        ch.touch(leg);
      }
    }
    const holder = this.holder(group);
    if (!holder) return;
    const need = filled.minus(sold).minus(holder.reserved);
    if (need.gt(0)) this.reserve(ch, account, rules.base, need, holder);
  }

  /** After a buy is taken up: a buy that ended without any fill takes its pending stop and target with it. */
  private settleLegs(
    ch: Changes,
    account: AccountState,
    rules: InstrumentRules,
    parent: EngineOrder,
    legs: readonly EngineOrder[],
  ): void {
    if (!LIVE.has(parent.status) && dec(parent.filled).eq(0))
      for (const leg of legs) this.finish(ch, account, rules, leg, 'cancelled');
    for (const leg of legs) ch.touch(leg);
  }

  /** Ends an order: releases what it still holds, and drops it from the live set. */
  private finish(
    ch: Changes,
    account: AccountState,
    rules: InstrumentRules,
    order: EngineOrder,
    status: 'filled' | 'cancelled',
  ): void {
    if (!this.live.has(order.id)) return;
    if (dec(order.reserved).gt(0))
      this.release(ch, account, order.side === 'buy' ? rules.quote : rules.base, dec(order.reserved), order);
    order.status = status;
    this.live.delete(order.id);
    ch.touch(order);
  }
}
