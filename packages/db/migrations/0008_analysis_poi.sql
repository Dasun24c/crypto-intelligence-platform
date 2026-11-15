-- SMC points of interest (data model §5.1 poi_zones; rulebook §4; ADR 017). Phase 5.

-- ---------------------------------------------------------------- profiles, version 3

-- Version 3 of the two launch profiles adds the zone settings of rulebook §10 (order blocks,
-- supply/demand, zone lifetimes; the same values for crypto majors and gold) to version 2's.
-- Profiles are immutable, so this is a new version; instruments move to it, which supersedes their
-- open runs (the rules version changes as well, to smc 0.2.0).
INSERT INTO market.instrument_profiles (id, name, version, params, params_hash)
SELECT v3.id, p.name, 3, v3.params, encode(sha256(convert_to(v3.params::text, 'UTF8')), 'hex')
FROM (VALUES
  ('019a6f00-0000-7000-8000-000000000205'::uuid, '019a6f00-0000-7000-8000-000000000203'::uuid),
  ('019a6f00-0000-7000-8000-000000000206'::uuid, '019a6f00-0000-7000-8000-000000000204'::uuid)
) AS x (id, v2)
JOIN market.instrument_profiles p ON p.id = x.v2
CROSS JOIN LATERAL (
  SELECT x.id,
         jsonb_set(p.params, '{smc}',
           (p.params->'smc')
           || '{"orderBlocks": {"lookback": 5, "maxClusterCandles": 3, "breakWithinBars": 10, "zoneMode": "wick"},
                "supplyDemand": {"baseMaxCandles": 4, "baseBodyAtr": 0.5, "departureAtr": 2.0}}'::jsonb
           || jsonb_build_object('expiry', (p.params->'smc'->'expiry')
                || '{"fvgCandles": 200, "orderBlockCandles": 300, "supplyDemandCandles": 300}'::jsonb)
         ) AS params
) AS v3;

UPDATE market.instruments
SET profile_id = CASE WHEN asset_class = 'tokenised_gold'
                      THEN '019a6f00-0000-7000-8000-000000000206'::uuid
                      ELSE '019a6f00-0000-7000-8000-000000000205'::uuid END,
    updated_at = now()
WHERE profile_id IS NULL
   OR profile_id IN ('019a6f00-0000-7000-8000-000000000201'::uuid, '019a6f00-0000-7000-8000-000000000202'::uuid,
                     '019a6f00-0000-7000-8000-000000000203'::uuid, '019a6f00-0000-7000-8000-000000000204'::uuid);

-- ---------------------------------------------------------------- the event log

-- Two more event types: a zone is created, and a zone's status or fill changes.
ALTER TABLE analysis.detection_events DROP CONSTRAINT detection_events_type_check;
ALTER TABLE analysis.detection_events ADD CONSTRAINT detection_events_type_check
  CHECK (type IN ('swing_confirmed', 'structure', 'range_detected', 'range_ended', 'level_created',
                  'level_status', 'sweep', 'zone_created', 'zone_status', 'gap_marker'));

-- ---------------------------------------------------------------- projection (data model §5.1)

-- Order blocks, FVGs and supply/demand zones, with their current status and fill. Ids derive from
-- the run and the natural key, as for the other projections. `fill_pct` is exact to 0.01 %.
CREATE TABLE analysis.poi_zones (
  id                         uuid PRIMARY KEY,
  run_id                     uuid NOT NULL REFERENCES analysis.detection_runs (id),
  instrument_id              uuid NOT NULL,
  timeframe                  text NOT NULL,
  type                       text NOT NULL CHECK (type IN ('order_block', 'fvg', 'supply', 'demand')),
  direction                  text NOT NULL CHECK (direction IN ('bullish', 'bearish')),
  top                        numeric NOT NULL,
  bottom                     numeric NOT NULL CHECK (top > bottom),
  origin_from                timestamptz NOT NULL,          -- open time of its first candle
  origin_to                  timestamptz NOT NULL,          -- open time of its last candle
  known_at                   timestamptz NOT NULL,
  htf                        boolean NOT NULL DEFAULT false,
  location                   text NOT NULL DEFAULT 'none'
                               CHECK (location IN ('internal', 'external', 'straddling', 'none')),
  structure_event_id         uuid REFERENCES analysis.structure_events (id),  -- order blocks: their break
  linked_zone_id             uuid REFERENCES analysis.poi_zones (id),        -- order block ↔ supply/demand
  swept_liquidity_at_origin  boolean NOT NULL DEFAULT false,
  status                     text NOT NULL
                               CHECK (status IN ('untouched', 'partially_filled', 'filled', 'invalidated', 'expired')),
  fill_pct                   numeric(5, 2) NOT NULL DEFAULT 0 CHECK (fill_pct BETWEEN 0 AND 100),
  first_touch_at             timestamptz,                   -- close of the first candle that traded into it
  status_changed_at          timestamptz,
  flags                      text[] NOT NULL DEFAULT '{}',
  UNIQUE (run_id, timeframe, type, direction, origin_from)
);
CREATE INDEX poi_zones_status_idx ON analysis.poi_zones (instrument_id, status, timeframe);
CREATE INDEX poi_zones_query_idx ON analysis.poi_zones (run_id, known_at);

-- ---------------------------------------------------------------- grants (data model §9)

GRANT SELECT ON analysis.poi_zones TO svc_api, svc_analyzer, svc_jobs;
GRANT INSERT, UPDATE ON analysis.poi_zones TO svc_analyzer;
