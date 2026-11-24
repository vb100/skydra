-- 0012_screening_providers: the providers that replace Ondato, match strength and a log of every
-- provider exchange.
--
--   * Provider codes: screening OPENSANCTIONS, identity DOKOBIT, registries REGISTRU_CENTRAS
--     (Ondato was never connected, so no row uses it).
--   * A match is STRONG when the provider counts it as a match (its score reaches the configured
--     threshold) and WEAK otherwise. Only strong matches must be reviewed before the case can
--     proceed; weak ones are shown folded and may still be reviewed.
--   * screening_requests keeps each request sent and response received, with a SHA-256 of the
--     response, so a check can be reproduced for the FIU. It is append-only.

-- ---------------------------------------------------------------------------------------------
-- Provider codes

ALTER TABLE screening_checks DROP CONSTRAINT screening_checks_provider_check;
ALTER TABLE screening_checks ADD CONSTRAINT screening_checks_provider_check
  CHECK (provider IN ('MOCK', 'MANUAL', 'OPENSANCTIONS'));

ALTER TABLE identity_verifications DROP CONSTRAINT identity_verifications_provider_check;
ALTER TABLE identity_verifications ADD CONSTRAINT identity_verifications_provider_check
  CHECK (provider IN ('MOCK', 'MANUAL', 'DOKOBIT'));

ALTER TABLE ownership_snapshots DROP CONSTRAINT ownership_snapshots_provider_check;
ALTER TABLE ownership_snapshots ADD CONSTRAINT ownership_snapshots_provider_check
  CHECK (provider IN ('MOCK', 'MANUAL', 'REGISTRU_CENTRAS'));

-- ---------------------------------------------------------------------------------------------
-- Match strength. Existing matches were all treated as matches, so they stay STRONG.

ALTER TABLE screening_matches
  ADD COLUMN strength text NOT NULL DEFAULT 'STRONG' CHECK (strength IN ('STRONG', 'WEAK'));

-- Same rules as in 0007, with the strength among the fixed result columns.
CREATE OR REPLACE FUNCTION app.screening_matches_before_write() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM screening_checks s WHERE s.id = NEW.check_id AND s.status = 'PENDING'
    ) THEN
      RAISE EXCEPTION 'matches can only be added to a pending check';
    END IF;
    NEW.review_status := 'OPEN';
    NEW.review_justification := NULL;
    NEW.reviewed_by := NULL;
    NEW.reviewed_at := NULL;
    RETURN NEW;
  END IF;

  IF NEW.organization_id <> OLD.organization_id OR NEW.check_id <> OLD.check_id
     OR NEW.external_id IS DISTINCT FROM OLD.external_id OR NEW.name <> OLD.name
     OR NEW.score IS DISTINCT FROM OLD.score OR NEW.categories <> OLD.categories
     OR NEW.details <> OLD.details OR NEW.strength <> OLD.strength THEN
    RAISE EXCEPTION 'screening results cannot be changed';
  END IF;
  IF OLD.review_status <> 'OPEN' THEN
    RAISE EXCEPTION 'this match has already been reviewed' USING ERRCODE = '42501';
  END IF;
  IF NEW.review_status <> 'OPEN' THEN
    NEW.reviewed_by := app.current_user_id();
    NEW.reviewed_at := now();
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Provider exchanges: one row per HTTP attempt (a retried call has several).

CREATE TABLE screening_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT app.current_organization_id(),
  check_id uuid NOT NULL,
  provider text NOT NULL,
  attempt integer NOT NULL CHECK (attempt >= 1),
  -- The request as sent, without credentials (they travel in headers, which are not kept).
  request jsonb NOT NULL,
  -- NULL when no response arrived (network error, timeout).
  response jsonb,
  http_status integer,
  response_sha256 text CHECK (response_sha256 ~ '^[0-9a-f]{64}$'),
  error text,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  sent_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, check_id) REFERENCES screening_checks (organization_id, id),
  CHECK ((response IS NULL) = (response_sha256 IS NULL))
);
CREATE INDEX screening_requests_check_idx ON screening_requests (check_id);

SELECT app.enable_tenant_isolation('screening_requests');
-- Append-only for the application: evidence is never edited or removed.
REVOKE UPDATE, DELETE, TRUNCATE ON screening_requests FROM skydra_app;
CREATE POLICY screening_request_visibility ON screening_requests AS RESTRICTIVE
  USING (EXISTS (SELECT 1 FROM screening_checks s WHERE s.id = screening_requests.check_id))
  WITH CHECK (EXISTS (SELECT 1 FROM screening_checks s WHERE s.id = screening_requests.check_id));

CREATE FUNCTION app.screening_requests_before_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM screening_checks s WHERE s.id = NEW.check_id AND s.status = 'PENDING'
  ) THEN
    RAISE EXCEPTION 'provider exchanges can only be added to a pending check';
  END IF;
  NEW.recorded_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER screening_requests_before_insert
  BEFORE INSERT ON screening_requests
  FOR EACH ROW EXECUTE FUNCTION app.screening_requests_before_insert();

-- ---------------------------------------------------------------------------------------------
-- Checklist: as in 0010, except that only strong matches must be reviewed.

