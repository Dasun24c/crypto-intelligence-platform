import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import {
  type LoginRequest,
  type MfaChallenge,
  type MfaSecretResponse,
  mfaMandatory,
  type TokenResponse,
} from '@cip/contracts';
import type { UserRow } from '@cip/db';
import type { Logger } from '@cip/observability';
import { AuditService } from '../audit/audit.service.js';
import { ProblemError } from '../common/problem.js';
import { LIMITS, RateLimiter } from '../common/rate-limiter.js';
import { CLOCK, type Clock, DB, LOGGER, REDIS } from '../tokens.js';
import { effectiveStatus, type Executor, toSummary, UsersRepository } from '../users/users.repository.js';
import { MfaService } from './mfa.service.js';
import { PasswordService } from './password.service.js';
import { RefreshTokensService } from './refresh-tokens.service.js';
import { MFA_TOKEN_TTL_SECONDS, TokenService } from './token.service.js';

export type ClientKind = 'web' | 'desktop';

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
  client: ClientKind;
}

/** Issued tokens; the controller puts web refresh tokens into the cookie instead of the body. */
export interface IssuedSession {
  response: TokenResponse;
  refreshToken: string;
  client: ClientKind;
}

/** Progressive lockout (architecture §14): failures → lock length. Every 5 further failures lock for an hour. */
export function lockoutSeconds(failures: number): number | null {
  if (failures < 5 || failures % 5 !== 0) return null;
  if (failures === 5) return 60;
  if (failures === 10) return 5 * 60;
  if (failures === 15) return 15 * 60;
  return 60 * 60;
}

