-- Phase 12: historical analytics and the replay UI (REQUIREMENTS §3.9, SMC-08, NFR-14; ADR 026).

-- A replay may change some of its profile's settings for itself (`POST /replays` with `settings`).
-- Profiles stay immutable and shared, so the replay keeps what it ran with on its own row:
-- `settings` as requested, and `params` the whole settings it used (the profile's with the changes);
-- `params_hash` is then that object's hash, computed as for profiles. Live runs and replays that
-- change nothing leave both null and read their profile's settings, as before.
ALTER TABLE analysis.detection_runs
  ADD COLUMN settings jsonb,
  ADD COLUMN params jsonb,
  ADD CONSTRAINT changed_settings_only_on_replays
    CHECK ((settings IS NULL AND params IS NULL) OR (mode = 'replay' AND settings IS NOT NULL AND params IS NOT NULL));

-- The statistics read each instrument's live runs, then their setups by run and creation time.
CREATE INDEX setups_run_created_idx ON analysis.setups (run_id, created_candle_time);
