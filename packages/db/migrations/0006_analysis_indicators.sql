-- Analysis runs and indicator values (data model §5, §8, §9), and the first instrument profiles. Phase 3.

-- ---------------------------------------------------------------- profiles

-- Profiles are immutable: a change is a new version (data model §4). Version 1 of the two launch
-- profiles holds the indicator settings (packages/indicators DEFAULT_INDICATOR_PARAMS); the SMC
-- settings arrive as new versions in Phases 4 and 5. params_hash is the SHA-256 of the jsonb text,
-- which PostgreSQL prints in one canonical key order, so equal settings always hash the same.
INSERT INTO market.instrument_profiles (id, name, version, params, params_hash)
SELECT id, name, 1, params, encode(sha256(convert_to(params::text, 'UTF8')), 'hex')
FROM (VALUES
  ('019a6f00-0000-7000-8000-000000000201'::uuid, 'crypto-majors', '{"indicators": {
      "rsi": {"period": 14}, "macd": {"fast": 12, "slow": 26, "signal": 9},
      "ema": {"fast": 20, "mid": 50, "slow": 200}, "atr": {"period": 14},
      "volume": {"lookback": 50, "zThreshold": 3.5}, "trend": {"slopeBars": 5, "minStrength": 0.1}}}'::jsonb),
  ('019a6f00-0000-7000-8000-000000000202'::uuid, 'gold', '{"indicators": {
      "rsi": {"period": 14}, "macd": {"fast": 12, "slow": 26, "signal": 9},
      "ema": {"fast": 20, "mid": 50, "slow": 200}, "atr": {"period": 14},
      "volume": {"lookback": 50, "zThreshold": 3.5}, "trend": {"slopeBars": 5, "minStrength": 0.1}}}'::jsonb)
) AS p (id, name, params);

-- Tokenised gold follows the gold profile; crypto pairs and the USDT reference pair crypto-majors.
UPDATE market.instruments
SET profile_id = CASE WHEN asset_class = 'tokenised_gold'
                      THEN '019a6f00-0000-7000-8000-000000000202'::uuid
                      ELSE '019a6f00-0000-7000-8000-000000000201'::uuid END,
    updated_at = now()
WHERE profile_id IS NULL;

-- ---------------------------------------------------------------- runs

CREATE TABLE analysis.detection_runs (
  id               uuid PRIMARY KEY,
  mode             text NOT NULL CHECK (mode IN ('live', 'replay')),
  instrument_id    uuid NOT NULL REFERENCES market.instruments (id),
  profile_id       uuid NOT NULL REFERENCES market.instrument_profiles (id),
  ruleset_version  text NOT NULL,                           -- the analysis code's rules version
  params_hash      text NOT NULL,
  from_time        timestamptz NOT NULL,                    -- candles before it are warm-up
  to_time          timestamptz,                             -- null while a live run is open
  -- Per timeframe, the open time (epoch ms) of the candle the run's series starts at, fixed when the
  -- timeframe starts, so a restart or later history never changes what the run computed.
  series_origins   jsonb NOT NULL DEFAULT '{}',
  status           text NOT NULL CHECK (status IN ('warming_up', 'running', 'completed', 'failed', 'superseded')),
  requested_by     uuid REFERENCES app.users (id),          -- replays
  result_digest    text,                                    -- sha256 over the canonical event list
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz
);
CREATE UNIQUE INDEX one_open_live_run ON analysis.detection_runs (instrument_id)
  WHERE mode = 'live' AND status IN ('warming_up', 'running');
CREATE INDEX detection_runs_instrument_idx ON analysis.detection_runs (instrument_id, started_at DESC);

-- ---------------------------------------------------------------- indicator values

-- One row per closed candle per run. Values are double precision (data model §5); null during an
-- indicator's warm-up. A point is a warm-up point when open_time < the run's from_time.
CREATE TABLE analysis.indicator_values (
  instrument_id   uuid NOT NULL,
  timeframe       text NOT NULL CHECK (timeframe IN ('1m', '5m', '15m', '1h', '4h', '1d')),
  open_time       timestamptz NOT NULL,
  run_id          uuid NOT NULL REFERENCES analysis.detection_runs (id),
  rsi             double precision,
  macd            double precision,
  macd_signal     double precision,
  macd_hist       double precision,
  ema_fast        double precision,                         -- 20 by default
  ema_mid         double precision,                         -- 50
  ema_slow        double precision,                         -- 200
  vwap            double precision,                         -- anchored daily (UTC)
  atr             double precision,
  volume_z        double precision,                         -- robust z-score (median/MAD)
  volume_anomaly  boolean,
  trend           text CHECK (trend IN ('bullish', 'bearish', 'neutral')),
  trend_strength  double precision,
  PRIMARY KEY (instrument_id, timeframe, open_time, run_id)
);
SELECT create_hypertable('analysis.indicator_values', by_range('open_time', INTERVAL '30 days'));
ALTER TABLE analysis.indicator_values SET (timescaledb.enable_columnstore,
  timescaledb.segmentby = 'instrument_id, timeframe', timescaledb.orderby = 'open_time DESC');
CALL add_columnstore_policy('analysis.indicator_values', after => INTERVAL '30 days');

-- ---------------------------------------------------------------- grants (data model §9)

GRANT SELECT ON analysis.detection_runs, analysis.indicator_values TO svc_api, svc_analyzer, svc_jobs;
-- The analyzer writes live runs; jobs will write replay runs (Phase 4).
GRANT INSERT, UPDATE ON analysis.detection_runs TO svc_analyzer, svc_jobs;
GRANT INSERT ON analysis.indicator_values TO svc_analyzer, svc_jobs;
