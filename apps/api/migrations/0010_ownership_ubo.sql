-- 0010_ownership_ubo: registry data of legal-entity parties, ownership analysis, beneficial owners
-- (UBO) and resolution of UBO discrepancies.
--
-- For every legal entity on which we perform CDD the broker fetches registry data (JAR, JADIS,
-- JANGIS through a provider; MOCK for now). The API traces the ownership chain, computes indirect
-- shares and compares the owners at the threshold with those declared in JANGIS. Every identified
-- beneficial owner becomes a party of the case (and is therefore screened); a discrepancy or an
-- untraceable chain blocks completion until resolved with a stated method and evidence.

-- UBO threshold as versioned data (principle 2 in docs/architecture.md).
CREATE TABLE ownership_rule_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  version text NOT NULL,
  threshold_percent numeric(5, 2) NOT NULL CHECK (threshold_percent > 0 AND threshold_percent <= 100),
  valid_from timestamptz NOT NULL,
  UNIQUE (code, version)
);

REVOKE ALL ON ownership_rule_sets FROM skydra_app;
GRANT SELECT ON ownership_rule_sets TO skydra_app;

-- More than 25 % of shares or voting rights (AMLR art. 52; PPTFPĮ 2 str. 14 d.).
INSERT INTO ownership_rule_sets (code, version, threshold_percent, valid_from)
VALUES ('LT-UBO-01', '1', 25, '2026-01-01T00:00:00+02:00');

-- ---------------------------------------------------------------------------------------------
-- Beneficial owners are case parties linked to the legal entity they own or control.

ALTER TABLE case_parties DROP CONSTRAINT case_parties_role_check;
ALTER TABLE case_parties ADD CONSTRAINT case_parties_role_check CHECK (role IN (
  'BUYER', 'SELLER', 'TENANT', 'LANDLORD', 'REPRESENTATIVE', 'PAYER', 'BENEFICIAL_OWNER', 'OTHER'));

ALTER TABLE case_parties
  ADD COLUMN beneficial_owner_of uuid REFERENCES case_parties (id),
  -- Keyed hash of the person's registry identity, to know which identified UBO a link covers.
  ADD COLUMN ubo_key text,
  ADD CONSTRAINT case_parties_beneficial_owner_link CHECK (
    (role = 'BENEFICIAL_OWNER') = (beneficial_owner_of IS NOT NULL)
    AND (beneficial_owner_of IS NULL OR ubo_key IS NOT NULL));

-- The same person may be the UBO of two legal entities in one case.
DROP INDEX case_parties_active_key;
CREATE UNIQUE INDEX case_parties_active_key
  ON case_parties (case_id, party_id, role,
                   coalesce(beneficial_owner_of, '00000000-0000-0000-0000-000000000000'))
  WHERE removed_at IS NULL;

CREATE FUNCTION app.case_parties_check_beneficial_owner() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.beneficial_owner_of IS NOT NULL AND (TG_OP = 'INSERT' OR
     NEW.beneficial_owner_of IS DISTINCT FROM OLD.beneficial_owner_of) THEN
    IF NOT EXISTS (
      SELECT 1 FROM case_parties e JOIN parties p ON p.id = e.party_id
       WHERE e.id = NEW.beneficial_owner_of AND e.case_id = NEW.case_id
         AND e.removed_at IS NULL AND p.party_type = 'LEGAL'
    ) THEN
      RAISE EXCEPTION 'a beneficial owner must belong to a legal entity of the same case'
        USING ERRCODE = '42501';
    END IF;
    IF (SELECT party_type FROM parties WHERE id = NEW.party_id) <> 'NATURAL' THEN
      RAISE EXCEPTION 'a beneficial owner is a natural person' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.beneficial_owner_of IS DISTINCT FROM OLD.beneficial_owner_of
                           OR NEW.ubo_key IS DISTINCT FROM OLD.ubo_key) THEN
    RAISE EXCEPTION 'case party identity columns cannot be changed';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER case_parties_check_beneficial_owner
  BEFORE INSERT OR UPDATE ON case_parties
  FOR EACH ROW EXECUTE FUNCTION app.case_parties_check_beneficial_owner();

-- ---------------------------------------------------------------------------------------------

