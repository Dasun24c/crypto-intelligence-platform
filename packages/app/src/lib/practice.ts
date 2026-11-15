import type {
  FeeRates,
  Instrument,
  OrderSide,
  PracticeAccount,
  PracticeOrder,
  PracticeOrderStatus,
  PracticeOrderType,
  PracticePosition,
} from '@cip/contracts';
import { dec } from '@cip/domain';

/**
 * Practice trading in the app (REQUIREMENTS §11, ADR 021): how orders, balances and results are
 * kept and described. Orders are simulated by the platform; nothing here reaches an exchange.
 */

export const ORDER_STATUS_LABEL: Record<PracticeOrderStatus, string> = {
  new: 'Submitted',
  pending: 'Waits for its buy',
  open: 'Open',
  partially_filled: 'Partly filled',
  filled: 'Filled',
  cancelled: 'Cancelled',
  refused: 'Refused',
};

export const ORDER_TYPE_LABEL: Record<PracticeOrderType, string> = {
  market: 'Market',
  limit: 'Limit',
  stop: 'Stop',
  target: 'Target',
};

const LIVE: ReadonlySet<PracticeOrderStatus> = new Set(['new', 'pending', 'open', 'partially_filled']);

/** Whether the order may still change (and can be cancelled). */
export const isLiveOrder = (o: Pick<PracticeOrder, 'status'>): boolean => LIVE.has(o.status);

const byAge = (a: PracticeOrder, b: PracticeOrder) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1);

/**
 * The open orders after an update: the order replaced or added, or dropped once it is finished.
 * An update older than the one held is ignored.
 */
export function applyOrder(open: readonly PracticeOrder[], order: PracticeOrder): PracticeOrder[] {
  const held = open.find((o) => o.id === order.id);
  if (held && held.updatedAt > order.updatedAt) return [...open];
  const rest = open.filter((o) => o.id !== order.id);
  return isLiveOrder(order) ? [...rest, order].sort(byAge) : rest;
}

/** The accounts with one replaced (or added). */
export function applyAccount(
  accounts: readonly PracticeAccount[],
  account: PracticeAccount,
): PracticeAccount[] {
  return accounts.some((a) => a.id === account.id)
    ? accounts.map((a) => (a.id === account.id ? account : a))
    : [...accounts, account];
}

/** Free and held amounts of one asset (zero when the account has none). */
export function balanceOf(
  account: PracticeAccount | undefined,
  asset: string,
): { available: string; reserved: string } {
  const b = account?.balances.find((x) => x.asset === asset);
  return { available: b?.available ?? '0', reserved: b?.reserved ?? '0' };
}

const DECIMAL = /^\d+(\.\d+)?$/;
export const isDecimal = (v: string): boolean => DECIMAL.test(v.trim());

/** A whole number of steps, rounded down; a step of 0 (unknown) leaves the value as it is. */
export function floorToStep(value: string, step: string): string {
  const s = dec(step);
  if (s.lte(0)) return dec(value).toString();
  return dec(value).div(s).round(0, 0).times(s).toString();
}

const onStep = (value: string, step: string) => dec(step).eq(0) || dec(value).mod(step).eq(0);

/** What the order form holds, as typed. */
export interface TicketDraft {
  side: OrderSide;
  type: 'market' | 'limit';
  quantity: string;
  limitPrice: string;
  stop: string;
  target: string;
}

/** The best prices now (from the ticker), for market orders and estimates. */
export interface Quote {
  bid: string | null;
  ask: string | null;
}

/**
 * The price an order is measured against: its limit, or for a market order the best price on the
 * other side of the book now (a large order walks further and pays more).
 */
export function referencePrice(
  t: Pick<TicketDraft, 'side' | 'type' | 'limitPrice'>,
  quote: Quote,
): string | null {
  if (t.type === 'limit')
    return isDecimal(t.limitPrice) && dec(t.limitPrice).gt(0) ? t.limitPrice.trim() : null;
  return t.side === 'buy' ? quote.ask : quote.bid;
}

export interface FieldProblem {
  field: keyof TicketDraft;
  message: string;
}

/**
 * Mistakes the form can show before anything is sent: amounts that are not positive numbers, prices
 * and quantities off the pair's steps, a stop or target on the wrong side of the price. The server
 * checks these again, and the balance, the minimum value and the pair's data.
 */
