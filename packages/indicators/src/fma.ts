/**
 * Correctly rounded fused multiply-add: a × b + c with a single rounding, like C's fma() and
 * IEEE 754 fusedMultiplyAdd. JavaScript has no Math.fma.
 *
 * TA-Lib 0.8 computes its EMA and Wilder recursions with explicit fma() calls (its "FMA numerical
 * contract", which makes every platform give the same bits). Matching TA-Lib bit for bit needs the
 * same operation here.
 *
 * Two paths:
 * - **Fast**, for the magnitudes prices and indicators have (2^-400 to 2^400): the error-free
 *   product and sum, then the remainder rounded to odd (Boldo and Melquiond, "Emulation of FMA and
 *   correctly rounded sums: proved algorithms using rounding to odd", IEEE Trans. Computers, 2008).
 *   No allocation; a few dozen floating-point operations.
 * - **Exact**, for everything else (huge, tiny or non-finite operands): the exact value in BigInt
 *   arithmetic, rounded to nearest, ties to even, with subnormals and overflow handled.
 * The test suite checks the two against each other on millions of operands, near-ties included.
 */

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
f64[0] = 1;
/** Index of the high (sign and exponent) word: 1 on little-endian machines. */
const HI = u32[1] === 0x3ff00000 ? 1 : 0;
const LO = 1 - HI;

const SPLITTER = 134_217_729; // 2^27 + 1, Veltkamp's splitting constant for 53-bit doubles
const SAFE_MIN = 2 ** -400;
const SAFE_MAX = 2 ** 400;

const inSafeRange = (x: number) => {
  const m = Math.abs(x);
  return m >= SAFE_MIN && m <= SAFE_MAX;
};

/** The neighbouring double of `s` (not zero) on the side of `direction`'s sign. */
function neighbour(s: number, direction: number): number {
  f64[0] = s;
  if (s > 0 === direction > 0) {
    // away from zero: the next bit pattern
    if (u32[LO] === 0xffffffff) {
      u32[LO] = 0;
      u32[HI] = u32[HI]! + 1;
    } else u32[LO] = u32[LO]! + 1;
  } else if (u32[LO] === 0) {
    // toward zero: the previous bit pattern
    u32[LO] = 0xffffffff;
    u32[HI] = u32[HI]! - 1;
  } else u32[LO] = u32[LO]! - 1;
  return f64[0];
}

function isOdd(s: number): boolean {
  f64[0] = s;
  return (u32[LO]! & 1) === 1;
}

function fmaFast(a: number, b: number, c: number): number {
  // Dekker's exact product: uh + ul = a × b.
  const uh = a * b;
  let t = SPLITTER * a;
  const ah = t - (t - a);
  const al = a - ah;
  t = SPLITTER * b;
  const bh = t - (t - b);
  const bl = b - bh;
  const ul = ah * bh - uh + ah * bl + al * bh + al * bl;
  // Knuth's exact sum: th + tl = c + uh.
  const th = c + uh;
  let bb = th - c;
  const tl = c - (th - bb) + (uh - bb);
  // v = tl + ul rounded to odd: round to nearest, then step to the odd neighbour if inexact and even.
  const s = tl + ul;
  bb = s - tl;
  const e = tl - (s - bb) + (ul - bb);
  const v = e === 0 || isOdd(s) ? s : neighbour(s, e);
  return th + v;
}

interface Parts {
  negative: boolean;
  /** Integer significand. */
  m: bigint;
  /** Exponent of the significand's unit bit: the value is m × 2^e. */
  e: number;
}

function parts(x: number): Parts {
  f64[0] = x;
  const hi = u32[HI]!;
  const biased = (hi >>> 20) & 0x7ff;
  const fraction = (BigInt(hi & 0xfffff) << 32n) | BigInt(u32[LO]!);
  return biased === 0
    ? { negative: hi >>> 31 === 1, m: fraction, e: -1074 }
    : { negative: hi >>> 31 === 1, m: fraction | (1n << 52n), e: biased - 1075 };
}

const bitLength = (n: bigint) => n.toString(2).length;

/** q × 2^unit as a double; q > 0 and already rounded, so the value is representable (or overflows). */
function compose(negative: boolean, q: bigint, unit: number): number {
  const length = bitLength(q);
  const lead = unit + length - 1;
  if (lead > 1023) return negative ? -Infinity : Infinity;
  let biased: number;
  let mantissa: bigint;
  if (lead >= -1022) {
    biased = lead + 1023;
    const shift = 53 - length;
    mantissa = (shift >= 0 ? q << BigInt(shift) : q >> BigInt(-shift)) & ((1n << 52n) - 1n);
  } else {
    biased = 0;
    mantissa = q << BigInt(unit + 1074);
  }
  u32[HI] = ((negative ? 0x80000000 : 0) | (biased << 20) | Number(mantissa >> 32n)) >>> 0;
  u32[LO] = Number(mantissa & 0xffffffffn);
  return f64[0]!;
}

/** The exact a × b + c, rounded once (to nearest, ties to even). Exported for the tests. */
export function fmaExact(a: number, b: number, c: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) {
    // IEEE 754: NaN in, NaN out; ∞ × 0 is NaN; otherwise the infinities decide, as in a × b + c.
    if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c)) return Number.NaN;
    if ((!Number.isFinite(a) && b === 0) || (!Number.isFinite(b) && a === 0)) return Number.NaN;
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      const product = (a > 0 === b > 0 ? 1 : -1) * Infinity;
      return Number.isFinite(c) || c === product ? product : Number.NaN;
    }
    return c;
  }
  const pa = parts(a);
  const pb = parts(b);
  const pc = parts(c);
  const productNegative = pa.negative !== pb.negative;
  const product = pa.m * pb.m;
  const productExp = pa.e + pb.e;
  if (product === 0n && pc.m === 0n) return productNegative && pc.negative ? -0 : 0;
  const unit = Math.min(productExp, pc.e);
  const p = product << BigInt(productExp - unit);
  const q = pc.m << BigInt(pc.e - unit);
  const sum = (productNegative ? -p : p) + (pc.negative ? -q : q);
  if (sum === 0n) return 0; // exact cancellation of non-zero terms gives +0
  const negative = sum < 0n;
  const magnitude = negative ? -sum : sum;
  const lead = unit + bitLength(magnitude) - 1;
  const cut = Math.max(lead - 52, -1074);
  const shift = cut - unit;
  if (shift <= 0) return compose(negative, magnitude, unit);
  let kept = magnitude >> BigInt(shift);
  const rest = magnitude - (kept << BigInt(shift));
  const half = 1n << BigInt(shift - 1);
  if (rest > half || (rest === half && (kept & 1n) === 1n)) kept += 1n;
  return kept === 0n ? (negative ? -0 : 0) : compose(negative, kept, cut);
}

/** a × b + c with one rounding (C's fma()). */
export function fma(a: number, b: number, c: number): number {
  if (a === 0 || b === 0) {
    // The product is an exact ±0, so the sum is c's (with IEEE's signed-zero rule): no fusion needed.
    if (Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c)) return a * b + c;
    return fmaExact(a, b, c);
  }
  if (c === 0 && Number.isFinite(a) && Number.isFinite(b)) return a * b; // one rounding already
  if (inSafeRange(a) && inSafeRange(b) && inSafeRange(c)) return fmaFast(a, b, c);
  return fmaExact(a, b, c);
}
