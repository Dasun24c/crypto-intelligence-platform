import type { RefusalReason } from '@cip/contracts';
import { dec, type DecimalString } from '@cip/domain';
import type { InstrumentRules } from './types.js';

/** Whether `value` is a whole number of `step`s. A step of 0 (unknown) allows anything. */
export function isMultipleOf(value: DecimalString, step: DecimalString): boolean {
  const s = dec(step);
  return s.eq(0) || dec(value).mod(s).eq(0);
}

/**
 * The venue's order rules (TRD-03): the quantity a whole number of quantity steps, every price a
 * whole number of price steps, and the order's value (quantity × the reference price: the limit, or
 * the best opposite price for a market order) at least the venue's minimum. The api checks these
 * before accepting an order, and the engine again when it takes it up.
 */
export function checkOrderRules(
  rules: InstrumentRules,
  order: {
    quantity: DecimalString;
    prices: readonly (DecimalString | null)[];
    referencePrice: DecimalString | null;
  },
): RefusalReason | null {
  if (!isMultipleOf(order.quantity, rules.qtyStep)) return 'quantity_step';
  for (const price of order.prices)
    if (price !== null && !isMultipleOf(price, rules.priceTick)) return 'price_step';
  const minimum = dec(rules.minNotional);
  if (
    order.referencePrice !== null &&
    minimum.gt(0) &&
    dec(order.quantity).times(order.referencePrice).lt(minimum)
  )
    return 'min_value';
  return null;
}

/** Valkey stream ids ("<ms>-<seq>") in order: negative when `a` is earlier. */
export function compareStreamIds(a: string, b: string): number {
  const [am = '0', as = '0'] = a.split('-');
  const [bm = '0', bs = '0'] = b.split('-');
  return Number(am) - Number(bm) || Number(as) - Number(bs);
}
