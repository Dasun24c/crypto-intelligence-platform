import type {
  AuditLogTable,
  RefreshTokensTable,
  SettingsTable,
  UserPreferencesTable,
  UsersTable,
} from './types.js';

type Columns<T> = { readonly [K in keyof Required<T>]: true };

const users = {
  id: true,
  email: true,
  display_name: true,
  password_hash: true,
  role: true,
  mfa_secret_enc: true,
  mfa_last_used_step: true,
  status: true,
  failed_logins: true,
  locked_until: true,
  password_changed_at: true,
  created_at: true,
  updated_at: true,
  last_login_at: true,
} as const satisfies Columns<UsersTable>;

const refreshTokens = {
  id: true,
  user_id: true,
  family_id: true,
  token_hash: true,
  client: true,
  device_label: true,
  created_at: true,
  expires_at: true,
  revoked_at: true,
  replaced_by: true,
} as const satisfies Columns<RefreshTokensTable>;

const auditLog = {
  id: true,
  chain_seq: true,
  at: true,
  actor_type: true,
  actor_user_id: true,
  action: true,
  target_type: true,
  target_id: true,
  ip: true,
  user_agent: true,
  details: true,
  prev_hash: true,
  hash: true,
} as const satisfies Columns<AuditLogTable>;

const settings = {
  key: true,
  value: true,
  updated_by: true,
  updated_at: true,
} as const satisfies Columns<SettingsTable>;

const userPreferences = {
  user_id: true,
  prefs: true,
  updated_at: true,
} as const satisfies Columns<UserPreferencesTable>;

/**
 * Runtime list of the columns declared in types.ts. `satisfies` makes the compiler reject a missing
 * or extra column, and the integration test compares these with the live schema.
 */
export const TABLE_COLUMNS: Record<string, readonly string[]> = {
  'app.users': Object.keys(users),
  'app.refresh_tokens': Object.keys(refreshTokens),
  'app.audit_log': Object.keys(auditLog),
  'app.settings': Object.keys(settings),
  'app.user_preferences': Object.keys(userPreferences),
};
