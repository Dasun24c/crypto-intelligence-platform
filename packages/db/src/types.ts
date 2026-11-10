import type { ColumnType, Generated, GeneratedAlways, Insertable, Selectable, Updateable } from 'kysely';

/**
 * Kysely table types for the `app` schema (data model §3). Column names stay snake_case, as in SQL;
 * repositories map them to the camelCase API contracts. Keep in step with the migrations: the
 * integration tests compare these columns with information_schema.
 */
export interface UsersTable {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  role: 'admin' | 'analyst' | 'viewer';
  mfa_secret_enc: Buffer | null;
  mfa_last_used_step: number | null;
  status: ColumnType<'active' | 'locked' | 'disabled', 'active' | 'locked' | 'disabled' | undefined>;
  failed_logins: Generated<number>;
  locked_until: Date | null;
  password_changed_at: Generated<Date>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  last_login_at: Date | null;
}

export interface RefreshTokensTable {
  id: string;
  user_id: string;
  family_id: string;
  token_hash: Buffer;
  client: 'web' | 'desktop';
  device_label: string | null;
  created_at: Generated<Date>;
  expires_at: Date;
  revoked_at: Date | null;
  replaced_by: string | null;
}

export interface AuditLogTable {
  /** bigint: returned as a string by node-postgres. */
  id: GeneratedAlways<string>;
  /** Assigned by the chain trigger. */
  chain_seq: ColumnType<string, never, never>;
  at: Generated<Date>;
  actor_type: 'user' | 'system';
  actor_user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  ip: string | null;
  user_agent: string | null;
  details: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, never>;
  prev_hash: ColumnType<Buffer, never, never>;
  hash: ColumnType<Buffer, never, never>;
}

export interface SettingsTable {
  key: string;
  value: unknown;
  updated_by: string | null;
  updated_at: Generated<Date>;
}

export interface UserPreferencesTable {
  user_id: string;
  prefs: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown>>;
  updated_at: Generated<Date>;
}

export interface Database {
  'app.users': UsersTable;
  'app.refresh_tokens': RefreshTokensTable;
  'app.audit_log': AuditLogTable;
  'app.settings': SettingsTable;
  'app.user_preferences': UserPreferencesTable;
}

export type UserRow = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;
export type RefreshTokenRow = Selectable<RefreshTokensTable>;
export type AuditLogRow = Selectable<AuditLogTable>;
export type NewAuditLogRow = Insertable<AuditLogTable>;
