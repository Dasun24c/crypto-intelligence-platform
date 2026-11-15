import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import {
  type AdminUser,
  type CreateUserRequest,
  CreateUserRequestSchema,
  type Page,
  type UpdateUserRequest,
  UpdateUserRequestSchema,
} from '@cip/contracts';
import type { UserUpdate } from '@cip/db';
import { AuditService, type AuditEvent } from '../audit/audit.service.js';
import { PasswordService } from '../auth/password.service.js';
import { RefreshTokensService } from '../auth/refresh-tokens.service.js';
import { Access, type ApiRequest, clientIp, userAgent } from '../common/access.js';
import { ProblemError } from '../common/problem.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { CLOCK, type Clock, DB } from '../tokens.js';
import { effectiveStatus, type Executor, toAdminUser, UsersRepository } from '../users/users.repository.js';

const IdPipe = new ZodPipe(z.uuid());

@Controller('admin/users')
@Access('users.manage')
export class AdminUsersController {
  constructor(
    @Inject(DB) private readonly db: Executor,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly users: UsersRepository,
    private readonly passwords: PasswordService,
    private readonly refreshTokens: RefreshTokensService,
    private readonly audit: AuditService,
  ) {}

  private event(
    req: ApiRequest,
    action: string,
    targetId: string,
    details: Record<string, unknown>,
  ): AuditEvent {
    return {
      actorType: 'user',
      actorUserId: req.user?.id ?? null,
      action,
      targetType: 'user',
      targetId,
      ip: clientIp(req),
      userAgent: userAgent(req),
      details,
    };
  }

  @Get()
  async list(): Promise<Page<AdminUser>> {
    const now = this.clock();
    return { items: (await this.users.list()).map((u) => toAdminUser(u, now)), nextCursor: null };
  }

  @Get(':id')
  async get(@Param('id', IdPipe) id: string): Promise<AdminUser> {
    const row = await this.users.findById(id);
    if (!row) throw new ProblemError('NOT_FOUND');
    return toAdminUser(row, this.clock());
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body(new ZodPipe(CreateUserRequestSchema)) body: CreateUserRequest,
    @Req() req: ApiRequest,
  ): Promise<AdminUser> {
    if (await this.users.findByEmail(body.email))
      throw new ProblemError('CONFLICT', 'A user with this e-mail exists.');
    const passwordHash = await this.passwords.hash(body.password);
    const row = await this.db.transaction().execute(async (trx) => {
      const created = await this.users.insert(
        {
          id: uuidv7(),
          email: body.email,
          display_name: body.displayName,
          role: body.role,
          password_hash: passwordHash,
          password_changed_at: new Date(this.clock()),
        },
        trx,
      );
      await this.audit.record(
        this.event(req, 'user.created', created.id, { email: body.email, role: body.role }),
        trx,
      );
      return created;
    });
    return toAdminUser(row, this.clock());
  }

  @Patch(':id')
  async update(
    @Param('id', IdPipe) id: string,
    @Body(new ZodPipe(UpdateUserRequestSchema)) body: UpdateUserRequest,
    @Req() req: ApiRequest,
  ): Promise<AdminUser> {
    const row = await this.db.transaction().execute(async (trx) => {
      const before = await this.users.lockById(id, trx);
      if (!before) throw new ProblemError('NOT_FOUND');
      const now = this.clock();
      const removesAdmin =
        before.role === 'admin' &&
        before.status !== 'disabled' &&
        ((body.role !== undefined && body.role !== 'admin') || body.status === 'disabled');
      if (removesAdmin) {
        // Serialise with other admin changes, then make sure an active admin remains.
        await trx.selectFrom('app.users').select('id').where('role', '=', 'admin').forUpdate().execute();
        if ((await this.users.countActiveAdmins(trx)) <= 1) {
          throw new ProblemError('CONFLICT', 'At least one active admin must remain.');
        }
      }

      const patch: UserUpdate = {};
      const events: AuditEvent[] = [];
      if (body.displayName !== undefined && body.displayName !== before.display_name) {
        patch.display_name = body.displayName;
        events.push(
          this.event(req, 'user.updated', id, {
            displayName: { from: before.display_name, to: body.displayName },
          }),
        );
      }
      if (body.role !== undefined && body.role !== before.role) {
        patch.role = body.role;
        events.push(this.event(req, 'user.role.changed', id, { from: before.role, to: body.role }));
      }
      const statusBefore = effectiveStatus(before, now);
      if (body.status !== undefined && body.status !== statusBefore) {
        patch.status = body.status;
        if (body.status === 'active') Object.assign(patch, { failed_logins: 0, locked_until: null });
        events.push(
          this.event(req, body.status === 'disabled' ? 'user.disabled' : 'user.enabled', id, {
            from: statusBefore,
          }),
        );
      }
      if (events.length === 0) return before;

      const after = await this.users.update(id, patch, trx);
      if (body.status === 'disabled') await this.refreshTokens.revokeAllForUser(id, trx);
      for (const event of events) await this.audit.record(event, trx);
      return after ?? before;
    });
    return toAdminUser(row, this.clock());
  }

  /** Clears the second factor; admins must enrol again at their next sign-in. */
  @Post(':id/reset-mfa')
  @HttpCode(204)
  async resetMfa(@Param('id', IdPipe) id: string, @Req() req: ApiRequest): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const before = await this.users.lockById(id, trx);
      if (!before) throw new ProblemError('NOT_FOUND');
      await this.users.update(id, { mfa_secret_enc: null, mfa_last_used_step: null }, trx);
      const revoked = await this.refreshTokens.revokeAllForUser(id, trx);
      await this.audit.record(
        this.event(req, 'user.mfa.reset', id, {
          hadMfa: before.mfa_secret_enc !== null,
          sessionsRevoked: revoked,
        }),
        trx,
      );
    });
  }
}
