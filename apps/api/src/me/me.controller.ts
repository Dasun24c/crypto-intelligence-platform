import { Body, Controller, Get, HttpCode, Inject, Post, Put, Req } from '@nestjs/common';
import {
  type ChangePasswordRequest,
  ChangePasswordRequestSchema,
  type MeResponse,
  type MfaConfirmRequest,
  MfaConfirmRequestSchema,
  type MfaSecretResponse,
  type Preferences,
  PreferencesSchema,
  UpdatePreferencesRequestSchema,
} from '@cip/contracts';
import { AuditService } from '../audit/audit.service.js';
import { MfaService } from '../auth/mfa.service.js';
import { PasswordService } from '../auth/password.service.js';
import { RefreshTokensService } from '../auth/refresh-tokens.service.js';
import { Access, type ApiRequest, type AuthenticatedUser, clientIp, userAgent } from '../common/access.js';
import { ProblemError } from '../common/problem.js';
import { LIMITS, RateLimiter } from '../common/rate-limiter.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { CLOCK, type Clock, DB } from '../tokens.js';
import { type Executor, toSummary, UsersRepository } from '../users/users.repository.js';

function currentUser(req: ApiRequest): AuthenticatedUser {
  if (!req.user) throw new ProblemError('AUTH_REQUIRED');
  return req.user;
}

@Controller('me')
@Access('authenticated')
export class MeController {
  constructor(
    @Inject(DB) private readonly db: Executor,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly users: UsersRepository,
    private readonly passwords: PasswordService,
    private readonly mfa: MfaService,
    private readonly refreshTokens: RefreshTokensService,
    private readonly audit: AuditService,
    private readonly rateLimiter: RateLimiter,
  ) {}

  @Get()
  async me(@Req() req: ApiRequest): Promise<MeResponse> {
    const row = await this.users.findById(currentUser(req).id);
    if (!row) throw new ProblemError('AUTH_REQUIRED');
    const stored = await this.db
      .selectFrom('app.user_preferences')
      .select('prefs')
      .where('user_id', '=', row.id)
      .executeTakeFirst();
    const parsed = PreferencesSchema.safeParse(stored?.prefs ?? {});
    return {
      user: toSummary(row),
      role: row.role,
      mfaEnabled: row.mfa_secret_enc !== null,
      preferences: parsed.success ? parsed.data : PreferencesSchema.parse({}),
    };
  }

  @Put('preferences')
  async preferences(
    @Body(new ZodPipe(UpdatePreferencesRequestSchema)) body: Preferences,
    @Req() req: ApiRequest,
  ): Promise<Preferences> {
    const userId = currentUser(req).id;
    await this.db
      .insertInto('app.user_preferences')
      .values({ user_id: userId, prefs: body })
      .onConflict((oc) =>
        oc.column('user_id').doUpdateSet({ prefs: body, updated_at: new Date(this.clock()) }),
      )
      .execute();
    return body;
  }

  /** Changing the password signs the account out everywhere, including this session. */
  @Put('password')
  @HttpCode(204)
  async changePassword(
    @Body(new ZodPipe(ChangePasswordRequestSchema)) body: ChangePasswordRequest,
    @Req() req: ApiRequest,
  ): Promise<void> {
    const user = currentUser(req);
    const decision = await this.rateLimiter.take(`password:${user.id}`, LIMITS.login, this.clock());
    if (!decision.allowed) {
      throw new ProblemError('RATE_LIMITED', undefined, {
        headers: { 'retry-after': String(decision.retryAfterSeconds) },
      });
    }
    const row = await this.users.findById(user.id);
    if (!row || !(await this.passwords.verify(row.password_hash, body.currentPassword))) {
      throw new ProblemError('VALIDATION_FAILED', 'The current password is not correct.', {
        errors: [{ path: 'currentPassword', message: 'Incorrect password.' }],
      });
    }
    const passwordHash = await this.passwords.hash(body.newPassword);
    await this.db.transaction().execute(async (trx) => {
      await this.users.update(
        user.id,
        { password_hash: passwordHash, password_changed_at: new Date(this.clock()) },
        trx,
      );
      const revoked = await this.refreshTokens.revokeAllForUser(user.id, trx);
      await this.audit.record(
        {
          actorType: 'user',
          actorUserId: user.id,
          action: 'user.password.changed',
          targetType: 'user',
          targetId: user.id,
          ip: clientIp(req),
          userAgent: userAgent(req),
          details: { sessionsRevoked: revoked },
        },
        trx,
      );
    });
  }

  @Post('mfa/setup')
  @HttpCode(200)
  async mfaSetup(@Req() req: ApiRequest): Promise<MfaSecretResponse> {
    const row = await this.users.findById(currentUser(req).id);
    if (!row) throw new ProblemError('AUTH_REQUIRED');
    if (row.mfa_secret_enc) throw new ProblemError('CONFLICT', 'A second factor is already set up.');
    return this.mfa.startEnrolment(row);
  }

  @Post('mfa/confirm')
  @HttpCode(204)
  async mfaConfirm(
    @Body(new ZodPipe(MfaConfirmRequestSchema)) body: MfaConfirmRequest,
    @Req() req: ApiRequest,
  ): Promise<void> {
    const user = currentUser(req);
    await this.db.transaction().execute(async (trx) => {
      if (!(await this.mfa.completeEnrolment(user.id, body.code, trx))) {
        throw new ProblemError('MFA_REQUIRED', 'The code is not valid, or the setup expired.');
      }
      await this.audit.record(
        {
          actorType: 'user',
          actorUserId: user.id,
          action: 'user.mfa.enabled',
          targetType: 'user',
          targetId: user.id,
          ip: clientIp(req),
          userAgent: userAgent(req),
        },
        trx,
      );
    });
  }
}
