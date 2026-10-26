-- 0002_audit_trail: append-only, hash-chained audit log per organization.
--
-- Guarantees:
--   * the runtime role can only INSERT and SELECT (own organization, via RLS);
--   * UPDATE, DELETE and TRUNCATE are rejected by triggers, even for the table owner;
--   * the database, not the application, assigns time, sequence number and hash, so a bug or a
--     compromised API cannot backdate, reorder or forge a chain link;
--   * each organization has its own chain (seq 1, 2, 3 ... each hash covering the previous one),
--     and the chain head is stored separately, so edits, deletions in the middle and truncation
--     of the tail are all detectable by app.verify_audit_chain().

-- Canonical hash of one event. jsonb normalizes key order, so the input is deterministic; the
-- timestamp is hashed as integer microseconds to avoid any time-zone or formatting ambiguity.
CREATE FUNCTION app.audit_event_hash(
  prev_hash bytea,
  organization_id uuid,
  seq bigint,
  occurred_at timestamptz,
  actor_user_id uuid,
  action text,
  entity_type text,
  entity_id text,
  before jsonb,
  after jsonb,
  metadata jsonb
) RETURNS bytea
  LANGUAGE sql STABLE
  AS $$
    SELECT sha256(convert_to(jsonb_build_array(
      encode(prev_hash, 'hex'),
      organization_id,
      seq,
      (extract(epoch FROM occurred_at) * 1000000)::bigint,
      actor_user_id,
      action,
      entity_type,
      entity_id,
      before,
      after,
      metadata
    )::text, 'UTF8'))
  $$;

CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL DEFAULT app.current_organization_id(),
  seq bigint NOT NULL,
  occurred_at timestamptz NOT NULL,
  actor_user_id uuid DEFAULT app.current_user_id(),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  entity_type text NOT NULL CHECK (length(entity_type) > 0),
  entity_id text,
  before jsonb,
  after jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash bytea NOT NULL,
  hash bytea NOT NULL,
  UNIQUE (organization_id, seq)
);

CREATE INDEX audit_events_entity_idx ON audit_events (organization_id, entity_type, entity_id);

-- Latest link of each organization's chain. Only the SECURITY DEFINER trigger touches it.
CREATE TABLE audit_chain_heads (
  organization_id uuid PRIMARY KEY,
  last_seq bigint NOT NULL,
  last_hash bytea NOT NULL
);

-- Default privileges from 0001 granted the runtime role full DML on new tables; narrow them.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM skydra_app;
REVOKE ALL ON audit_chain_heads FROM skydra_app;

SELECT app.enable_tenant_isolation('audit_events');

CREATE FUNCTION app.audit_events_chain() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, app
  AS $$
DECLARE
  head audit_chain_heads%ROWTYPE;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'audit event without organization context';
  END IF;

  INSERT INTO audit_chain_heads (organization_id, last_seq, last_hash)
  VALUES (NEW.organization_id, 0, decode(repeat('00', 32), 'hex'))
  ON CONFLICT (organization_id) DO NOTHING;

  -- Row lock serializes concurrent writers of the same organization; after waiting, READ
  -- COMMITTED re-reads the head updated by the transaction that held the lock.
  SELECT * INTO head FROM audit_chain_heads
  WHERE organization_id = NEW.organization_id
  FOR UPDATE;

  NEW.seq := head.last_seq + 1;
  NEW.occurred_at := now();
  NEW.prev_hash := head.last_hash;
  NEW.hash := app.audit_event_hash(
    NEW.prev_hash, NEW.organization_id, NEW.seq, NEW.occurred_at, NEW.actor_user_id,
    NEW.action, NEW.entity_type, NEW.entity_id, NEW.before, NEW.after, NEW.metadata
  );

  UPDATE audit_chain_heads
  SET last_seq = NEW.seq, last_hash = NEW.hash
  WHERE organization_id = NEW.organization_id;

  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION app.audit_events_chain() FROM PUBLIC;

CREATE TRIGGER audit_events_chain
  BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION app.audit_events_chain();

CREATE FUNCTION app.reject_audit_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP;
END
$$;

CREATE TRIGGER audit_events_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_audit_change();

CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_audit_change();

-- Recomputes the current organization's chain. Runs as owner so it can compare against the
-- stored head (detecting a truncated tail), but only ever for the caller's own organization.
CREATE FUNCTION app.verify_audit_chain()
  RETURNS TABLE (valid boolean, checked bigint, first_invalid_seq bigint, reason text)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, app
  AS $$
DECLARE
  org uuid := app.current_organization_id();
  expected_prev bytea := decode(repeat('00', 32), 'hex');
  expected_seq bigint := 0;
  e audit_events%ROWTYPE;
  head audit_chain_heads%ROWTYPE;
BEGIN
  IF org IS NULL THEN
    RAISE EXCEPTION 'organization context is required';
  END IF;

  FOR e IN SELECT * FROM audit_events WHERE organization_id = org ORDER BY seq LOOP
    expected_seq := expected_seq + 1;
    IF e.seq <> expected_seq THEN
      RETURN QUERY SELECT false, expected_seq - 1, expected_seq, 'missing event'::text;
      RETURN;
    END IF;
    IF e.prev_hash <> expected_prev THEN
      RETURN QUERY SELECT false, expected_seq - 1, e.seq, 'broken link to previous event'::text;
      RETURN;
    END IF;
    IF e.hash <> app.audit_event_hash(
      e.prev_hash, e.organization_id, e.seq, e.occurred_at, e.actor_user_id,
      e.action, e.entity_type, e.entity_id, e.before, e.after, e.metadata
    ) THEN
      RETURN QUERY SELECT false, expected_seq - 1, e.seq, 'event content was modified'::text;
      RETURN;
    END IF;
    expected_prev := e.hash;
  END LOOP;

  SELECT * INTO head FROM audit_chain_heads WHERE organization_id = org;
  IF FOUND AND (head.last_seq <> expected_seq OR head.last_hash <> expected_prev) THEN
    RETURN QUERY SELECT false, expected_seq, expected_seq + 1, 'events missing at the end'::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT true, expected_seq, NULL::bigint, NULL::text;
END
$$;

REVOKE EXECUTE ON FUNCTION app.verify_audit_chain() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.verify_audit_chain() TO skydra_app;
