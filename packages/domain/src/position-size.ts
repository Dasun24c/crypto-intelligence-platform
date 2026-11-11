import Big from 'big.js';
import type { DecimalString } from './decimal.js';

/**
 * The risk reference of REQUIREMENTS §3.7 (SMC-06): hypothetical R:R and the position size a
 * user-entered account size and risk % imply. Calculation only: nothing here is linked to an
 * exchange account and no order is ever placed. Exact decimals throughout (big.js), so 0.3 − 0.1 is
 * 0.2 and not 0.19999999999999998.
 */
const D = Big();
D.DP = 40;
D.RM = D.roundDown;
D.NE = -40;
D.PE = 60;

/** The risk % the UI suggests (REQUIREMENTS §3.7: "default range 0.5–1%"). */
export const DEFAULT_RISK_PCT: DecimalString = '1';
export const SUGGESTED_RISK_PCT = { min: '0.5', max: '1' } as const;

export interface PositionSizeInput {
  /** Account size in the quote currency (USD, USDT). */
  accountSize: DecimalString;
  /** Risk per trade in % of the account: "1" is 1 %. */
  riskPct: DecimalString;
  /** Hypothetical entry and invalidation (stop) prices. */
  entry: DecimalString;
  invalidation: DecimalString;
  /** The instrument's quantity step: the size is rounded down to it. Default: 8 decimals. */
  qtyStep?: DecimalString;
  /** Optional first target, for the R:R and the reward. */
  target?: DecimalString | null;
}

export interface PositionSize {
  /** Long when the invalidation is below the entry. */
  side: 'long' | 'short';
  /** accountSize × riskPct / 100. */
  riskAmount: DecimalString;
  /** |entry − invalidation|, and as % of the entry (4 decimals, rounded down). */
  distance: DecimalString;
  distancePct: DecimalString;
  /** riskAmount / distance, rounded down to the quantity step. */
  quantity: DecimalString;
  /** quantity × entry. */
  notional: DecimalString;
  /** What the rounded quantity actually risks: quantity × distance (never above riskAmount). */
  riskAtQuantity: DecimalString;
  /** notional / accountSize, 4 decimals rounded down: above 1 needs leverage. */
  leverage: DecimalString;
  /** |target − entry| / distance (4 decimals, rounded down), and quantity × |target − entry|. */
  rr: DecimalString | null;
  reward: DecimalString | null;
}

function positive(name: string, value: string): Big {
  let v: Big;
  try {
    v = new D(value);
  } catch {
    throw new RangeError(`${name} is not a number: "${value}"`);
  }
  if (v.lte(0)) throw new RangeError(`${name} must be greater than zero`);
  return v;
}

/**
 * |target − entry| / |entry − invalidation|, rounded down to 4 decimals: the engine's R:R. Null
 * when the target is not on the far side of the entry from the invalidation.
 */
export function riskReward(
  entry: DecimalString,
  invalidation: DecimalString,
  target: DecimalString,
): DecimalString | null {
  const e = positive('entry', entry);
  const inv = positive('invalidation', invalidation);
  const t = positive('target', target);
  if (e.eq(inv)) throw new RangeError('entry and invalidation must differ');
  const long = inv.lt(e);
  if (long ? t.lte(e) : t.gte(e)) return null;
  return t.minus(e).abs().div(e.minus(inv).abs()).round(4, D.roundDown).toString();
}

export function positionSize(input: PositionSizeInput): PositionSize {
  const account = positive('accountSize', input.accountSize);
  const pct = positive('riskPct', input.riskPct);
  if (pct.gt(100)) throw new RangeError('riskPct must be at most 100');
  const entry = positive('entry', input.entry);
  const inv = positive('invalidation', input.invalidation);
  if (entry.eq(inv)) throw new RangeError('entry and invalidation must differ');
  const step = input.qtyStep === undefined ? new D('0.00000001') : positive('qtyStep', input.qtyStep);

  const riskAmount = account.times(pct).div(100);
  const distance = entry.minus(inv).abs();
  const quantity = riskAmount.div(distance).div(step).round(0, D.roundDown).times(step);
  const notional = quantity.times(entry);
  const rr = input.target ? riskReward(input.entry, input.invalidation, input.target) : null;
  const reward = rr === null ? null : quantity.times(new D(input.target!).minus(entry).abs());
  return {
    side: inv.lt(entry) ? 'long' : 'short',
    riskAmount: riskAmount.toString(),
    distance: distance.toString(),
    distancePct: distance.div(entry).times(100).round(4, D.roundDown).toString(),
    quantity: quantity.toString(),
    notional: notional.toString(),
    riskAtQuantity: quantity.times(distance).toString(),
    leverage: notional.div(account).round(4, D.roundDown).toString(),
    rr,
    reward: reward?.toString() ?? null,
  };
}
