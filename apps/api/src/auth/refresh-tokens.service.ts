import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import type { RefreshTokenRow } from '@cip/db';
import type { Executor } from '../users/users.repository.js';
import { CLOCK, type Clock, DB } from '../tokens.js';

export const REFRESH_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type RotationResult =
  | { kind: 'rotated'; token: string; row: RefreshTokenRow; previous: RefreshTokenRow }
  | { kind: 'reuse'; familyId: string; userId: string }
  | { kind: 'invalid' };

const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest();

/**
 * Opaque refresh tokens, stored hashed and rotated on every use (architecture §14). Presenting a token
 * that was already rotated means it was copied: the whole family is revoked, logging out both the
 * thief and the user, who must sign in again.
 */
@Injectable()
export class RefreshTokensService {
  constructor(
    @Inject(DB) private readonly db: Executor,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async issue(
    userId: string,
    client: 'web' | 'desktop',
    familyId: string = uuidv7(),
    ex: Executor = this.db,
  ): Promise<{ token: string; row: RefreshTokenRow }> {
    const token = randomBytes(32).toString('base64url');
    const row = await ex
      .insertInto('app.refresh_tokens')
      .values({
        id: uuidv7(),
        user_id: userId,
        family_id: familyId,
        token_hash: hashToken(token),
        client,
        expires_at: new Date(this.clock() + REFRESH_TOKEN_TTL_MS),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { token, row };
  }

  /** Validates and rotates in one transaction; concurrent use of the same token yields one winner. */
  rotate(
    presented: string,
    isUserActive: (userId: string, ex: Executor) => Promise<boolean>,
  ): Promise<RotationResult> {
    return this.db.transaction().execute(async (trx): Promise<RotationResult> => {
      const current = await trx
        .selectFrom('app.refresh_tokens')
        .selectAll()
        .where('token_hash', '=', hashToken(presented))
        .forUpdate()
        .executeTakeFirst();
      if (!current) return { kind: 'invalid' };
      if (current.revoked_at !== null || current.replaced_by !== null) {
        await this.revokeFamily(current.family_id, trx);
        return { kind: 'reuse', familyId: current.family_id, userId: current.user_id };
      }
      if (current.expires_at.getTime() <= this.clock() || !(await isUserActive(current.user_id, trx))) {
        await this.revokeFamily(current.family_id, trx);
        return { kind: 'invalid' };
      }
      const next = await this.issue(current.user_id, current.client, current.family_id, trx);
      await trx
        .updateTable('app.refresh_tokens')
        .set({ revoked_at: new Date(this.clock()), replaced_by: next.row.id })
        .where('id', '=', current.id)
        .execute();
      return { kind: 'rotated', token: next.token, row: next.row, previous: current };
    });
  }

  async findActive(presented: string): Promise<RefreshTokenRow | undefined> {
    return this.db
      .selectFrom('app.refresh_tokens')
      .selectAll()
      .where('token_hash', '=', hashToken(presented))
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
  }

  async revokeFamily(familyId: string, ex: Executor = this.db): Promise<number> {
    const res = await ex
      .updateTable('app.refresh_tokens')
      .set({ revoked_at: new Date(this.clock()) })
      .where('family_id', '=', familyId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return Number(res.numUpdatedRows);
  }

  /** Signs the user out everywhere: password change, account disabled, MFA reset. */
  async revokeAllForUser(userId: string, ex: Executor = this.db, exceptFamilyId?: string): Promise<number> {
    let q = ex
      .updateTable('app.refresh_tokens')
      .set({ revoked_at: new Date(this.clock()) })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null);
    if (exceptFamilyId) q = q.where('family_id', '!=', exceptFamilyId);
    const res = await q.executeTakeFirst();
    return Number(res.numUpdatedRows);
  }
}
