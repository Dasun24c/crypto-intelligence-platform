-- SMC structure and liquidity (data model §5, §5.1, §8, §9; ADR 004, ADR 017). Phase 4.

-- ---------------------------------------------------------------- profiles, version 2

-- Version 2 of the two launch profiles adds the SMC settings (rulebook §10, the rules Phase 4
-- implements; packages/smc-engine CRYPTO_MAJORS_SMC_PARAMS and GOLD_SMC_PARAMS) next to the
-- unchanged indicator settings. Profiles are immutable, so this is a new version; instruments move
-- to it, which supersedes their open runs.
INSERT INTO market.instrument_profiles (id, name, version, params, params_hash)
SELECT id, name, 2, params, encode(sha256(convert_to(params::text, 'UTF8')), 'hex')
FROM (VALUES
  ('019a6f00-0000-7000-8000-000000000203'::uuid, 'crypto-majors', '{
    "indicators": {
      "rsi": {"period": 14}, "macd": {"fast": 12, "slow": 26, "signal": 9},
      "ema": {"fast": 20, "mid": 50, "slow": 200}, "atr": {"period": 14},
      "volume": {"lookback": 50, "zThreshold": 3.5}, "trend": {"slopeBars": 5, "minStrength": 0.1}},
    "smc": {
      "atrPeriod": 14,
      "structureTimeframes": ["5m", "15m", "1h", "4h", "1d"],
      "timeframePairs": [{"context": "4h", "setup": "15m"}, {"context": "1h", "setup": "5m"}],
      "swings": {"internalOrder": 2, "externalOrder": 5},
      "structure": {"breakBufferAtr": 0},
      "displacement": {"candleBodyAtr": 1.2, "candleBodyRatio": 0.6, "legMinCandles": 2, "legMaxCandles": 4,
                       "legBodyAtr": 2, "legCandleBodyRatio": 0.5},
      "fvg": {"minSizeAtr": 0.2},
      "ranges": {"lookback": 48, "maxHeightAtr": 6, "maxEfficiency": 0.3, "touchTolAtr": 0.25, "minTouches": 2,
                 "minTouchSeparation": 5, "breakCloses": 2, "breakBufferAtr": 0.25, "maxAge": 300},
      "equalLevels": {"tolAtr": 0.1, "minGap": 5, "maxGap": 200},
      "sweeps": {"minPenetrationAtr": 0.02, "maxPenetrationAtr": 2, "closeBackBars": 3},
      "thinBook": {"notionalUsd": 100000},
      "sessions": [{"name": "asia", "start": "00:00", "end": "07:00"},
                   {"name": "london", "start": "07:00", "end": "13:00"},
                   {"name": "new_york", "start": "13:00", "end": "21:00"}],
      "expiry": {"sessionDays": 5, "dayDays": 5, "weekWeeks": 4, "monthMonths": 3, "weekendDays": 7,
                 "equalCandles": 500, "swingCandles": 300, "sweepExtremeCandles": 300}}}'::jsonb),
  ('019a6f00-0000-7000-8000-000000000204'::uuid, 'gold', '{
    "indicators": {
      "rsi": {"period": 14}, "macd": {"fast": 12, "slow": 26, "signal": 9},
      "ema": {"fast": 20, "mid": 50, "slow": 200}, "atr": {"period": 14},
      "volume": {"lookback": 50, "zThreshold": 3.5}, "trend": {"slopeBars": 5, "minStrength": 0.1}},
    "smc": {
      "atrPeriod": 14,
      "structureTimeframes": ["5m", "15m", "1h", "4h", "1d"],
      "timeframePairs": [{"context": "4h", "setup": "15m"}, {"context": "1h", "setup": "5m"}],
      "swings": {"internalOrder": 2, "externalOrder": 5},
      "structure": {"breakBufferAtr": 0},
      "displacement": {"candleBodyAtr": 1.2, "candleBodyRatio": 0.6, "legMinCandles": 2, "legMaxCandles": 4,
                       "legBodyAtr": 2, "legCandleBodyRatio": 0.5},
      "fvg": {"minSizeAtr": 0.2},
      "ranges": {"lookback": 48, "maxHeightAtr": 6, "maxEfficiency": 0.3, "touchTolAtr": 0.25, "minTouches": 2,
                 "minTouchSeparation": 5, "breakCloses": 2, "breakBufferAtr": 0.25, "maxAge": 300},
      "equalLevels": {"tolAtr": 0.15, "minGap": 5, "maxGap": 200},
      "sweeps": {"minPenetrationAtr": 0.02, "maxPenetrationAtr": 2, "closeBackBars": 3},
      "thinBook": {"notionalUsd": 20000},
      "sessions": [{"name": "asia", "start": "00:00", "end": "07:00"},
                   {"name": "london", "start": "07:00", "end": "13:00"},
                   {"name": "new_york", "start": "13:00", "end": "21:00"}],
      "expiry": {"sessionDays": 5, "dayDays": 5, "weekWeeks": 4, "monthMonths": 3, "weekendDays": 7,
                 "equalCandles": 500, "swingCandles": 300, "sweepExtremeCandles": 300}}}'::jsonb)
) AS p (id, name, params);

