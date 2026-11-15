/**
 * Prices inside the engine are whole numbers of 10⁻⁸ ("units"). Comparisons such as "close at least
 * one tick above the level" are then exact, which floating-point decimals are not (0.1 + 0.2 ≠ 0.3).
 * Every venue price has at most 8 decimals, and 2⁵³ units allow prices up to about 90 million.
 * Thresholds measured in ATR are doubles in the same units.
 */
export const PRICE_SCALE = 100_000_000;
const DIGITS = 8;
const DECIMAL = /^(-?)(\d*)(?:\.(\d*))?$/;

/**
 * `"60321.5"` → 6032150000000. Exact for up to 8 decimals; a ninth or later digit rounds half up
 * (venue prices never have one, but stored numerics may carry trailing zeros).
 */
export function toUnits(price: string): number {
  const m = DECIMAL.exec(price);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new RangeError(`not a decimal price: "${price}"`);
  const whole = m[2] || '0';
  let fraction = m[3] ?? '';
  let carry = 0;
  if (fraction.length > DIGITS) {
    carry = fraction.charCodeAt(DIGITS) >= 53 ? 1 : 0; // '5'
    fraction = fraction.slice(0, DIGITS);
  }
  const units = Number(whole) * PRICE_SCALE + Number(fraction.padEnd(DIGITS, '0')) + carry;
  if (!Number.isSafeInteger(units)) throw new RangeError(`price out of range: "${price}"`);
  return m[1] === '-' && units !== 0 ? -units : units;
}

/** 6032150000000 → `"60321.5"`: the shortest exact decimal. */
export function fromUnits(units: number): string {
  if (!Number.isSafeInteger(units)) throw new RangeError(`not a whole number of units: ${units}`);
  const sign = units < 0 ? '-' : '';
  const abs = Math.abs(units);
  const whole = Math.floor(abs / PRICE_SCALE);
  const fraction = String(abs - whole * PRICE_SCALE)
    .padStart(DIGITS, '0')
    .replace(/0+$/, '');
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

/** The exact midpoint of two prices, which may need a ninth decimal (a range's equilibrium). */
export function midpoint(a: number, b: number): string {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) throw new RangeError('prices out of range');
  if (sum % 2 === 0) return fromUnits(sum / 2);
  const half = (sum - Math.sign(sum)) / 2;
  const base = fromUnits(Math.abs(half));
  const [whole, fraction = ''] = base.split('.');
  return `${sum < 0 ? '-' : ''}${whole}.${fraction.padEnd(DIGITS, '0')}5`;
}

/** Units to a double price, for notional values (USD). */
export function unitsToNumber(units: number): number {
  return units / PRICE_SCALE;
}
