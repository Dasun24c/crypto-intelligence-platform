-- Alerts and notifications (data model §7; architecture §9; ADR 020). Phase 8.

-- ---------------------------------------------------------------- rules

-- A user's alert rule. `scope` and `condition` are validated by contracts (AlertScope,
-- AlertCondition) before they are written. A removed rule keeps its row, `deleted_at` set, so its
-- alerts stay in the inbox with their rule's name; it is never evaluated again.
CREATE TABLE alerts.rules (
  id            uuid PRIMARY KEY,
  owner_id      uuid NOT NULL REFERENCES app.users (id),
  name          text NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,
  scope         jsonb NOT NULL DEFAULT '{}',              -- instruments, venues
  condition     jsonb NOT NULL,                           -- one of the twelve kinds
  severity      text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  cooldown_sec  integer NOT NULL DEFAULT 300 CHECK (cooldown_sec BETWEEN 0 AND 86400),
  channels      text[] NOT NULL DEFAULT '{in_app}'
                CHECK (channels <@ ARRAY['in_app', 'desktop', 'web'] AND 'in_app' = ANY (channels)),
  quiet_hours   jsonb,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX ON alerts.rules (owner_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------- events

-- One row per fired occurrence. `dedupe_key` names one logical occurrence (a setup reaching a state,
-- a detection, a crossing at an instant), so the same occurrence never fires twice for a rule, even
-- when its source is processed again after a restart. `late`: fired by catch-up processing.
CREATE TABLE alerts.events (
  id           uuid PRIMARY KEY,
  rule_id      uuid NOT NULL REFERENCES alerts.rules (id),
  fired_at     timestamptz NOT NULL,
  dedupe_key   text NOT NULL,
  severity     text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  title        text NOT NULL,
  body         text NOT NULL,
  source_refs  jsonb NOT NULL DEFAULT '{}',
  late         boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, dedupe_key)
);
CREATE INDEX ON alerts.events (rule_id, fired_at DESC);

-- ---------------------------------------------------------------- notifications

-- Delivery of an event to a user, one row per channel the rule chose. The `in_app` row is the inbox
-- item (its `read_at` is the user's); `desktop` and `web` rows record whether the push reached an
-- open app (`sent`) or waited for the inbox summary after reconnecting (`pending`).
CREATE TABLE alerts.notifications (
  id          uuid PRIMARY KEY,
  event_id    uuid NOT NULL REFERENCES alerts.events (id),
  user_id     uuid NOT NULL REFERENCES app.users (id),
  channel     text NOT NULL CHECK (channel IN ('in_app', 'desktop', 'web')),
  status      text NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz,
  UNIQUE (event_id, user_id, channel)
);
CREATE INDEX ON alerts.notifications (user_id, read_at, created_at DESC);

-- ---------------------------------------------------------------- grants (data model §9)

-- The API manages rules and marks inbox items read; the analyzer fires events; the jobs service
-- delivers them.
GRANT SELECT ON alerts.rules, alerts.events, alerts.notifications TO svc_api, svc_analyzer, svc_jobs;
GRANT INSERT, UPDATE ON alerts.rules TO svc_api;
GRANT UPDATE (read_at) ON alerts.notifications TO svc_api;
GRANT INSERT ON alerts.events TO svc_analyzer;
GRANT INSERT, UPDATE ON alerts.notifications TO svc_jobs;