UPDATE market.instruments
SET profile_id = CASE WHEN asset_class = 'tokenised_gold'
                      THEN '019a6f00-0000-7000-8000-000000000204'::uuid
                      ELSE '019a6f00-0000-7000-8000-000000000203'::uuid END,
    updated_at = now()
WHERE profile_id IS NULL
   OR profile_id IN ('019a6f00-0000-7000-8000-000000000201'::uuid, '019a6f00-0000-7000-8000-000000000202'::uuid);

-- ---------------------------------------------------------------- replays (ADR 017)

-- The live run a replay copied its series origins and profile from: its digest over the replay's
-- period is the one the replay must reproduce (criterion 4.3). Null for live runs, and for replays
-- of a period no live run covers.
ALTER TABLE analysis.detection_runs
  ADD COLUMN source_run_id uuid REFERENCES analysis.detection_runs (id),
  ADD CONSTRAINT source_run_is_replay CHECK (source_run_id IS NULL OR mode = 'replay');

-- ---------------------------------------------------------------- checkpoints and the event log

-- One checkpoint per run: the engine and indicator state (gzip JSON) after `last_boundary`, written
-- in the same transaction as the detections up to it. `lease_epoch` fences former lease holders:
-- a checkpoint is replaced only by an epoch at least as new (architecture §6).
CREATE TABLE analysis.engine_checkpoints (
  run_id         uuid PRIMARY KEY REFERENCES analysis.detection_runs (id),
  last_boundary  timestamptz NOT NULL,
  lease_epoch    bigint NOT NULL,
  state          bytea NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Everything the engine emitted, in order: the source of run digests (ADR 004). The payload is the
-- engine's event, `{key, data}`, keyed by natural keys that are the same in every run.
CREATE TABLE analysis.detection_events (
  run_id         uuid NOT NULL,
  seq            bigint NOT NULL,                         -- per-run sequence, from 1
  candle_time    timestamptz NOT NULL,                    -- close time of the deciding candle
  instrument_id  uuid NOT NULL,
  timeframe      text NOT NULL CHECK (timeframe IN ('1m', '5m', '15m', '1h', '4h', '1d')),
  type           text NOT NULL CHECK (type IN ('swing_confirmed', 'structure', 'range_detected', 'range_ended',
                                               'level_created', 'level_status', 'sweep', 'gap_marker')),
  entity_id      uuid,
  payload        jsonb NOT NULL,
  PRIMARY KEY (run_id, seq, candle_time)
);
SELECT create_hypertable('analysis.detection_events', by_range('candle_time', INTERVAL '30 days'));
ALTER TABLE analysis.detection_events SET (timescaledb.enable_columnstore,
  timescaledb.segmentby = 'instrument_id', timescaledb.orderby = 'candle_time DESC');
CALL add_columnstore_policy('analysis.detection_events', after => INTERVAL '60 days');
CREATE INDEX detection_events_run_idx ON analysis.detection_events (run_id, candle_time);

-- ---------------------------------------------------------------- projections (data model §5.1)

-- Queryable current state, written with the events. Ids are derived from the run and the natural
-- key, so a restart writes the same rows. `flags` holds the engine's flags (deep, thin_book,
-- liquidity_unverified, underlying_closed, data_gap) and the run's (warmup, late_detection).

CREATE TABLE analysis.swing_points (
  id               uuid PRIMARY KEY,
  run_id           uuid NOT NULL REFERENCES analysis.detection_runs (id),
  instrument_id    uuid NOT NULL,
  timeframe        text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('high', 'low')),
  structure_level  text NOT NULL CHECK (structure_level IN ('internal', 'external')),
  price            numeric NOT NULL,
  candle_time      timestamptz NOT NULL,                  -- the swing candle (open time)
  confirmed_at     timestamptz NOT NULL,                  -- close of the confirming candle
  flags            text[] NOT NULL DEFAULT '{}',
  UNIQUE (run_id, timeframe, kind, structure_level, candle_time)
);
CREATE INDEX swing_points_query_idx ON analysis.swing_points (run_id, timeframe, candle_time);

CREATE TABLE analysis.structure_events (
  id                 uuid PRIMARY KEY,
  run_id             uuid NOT NULL REFERENCES analysis.detection_runs (id),
  instrument_id      uuid NOT NULL,
  timeframe          text NOT NULL,
  structure_level    text NOT NULL CHECK (structure_level IN ('internal', 'external')),
  type               text NOT NULL CHECK (type IN ('bos', 'choch', 'mss')),
  direction          text NOT NULL CHECK (direction IN ('bullish', 'bearish')),
  broken_swing_id    uuid REFERENCES analysis.swing_points (id),
  break_price        numeric NOT NULL,
  break_candle_time  timestamptz NOT NULL,                -- open time
  is_initial         boolean NOT NULL DEFAULT false,
  displacement       jsonb,                               -- {from, to, bodyAtr, createdFvg} when present
  flags              text[] NOT NULL DEFAULT '{}',
  UNIQUE (run_id, timeframe, structure_level, type, break_candle_time)
);
CREATE INDEX structure_events_query_idx ON analysis.structure_events (run_id, timeframe, break_candle_time);