CREATE TABLE ownership_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT app.current_organization_id(),
  case_id uuid NOT NULL,
  case_party_id uuid NOT NULL REFERENCES case_parties (id),
  party_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('MOCK', 'MANUAL', 'ONDATO')),
  rule_set_id uuid NOT NULL REFERENCES ownership_rule_sets (id),
  -- Registry records as received, with personal codes replaced by encrypted values and masks.
  company jsonb NOT NULL,
  records jsonb NOT NULL,
  -- Ownership tree with effective shares, issues found, and the persons to identify.
  analysis jsonb NOT NULL,
  ubos jsonb NOT NULL CHECK (jsonb_typeof(ubos) = 'array'),
  depth integer NOT NULL CHECK (depth >= 1),
  incomplete boolean NOT NULL,
  discrepancy boolean NOT NULL,
  legal_regime text NOT NULL CHECK (legal_regime IN ('PPTFPI', 'AMLR')),
  fetched_by uuid NOT NULL DEFAULT app.current_user_id(),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, case_id) REFERENCES cases (organization_id, id),
  FOREIGN KEY (organization_id, party_id) REFERENCES parties (organization_id, id)
);

CREATE INDEX ownership_snapshots_case_party_idx
  ON ownership_snapshots (case_party_id, fetched_at DESC);

SELECT app.enable_tenant_isolation('ownership_snapshots');
-- Registry extracts are evidence: never changed.
REVOKE UPDATE, DELETE, TRUNCATE ON ownership_snapshots FROM skydra_app;

CREATE POLICY ownership_snapshot_visibility ON ownership_snapshots AS RESTRICTIVE
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = ownership_snapshots.case_id))
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = ownership_snapshots.case_id));

CREATE FUNCTION app.ownership_snapshots_before_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM case_parties cp JOIN parties p ON p.id = cp.party_id
     WHERE cp.id = NEW.case_party_id AND cp.case_id = NEW.case_id AND cp.party_id = NEW.party_id
       AND cp.removed_at IS NULL AND p.party_type = 'LEGAL'
  ) THEN
    RAISE EXCEPTION 'registry data applies to a legal entity that is part of this case'
      USING ERRCODE = '42501';
  END IF;
  NEW.fetched_by := app.current_user_id();
  NEW.fetched_at := now();
  NEW.legal_regime := CASE WHEN now() < '2027-07-10 00:00:00+03' THEN 'PPTFPI' ELSE 'AMLR' END;
  RETURN NEW;
END
$$;

CREATE TRIGGER ownership_snapshots_before_insert
  BEFORE INSERT ON ownership_snapshots
  FOR EACH ROW EXECUTE FUNCTION app.ownership_snapshots_before_insert();

CREATE TABLE ownership_resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT app.current_organization_id(),
  case_id uuid NOT NULL,
  snapshot_id uuid NOT NULL UNIQUE,
  resolution text NOT NULL
    CHECK (resolution IN ('CLARIFIED_WITH_CLIENT', 'CLIENT_DOCUMENTS_ACCEPTED', 'REPORTED_TO_REGISTRY')),
  notes text NOT NULL CHECK (length(btrim(notes)) >= 20),
  evidence text NOT NULL CHECK (length(btrim(evidence)) >= 3),
  resolved_by uuid NOT NULL DEFAULT app.current_user_id(),
  resolved_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, case_id) REFERENCES cases (organization_id, id),
  FOREIGN KEY (organization_id, snapshot_id) REFERENCES ownership_snapshots (organization_id, id)
);

SELECT app.enable_tenant_isolation('ownership_resolutions');
REVOKE UPDATE, DELETE, TRUNCATE ON ownership_resolutions FROM skydra_app;

CREATE POLICY ownership_resolution_visibility ON ownership_resolutions AS RESTRICTIVE
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = ownership_resolutions.case_id))
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = ownership_resolutions.case_id));

