-- Market reference data and time series (data model §4, §8, §9). Phase 2.

CREATE TABLE market.venues (
  id       text PRIMARY KEY CHECK (id IN ('binance', 'coinbase', 'replay')),
  name     text NOT NULL,
  enabled  boolean NOT NULL DEFAULT true
);

CREATE TABLE market.instrument_profiles (
  id           uuid PRIMARY KEY,
  name         text NOT NULL,                             -- 'crypto-majors', 'gold'
  version      int  NOT NULL,
  params       jsonb NOT NULL,
  params_hash  text NOT NULL,
  created_by   uuid REFERENCES app.users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, version)                                  -- profiles are immutable; a change is a new version
);

CREATE TABLE market.underlying_calendars (
  id           text PRIMARY KEY,                          -- 'gold'
  time_zone    text NOT NULL,
  weekly_rule  jsonb NOT NULL
);

CREATE TABLE market.underlying_market_closures (
  calendar_id  text NOT NULL REFERENCES market.underlying_calendars (id),
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL CHECK (ends_at > starts_at),
  reason       text NOT NULL CHECK (reason IN ('weekend', 'daily_break', 'holiday')),
  source       text NOT NULL CHECK (source IN ('generated', 'manual')),
  PRIMARY KEY (calendar_id, starts_at)
);

CREATE TABLE market.instruments (
  id                      uuid PRIMARY KEY,
  venue_id                text NOT NULL REFERENCES market.venues (id),
  venue_symbol            text NOT NULL,
  base_asset              text NOT NULL,
  quote_asset             text NOT NULL,
  asset_class             text NOT NULL CHECK (asset_class IN ('crypto', 'tokenised_gold', 'stablecoin')),
  role                    text NOT NULL DEFAULT 'monitored' CHECK (role IN ('monitored', 'reference')),
  price_tick              numeric NOT NULL,
  qty_step                numeric NOT NULL,
  profile_id              uuid REFERENCES market.instrument_profiles (id),
  underlying_calendar_id  text REFERENCES market.underlying_calendars (id),
  is_primary_venue        boolean NOT NULL DEFAULT true,
  store_raw_trades        boolean NOT NULL DEFAULT true,
  venue_status            text NOT NULL DEFAULT 'unknown' CHECK (venue_status IN ('trading', 'halted', 'delisted', 'unknown')),
  enabled                 boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, venue_symbol)
);

-- ---------------------------------------------------------------- time series (hypertables)

CREATE TABLE market.candles (
  instrument_id      uuid NOT NULL,
  timeframe          text NOT NULL CHECK (timeframe IN ('1m', '5m', '15m', '1h', '4h', '1d')),
  open_time          timestamptz NOT NULL,
  open               numeric NOT NULL,
  high               numeric NOT NULL,
  low                numeric NOT NULL,
  close              numeric NOT NULL,
  volume             numeric NOT NULL,
  quote_volume       numeric NOT NULL,
  trade_count        int,
  taker_buy_volume   numeric,
  micro_profile      real[],
  source             text NOT NULL CHECK (source IN ('exchange_kline', 'trades', 'rest', 'aggregated', 'replay')),
  quality            text NOT NULL CHECK (quality IN ('complete', 'repaired', 'partial')),
  underlying_closed  boolean NOT NULL DEFAULT false,
  finalized_at       timestamptz NOT NULL,
  PRIMARY KEY (instrument_id, timeframe, open_time)
);
SELECT create_hypertable('market.candles', by_range('open_time', INTERVAL '7 days'));

CREATE TABLE market.trades (
  instrument_id    uuid NOT NULL,
  ts               timestamptz NOT NULL,
  trade_id         text NOT NULL,
  price            numeric NOT NULL,
  qty              numeric NOT NULL,
  taker_side       text NOT NULL CHECK (taker_side IN ('buy', 'sell')),
  taker_order_ref  text,
  received_at      timestamptz NOT NULL,
  PRIMARY KEY (instrument_id, ts, trade_id)
);
SELECT create_hypertable('market.trades', by_range('ts', INTERVAL '1 day'));

CREATE TABLE market.orderbook_metrics (
  instrument_id    uuid NOT NULL,
  ts               timestamptz NOT NULL,
  mid              numeric NOT NULL,
  spread_bps       double precision NOT NULL,
  bid_usd_10bp     double precision,
  ask_usd_10bp     double precision,
  bid_usd_50bp     double precision,
  ask_usd_50bp     double precision,
  bid_usd_100bp    double precision,
  ask_usd_100bp    double precision,
  imbalance_10bp   double precision,
  imbalance_50bp   double precision,
  imbalance_100bp  double precision,
  coverage_bps     double precision,
  PRIMARY KEY (instrument_id, ts)
);
SELECT create_hypertable('market.orderbook_metrics', by_range('ts', INTERVAL '1 day'));