CREATE TABLE analysis.trading_ranges (
  id             uuid PRIMARY KEY,
  run_id         uuid NOT NULL REFERENCES analysis.detection_runs (id),
  instrument_id  uuid NOT NULL,
  timeframe      text NOT NULL,
  high           numeric NOT NULL,
  low            numeric NOT NULL,
  equilibrium    numeric NOT NULL,
  window_start   timestamptz NOT NULL,
  detected_at    timestamptz NOT NULL,
  ended_at       timestamptz,
  end_reason     text CHECK (end_reason IN ('breakout_up', 'breakout_down', 'expired', 'data_gap')),
  flags          text[] NOT NULL DEFAULT '{}',
  UNIQUE (run_id, timeframe, detected_at)
);
CREATE INDEX trading_ranges_query_idx ON analysis.trading_ranges (run_id, timeframe, detected_at);

CREATE TABLE analysis.liquidity_levels (
  id                 uuid PRIMARY KEY,
  run_id             uuid NOT NULL REFERENCES analysis.detection_runs (id),
  instrument_id      uuid NOT NULL,
  origin_timeframe   text NOT NULL,
  type               text NOT NULL CHECK (type IN ('eqh', 'eql', 'pdh', 'pdl', 'pwh', 'pwl', 'pmh', 'pml',
                                                  'session_high', 'session_low', 'range_high', 'range_low',
                                                  'weekend_high', 'weekend_low', 'swing_high', 'swing_low',
                                                  'sweep_extreme')),
  side               text NOT NULL CHECK (side IN ('buy_side', 'sell_side')),
  price              numeric NOT NULL,
  touches            int NOT NULL DEFAULT 1,
  session_name       text CHECK (session_name IN ('asia', 'london', 'new_york')),
  source_ref         jsonb,                               -- natural keys it came from (swings, a range, sweeps)
  location           text NOT NULL DEFAULT 'none' CHECK (location IN ('internal', 'external', 'straddling', 'none')),
  known_at           timestamptz NOT NULL,
  status             text NOT NULL CHECK (status IN ('active', 'swept', 'broken', 'expired')),
  status_changed_at  timestamptz,
  sweep_count        int NOT NULL DEFAULT 0,
  flags              text[] NOT NULL DEFAULT '{}',
  UNIQUE (run_id, origin_timeframe, type, side, known_at)
);
CREATE INDEX liquidity_levels_status_idx ON analysis.liquidity_levels (instrument_id, status, origin_timeframe);
CREATE INDEX liquidity_levels_query_idx ON analysis.liquidity_levels (run_id, known_at);

CREATE TABLE analysis.sweeps (
  id                     uuid PRIMARY KEY,
  run_id                 uuid NOT NULL REFERENCES analysis.detection_runs (id),
  instrument_id          uuid NOT NULL,
  timeframe              text NOT NULL,                 -- the timeframe it was evaluated on
  level_id               uuid NOT NULL REFERENCES analysis.liquidity_levels (id),
  group_id               uuid NOT NULL,                 -- sweeps confirmed by the same candle on the same side
  kind                   text NOT NULL CHECK (kind IN ('wick', 'false_breakout')),
  side                   text NOT NULL CHECK (side IN ('buy_side', 'sell_side')),
  level_price            numeric NOT NULL,
  extreme_price          numeric NOT NULL,
  penetration_atr        double precision NOT NULL,
  breach_candle_time     timestamptz NOT NULL,          -- open times
  confirmed_candle_time  timestamptz NOT NULL,
  notional_beyond_usd    numeric,                       -- null when micro profiles are missing
  flags                  text[] NOT NULL DEFAULT '{}',
  UNIQUE (run_id, timeframe, level_id, breach_candle_time)
);
CREATE INDEX sweeps_query_idx ON analysis.sweeps (run_id, timeframe, confirmed_candle_time);

-- ---------------------------------------------------------------- grants (data model §9)

GRANT SELECT ON analysis.engine_checkpoints, analysis.detection_events, analysis.swing_points,
  analysis.structure_events, analysis.trading_ranges, analysis.liquidity_levels, analysis.sweeps
  TO svc_api, svc_analyzer, svc_jobs;
-- The analyzer runs live runs and replays (ADR 017).
GRANT INSERT, UPDATE ON analysis.engine_checkpoints, analysis.detection_events, analysis.swing_points,
  analysis.structure_events, analysis.trading_ranges, analysis.liquidity_levels, analysis.sweeps
  TO svc_analyzer;
