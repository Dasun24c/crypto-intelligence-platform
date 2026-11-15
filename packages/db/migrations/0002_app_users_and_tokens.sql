-- Users, refresh tokens, settings and preferences (data model §3).

CREATE TABLE app.users (
  id                   uuid PRIMARY KEY,
  email                citext NOT NULL UNIQUE,
  display_name         text NOT NULL,
  password_hash        text NOT NULL,                       -- argon2id, PHC string
  role                 text NOT NULL CHECK (role IN ('admin', 'analyst', 'viewer')),
  mfa_secret_enc       bytea,                               -- TOTP secret, AES-256-GCM with a server key; NULL = not enrolled
  mfa_last_used_step   integer,                             -- last accepted TOTP time step (replay protection)
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'locked', 'disabled')),
  failed_logins        integer NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  password_changed_at  timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  last_login_at        timestamptz
);

CREATE TABLE app.refresh_tokens (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES app.users (id),
  family_id     uuid NOT NULL,                              -- reuse of a rotated token revokes the whole family
  token_hash    bytea NOT NULL UNIQUE,                      -- SHA-256 of the opaque token
  client        text NOT NULL CHECK (client IN ('web', 'desktop')),
  device_label  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  replaced_by   uuid REFERENCES app.refresh_tokens (id)
);
CREATE INDEX refresh_tokens_family_idx ON app.refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user_idx ON app.refresh_tokens (user_id) WHERE revoked_at IS NULL;

CREATE TABLE app.settings (
  key         text PRIMARY KEY,                             -- 'ai.budget', 'ai.models', 'alerts.defaults', ...
  value       jsonb NOT NULL,                               -- validated by a zod schema per key
  updated_by  uuid REFERENCES app.users (id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.user_preferences (
  user_id     uuid PRIMARY KEY REFERENCES app.users (id),
  prefs       jsonb NOT NULL DEFAULT '{}',                  -- display time zone, watchlist, layouts
  updated_at  timestamptz NOT NULL DEFAULT now()
);
