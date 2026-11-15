import type { OrderSide } from '@cip/contracts';
import { dec, type Decimal } from '@cip/domain';
import type { Book, Level } from './types.js';

/** One price level an order took from, and how much. */
export interface Part {
  price: string;
  quantity: string;
}

export interface Taken {
  parts: Part[];
  filled: Decimal;
  value: Decimal;
  /** The book ran out (on that side, or within the limit) before the quantity was filled. */
  exhausted: boolean;
}

/** The side of the book an order takes from: a buy takes the asks, a sell the bids. */
export function opposite(book: Book, side: OrderSide): readonly Level[] {
  return side === 'buy' ? book.asks : book.bids;
}

/** The best price an order of that side would meet, or null on an empty side. */
export function bestPrice(book: Book | null, side: OrderSide): string | null {
  return book ? (opposite(book, side)[0]?.[0] ?? null) : null;
}

/**
 * Walks one side of the book, best first, taking up to `quantity`, and for a limit order no worse
 * than `limit` (a buy pays at most the limit, a sell receives at least it). Each level fills at its
 * own price, so a large order pays slippage (TRD-03).
 */
export function take(
  levels: readonly Level[],
  side: OrderSide,
  quantity: Decimal,
  limit: Decimal | null,
): Taken {
  const parts: Part[] = [];
  let remaining = quantity;
  let value = dec(0);
  for (const [price, size] of levels) {
    if (remaining.lte(0)) break;
    const p = dec(price);
    if (limit !== null && (side === 'buy' ? p.gt(limit) : p.lt(limit))) break;
    const q = remaining.lt(size) ? remaining : dec(size);
    if (q.lte(0)) continue;
    parts.push({ price: p.toString(), quantity: q.toString() });
    value = value.plus(p.times(q));
    remaining = remaining.minus(q);
  }
  return { parts, filled: quantity.minus(remaining), value, exhausted: remaining.gt(0) };
}

/** A fill is flagged "thin book" when the order takes more than this share of the depth near the best price. */
export const THIN_SHARE = '0.2';
/** How far from the best price that depth is counted: 0.5 %. */
export const THIN_BAND = '0.005';

/**
 * Whether an order took a large share of a thin book (ADR 021): more than a fifth of the quantity
 * the book shows within 0.5 % of its best price, or all of it. Such fills are less certain than the
 * simulation suggests, and are flagged.
 */
export function isThin(
  levels: readonly Level[],
  side: OrderSide,
  quantity: Decimal,
  exhausted: boolean,
): boolean {
  if (exhausted) return true;
  const best = levels[0]?.[0];
  if (best === undefined) return true;
  const band = dec(best).times(side === 'buy' ? dec(1).plus(THIN_BAND) : dec(1).minus(THIN_BAND));
  let depth = dec(0);
  for (const [price, size] of levels) {
    const p = dec(price);
    if (side === 'buy' ? p.gt(band) : p.lt(band)) break;
    depth = depth.plus(size);
  }
  return quantity.gt(depth.times(THIN_SHARE));
}
