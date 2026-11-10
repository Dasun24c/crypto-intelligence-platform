-- Least-privilege database roles per service (data model §9). Roles are created here without a
-- password; the migration CLI enables LOGIN and sets each password from that service's secret.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['svc_api', 'svc_ingestor', 'svc_analyzer', 'svc_jobs'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT', r);
    END IF;
  END LOOP;
END
$$;

GRANT USAGE ON SCHEMA app, market, analysis, ai, alerts, ops TO svc_api, svc_ingestor, svc_analyzer, svc_jobs;

-- api: authentication, user administration, settings and preferences.
GRANT SELECT, INSERT, UPDATE ON app.users, app.refresh_tokens, app.user_preferences, app.settings TO svc_api;

-- Audit log: append and read only, for every service that records actions. No UPDATE, DELETE or TRUNCATE.
GRANT SELECT, INSERT ON app.audit_log TO svc_api, svc_analyzer, svc_jobs;
GRANT EXECUTE ON FUNCTION app.verify_audit_chain() TO svc_api;

-- jobs: maintenance removes expired refresh tokens.
GRANT SELECT, DELETE ON app.refresh_tokens TO svc_jobs;
GRANT SELECT ON app.users TO svc_jobs, svc_analyzer;

REVOKE ALL ON FUNCTION app.audit_log_chain() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.audit_log_append_only() FROM PUBLIC;
