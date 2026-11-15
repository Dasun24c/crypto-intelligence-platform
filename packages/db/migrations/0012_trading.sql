-- Phase 14: practice trading (REQUIREMENTS §11, ADR 021, data model §10). Simulated spot orders on
-- practice balances, filled by the broker service from the platform's own live data. Nothing here
-- reaches an exchange.

-- ---------------------------------------------------------------- minimum order values

-- Read by the pair-status job: Binance NOTIONAL / MIN_NOTIONAL, Coinbase min_market_funds.
-- 0 while unknown: no minimum is applied.
ALTER TABLE market.instruments
  ADD COLUMN min_notional numeric NOT NULL DEFAULT 0 CHECK (min_notional >= 0);
GRANT UPDATE (min_notional) ON market.instruments TO svc_jobs;

-- ---------------------------------------------------------------- the broker's role

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'svc_broker') THEN
    CREATE ROLE svc_broker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

CREATE SCHEMA trading;

-- ---------------------------------------------------------------- tables

-- One practice account per user and venue: a Binance balance cannot pay for a Coinbase order.
CREATE TABLE trading.accounts (
  id                 uuid PRIMARY KEY,
  user_id            uuid NOT NULL REFERENCES app.users (id),
  venue_id           text NOT NULL REFERENCES market.venues (id),
  starting_balances  jsonb NOT NULL,                        -- {asset: amount} of the current period
  reset_epoch        int NOT NULL DEFAULT 0 CHECK (reset_epoch >= 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, venue_id)
);

CREATE TABLE trading.orders (
  id                 uuid PRIMARY KEY,
  account_id         uuid NOT NULL REFERENCES trading.accounts (id),
  instrument_id      uuid NOT NULL REFERENCES market.instruments (id),
  client_order_id    text NOT NULL,                         -- the client's idempotency key
  side               text NOT NULL CHECK (side IN ('buy', 'sell')),
  type               text NOT NULL CHECK (type IN ('market', 'limit', 'stop', 'target')),
  quantity           numeric NOT NULL CHECK (quantity >= 0), -- a stop's or target's: what it protects
  limit_price        numeric CHECK (limit_price > 0),       -- limit orders and targets
  stop_price         numeric CHECK (stop_price > 0),        -- stops
  status             text NOT NULL
                       CHECK (status IN ('new', 'pending', 'open', 'partially_filled', 'filled', 'cancelled', 'refused')),
  refusal_reason     text,
  filled_quantity    numeric NOT NULL DEFAULT 0 CHECK (filled_quantity >= 0),
  filled_value       numeric NOT NULL DEFAULT 0 CHECK (filled_value >= 0),
  reserved           numeric NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  parent_id          uuid REFERENCES trading.orders (id),   -- the buy a stop or target belongs to
  oco_group          uuid,                                   -- a stop and target that cancel each other
  source             text NOT NULL CHECK (source IN ('manual', 'setup')),
  setup_id           uuid,                                   -- when "Practise this setup" filled in the ticket
  underlying_closed  boolean NOT NULL DEFAULT false,
  reset_epoch        int NOT NULL,
  seq                bigint,                                 -- the engine's arrival order, set by the broker
  accepted_after     text,                                   -- md:trades position when the broker took it up
  fill_count         int NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, client_order_id),
  CHECK ((status = 'refused') = (refusal_reason IS NOT NULL)),
  CHECK ((parent_id IS NULL) = (type IN ('market', 'limit')))
);
CREATE INDEX ON trading.orders (account_id, created_at DESC);
-- The broker loads live orders on start.
CREATE INDEX trading_orders_live_idx ON trading.orders (status)
  WHERE status IN ('new', 'pending', 'open', 'partially_filled');

