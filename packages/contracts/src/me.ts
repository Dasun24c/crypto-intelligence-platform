import { z } from 'zod';
import { PasswordSchema, TotpCodeSchema, UserSummarySchema } from './auth.js';
import { RoleSchema } from './rbac.js';

export const PreferencesSchema = z.strictObject({
  /** IANA time zone used to display times; storage and APIs stay in UTC. */
  displayTimeZone: z.string().min(1).max(64).default('UTC'),
  watchlist: z.array(z.string().max(64)).max(100).default([]),
  layouts: z.record(z.string().max(64), z.unknown()).default({}),
});
export type Preferences = z.infer<typeof PreferencesSchema>;

/** `GET /me` */
export const MeResponseSchema = z.object({
  user: UserSummarySchema,
  role: RoleSchema,
  mfaEnabled: z.boolean(),
  preferences: PreferencesSchema,
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

/** `PUT /me/preferences` */
export const UpdatePreferencesRequestSchema = PreferencesSchema;

/** `PUT /me/password` */
export const ChangePasswordRequestSchema = z
  .strictObject({ currentPassword: z.string().min(1).max(256), newPassword: PasswordSchema })
  .refine((v) => v.currentPassword !== v.newPassword, {
    error: 'The new password must differ from the current one.',
    path: ['newPassword'],
  });
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

/** `POST /me/mfa/confirm` */
export const MfaConfirmRequestSchema = z.strictObject({ code: TotpCodeSchema });
export type MfaConfirmRequest = z.infer<typeof MfaConfirmRequestSchema>;