CREATE TABLE market.orderbook_snapshots (
  instrument_id  uuid NOT NULL,
  ts             timestamptz NOT NULL,
  bids           numeric[] NOT NULL,                      -- flattened [price, qty, ...], best first, top 50
  asks           numeric[] NOT NULL,
  venue_seq      text,
  PRIMARY KEY (instrument_id, ts)
);
SELECT create_hypertable('market.orderbook_snapshots', by_range('ts', INTERVAL '1 day'));

CREATE TABLE market.cross_venue_spreads (
  base_asset               text NOT NULL,
  ts                       timestamptz NOT NULL,
  primary_instrument_id    uuid NOT NULL,
  secondary_instrument_id  uuid NOT NULL,
  primary_usd              numeric NOT NULL,
  secondary_usd            numeric NOT NULL,
  usdt_usd                 numeric NOT NULL,
  spread_bps               double precision NOT NULL,
  PRIMARY KEY (base_asset, ts)
);
SELECT create_hypertable('market.cross_venue_spreads', by_range('ts', INTERVAL '30 days'));

CREATE TABLE market.feed_events (
  ts             timestamptz NOT NULL,
  venue_id       text NOT NULL,
  instrument_id  uuid,
  event          text NOT NULL CHECK (event IN ('connected', 'disconnected', 'reconnecting', 'resubscribed',
                                                'rate_limited', 'delayed', 'recovered', 'error', 'status_change')),
  details        jsonb NOT NULL DEFAULT '{}'
);
SELECT create_hypertable('market.feed_events', by_range('ts', INTERVAL '30 days'));

-- Columnstore (compression) and retention, data model §8. Segment by instrument; newest first.
ALTER TABLE market.candles SET (timescaledb.enable_columnstore, timescaledb.segmentby = 'instrument_id, timeframe', timescaledb.orderby = 'open_time DESC');
ALTER TABLE market.trades SET (timescaledb.enable_columnstore, timescaledb.segmentby = 'instrument_id', timescaledb.orderby = 'ts DESC');
ALTER TABLE market.orderbook_metrics SET (timescaledb.enable_columnstore, timescaledb.segmentby = 'instrument_id', timescaledb.orderby = 'ts DESC');
ALTER TABLE market.orderbook_snapshots SET (timescaledb.enable_columnstore, timescaledb.segmentby = 'instrument_id', timescaledb.orderby = 'ts DESC');
ALTER TABLE market.cross_venue_spreads SET (timescaledb.enable_columnstore, timescaledb.segmentby = 'base_asset', timescaledb.orderby = 'ts DESC');
ALTER TABLE market.feed_events SET (timescaledb.enable_columnstore, timescaledb.segmentby = 'venue_id', timescaledb.orderby = 'ts DESC');

CALL add_columnstore_policy('market.candles', after => INTERVAL '14 days');
CALL add_columnstore_policy('market.trades', after => INTERVAL '1 day');
CALL add_columnstore_policy('market.orderbook_metrics', after => INTERVAL '2 days');
CALL add_columnstore_policy('market.orderbook_snapshots', after => INTERVAL '1 day');
CALL add_columnstore_policy('market.cross_venue_spreads', after => INTERVAL '30 days');
CALL add_columnstore_policy('market.feed_events', after => INTERVAL '30 days');

SELECT add_retention_policy('market.trades', drop_after => INTERVAL '14 days');
SELECT add_retention_policy('market.orderbook_metrics', drop_after => INTERVAL '90 days');
SELECT add_retention_policy('market.orderbook_snapshots', drop_after => INTERVAL '14 days');
SELECT add_retention_policy('market.feed_events', drop_after => INTERVAL '365 days');

-- ---------------------------------------------------------------- events and quality

CREATE TABLE market.large_trades (
  id              uuid PRIMARY KEY,
  instrument_id   uuid NOT NULL REFERENCES market.instruments (id),
  ts              timestamptz NOT NULL,
  taker_side      text NOT NULL CHECK (taker_side IN ('buy', 'sell')),
  avg_price       numeric NOT NULL,
  qty             numeric NOT NULL,
  notional_usd    numeric NOT NULL,
  grouping        text NOT NULL CHECK (grouping IN ('single', 'taker_order', 'burst')),
  fill_count      int NOT NULL,
  price_levels    int NOT NULL,
  threshold_usd   numeric NOT NULL
);
CREATE INDEX large_trades_instrument_ts_idx ON market.large_trades (instrument_id, ts DESC);

CREATE TABLE market.orderbook_walls (
  id                uuid PRIMARY KEY,
  instrument_id     uuid NOT NULL REFERENCES market.instruments (id),
  side              text NOT NULL CHECK (side IN ('bid', 'ask')),
  price             numeric NOT NULL,
  first_seen        timestamptz NOT NULL,
  last_seen         timestamptz NOT NULL,
  max_notional_usd  numeric NOT NULL,
  ended_reason      text CHECK (ended_reason IN ('filled', 'pulled', 'unknown'))
);
CREATE INDEX orderbook_walls_instrument_idx ON market.orderbook_walls (instrument_id, first_seen DESC);

