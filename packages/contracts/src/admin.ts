import { z } from 'zod';
import { EmailSchema, PasswordSchema } from './auth.js';
import { TsSchema } from './common.js';
import { RoleSchema } from './rbac.js';

export const USER_STATUSES = ['active', 'locked', 'disabled'] as const;
export const UserStatusSchema = z.enum(USER_STATUSES);
export type UserStatus = z.infer<typeof UserStatusSchema>;

export const AdminUserSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  role: RoleSchema,
  status: UserStatusSchema,
  mfaEnabled: z.boolean(),
  createdAt: TsSchema,
  lastLoginAt: TsSchema.nullable(),
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

/** `POST /admin/users` */
export const CreateUserRequestSchema = z.strictObject({
  email: EmailSchema,
  displayName: z.string().trim().min(1).max(100),
  role: RoleSchema,
  /** Initial password, handed to the user out of band. */
  password: PasswordSchema,
});
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;

/** `PATCH /admin/users/{id}` */
export const UpdateUserRequestSchema = z
  .strictObject({
    displayName: z.string().trim().min(1).max(100).optional(),
    role: RoleSchema.optional(),
    /** `locked` is set by the lockout policy; admins can only activate or disable. */
    status: z.enum(['active', 'disabled']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { error: 'Nothing to update.' });
export type UpdateUserRequest = z.infer<typeof UpdateUserRequestSchema>;

/** `GET /admin/audit` */
export const AuditQuerySchema = z.strictObject({
  actor: z.uuid().optional(),
  action: z.string().max(100).optional(),
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});
export type AuditQuery = z.infer<typeof AuditQuerySchema>;

export const AuditEntrySchema = z.object({
  id: z.string(),
  at: TsSchema,
  actorType: z.enum(['user', 'system']),
  actorUserId: z.uuid().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  ip: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

/** `GET /admin/audit/verify`: result of walking the hash chain. */
export const AuditChainStatusSchema = z.object({
  ok: z.boolean(),
  checkedRows: z.number().int(),
  firstBrokenSeq: z.number().int().nullable(),
});
export type AuditChainStatus = z.infer<typeof AuditChainStatusSchema>;
