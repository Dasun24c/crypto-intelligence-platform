-- SMC setups: patterns, checklist and outcomes (data model §5.2; rulebook §5–§8; ADR 017). Phase 6.

-- ---------------------------------------------------------------- profiles, version 4

-- Version 4 of the two launch profiles adds the setup settings of rulebook §10 to version 3's:
-- patterns, the sweep-anchored MSS, hypothetical levels, timing, the checklist and quality flags.
-- Gold differs in its news blackout (60/60 min), its spread limit and in blocking confirmation while
-- the gold market is closed (J9). Profiles are immutable, so this is a new version; instruments move
-- to it, which supersedes their open runs (the rules version changes as well, to smc 0.3.0).
INSERT INTO market.instrument_profiles (id, name, version, params, params_hash)
SELECT v4.id, p.name, 4, v4.params, encode(sha256(convert_to(v4.params::text, 'UTF8')), 'hex')
FROM (VALUES
  ('019a6f00-0000-7000-8000-000000000207'::uuid, '019a6f00-0000-7000-8000-000000000205'::uuid, false),
  ('019a6f00-0000-7000-8000-000000000208'::uuid, '019a6f00-0000-7000-8000-000000000206'::uuid, true)
) AS x (id, v3, gold)
JOIN market.instrument_profiles p ON p.id = x.v3
CROSS JOIN LATERAL (
  SELECT x.id,
         jsonb_set(p.params, '{smc,setups}',
           '{"patterns": ["double_liquidity_trap", "eq_near_poi", "htf_order_block", "sweep_outside_fill_inside"],
             "mss": {"maxBars": 12, "maxDistanceAtr": 6, "requireDisplacement": true},
             "levels": {"slBufferAtr": 0.1, "targetMinDistanceAtr": 1, "entryRef": "proximal"},
             "timing": {"entryExpiryBars": 24, "maxHoldBars": 288},
             "pattern1": {"minBarsBetweenSweeps": 5, "maxBarsBetweenSweeps": 60, "rangeEdgeTolAtr": 0.5},
             "pattern2": {"proximityAtr": 1, "maxPoiFill": 0.5},
             "pattern3": {"approachAtr": 2, "liqProximityAtr": 1, "sweepWindowBars": 12, "maxObFill": 0.5},
             "pattern4": {"maxTargetFvgFill": 0.5}}'::jsonb
           || jsonb_build_object(
                'checklist',
                '{"minRR": 2, "newsCurrencies": ["USD"],
                  "weights": {"htf_bias": 15, "liquidity_marked": 10, "poi_present": 15, "sweep": 15,
                              "mss": 20, "levels_defined": 5, "risk_reward": 15, "news_clear": 5},
                  "mandatory": ["sweep", "mss", "levels_defined"]}'::jsonb
                || jsonb_build_object('newsBlackoutMin', CASE WHEN x.gold
                     THEN '{"before": 60, "after": 60}'::jsonb ELSE '{"before": 30, "after": 30}'::jsonb END),
                'quality',
                jsonb_build_object(
                  'lowLiqVolumeRatio', 0.3,
                  'maxSpreadBps', CASE WHEN x.gold THEN 15 ELSE 5 END,
                  'lateThresholdSec', 120,
                  'blockConfirmWhenUnderlyingClosed', x.gold,
                  'blockConfirmOnLowLiquidity', false))
         ) AS params
) AS v4;

UPDATE market.instruments
SET profile_id = CASE WHEN asset_class = 'tokenised_gold'
                      THEN '019a6f00-0000-7000-8000-000000000208'::uuid
                      ELSE '019a6f00-0000-7000-8000-000000000207'::uuid END,
    updated_at = now()
WHERE profile_id IS NULL
   OR profile_id IN ('019a6f00-0000-7000-8000-000000000201'::uuid, '019a6f00-0000-7000-8000-000000000202'::uuid,
                     '019a6f00-0000-7000-8000-000000000203'::uuid, '019a6f00-0000-7000-8000-000000000204'::uuid,
                     '019a6f00-0000-7000-8000-000000000205'::uuid, '019a6f00-0000-7000-8000-000000000206'::uuid);

-- ---------------------------------------------------------------- the event log

-- One more event type: a setup's state transition (each carries the whole setup).
ALTER TABLE analysis.detection_events DROP CONSTRAINT detection_events_type_check;
ALTER TABLE analysis.detection_events ADD CONSTRAINT detection_events_type_check
  CHECK (type IN ('swing_confirmed', 'structure', 'range_detected', 'range_ended', 'level_created',
                  'level_status', 'sweep', 'zone_created', 'zone_status', 'setup_transition', 'gap_marker'));

-- ---------------------------------------------------------------- projections (data model §5.2)