CREATE TABLE market.data_gaps (
  id             uuid PRIMARY KEY,
  instrument_id  uuid NOT NULL REFERENCES market.instruments (id),
  stream         text NOT NULL CHECK (stream IN ('trades', 'depth', 'kline', 'ticker')),
  gap_start      timestamptz NOT NULL,
  gap_end        timestamptz,
  detected_at    timestamptz NOT NULL,
  detected_by    text NOT NULL CHECK (detected_by IN ('sequence', 'heartbeat', 'timer', 'reconnect', 'consistency_check')),
  status         text NOT NULL CHECK (status IN ('open', 'backfilling', 'repaired', 'unrepairable')),
  resolved_at    timestamptz,
  details        jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX data_gaps_instrument_status_idx ON market.data_gaps (instrument_id, status);

-- ---------------------------------------------------------------- reference data

INSERT INTO market.venues (id, name) VALUES
  ('binance', 'Binance'),
  ('coinbase', 'Coinbase'),
  ('replay', 'Replay (tests and demos)');

INSERT INTO market.underlying_calendars (id, time_zone, weekly_rule) VALUES
  ('gold', 'America/New_York',
   '{"weekend": {"closeDay": 5, "closeTime": "17:00", "openDay": 0, "openTime": "18:00"},
     "dailyBreak": {"days": [1, 2, 3, 4], "start": "17:00", "end": "18:00"}}');

-- The nine launch pairs (requirements A5). Tick and step sizes read from the venues on 2026-11-10;
-- the pair-status job keeps them current. Binance is the primary venue for every base asset.
INSERT INTO market.instruments
  (id, venue_id, venue_symbol, base_asset, quote_asset, asset_class, role, price_tick, qty_step, underlying_calendar_id, is_primary_venue)
VALUES
  ('019a6f00-0000-7000-8000-000000000001', 'binance',  'BTCUSDT',  'BTC',  'USDT', 'crypto',         'monitored', 0.01,    0.00001,    NULL,   true),
  ('019a6f00-0000-7000-8000-000000000002', 'binance',  'ETHUSDT',  'ETH',  'USDT', 'crypto',         'monitored', 0.01,    0.0001,     NULL,   true),
  ('019a6f00-0000-7000-8000-000000000003', 'binance',  'SOLUSDT',  'SOL',  'USDT', 'crypto',         'monitored', 0.01,    0.001,      NULL,   true),
  ('019a6f00-0000-7000-8000-000000000004', 'binance',  'PAXGUSDT', 'PAXG', 'USDT', 'tokenised_gold', 'monitored', 0.01,    0.0001,     'gold', true),
  ('019a6f00-0000-7000-8000-000000000005', 'coinbase', 'BTC-USD',  'BTC',  'USD',  'crypto',         'monitored', 0.01,    0.00000001, NULL,   false),
  ('019a6f00-0000-7000-8000-000000000006', 'coinbase', 'ETH-USD',  'ETH',  'USD',  'crypto',         'monitored', 0.01,    0.00000001, NULL,   false),
  ('019a6f00-0000-7000-8000-000000000007', 'coinbase', 'SOL-USD',  'SOL',  'USD',  'crypto',         'monitored', 0.01,    0.00000001, NULL,   false),
  ('019a6f00-0000-7000-8000-000000000008', 'coinbase', 'PAXG-USD', 'PAXG', 'USD',  'tokenised_gold', 'monitored', 0.01,    0.00001,    'gold', false),
  ('019a6f00-0000-7000-8000-000000000009', 'coinbase', 'USDT-USD', 'USDT', 'USD',  'stablecoin',     'reference', 0.00001, 0.01,       NULL,   false);

-- ---------------------------------------------------------------- grants (data model §9)

GRANT SELECT ON ALL TABLES IN SCHEMA market TO svc_api, svc_ingestor, svc_analyzer, svc_jobs;

-- api: admin-managed reference data
GRANT INSERT, UPDATE ON market.instruments, market.instrument_profiles TO svc_api;
GRANT INSERT, DELETE ON market.underlying_market_closures TO svc_api;

-- ingestor: live market data, quality and feed events
GRANT INSERT, UPDATE ON market.candles, market.trades, market.orderbook_metrics, market.orderbook_snapshots,
  market.cross_venue_spreads, market.large_trades, market.orderbook_walls, market.data_gaps TO svc_ingestor;
GRANT INSERT ON market.feed_events TO svc_ingestor;

-- jobs: backfill, gap repair, pair status, generated closures
GRANT INSERT, UPDATE ON market.candles, market.trades, market.data_gaps TO svc_jobs;
GRANT UPDATE (venue_status, price_tick, qty_step, updated_at) ON market.instruments TO svc_jobs;
GRANT INSERT, DELETE ON market.underlying_market_closures TO svc_jobs;
GRANT INSERT ON market.feed_events TO svc_jobs;