CREATE OR REPLACE FUNCTION app.case_checklist(p_case_id uuid)
  RETURNS TABLE (case_party_id uuid, item text, ok boolean)
  LANGUAGE sql STABLE
  AS $$
    WITH active AS (
      SELECT cp.id, cp.role, cp.cdd_scope, cp.cdd_status, p.party_type
        FROM case_parties cp JOIN parties p ON p.id = cp.party_id
       WHERE cp.case_id = p_case_id AND cp.removed_at IS NULL
    ),
    latest AS (
      SELECT DISTINCT ON (s.case_party_id) s.case_party_id, s.id
        FROM screening_checks s JOIN active a ON a.id = s.case_party_id
       WHERE s.status = 'COMPLETED'
       ORDER BY s.case_party_id, s.requested_at DESC
    ),
    matches AS (
      SELECT l.case_party_id, m.review_status, m.reviewed_at, m.categories, m.strength
        FROM screening_matches m JOIN latest l ON l.id = m.check_id
    ),
    entities AS (
      SELECT a.id FROM active a WHERE a.party_type = 'LEGAL' AND a.cdd_scope = 'FULL'
    ),
    ownership AS (
      SELECT DISTINCT ON (o.case_party_id) o.case_party_id, o.id, o.ubos,
             o.incomplete OR o.discrepancy AS needs_resolution
        FROM ownership_snapshots o JOIN entities e ON e.id = o.case_party_id
       ORDER BY o.case_party_id, o.fetched_at DESC
    ),
    risk AS (
      SELECT final_level, assessed_at FROM risk_assessments
       WHERE case_id = p_case_id ORDER BY assessed_at DESC LIMIT 1
    ),
    edd AS (
      SELECT greatest(
               (SELECT max(reviewed_at) FROM matches
                 WHERE review_status = 'TRUE_POSITIVE' AND NOT ('SANCTIONS' = ANY (categories))),
               (SELECT assessed_at FROM risk WHERE final_level = 'HIGH')) AS needed_since
    ),
    last_approval AS (
      SELECT status, decided_at FROM case_approvals
       WHERE case_id = p_case_id ORDER BY requested_at DESC LIMIT 1
    )
    SELECT NULL::uuid, 'PARTIES_ADDED', EXISTS (SELECT 1 FROM active)
    UNION ALL
    SELECT a.id, 'SCREENED', EXISTS (SELECT 1 FROM latest l WHERE l.case_party_id = a.id)
      FROM active a
    UNION ALL
    SELECT a.id, 'MATCHES_REVIEWED',
           NOT EXISTS (SELECT 1 FROM matches m
                        WHERE m.case_party_id = a.id AND m.review_status = 'OPEN'
                          AND m.strength = 'STRONG')
      FROM active a
    UNION ALL
    SELECT a.id, 'IDENTITY_VERIFIED',
           EXISTS (SELECT 1 FROM identity_verifications v
                    WHERE v.case_party_id = a.id AND v.status = 'VERIFIED')
      FROM active a
     WHERE a.party_type = 'NATURAL' AND a.cdd_scope = 'FULL' AND a.role <> 'BENEFICIAL_OWNER'
    UNION ALL
    SELECT a.id, 'CDD_COMPLETED', a.cdd_status = 'COMPLETED'
      FROM active a WHERE a.cdd_scope = 'FULL' AND a.role <> 'BENEFICIAL_OWNER'
    UNION ALL
    SELECT e.id, 'OWNERSHIP_FETCHED', EXISTS (SELECT 1 FROM ownership o WHERE o.case_party_id = e.id)
      FROM entities e
    UNION ALL
    SELECT o.case_party_id, 'OWNERSHIP_RESOLVED',
           NOT o.needs_resolution
           OR EXISTS (SELECT 1 FROM ownership_resolutions r WHERE r.snapshot_id = o.id)
      FROM ownership o
    UNION ALL
    SELECT o.case_party_id, 'UBOS_LINKED',
           NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(o.ubos) u
              WHERE NOT EXISTS (
                SELECT 1 FROM case_parties b
                 WHERE b.beneficial_owner_of = o.case_party_id AND b.removed_at IS NULL
                   AND b.ubo_key = u ->> 'key'))
      FROM ownership o
    UNION ALL
    SELECT NULL, 'RISK_ASSESSED',
           EXISTS (SELECT 1 FROM risk
                    WHERE assessed_at >= app.case_risk_inputs_changed_at(p_case_id))
    UNION ALL
    SELECT NULL, 'NO_CONFIRMED_SANCTIONS',
           NOT EXISTS (SELECT 1 FROM matches
                        WHERE review_status = 'TRUE_POSITIVE' AND 'SANCTIONS' = ANY (categories))
    UNION ALL
    SELECT NULL, 'EDD_APPROVED',
           (SELECT needed_since FROM edd) IS NULL
           OR EXISTS (SELECT 1 FROM last_approval la
                       WHERE la.status = 'APPROVED'
                         AND la.decided_at >= (SELECT needed_since FROM edd))
    UNION ALL
    SELECT NULL, 'APPROVAL_NOT_REJECTED',
           NOT EXISTS (SELECT 1 FROM last_approval WHERE status = 'REJECTED')
    UNION ALL
    SELECT NULL, 'NO_OPEN_ESCALATION',
           NOT EXISTS (SELECT 1 FROM case_escalations e
                        WHERE e.case_id = p_case_id AND e.status IN ('OPEN', 'REPORTED'))
  $$;