const GENERIC_LOGIN_FAILURE = 'Invalid e-mail or password, or the account is temporarily locked.';

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Executor,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly log: Logger,
    private readonly users: UsersRepository,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly refreshTokens: RefreshTokensService,
    private readonly mfa: MfaService,
    private readonly audit: AuditService,
    private readonly rateLimiter: RateLimiter,
  ) {}

  private async limit(keys: string[], ctx: RequestContext): Promise<void> {
    for (const key of keys) {
      const decision = await this.rateLimiter.take(key, LIMITS.login, this.clock());
      if (!decision.allowed) {
        this.log.warn({ key, ip: ctx.ip }, 'authentication rate limit hit');
        throw new ProblemError('RATE_LIMITED', 'Too many attempts. Try again later.', {
          headers: { 'retry-after': String(decision.retryAfterSeconds) },
        });
      }
    }
  }

  private failed(ctx: RequestContext, details: Record<string, unknown>, user?: UserRow, ex?: Executor) {
    return this.audit.record(
      {
        actorType: user ? 'user' : 'system',
        actorUserId: user?.id ?? null,
        action: 'auth.login.failed',
        targetType: 'user',
        targetId: user?.id ?? null,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        details: { client: ctx.client, ...details },
      },
      ex,
    );
  }

  async login(input: LoginRequest, ctx: RequestContext): Promise<MfaChallenge | IssuedSession> {
    await this.limit([`login:ip:${ctx.ip ?? 'unknown'}`, `login:account:${input.email}`], ctx);
    const now = this.clock();
    const user = await this.users.findByEmail(input.email);

    if (!user) {
      await this.passwords.burnTime(input.password);
      await this.failed(ctx, { email: input.email, reason: 'unknown_user' });
      throw new ProblemError('AUTH_REQUIRED', GENERIC_LOGIN_FAILURE);
    }
    const status = effectiveStatus(user, now);
    if (status !== 'active') {
      await this.passwords.burnTime(input.password);
      await this.failed(ctx, { reason: status === 'disabled' ? 'disabled' : 'locked' }, user);
      throw new ProblemError('AUTH_REQUIRED', GENERIC_LOGIN_FAILURE);
    }

    if (!(await this.passwords.verify(user.password_hash, input.password))) {
      await this.db.transaction().execute(async (trx) => {
        const locked = await this.users.lockById(user.id, trx);
        const failures = (locked?.failed_logins ?? user.failed_logins) + 1;
        const lockFor = lockoutSeconds(failures);
        await this.users.update(
          user.id,
          lockFor
            ? { failed_logins: failures, status: 'locked', locked_until: new Date(now + lockFor * 1000) }
            : { failed_logins: failures },
          trx,
        );
        await this.failed(ctx, { reason: 'bad_password', failedLogins: failures }, user, trx);
        if (lockFor) {
          await this.audit.record(
            {
              actorType: 'system',
              action: 'auth.lockout',
              targetType: 'user',
              targetId: user.id,
              ip: ctx.ip,
              details: { failedLogins: failures, lockedForSeconds: lockFor },
            },
            trx,
          );
        }
      });
      throw new ProblemError('AUTH_REQUIRED', GENERIC_LOGIN_FAILURE);
    }

    const patch: Parameters<UsersRepository['update']>[1] = {};
    if (user.failed_logins > 0 || user.status === 'locked') {
      Object.assign(patch, { failed_logins: 0, status: 'active', locked_until: null });
    }
    if (this.passwords.needsRehash(user.password_hash))
      patch.password_hash = await this.passwords.hash(input.password);
    if (Object.keys(patch).length > 0) await this.users.update(user.id, patch);

    if (user.mfa_secret_enc || mfaMandatory(user.role)) {
      const enroll = !user.mfa_secret_enc;
      return {
        mfaRequired: true,
        mfaToken: await this.tokens.issueMfaToken(user.id, ctx.client, enroll),
        enrollmentRequired: enroll,
      };
    }
    return this.completeLogin(user, ctx, { mfa: false });
  }

  /** Starts TOTP enrolment during first sign-in, for accounts that must use MFA (admins). */
  async enrollDuringLogin(mfaToken: string, ctx: RequestContext): Promise<MfaSecretResponse> {
    const claims = await this.tokens.verifyMfaToken(mfaToken);
    await this.limit([`mfa:user:${claims.userId}`, `mfa:ip:${ctx.ip ?? 'unknown'}`], ctx);
    if (!claims.enroll) throw new ProblemError('CONFLICT', 'This account already has a second factor.');
    const user = await this.users.findById(claims.userId);
    if (!user || effectiveStatus(user, this.clock()) !== 'active') throw new ProblemError('AUTH_REQUIRED');
    if (user.mfa_secret_enc) throw new ProblemError('CONFLICT', 'This account already has a second factor.');
    return this.mfa.startEnrolment(user);
  }

  async verifyMfa(mfaToken: string, code: string, ctx: RequestContext): Promise<IssuedSession> {
    const claims = await this.tokens.verifyMfaToken(mfaToken);
    await this.limit([`mfa:user:${claims.userId}`, `mfa:ip:${ctx.ip ?? 'unknown'}`], ctx);
    const user = await this.users.findById(claims.userId);
    if (!user || effectiveStatus(user, this.clock()) !== 'active') throw new ProblemError('AUTH_REQUIRED');

    const ok = await this.db.transaction().execute(async (trx) => {
      if (claims.enroll) {
        if (user.mfa_secret_enc) return false;
        const enrolled = await this.mfa.completeEnrolment(user.id, code, trx);
        if (enrolled) {
          await this.audit.record(
            {
              actorType: 'user',
              actorUserId: user.id,
              action: 'user.mfa.enabled',
              targetType: 'user',
              targetId: user.id,
              ip: ctx.ip,
              userAgent: ctx.userAgent,
              details: { during: 'first_sign_in' },
            },
            trx,
          );
        }
        return enrolled;
      }
      return this.mfa.verify(user, code, trx);
    });
    if (!ok) {
      await this.failed(ctx, { reason: 'bad_mfa_code', stage: claims.enroll ? 'enrolment' : 'mfa' }, user);
      throw new ProblemError('MFA_REQUIRED', 'The code is not valid.');
    }
    // One successful use per MFA token.
    const fresh = await this.redis.set(`mfa:used:${claims.jti}`, '1', 'EX', MFA_TOKEN_TTL_SECONDS, 'NX');
    if (fresh !== 'OK')
      throw new ProblemError('AUTH_REQUIRED', 'This sign-in attempt was already completed.');
    return this.completeLogin(user, { ...ctx, client: claims.client }, { mfa: true });
  }

  private async completeLogin(
    user: UserRow,
    ctx: RequestContext,
    how: { mfa: boolean },
  ): Promise<IssuedSession> {
    const session = await this.db.transaction().execute(async (trx) => {
      await this.users.update(user.id, { last_login_at: new Date(this.clock()) }, trx);
      await this.audit.record(
        {
          actorType: 'user',
          actorUserId: user.id,
          action: 'auth.login.succeeded',
          targetType: 'user',
          targetId: user.id,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          details: { client: ctx.client, mfa: how.mfa },
        },
        trx,
      );
      return this.refreshTokens.issue(user.id, ctx.client, undefined, trx);
    });
    return this.session(user, session.token, ctx.client);
  }

  private async session(user: UserRow, refreshToken: string, client: ClientKind): Promise<IssuedSession> {
    const access = await this.tokens.issueAccessToken({ userId: user.id, role: user.role });
    return {
      response: { accessToken: access.token, expiresAt: access.expiresAt, user: toSummary(user) },
      refreshToken,
      client,
    };
  }

  async refresh(presented: string, ctx: RequestContext): Promise<IssuedSession> {
    const result = await this.refreshTokens.rotate(presented, async (userId, ex) => {
      const row = await this.users.findById(userId, ex);
      return row !== undefined && effectiveStatus(row, this.clock()) === 'active';
    });
    if (result.kind === 'reuse') {
      await this.audit.record({
        actorType: 'system',
        action: 'auth.refresh.reuse_detected',
        targetType: 'user',
        targetId: result.userId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        details: { familyId: result.familyId },
      });
      this.log.warn(
        { userId: result.userId, familyId: result.familyId },
        'refresh token reuse: family revoked',
      );
      throw new ProblemError('AUTH_REQUIRED', 'The session has ended. Sign in again.');
    }
    if (result.kind === 'invalid')
      throw new ProblemError('AUTH_REQUIRED', 'The session has ended. Sign in again.');
    const user = await this.users.findById(result.row.user_id);
    if (!user) throw new ProblemError('AUTH_REQUIRED');
    return this.session(user, result.token, result.row.client);
  }

  async logout(presented: string | undefined, ctx: RequestContext): Promise<void> {
    if (!presented) return;
    const token = await this.refreshTokens.findActive(presented);
    if (!token) return;
    await this.db.transaction().execute(async (trx) => {
      await this.refreshTokens.revokeFamily(token.family_id, trx);
      await this.audit.record(
        {
          actorType: 'user',
          actorUserId: token.user_id,
          action: 'auth.logout',
          targetType: 'user',
          targetId: token.user_id,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          details: { client: token.client },
        },
        trx,
      );
    });
  }
}
