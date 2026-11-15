-- Append-only audit log with a SHA-256 hash chain computed by a trigger (architecture §14, data model §3).
--
-- Each row's hash covers the previous row's hash and a canonical JSON rendering of the row, so any
-- edit, deletion or reordering breaks the chain from that row on. The chain is ordered by chain_seq,
-- which the trigger assigns while holding a transaction-level advisory lock; the identity id can be
-- out of order under concurrency, chain_seq never is.

CREATE TABLE app.audit_log (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chain_seq      bigint NOT NULL UNIQUE,
  at             timestamptz NOT NULL DEFAULT now(),
  actor_type     text NOT NULL CHECK (actor_type IN ('user', 'system')),
  actor_user_id  uuid REFERENCES app.users (id),
  action         text NOT NULL,                             -- e.g. 'auth.login.failed', 'user.role.changed'
  target_type    text,
  target_id      text,
  ip             inet,
  user_agent     text,
  details        jsonb NOT NULL DEFAULT '{}',
  prev_hash      bytea NOT NULL,
  hash           bytea NOT NULL
);
CREATE INDEX audit_log_at_idx ON app.audit_log (at);
CREATE INDEX audit_log_actor_idx ON app.audit_log (actor_user_id, chain_seq);
CREATE INDEX audit_log_action_idx ON app.audit_log (action, chain_seq);

-- Canonical digest of one row. jsonb_build_array gives unambiguous escaping and NULL handling;
-- the timestamp is rendered as epoch microseconds so the session time zone cannot change it.
CREATE FUNCTION app.audit_row_digest(
  p_prev_hash bytea, p_chain_seq bigint, p_at timestamptz, p_actor_type text, p_actor_user_id uuid,
  p_action text, p_target_type text, p_target_id text, p_ip inet, p_user_agent text, p_details jsonb
) RETURNS bytea
LANGUAGE sql STABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT sha256(p_prev_hash || convert_to(jsonb_build_array(
    p_chain_seq,
    (extract(epoch FROM p_at) * 1000000)::bigint,
    p_actor_type,
    p_actor_user_id,
    p_action,
    p_target_type,
    p_target_id,
    p_ip::text,
    p_user_agent,
    p_details
  )::text, 'UTF8'))
$$;

CREATE FUNCTION app.audit_log_chain() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_prev_hash bytea;
  v_prev_seq  bigint;
BEGIN
  -- Serialise appends: one writer extends the chain at a time (released at commit or rollback).
  PERFORM pg_advisory_xact_lock(7461001);
  SELECT a.hash, a.chain_seq INTO v_prev_hash, v_prev_seq
    FROM app.audit_log a ORDER BY a.chain_seq DESC LIMIT 1;
  IF v_prev_seq IS NULL THEN
    v_prev_hash := decode(repeat('00', 32), 'hex');
    v_prev_seq := 0;
  END IF;

  NEW.chain_seq := v_prev_seq + 1;
  NEW.details := COALESCE(NEW.details, '{}'::jsonb);
  NEW.prev_hash := v_prev_hash;
  NEW.hash := app.audit_row_digest(
    NEW.prev_hash, NEW.chain_seq, NEW.at, NEW.actor_type, NEW.actor_user_id,
    NEW.action, NEW.target_type, NEW.target_id, NEW.ip, NEW.user_agent, NEW.details);
  RETURN NEW;
END
$$;

CREATE TRIGGER audit_log_chain BEFORE INSERT ON app.audit_log
  FOR EACH ROW EXECUTE FUNCTION app.audit_log_chain();

-- Defence in depth on top of the grants: even the owner cannot change or remove rows without first
-- dropping these triggers, which is itself a visible DDL change.
CREATE FUNCTION app.audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'app.audit_log is append-only (% refused)', TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON app.audit_log
  FOR EACH ROW EXECUTE FUNCTION app.audit_log_append_only();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON app.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION app.audit_log_append_only();

-- Walks the chain in order and reports the first row whose sequence, link or digest is wrong.
CREATE FUNCTION app.verify_audit_chain(OUT ok boolean, OUT checked_rows bigint, OUT first_broken_seq bigint)
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog
AS $$
DECLARE
  r app.audit_log%ROWTYPE;
  v_prev_hash bytea := decode(repeat('00', 32), 'hex');
  v_expected_seq bigint := 1;
BEGIN
  checked_rows := 0;
  first_broken_seq := NULL;
  FOR r IN SELECT * FROM app.audit_log ORDER BY chain_seq LOOP
    IF r.chain_seq <> v_expected_seq
       OR r.prev_hash <> v_prev_hash
       OR r.hash <> app.audit_row_digest(r.prev_hash, r.chain_seq, r.at, r.actor_type, r.actor_user_id,
                                         r.action, r.target_type, r.target_id, r.ip, r.user_agent, r.details)
    THEN
      ok := false;
      first_broken_seq := r.chain_seq;
      RETURN;
    END IF;
    v_prev_hash := r.hash;
    v_expected_seq := v_expected_seq + 1;
    checked_rows := checked_rows + 1;
  END LOOP;
  ok := true;
END
$$;
