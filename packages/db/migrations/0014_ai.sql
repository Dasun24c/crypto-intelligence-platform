-- Phase 9: AI analyses (REQUIREMENTS §4, data model §6, ADR 011, ADR 023).
-- Every analysis is kept, accepted or not, with exactly what was sent and received (criterion 9.6).

CREATE TABLE ai.analyses (
  id                   uuid PRIMARY KEY,
  instrument_id        uuid REFERENCES market.instruments (id),
  trigger              text NOT NULL CHECK (trigger IN ('event', 'digest', 'on_demand')),
  trigger_refs         jsonb NOT NULL DEFAULT '[]',     -- events with their scores, the digest slot, or the request
  request_reason       text CHECK (request_reason IN ('market_summary', 'setup_review', 'refresh')),
  setup_id             uuid,                            -- a setup review's setup
  requested_by         uuid REFERENCES app.users (id),  -- on-demand requests only
  context_hash         text NOT NULL,
  context              jsonb NOT NULL,                  -- exactly what was sent (or would have been)
  prompt_version       text NOT NULL,
  model_requested      text NOT NULL,
  model_reported       text,                            -- the model the API says answered
  status               text NOT NULL CHECK (status IN ('accepted', 'rejected', 'failed', 'skipped_budget', 'cache_hit')),
  cache_source_id      uuid REFERENCES ai.analyses (id),
  stance               text CHECK (stance IN ('bullish', 'bearish', 'neutral')),
  confidence           text CHECK (confidence IN ('low', 'medium', 'high')),
  response             jsonb,                           -- the answer as validated (or as rejected)
  validation           jsonb NOT NULL DEFAULT '{}',     -- errors and warnings
  repair_attempted     boolean NOT NULL DEFAULT false,
  error                text,                            -- failed: why; skipped_budget: which cap
  input_tokens         int,
  cached_input_tokens  int,
  output_tokens        int,
  reasoning_tokens     int,
  cost_usd             numeric(12, 6),
  latency_ms           int,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'cache_hit') = (cache_source_id IS NOT NULL)),
  CHECK (status <> 'accepted' OR (response IS NOT NULL AND stance IS NOT NULL AND confidence IS NOT NULL)),
  CHECK ((trigger = 'on_demand') = (request_reason IS NOT NULL))
);
CREATE INDEX ON ai.analyses (instrument_id, created_at DESC);
CREATE INDEX ON ai.analyses (context_hash, created_at DESC);
CREATE INDEX ON ai.analyses (created_at DESC);

-- Usage per UTC day: what was called, what it cost (low volume: a view is enough).
CREATE VIEW ai.daily_usage AS
SELECT
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
  count(*) FILTER (WHERE status IN ('accepted', 'rejected', 'failed'))::int AS calls,
  count(*) FILTER (WHERE status = 'accepted')::int AS accepted,
  count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
  count(*) FILTER (WHERE status = 'failed')::int AS failed,
  count(*) FILTER (WHERE status = 'cache_hit')::int AS cache_hits,
  count(*) FILTER (WHERE status = 'skipped_budget')::int AS skipped,
  coalesce(sum(input_tokens), 0)::int AS input_tokens,
  coalesce(sum(coalesce(output_tokens, 0) + coalesce(reasoning_tokens, 0)), 0)::int AS output_tokens,
  coalesce(sum(cost_usd), 0)::numeric(12, 6) AS cost_usd
FROM ai.analyses
GROUP BY 1;

-- The jobs service writes analyses (only it calls the model); the api reads them.
GRANT SELECT, INSERT ON ai.analyses TO svc_jobs;
GRANT SELECT ON ai.analyses, ai.daily_usage TO svc_api, svc_jobs;
-- The jobs service reads the admins' AI settings (key `ai`); the api writes them.
GRANT SELECT ON app.settings TO svc_jobs;
