import { z } from 'zod';
import { TsSchema } from './common.js';
import { RoleSchema } from './rbac.js';

/** Password rules shared by the server and the forms (OWASP ASVS 2.1: ≥ 12 characters, long passphrases allowed). */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;
export const PasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, { error: `Use at least ${PASSWORD_MIN_LENGTH} characters.` })
  .max(PASSWORD_MAX_LENGTH, { error: `Use at most ${PASSWORD_MAX_LENGTH} characters.` });

export const EmailSchema = z
  .email()
  .max(254)
  .transform((e) => e.toLowerCase());

export const TotpCodeSchema = z.string().regex(/^\d{6}$/, { error: 'Enter the 6-digit code.' });

export const UserSummarySchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  role: RoleSchema,
});
export type UserSummary = z.infer<typeof UserSummarySchema>;

/** `POST /auth/login` */
export const LoginRequestSchema = z.strictObject({
  email: EmailSchema,
  // Not validated against the password policy here: old passwords must still be able to sign in.
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const TokenResponseSchema = z.object({
  accessToken: z.string(),
  expiresAt: TsSchema,
  /** Desktop only (`X-Client: desktop`). Web clients receive an httpOnly cookie instead. */
  refreshToken: z.string().optional(),
  user: UserSummarySchema,
});
export type TokenResponse = z.infer<typeof TokenResponseSchema>;

export const MfaChallengeSchema = z.object({
  mfaRequired: z.literal(true),
  /** Short-lived token proving the password step succeeded. */
  mfaToken: z.string(),
  /** True when the account must enrol TOTP before it can sign in (admins without MFA). */
  enrollmentRequired: z.boolean(),
});
export type MfaChallenge = z.infer<typeof MfaChallengeSchema>;

export const LoginResponseSchema = z.union([MfaChallengeSchema, TokenResponseSchema]);
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

/** `POST /auth/mfa` */
export const MfaVerifyRequestSchema = z.strictObject({ mfaToken: z.string().min(1), code: TotpCodeSchema });
export type MfaVerifyRequest = z.infer<typeof MfaVerifyRequestSchema>;

/** `POST /auth/mfa/enroll`: first-sign-in enrolment for accounts that must use MFA. */
export const MfaEnrollRequestSchema = z.strictObject({ mfaToken: z.string().min(1) });
export type MfaEnrollRequest = z.infer<typeof MfaEnrollRequestSchema>;

export const MfaSecretResponseSchema = z.object({
  /** Base32 TOTP secret, shown once for manual entry. */
  secret: z.string(),
  /** `otpauth://` URI for authenticator apps. */
  otpauthUri: z.string(),
});
export type MfaSecretResponse = z.infer<typeof MfaSecretResponseSchema>;

/** `POST /auth/refresh`: desktop sends the token in the body; web uses the cookie and sends `{}`. */
export const RefreshRequestSchema = z.strictObject({ refreshToken: z.string().min(1).optional() });
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

export const LogoutRequestSchema = RefreshRequestSchema;

/** Header that desktop clients send to receive the refresh token in the response body. */
export const CLIENT_HEADER = 'x-client';
export const REFRESH_COOKIE = 'cip_refresh';
