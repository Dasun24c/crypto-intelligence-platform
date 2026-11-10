/**
 * Display helpers for decimal strings (API contracts §1: prices and quantities are strings). They work
 * on the digits, never through a float, so a stored price is shown exactly as the venue sent it.
 */

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

interface Parts {
  negative: boolean;
  int: string;
  frac: string;
}

function parse(value: string): Parts | null {
  const m = DECIMAL.exec(value.trim());
  if (!m) return null;
  return { negative: m[1] === '-', int: m[2]!.replace(/^0+(?=\d)/, ''), frac: m[3] ?? '' };
}

function group(int: string): string {
  let out = '';
  for (let i = 0; i < int.length; i++) {
    if (i > 0 && (int.length - i) % 3 === 0) out += ',';
    out += int[i];
  }
  return out;
}

const isZero = (digits: string) => !/[1-9]/.test(digits);

/** How many fraction digits a step such as a tick size needs: "0.0100" → 2, "1" → 0. */
export function stepDecimals(step: string): number {
  const p = parse(step);
  return p ? p.frac.replace(/0+$/, '').length : 0;
}

/**
 * A decimal string with thousands separators. Every significant fraction digit is kept; trailing
 * zeros are trimmed down to `minFraction` digits (e.g. the instrument's tick precision) or padded up to
 * it. Anything that is not a decimal string is returned unchanged.
 */
export function formatDecimal(value: string, minFraction = 0): string {
  const p = parse(value);
  if (!p) return value;
  let frac = p.frac.replace(/0+$/, '');
  if (frac.length < minFraction) frac = frac.padEnd(minFraction, '0');
  const sign = p.negative && !(isZero(p.int) && isZero(frac)) ? '-' : '';
  return `${sign}${group(p.int)}${frac ? `.${frac}` : ''}`;
}

function increment(digits: string): string {
  const out = digits.split('');
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] !== '9') {
      out[i] = String(Number(out[i]) + 1);
      return out.join('');
    }
    out[i] = '0';
  }
  return `1${out.join('')}`;
}

/**
 * Rounds a decimal string half away from zero to `dp` fraction digits, on its digits. Only for values
 * the server derived (USD notionals, converted prices), never for a venue's own price.
 */
export function roundDecimal(value: string, dp: number): string {
  const p = parse(value);
  if (!p || p.frac.length <= dp) return value;
  let digits = p.int + p.frac.slice(0, dp);
  if (Number(p.frac[dp]) >= 5) digits = increment(digits);
  const intLength = digits.length - dp;
  const int = digits.slice(0, intLength) || '0';
  const frac = digits.slice(intLength);
  const sign = p.negative && !isZero(digits) ? '-' : '';
  return `${sign}${int}${dp > 0 ? `.${frac}` : ''}`;
}

/** "$174,230.50" from "174230.5". */
export function formatUsd(value: string, dp = 2): string {
  const formatted = formatDecimal(roundDecimal(value, dp), dp);
  return formatted.startsWith('-') ? `-$${formatted.slice(1)}` : `$${formatted}`;
}

const compactUsd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 2,
});

/** "$1.24M" for a derived number such as book depth (a number in the contracts, not a price). */
export function formatCompactUsd(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : compactUsd.format(value);
}

/** "+2.35 bps" (signed) or "1.20 bps". */
export function formatBps(value: number | null, signed = false, dp = 2): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const sign = signed && value > 0 ? '+' : '';
  return `${sign}${value.toFixed(dp)} bps`;
}

/** "+1.25%" or "-0.40%". */
export function formatPct(value: number | null, dp = 2): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(dp)}%`;
}

/**
 * The bid-ask spread in basis points of the mid: a derived ratio, so a number. Null when either side
 * is missing or not positive.
 */
export function spreadBps(bid: string, ask: string): number | null {
  const b = Number(bid);
  const a = Number(ask);
  if (!(b > 0) || !(a > 0)) return null;
  return ((a - b) / ((a + b) / 2)) * 10_000;
}