export function ticketProblems(t: TicketDraft, instrument: Instrument, quote: Quote): FieldProblem[] {
  const problems: FieldProblem[] = [];
  const amount = (field: keyof TicketDraft, label: string, step: string, optional: boolean) => {
    const v = t[field].trim();
    if (v === '') {
      if (!optional) problems.push({ field, message: `Enter the ${label}.` });
      return false;
    }
    if (!isDecimal(v) || dec(v).lte(0)) {
      problems.push({ field, message: `The ${label} must be a number above zero.` });
      return false;
    }
    if (!onStep(v, step)) {
      problems.push({
        field,
        message: `The ${label} must be a whole number of steps of ${dec(step).toString()}.`,
      });
      return false;
    }
    return true;
  };
  amount('quantity', 'quantity', instrument.qtyStep, false);
  if (t.type === 'limit') amount('limitPrice', 'limit price', instrument.priceTick, false);
  if (t.side === 'buy') {
    const reference = referencePrice(t, quote);
    if (
      amount('stop', 'stop', instrument.priceTick, true) &&
      reference !== null &&
      dec(t.stop).gte(reference)
    )
      problems.push({ field: 'stop', message: `The stop must be below the buying price (${reference}).` });
    if (
      amount('target', 'target', instrument.priceTick, true) &&
      reference !== null &&
      dec(t.target).lte(reference)
    )
      problems.push({
        field: 'target',
        message: `The target must be above the buying price (${reference}).`,
      });
  }
  return problems;
}

export interface Estimate {
  price: string;
  /** Quantity × price, in the quote currency. */
  value: string;
  /** At the taker rate for a market order; up to the higher rate for a limit order. */
  fee: string;
  /** A buy's cost with its fee, or a sell's proceeds after it. */
  total: string;
}

/** What the order is expected to cost or bring, before slippage beyond the best price. */
export function estimateOrder(
  t: Pick<TicketDraft, 'side' | 'type' | 'quantity' | 'limitPrice'>,
  quote: Quote,
  fees: FeeRates | undefined,
): Estimate | null {
  const price = referencePrice(t, quote);
  if (price === null || !isDecimal(t.quantity) || !fees) return null;
  const value = dec(t.quantity).times(price);
  const rate =
    t.type === 'market'
      ? dec(fees.taker)
      : dec(fees.maker).gt(fees.taker)
        ? dec(fees.maker)
        : dec(fees.taker);
  const fee = value.times(rate);
  return {
    price,
    value: value.toString(),
    fee: fee.toString(),
    total: (t.side === 'buy' ? value.plus(fee) : value.minus(fee)).toString(),
  };
}

/** "0.1 %" from "0.001". */
export const feePct = (fraction: string): string => `${dec(fraction).times(100).toString()} %`;

export interface PnlTotal {
  quote: string;
  realised: string;
  /** Null when a holding has no last price. */
  unrealised: string | null;
  fees: string;
}

/** Profit and loss summed per quote currency (a USDT result and a USD result are not added up). */
export function pnlTotals(
  positions: readonly PracticePosition[],
  instruments: readonly Instrument[],
): PnlTotal[] {
  const quoteOf = new Map(instruments.map((i) => [i.id, i.quote]));
  const totals = new Map<string, PnlTotal>();
  for (const p of positions) {
    const quote = quoteOf.get(p.instrumentId) ?? '?';
    const t = totals.get(quote) ?? { quote, realised: '0', unrealised: '0', fees: '0' };
    t.realised = dec(t.realised).plus(p.realisedPnl).toString();
    t.fees = dec(t.fees).plus(p.fees).toString();
    t.unrealised =
      t.unrealised === null || p.unrealisedPnl === null
        ? null
        : dec(t.unrealised).plus(p.unrealisedPnl).toString();
    totals.set(quote, t);
  }
  return [...totals.values()].sort((a, b) => a.quote.localeCompare(b.quote));
}

/** "+12.5" or "−3.2": a result never shown by colour alone. */
export function signed(value: string): string {
  const v = dec(value);
  return v.gt(0) ? `+${v.toString()}` : v.lt(0) ? `−${v.abs().toString()}` : '0';
}

/** A new idempotency key for a submission: a retry of the same confirmation reuses it. */
export function newClientOrderId(): string {
  return `web-${crypto.randomUUID()}`;
}
