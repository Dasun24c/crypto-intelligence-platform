import Big from 'big.js';

/**
 * Exact decimal arithmetic for prices and quantities, which arrive and travel as strings
 * (API contracts §1). A private big.js constructor keeps this configuration local: plain notation
 * for every realistic magnitude, and 30 decimal places for the few divisions we do.
 */
const D = Big();
D.DP = 30;
D.RM = D.roundHalfUp;
D.NE = -40;
D.PE = 60;

export type Decimal = Big;
export type DecimalString = string;

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

export function isDecimalString(value: string): boolean {
  return DECIMAL_PATTERN.test(value);
}

export function dec(value: string | number | Big): Big {
  return new D(value);
}

/** Canonical form: no exponent, no trailing zeros ("0.00100000" → "0.001", "65000.10" → "65000.1"). */
export function normalizeDecimal(value: string | number | Big): DecimalString {
  return new D(value).toString();
}

export function addDecimals(values: readonly DecimalString[]): DecimalString {
  let total = new D(0);
  for (const v of values) total = total.plus(v);
  return total.toString();
}

export function mulDecimal(a: DecimalString, b: DecimalString): DecimalString {
  return new D(a).times(b).toString();
}

export function maxDecimal(a: DecimalString, b: DecimalString): DecimalString {
  return new D(a).gte(b) ? a : b;
}

export function minDecimal(a: DecimalString, b: DecimalString): DecimalString {
  return new D(a).lte(b) ? a : b;
}

export function compareDecimal(a: DecimalString, b: DecimalString): -1 | 0 | 1 {
  return new D(a).cmp(b);
}

/** For metrics and ratios only (spread in bps, depth in USD): never for stored prices or volumes. */
export function toNumber(value: DecimalString): number {
  return Number(value);
}

/** a ÷ b, rounded half-up to `dp` decimal places, in canonical form (average prices). */
export function divDecimal(a: DecimalString, b: DecimalString, dp = 12): DecimalString {
  return new D(a).div(b).round(dp).toString();
}

/** Rounded half-up to `dp` decimal places, in canonical form (USD notionals to the cent). */
export function roundDecimal(value: DecimalString, dp: number): DecimalString {
  return new D(value).round(dp).toString();
}
