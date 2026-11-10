import { Injectable } from '@nestjs/common';
import { type Algorithm, hash, verify } from '@node-rs/argon2';

/**
 * argon2id with the OWASP Password Storage Cheat Sheet's first option: 19 MiB memory, 2 iterations,
 * parallelism 1. Parameters are stored in the PHC string, so they can be raised later and old
 * hashes still verify (and are re-hashed on the next successful login).
 */
// `Algorithm` is an ambient const enum, which isolated-module builds cannot inline: 2 is Argon2id.
const ARGON2ID = 2 as Algorithm;
export const ARGON2_OPTIONS = { algorithm: ARGON2ID, memoryCost: 19_456, timeCost: 2, parallelism: 1 };
const CURRENT_PARAMS = `m=${ARGON2_OPTIONS.memoryCost},t=${ARGON2_OPTIONS.timeCost},p=${ARGON2_OPTIONS.parallelism}`;

@Injectable()
export class PasswordService {
  /** Verifying against this keeps the timing of "unknown e-mail" close to "wrong password". */
  private readonly dummyHash: Promise<string>;

  constructor() {
    this.dummyHash = hash('dummy password for timing equalisation', ARGON2_OPTIONS);
  }

  hash(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  async burnTime(password: string): Promise<void> {
    await this.verify(await this.dummyHash, password);
  }

  needsRehash(passwordHash: string): boolean {
    return !passwordHash.startsWith('$argon2id$') || !passwordHash.includes(CURRENT_PARAMS);
  }
}
