import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { UserRow } from '@cip/db';
import type { ApiConfig } from '../config.js';
import { API_CONFIG, CLOCK, type Clock, REDIS } from '../tokens.js';
import type { Executor } from '../users/users.repository.js';
import { UsersRepository } from '../users/users.repository.js';
import { SecretBox } from './secret-box.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp.js';

const ISSUER = 'Crypto Intelligence Platform';
const PENDING_TTL_SECONDS = 10 * 60;
const pendingKey = (userId: string) => `mfa:pending:${userId}`;

/**
 * TOTP enrolment and verification. A new secret is held (encrypted) in Redis until the user proves
 * possession with a valid code; only then is it stored on the account. Accepted time steps are
 * recorded so a code cannot be replayed.
 */
@Injectable()
export class MfaService {
  private readonly box: SecretBox;

  constructor(
    @Inject(API_CONFIG) config: ApiConfig,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly users: UsersRepository,
  ) {
    this.box = new SecretBox(config.MFA_ENCRYPTION_KEY);
  }

  async startEnrolment(user: Pick<UserRow, 'id' | 'email'>): Promise<{ secret: string; otpauthUri: string }> {
    const secret = generateTotpSecret();
    const sealed = this.box.seal(secret, user.id).toString('base64');
    await this.redis.set(pendingKey(user.id), sealed, 'EX', PENDING_TTL_SECONDS);
    return { secret, otpauthUri: otpauthUri({ secret, account: user.email, issuer: ISSUER }) };
  }

  /** Confirms the pending secret with a code and stores it on the account. False if no match. */
  async completeEnrolment(userId: string, code: string, ex: Executor): Promise<boolean> {
    const sealed = await this.redis.get(pendingKey(userId));
    if (!sealed) return false;
    const box = Buffer.from(sealed, 'base64');
    const step = verifyTotp(this.box.open(box, userId), code, this.clock());
    if (step === null) return false;
    await this.users.update(userId, { mfa_secret_enc: box, mfa_last_used_step: step }, ex);
    await this.redis.del(pendingKey(userId));
    return true;
  }

  async hasPendingEnrolment(userId: string): Promise<boolean> {
    return (await this.redis.exists(pendingKey(userId))) === 1;
  }

  /** Verifies a code for an enrolled user and records the step. False if wrong or replayed. */
  async verify(user: UserRow, code: string, ex: Executor): Promise<boolean> {
    if (!user.mfa_secret_enc) return false;
    const secret = this.box.open(user.mfa_secret_enc, user.id);
    const step = verifyTotp(secret, code, this.clock(), { lastUsedStep: user.mfa_last_used_step });
    if (step === null) return false;
    // Conditional update: two requests racing with the same code cannot both succeed.
    const res = await ex
      .updateTable('app.users')
      .set({ mfa_last_used_step: step })
      .where('id', '=', user.id)
      .where((eb) => eb.or([eb('mfa_last_used_step', 'is', null), eb('mfa_last_used_step', '<', step)]))
      .executeTakeFirst();
    return res.numUpdatedRows === 1n;
  }
}
