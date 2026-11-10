import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretBox } from './secret-box.js';

const key = randomBytes(32).toString('base64');

describe('SecretBox', () => {
  it('round-trips and never stores the plaintext', () => {
    const box = new SecretBox(key);
    const sealed = box.seal('JBSWY3DPEHPK3PXP', 'user-1');
    expect(sealed.includes(Buffer.from('JBSWY3DPEHPK3PXP'))).toBe(false);
    expect(box.open(sealed, 'user-1')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('uses a fresh IV per seal', () => {
    const box = new SecretBox(key);
    expect(box.seal('same', 'u').equals(box.seal('same', 'u'))).toBe(false);
  });

  it('refuses a ciphertext moved to another owner, tampered with, or opened with another key', () => {
    const box = new SecretBox(key);
    const sealed = box.seal('secret', 'user-1');
    expect(() => box.open(sealed, 'user-2')).toThrow();
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => box.open(tampered, 'user-1')).toThrow();
    expect(() => new SecretBox(randomBytes(32).toString('base64')).open(sealed, 'user-1')).toThrow();
  });

  it('rejects keys of the wrong size', () => {
    expect(() => new SecretBox(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });
});