CREATE TABLE trading.fills (
  id             uuid PRIMARY KEY,
  order_id       uuid NOT NULL REFERENCES trading.orders (id),
  account_id     uuid NOT NULL REFERENCES trading.accounts (id),
  instrument_id  uuid NOT NULL REFERENCES market.instruments (id),
  side           text NOT NULL CHECK (side IN ('buy', 'sell')),
  price          numeric NOT NULL CHECK (price > 0),
  quantity       numeric NOT NULL CHECK (quantity > 0),
  fee            numeric NOT NULL CHECK (fee >= 0),
  fee_asset      text NOT NULL,
  liquidity      text NOT NULL CHECK (liquidity IN ('maker', 'taker')),
  flags          text[] NOT NULL DEFAULT '{}',              -- thin_book, underlying_closed
  basis          jsonb NOT NULL,                            -- the book levels walked, or the trade through the price
  reset_epoch    int NOT NULL,
  filled_at      timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON trading.fills (account_id, filled_at DESC);
CREATE INDEX ON trading.fills (order_id);

-- Every change of an available balance. Balances are never stored: they are sums of these entries
-- for the account's current period, so they always reconcile with the fills and fees.
CREATE TABLE trading.ledger (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id   uuid NOT NULL REFERENCES trading.accounts (id),
  reset_epoch  int NOT NULL,
  asset        text NOT NULL,
  amount       numeric NOT NULL,
  reason       text NOT NULL CHECK (reason IN ('start', 'reserve', 'release', 'fill', 'fee')),
  order_id     uuid REFERENCES trading.orders (id),
  fill_id      uuid REFERENCES trading.fills (id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON trading.ledger (account_id, reset_epoch, asset);

-- The broker's journal: every input that changed something, with what it read (the book), so a
-- replay can feed the same inputs to the engine and compare the fills' digest (criterion 14.3).
CREATE TABLE trading.journal (
  seq      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  kind     text NOT NULL CHECK (kind IN ('load', 'place', 'cancel', 'reset', 'trade')),
  input    jsonb NOT NULL,
  fills    text[] NOT NULL DEFAULT '{}'                     -- the fills' digest lines, in order
);

-- The broker's lease fencing and stream positions (one row).
CREATE TABLE trading.broker_state (
  id               int PRIMARY KEY CHECK (id = 1),
  lease_epoch      bigint NOT NULL DEFAULT 0,
  commands_cursor  text NOT NULL DEFAULT '0-0',
  trade_cursors    jsonb NOT NULL DEFAULT '{}',             -- {instrumentId: stream id}
  updated_at       timestamptz NOT NULL DEFAULT now()
);
INSERT INTO trading.broker_state (id) VALUES (1);

-- ---------------------------------------------------------------- who may write what

-- The api opens accounts with their starting balances and stores orders as submitted (or refused);
-- the broker alone fills orders and moves balances afterwards. The analyzer and jobs services have
-- no access to trading at all: nothing but a person's request through the api can place an order.
GRANT USAGE ON SCHEMA trading TO svc_api, svc_broker;
GRANT USAGE ON SCHEMA app, market TO svc_broker;

GRANT SELECT ON trading.accounts, trading.orders, trading.fills, trading.ledger TO svc_api, svc_broker;
GRANT INSERT ON trading.accounts, trading.orders, trading.ledger TO svc_api;
GRANT USAGE ON SEQUENCE trading.ledger_id_seq TO svc_api, svc_broker;

GRANT UPDATE (reset_epoch, starting_balances, updated_at) ON trading.accounts TO svc_broker;
GRANT UPDATE (status, refusal_reason, quantity, filled_quantity, filled_value, reserved, seq, accepted_after,
              fill_count, updated_at) ON trading.orders TO svc_broker;
GRANT INSERT ON trading.fills, trading.ledger TO svc_broker;
GRANT SELECT, INSERT ON trading.journal TO svc_broker;
GRANT USAGE ON SEQUENCE trading.journal_seq_seq TO svc_broker;
GRANT SELECT, UPDATE ON trading.broker_state TO svc_broker;

GRANT SELECT ON market.venues, market.instruments, market.data_gaps, market.underlying_market_closures TO svc_broker;
GRANT SELECT ON app.settings, app.users TO svc_broker;
GRANT SELECT, INSERT ON app.audit_log TO svc_broker;

-- Rows the api may write, enforced by the database: an order only as submitted or refused, and
-- ledger entries only for starting balances. The table owner (migrations) is not bound by these.
ALTER TABLE trading.orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY orders_read ON trading.orders FOR SELECT TO svc_api, svc_broker USING (true);
CREATE POLICY orders_api_insert ON trading.orders FOR INSERT TO svc_api
  WITH CHECK (status IN ('new', 'refused') AND filled_quantity = 0 AND reserved = 0);
CREATE POLICY orders_broker_update ON trading.orders FOR UPDATE TO svc_broker USING (true) WITH CHECK (true);

ALTER TABLE trading.ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY ledger_read ON trading.ledger FOR SELECT TO svc_api, svc_broker USING (true);
CREATE POLICY ledger_api_start ON trading.ledger FOR INSERT TO svc_api WITH CHECK (reason = 'start');
CREATE POLICY ledger_broker_insert ON trading.ledger FOR INSERT TO svc_broker WITH CHECK (true);