-- One row per setup with its state after its latest transition. Ids derive from the run and the
-- setup's natural key, as for the other projections. Differences from the data model (rulebook §14):
-- `expired` ends a setup that never confirmed; the score can end in .5 (half credits); `flags`
-- holds the run's flags (warmup, late_detection) as on the other projections.
CREATE TABLE analysis.setups (
  id                    uuid PRIMARY KEY,
  run_id                uuid NOT NULL REFERENCES analysis.detection_runs (id),
  instrument_id         uuid NOT NULL,
  pattern               text NOT NULL CHECK (pattern IN ('double_liquidity_trap', 'eq_near_poi',
                                                         'htf_order_block', 'sweep_outside_fill_inside')),
  variant               text CHECK (variant IN ('A', 'B')),       -- Pattern 1
  direction             text NOT NULL CHECK (direction IN ('bullish', 'bearish')),
  context_tf            text NOT NULL,
  setup_tf              text NOT NULL,
  state                 text NOT NULL CHECK (state IN ('forming', 'triggered', 'confirmed', 'entry_active', 'resolved')),
  resolution            text CHECK (resolution IN ('target_reached', 'invalidated', 'expired_no_entry',
                                                   'expired_open', 'ambiguous', 'expired')),
  entry_zone_id         uuid REFERENCES analysis.poi_zones (id),
  entry_price           numeric,                                  -- hypothetical: the entry zone's proximal edge
  invalidation_price    numeric,
  target1_price         numeric,
  target2_price         numeric,
  target1_ref           jsonb,                                    -- {kind: level | zone, id, price}
  target2_ref           jsonb,
  rr_target1            double precision,
  confluence_score      numeric(4, 1) NOT NULL DEFAULT 0 CHECK (confluence_score BETWEEN 0 AND 100),
  mandatory_passed      boolean NOT NULL DEFAULT false,
  quality_flags         text[] NOT NULL DEFAULT '{}',             -- rulebook §7
  flags                 text[] NOT NULL DEFAULT '{}',             -- the run's: warmup, late_detection
  refs                  jsonb NOT NULL DEFAULT '{}',              -- sweeps, MSS, range, POI and level ids
  created_candle_time   timestamptz NOT NULL,                     -- close of the candle it started forming at
  updated_candle_time   timestamptz NOT NULL,                     -- close of the candle of its latest transition
  resolved_candle_time  timestamptz,
  UNIQUE (run_id, pattern, direction, context_tf, setup_tf, created_candle_time)
);
CREATE INDEX setups_state_idx ON analysis.setups (state, instrument_id);
CREATE INDEX setups_instrument_idx ON analysis.setups (instrument_id, created_candle_time DESC);
CREATE INDEX setups_run_idx ON analysis.setups (run_id, updated_candle_time DESC);

-- Every transition, with the candle that caused it and why (rulebook §6.1). A failed confirmation
-- is recorded as triggered → triggered with its reasons.
CREATE TABLE analysis.setup_transitions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  setup_id      uuid NOT NULL REFERENCES analysis.setups (id),
  event_seq     bigint NOT NULL,                                  -- the run's event that recorded it
  from_state    text,
  to_state      text NOT NULL,
  candle_time   timestamptz NOT NULL,                             -- open time of the deciding candle
  decided_at    timestamptz NOT NULL,                             -- its close
  processed_at  timestamptz NOT NULL,                             -- wall clock: latency and late detection
  reason        text NOT NULL,
  evidence      jsonb NOT NULL DEFAULT '{}',
  UNIQUE (setup_id, event_seq)
);
CREATE INDEX setup_transitions_setup_idx ON analysis.setup_transitions (setup_id, id);

-- The checklist as evaluated when the setup reached each state (rulebook §7).
CREATE TABLE analysis.setup_checklist_results (
  setup_id   uuid NOT NULL REFERENCES analysis.setups (id),
  state      text NOT NULL,
  item       text NOT NULL CHECK (item IN ('htf_bias', 'liquidity_marked', 'poi_present', 'sweep', 'mss',
                                           'levels_defined', 'risk_reward', 'news_clear')),
  credit     real NOT NULL CHECK (credit IN (0, 0.5, 1)),
  weight     smallint NOT NULL,
  mandatory  boolean NOT NULL,
  evidence   jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (setup_id, state, item)
);

-- Rulebook §8: the result of every setup that confirmed.
CREATE TABLE analysis.setup_outcomes (
  setup_id          uuid PRIMARY KEY REFERENCES analysis.setups (id),
  entry_touched_at  timestamptz,
  resolved_at       timestamptz NOT NULL,
  result            text NOT NULL CHECK (result IN ('target_reached', 'invalidated', 'expired_no_entry',
                                                    'expired_open', 'ambiguous', 'expired')),
  mfe_r             double precision,
  mae_r             double precision,
  bars_held         int,
  resolved_with_tf  text CHECK (resolved_with_tf IN ('1m'))       -- 1m candles decided the order of events
);

-- ---------------------------------------------------------------- grants (data model §9)

GRANT SELECT ON analysis.setups, analysis.setup_transitions, analysis.setup_checklist_results,
  analysis.setup_outcomes TO svc_api, svc_analyzer, svc_jobs;
GRANT INSERT, UPDATE ON analysis.setups, analysis.setup_transitions, analysis.setup_checklist_results,
  analysis.setup_outcomes TO svc_analyzer;
GRANT USAGE ON SEQUENCE analysis.setup_transitions_id_seq TO svc_analyzer;
