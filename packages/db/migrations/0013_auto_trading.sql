-- Phase 16: automatic practice trading (REQUIREMENTS §11 revision 5, proposal 002, ADR 022).
-- A user's own rules place practice orders on confirmed setups, inside the broker. Practice balances
-- only: nothing here reaches an exchange.

-- ---------------------------------------------------------------- orders placed automatically

ALTER TABLE trading.orders DROP CONSTRAINT orders_source_check;
ALTER TABLE trading.orders
  ADD CONSTRAINT orders_source_check CHECK (source IN ('manual', 'setup', 'auto'));

-- The broker journals setup transitions and strategy changes too, with the auto-trader's digest
-- lines (orders placed, decisions, pauses) beside the fills', so a replay checks both (16.6).
ALTER TABLE trading.journal DROP CONSTRAINT journal_kind_check;
ALTER TABLE trading.journal
  ADD CONSTRAINT journal_kind_check CHECK (kind IN ('load', 'place', 'cancel', 'reset', 'trade', 'setup', 'strategy'));
ALTER TABLE trading.journal ADD COLUMN decisions text[] NOT NULL DEFAULT '{}';

-- Its position in an:events, the third stream it reads.
ALTER TABLE trading.broker_state ADD COLUMN setups_cursor text NOT NULL DEFAULT '0-0';

-- ---------------------------------------------------------------- tables

-- One set of rules per user. The api writes the rules and the switch; the broker writes only the pause.
CREATE TABLE trading.strategies (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL UNIQUE REFERENCES app.users (id),
  enabled       boolean NOT NULL DEFAULT false,
  rules         jsonb NOT NULL,                               -- validated by AutoRulesSchema
  version       int NOT NULL DEFAULT 0 CHECK (version >= 0),  -- raised by every change
  paused_until  timestamptz,                                  -- the daily loss limit's pause
  updated_by    uuid REFERENCES app.users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Every confirmed setup the auto-trader considered for a user, and what it did. The setup's
-- analysis run names the ruleset version that found it.
CREATE TABLE trading.auto_decisions (
  id                uuid PRIMARY KEY,
  strategy_id       uuid NOT NULL REFERENCES trading.strategies (id),
  user_id           uuid NOT NULL REFERENCES app.users (id),
  setup_id          uuid NOT NULL,
  run_id            uuid NOT NULL,
  instrument_id     uuid NOT NULL REFERENCES market.instruments (id),
  pattern           text NOT NULL,
  outcome           text NOT NULL CHECK (outcome IN ('placed', 'skipped', 'refused', 'cancelled')),
  reason            text,
  order_id          uuid REFERENCES trading.orders (id),
  strategy_version  int NOT NULL,
  decided_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((outcome = 'placed') = (reason IS NULL))
);
CREATE INDEX ON trading.auto_decisions (user_id, decided_at DESC);

-- One account's automatic trading on one UTC day: buys placed (refused ones included) and the
-- realized result of the automatic trades closed, for the limits and the "today" figures.
CREATE TABLE trading.auto_days (
  account_id  uuid NOT NULL REFERENCES trading.accounts (id),
  day         text NOT NULL CHECK (day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),  -- the UTC day
  orders      int NOT NULL DEFAULT 0 CHECK (orders >= 0),
  result      numeric NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, day)
);

-- ---------------------------------------------------------------- who may write what

GRANT SELECT, INSERT ON trading.strategies TO svc_api;
GRANT UPDATE (enabled, rules, version, updated_by, updated_at) ON trading.strategies TO svc_api;
GRANT SELECT ON trading.auto_decisions, trading.auto_days TO svc_api;

GRANT SELECT ON trading.strategies TO svc_broker;
GRANT UPDATE (paused_until, updated_at) ON trading.strategies TO svc_broker;
GRANT SELECT, INSERT ON trading.auto_decisions TO svc_broker;
GRANT SELECT, INSERT, UPDATE ON trading.auto_days TO svc_broker;

-- Automatic orders come only from the broker: the api may no longer store one.
DROP POLICY orders_api_insert ON trading.orders;
CREATE POLICY orders_api_insert ON trading.orders FOR INSERT TO svc_api
  WITH CHECK (source <> 'auto' AND status IN ('new', 'refused') AND filled_quantity = 0 AND reserved = 0);

-- The broker may now insert orders, but only automatic ones, as submitted, and only for a user who
-- has set up automatic trading. Switching it on and off reaches the broker in order with its other
-- inputs (ADR 022), so the switch itself is the broker's to apply, not this policy's: a replay must
-- not depend on when the row changed.
GRANT INSERT ON trading.orders TO svc_broker;
CREATE POLICY orders_broker_auto ON trading.orders FOR INSERT TO svc_broker
  WITH CHECK (
    source = 'auto'
    AND status = 'new'
    AND filled_quantity = 0
    AND reserved = 0
    AND EXISTS (
      SELECT 1
      FROM trading.accounts a
      JOIN trading.strategies s ON s.user_id = a.user_id
      WHERE a.id = account_id
    )
  );
