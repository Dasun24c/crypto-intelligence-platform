import { describe, expect, it } from 'vitest';
import { fma, fmaExact } from './fma.js';

/** Deterministic PRNG (mulberry32), so a failure can be reproduced from its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
const HI = (() => {
  f64[0] = 1;
  return u32[1] === 0x3ff00000 ? 1 : 0;
})();

/** A double with random sign, significand and an exponent in [minExp, maxExp]. */
function randomDouble(next: () => number, minExp: number, maxExp: number): number {
  const exp = minExp + Math.floor(next() * (maxExp - minExp + 1));
  u32[HI] = ((next() < 0.5 ? 0x80000000 : 0) | ((exp + 1023) << 20) | Math.floor(next() * 0x100000)) >>> 0;
  u32[1 - HI] = Math.floor(next() * 0x100000000) >>> 0;
  return f64[0]!;
}

function ulp(x: number): number {
  f64[0] = Math.abs(x);
  const exp = ((u32[HI]! >>> 20) & 0x7ff) - 1023;
  return 2 ** Math.max(exp - 52, -1074);
}

const same = (a: number, b: number) => Object.is(a, b);

describe('fma: correctly rounded fused multiply-add', () => {
  it('rounds once: known results that differ from a × b + c', () => {
    // 0.1 × 10 is 1 + 2^-54 exactly; rounding the product first loses the 2^-54.
    expect(fma(0.1, 10, -1)).toBe(2 ** -54);
    expect(0.1 * 10 - 1).toBe(0);
    // (1 + 2^-52)² − 1 = 2^-51 + 2^-104: exactly half an ulp above 2^-51, a tie that goes to even.
    expect(fma(1 + 2 ** -52, 1 + 2 ** -52, -1)).toBe(2 ** -51);
    // (1 + 2^-27)(1 − 2^-27) − 1 = −2^-54, which a separate product rounds to 1 and loses.
    expect(fma(1 + 2 ** -27, 1 - 2 ** -27, -1)).toBe(-(2 ** -54));
    expect(fma(3, 7, 0.5)).toBe(21.5);
  });

  it('follows IEEE 754 for zeros, infinities and NaN', () => {
    expect(same(fma(0, 5, -0), 0)).toBe(true);
    expect(same(fma(-0, 5, -0), -0)).toBe(true);
    expect(same(fma(2, 3, -6), 0)).toBe(true); // exact cancellation is +0
    expect(same(fma(-2, 3, 0), -6)).toBe(true);
    expect(fma(Infinity, 2, 1)).toBe(Infinity);
    expect(fma(-Infinity, 2, 1)).toBe(-Infinity);
    expect(fma(Infinity, 2, -Infinity)).toBeNaN();
    expect(fma(Infinity, 2, Infinity)).toBe(Infinity);
    expect(fma(Infinity, 0, 1)).toBeNaN();
    expect(fma(0, -Infinity, 1)).toBeNaN();
    expect(fma(2, 3, -Infinity)).toBe(-Infinity);
    expect(fma(Number.NaN, 1, 1)).toBeNaN();
    expect(fma(1, 1, Number.NaN)).toBeNaN();
    // Overflow of the exact result, and an exact result that a separate product would overflow.
    expect(fma(2 ** 1000, 2 ** 100, 0)).toBe(Infinity);
    expect(fma(2 ** 600, 2 ** 500, -(2 ** 1023))).toBe(Infinity);
    expect(fma(2 ** 1023, 2, -(2 ** 1023))).toBe(2 ** 1023);
  });

  it('handles subnormal results and operands exactly', () => {
    const tiny = 2 ** -1074;
    expect(fma(tiny, 0.5, 0)).toBe(0); // half the smallest subnormal ties to even (0)
    expect(fma(tiny, 1.5, 0)).toBe(2 * tiny); // 1.5 ulp rounds to even (2)
    expect(fma(2 ** -600, 2 ** -500, 2 ** -1073)).toBe(2 ** -1073);
    expect(fma(2 ** -537, 2 ** -537, -(2 ** -1074))).toBe(0);
    expect(fma(2 ** -1022, 0.75, 0)).toBe(2 ** -1022 * 0.75);
    expect(fma(3 * tiny, 1 / 3, 0)).toBe(tiny);
  });

  it('the fast path equals the exact one on 1,000,000 random operands across the safe range', () => {
    const next = rng(20261110);
    for (let i = 0; i < 1_000_000; i++) {
      const a = randomDouble(next, -60, 60);
      const b = randomDouble(next, -60, 60);
      const c = randomDouble(next, -120, 120);
      const got = fma(a, b, c);
      const want = fmaExact(a, b, c);
      if (!same(got, want)) expect([a, b, c, got]).toEqual([a, b, c, want]);
    }
  });

  it('the fast path equals the exact one on 300,000 constructed near-ties and cancellations', () => {
    const next = rng(42);
    const cases: [number, number, number][] = [];
    for (let i = 0; i < 50_000; i++) {
      const a = randomDouble(next, -30, 30);
      const b = randomDouble(next, -30, 30);
      const p = a * b;
      const u = ulp(p);
      // a × b + c lands on or a hair beside a halfway point between doubles, or cancels.
      cases.push(
        [a, b, -p],
        [a, b, u / 2],
        [a, b, -u / 2],
        [a, b, u / 2 + ulp(u / 2)],
        [a, b, -u / 2 - ulp(u / 2)],
        [a, b, -p + u * (next() - 0.5)],
      );
    }
    for (const [a, b, c] of cases) {
      const got = fma(a, b, c);
      const want = fmaExact(a, b, c);
      if (!same(got, want)) expect([a, b, c, got]).toEqual([a, b, c, want]);
    }
  });

  it('the exact path agrees with plain arithmetic wherever the product is exact', () => {
    const next = rng(7);
    for (let i = 0; i < 100_000; i++) {
      // Integers below 2^26 multiply exactly, so a × b + c has a single rounding in plain arithmetic too.
      const a = Math.floor(next() * 2 ** 26) - 2 ** 25;
      const b = Math.floor(next() * 2 ** 26) - 2 ** 25;
      const c = randomDouble(next, -80, 80);
      const want = a * b + c;
      if (!same(fmaExact(a, b, c), want) || !same(fma(a, b, c), want))
        expect([a, b, c, fmaExact(a, b, c), fma(a, b, c)]).toEqual([a, b, c, want, want]);
    }
  });

  it('falls back to the exact path outside the safe range', () => {
    const next = rng(99);
    for (let i = 0; i < 20_000; i++) {
      const a = randomDouble(next, -1022, 1023);
      const b = randomDouble(next, -1022, 1023);
      const c = randomDouble(next, -1022, 1023);
      if (!same(fma(a, b, c), fmaExact(a, b, c)))
        expect([a, b, c, fma(a, b, c)]).toEqual([a, b, c, fmaExact(a, b, c)]);
    }
  });
});
