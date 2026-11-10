import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  otpauthUri,
  totp,
  totpStep,
  verifyTotp,
} from './totp.js';

// RFC 6238 appendix B, SHA-1 column: ASCII key "12345678901234567890", 8 digits.
const RFC_KEY = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP (RFC 6238)', () => {
  it.each(RFC_VECTORS)('matches the RFC test vector at T=%i', (seconds, expected) => {
    expect(hotp(RFC_KEY, Math.floor(seconds / 30), 8)).toBe(expected);
  });

  it('round-trips base32 (RFC 4648)', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    expect(base32Decode('mzxw 6ytb oi======').toString()).toBe('foobar');
    expect(() => base32Decode('not*base32')).toThrow();
  });

  it('generates 160-bit secrets', () => {
    const secret = generateTotpSecret();
    expect(base32Decode(secret)).toHaveLength(20);
    expect(generateTotpSecret()).not.toBe(secret);
  });

  it('accepts the current code and one step of drift, refuses older codes', () => {
    const secret = generateTotpSecret();
    const now = Date.UTC(2026, 10, 10, 12, 0, 15);
    const step = totpStep(now);
    expect(verifyTotp(secret, totp(secret, now), now)).toBe(step);
    expect(verifyTotp(secret, totp(secret, now - 30_000), now)).toBe(step - 1);
    expect(verifyTotp(secret, totp(secret, now + 30_000), now)).toBe(step + 1);
    expect(verifyTotp(secret, totp(secret, now - 90_000), now)).toBeNull();
  });

  it('refuses a code whose step was already used (replay)', () => {
    const secret = generateTotpSecret();
    const now = Date.UTC(2026, 10, 10, 12, 0, 0);
    const code = totp(secret, now);
    const used = verifyTotp(secret, code, now);
    expect(used).not.toBeNull();
    expect(verifyTotp(secret, code, now, { lastUsedStep: used })).toBeNull();
  });

  it('refuses malformed codes', () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, '12345', Date.now())).toBeNull();
    expect(verifyTotp(secret, 'abcdef', Date.now())).toBeNull();
  });

  it('builds an otpauth URI that authenticator apps accept', () => {
    const uri = new URL(
      otpauthUri({ secret: 'ABC', account: 'ana@example.test', issuer: 'Crypto Intelligence' }),
    );
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.searchParams.get('secret')).toBe('ABC');
    expect(uri.searchParams.get('period')).toBe('30');
  });
});
