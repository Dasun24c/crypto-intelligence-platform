-- The economic calendar (data model §4; feasibility §6.1; rulebook §7 item 8 and I38). Phase 7.

-- ---------------------------------------------------------------- events

-- One row per scheduled release, as the platform knows it now (data model §4, with Phase 7's
-- additions). `release` names the standard releases the platform tracks; admins may enter others.
-- `status`:
--   scheduled   the release as listed;
--   cancelled   an admin removed the entry, or its source stopped listing the date;
--   superseded  a FRED date for GDP or Personal Income and Outlays that BEA lists, with its time.
-- Rows are never deleted: checklist item 8 reads the calendar as it was known at each decision, so
-- every version is kept (below), and replays see what the live run saw (rulebook I38).
CREATE TABLE market.economic_events (
  id              uuid PRIMARY KEY,
  source          text NOT NULL CHECK (source IN ('fred', 'bea', 'manual')),
  source_ref      text NOT NULL,
  release         text CHECK (release IN ('cpi', 'employment_situation', 'gdp', 'personal_income_outlays', 'fomc')),
  title           text NOT NULL,
  country         text NOT NULL DEFAULT 'US',
  currency        text NOT NULL DEFAULT 'USD',
  category        text NOT NULL CHECK (category IN ('inflation', 'employment', 'growth', 'central_bank', 'other')),
  impact          text NOT NULL CHECK (impact IN ('low', 'medium', 'high')),
  scheduled_at    timestamptz NOT NULL,
  time_confirmed  boolean NOT NULL,                     -- false: only the date is published; the time is the standard one
  status          text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled', 'superseded')),
  actual          text,
  forecast        text,
  previous        text,
  revision        integer NOT NULL DEFAULT 1,           -- the latest row in economic_event_revisions
  created_by      uuid REFERENCES app.users (id),       -- manual entries
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_ref)
);
CREATE INDEX ON market.economic_events (scheduled_at);

-- Every version of every event, in order: what the platform knew from `recorded_at` on. Written only
-- by the triggers below, when an event is created or changes in anything the calendar shows or item 8
-- reads; nothing updates or deletes a revision.
CREATE TABLE market.economic_event_revisions (
  event_id        uuid NOT NULL REFERENCES market.economic_events (id),
  revision        integer NOT NULL,
  recorded_at     timestamptz NOT NULL,
  scheduled_at    timestamptz NOT NULL,
  time_confirmed  boolean NOT NULL,
  title           text NOT NULL,
  currency        text NOT NULL,
  impact          text NOT NULL,
  status          text NOT NULL,
  PRIMARY KEY (event_id, revision)
);
CREATE INDEX ON market.economic_event_revisions (recorded_at);

-- A new event is revision 1; a change to a field the revisions keep makes the next one. Other columns
-- (actual, forecast, previous) change without a revision.
CREATE FUNCTION market.economic_event_bump() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.revision := 1;
  ELSIF (NEW.scheduled_at, NEW.time_confirmed, NEW.title, NEW.currency, NEW.impact, NEW.status)
        IS DISTINCT FROM (OLD.scheduled_at, OLD.time_confirmed, OLD.title, OLD.currency, OLD.impact, OLD.status) THEN
    NEW.revision := OLD.revision + 1;
    NEW.updated_at := now();
  ELSE
    NEW.revision := OLD.revision;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER economic_events_bump BEFORE INSERT OR UPDATE ON market.economic_events
  FOR EACH ROW EXECUTE FUNCTION market.economic_event_bump();

-- Runs as the owner, so the services need no write access to the revisions.
CREATE FUNCTION market.economic_event_record() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.revision <> OLD.revision THEN
    INSERT INTO market.economic_event_revisions
      (event_id, revision, recorded_at, scheduled_at, time_confirmed, title, currency, impact, status)
    VALUES
      (NEW.id, NEW.revision, now(), NEW.scheduled_at, NEW.time_confirmed, NEW.title, NEW.currency,
       NEW.impact, NEW.status);
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER economic_events_record AFTER INSERT OR UPDATE ON market.economic_events
  FOR EACH ROW EXECUTE FUNCTION market.economic_event_record();

-- Rows are kept for the engine's history: cancel an event instead of deleting it.
CREATE FUNCTION market.economic_calendar_keep() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% keeps its history (% refused)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER economic_events_no_delete BEFORE DELETE ON market.economic_events
  FOR EACH ROW EXECUTE FUNCTION market.economic_calendar_keep();
CREATE TRIGGER economic_event_revisions_append_only BEFORE UPDATE OR DELETE ON market.economic_event_revisions
  FOR EACH ROW EXECUTE FUNCTION market.economic_calendar_keep();

-- ---------------------------------------------------------------- syncs

-- One row per sync attempt of a source. `skipped`: the source is not configured (no FRED key). The
-- first complete FRED sync makes the calendar available to checklist item 8 (rulebook I38).
CREATE TABLE market.calendar_syncs (
  id           uuid PRIMARY KEY,
  source       text NOT NULL CHECK (source IN ('fred', 'bea')),
  started_at   timestamptz NOT NULL,
  finished_at  timestamptz,
  status       text NOT NULL CHECK (status IN ('running', 'ok', 'failed', 'skipped')),
  inserted     integer NOT NULL DEFAULT 0,
  updated      integer NOT NULL DEFAULT 0,
  unchanged    integer NOT NULL DEFAULT 0,
  cancelled    integer NOT NULL DEFAULT 0,
  error        text,
  details      jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX ON market.calendar_syncs (source, started_at DESC);

-- ---------------------------------------------------------------- grants (data model §9)

GRANT SELECT ON market.economic_events, market.economic_event_revisions, market.calendar_syncs
  TO svc_api, svc_analyzer, svc_jobs;
-- The jobs service syncs; the API writes admins' manual entries (and cancels them).
GRANT INSERT, UPDATE ON market.economic_events TO svc_jobs, svc_api;
GRANT INSERT, UPDATE ON market.calendar_syncs TO svc_jobs;