CREATE FUNCTION app.ownership_resolutions_before_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ownership_snapshots s
     WHERE s.id = NEW.snapshot_id AND s.case_id = NEW.case_id AND (s.incomplete OR s.discrepancy)
  ) THEN
    RAISE EXCEPTION 'there is no discrepancy to resolve' USING ERRCODE = '42501';
  END IF;
  NEW.resolved_by := app.current_user_id();
  NEW.resolved_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER ownership_resolutions_before_insert
  BEFORE INSERT ON ownership_resolutions
  FOR EACH ROW EXECUTE FUNCTION app.ownership_resolutions_before_insert();

-- ---------------------------------------------------------------------------------------------
-- Beneficial owners are identified from registry data and screened, but not verified face to face
-- like a client, and give no transaction answers: their CDD is covered by the legal entity's.

CREATE OR REPLACE FUNCTION app.case_parties_guard_cdd() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  v_type text;
BEGIN
  IF NEW.cdd_status <> 'COMPLETED' OR NEW.removed_at IS NOT NULL
     OR NEW.role = 'BENEFICIAL_OWNER'
     OR (TG_OP = 'UPDATE' AND OLD.cdd_status = 'COMPLETED' AND NEW.kyc = OLD.kyc
         AND NEW.cdd_scope = OLD.cdd_scope) THEN
    RETURN NEW;
  END IF;
  IF NEW.cdd_scope = 'FULL' THEN
    IF length(btrim(coalesce(NEW.kyc ->> 'purpose', ''))) = 0
       OR jsonb_typeof(NEW.kyc -> 'actsOnOwnBehalf') IS DISTINCT FROM 'boolean'
       OR jsonb_typeof(NEW.kyc -> 'pepSelfDeclared') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'CDD cannot be completed: purpose, acting on own behalf and PEP declaration are required'
        USING ERRCODE = '42501';
    END IF;
    SELECT party_type INTO v_type FROM parties WHERE id = NEW.party_id;
    IF v_type = 'NATURAL' AND NOT EXISTS (
      SELECT 1 FROM identity_verifications v
       WHERE v.case_party_id = NEW.id AND v.status = 'VERIFIED'
    ) THEN
      RAISE EXCEPTION 'CDD cannot be completed: the identity has not been verified'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- Registry data and resolutions are risk inputs too.
CREATE OR REPLACE FUNCTION app.case_risk_inputs_changed_at(p_case_id uuid) RETURNS timestamptz
  LANGUAGE sql STABLE
  AS $$
    SELECT greatest(
      (SELECT risk_inputs_changed_at FROM cases WHERE id = p_case_id),
      (SELECT max(cp.risk_inputs_changed_at) FROM case_parties cp WHERE cp.case_id = p_case_id),
      (SELECT max(p.updated_at) FROM case_parties cp JOIN parties p ON p.id = cp.party_id
        WHERE cp.case_id = p_case_id AND cp.removed_at IS NULL),
      (SELECT max(completed_at) FROM screening_checks WHERE case_id = p_case_id),
      (SELECT max(m.reviewed_at) FROM screening_matches m
         JOIN screening_checks s ON s.id = m.check_id WHERE s.case_id = p_case_id),
      (SELECT max(completed_at) FROM identity_verifications WHERE case_id = p_case_id),
      (SELECT max(fetched_at) FROM ownership_snapshots WHERE case_id = p_case_id),
      (SELECT max(resolved_at) FROM ownership_resolutions WHERE case_id = p_case_id))
  $$;

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
      SELECT l.case_party_id, m.review_status, m.reviewed_at, m.categories
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
                        WHERE m.case_party_id = a.id AND m.review_status = 'OPEN')
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

-- ---------------------------------------------------------------------------------------------
-- Risk methodology DEMO-2: DEMO-1 plus a complex or untraceable ownership structure.

INSERT INTO risk_rule_sets (code, version, title, is_demo, valid_from, definition)
SELECT code, 'DEMO-2',
       'LT-RISK-01 (demonstracinė versija 2: su nuosavybės struktūra)',
       true, '2026-10-29T00:00:00+02:00',
       jsonb_set(definition, '{factors}', (definition -> 'factors') || $json$[
         { "code": "COMPLEX_OWNERSHIP", "group": "CUSTOMER", "fact": "complexOwnership",
           "is": true, "level": "MEDIUM" }
       ]$json$::jsonb)
  FROM risk_rule_sets WHERE code = 'LT-RISK-01' AND version = 'DEMO-1';
