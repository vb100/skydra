-- 0008_kyc_completion: identity verification, enhanced-due-diligence approval, escalation to the
-- AML officer and the checklist that decides when a case is compliant.
--
-- One function, app.case_checklist, lists what a case still needs; the compliance status and the
-- broker's "what is missing" view both come from it, so they cannot disagree.

-- Approvers and AML officers act on cases they are not responsible for, so they see all cases of
-- the organization (mirrors case.view_all in access/policy.ts).
CREATE OR REPLACE FUNCTION app.case_access() RETURNS text
  LANGUAGE sql STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, app
  AS $$
    SELECT CASE
             WHEN 'MANAGER' = ANY (m.roles)
               OR m.permissions && ARRAY['CASE_VIEW_ALL', 'APPROVER', 'AML_OFFICER'] THEN 'ALL'
             WHEN 'BROKER' = ANY (m.roles) THEN 'OWN'
           END
      FROM memberships m
     WHERE m.organization_id = app.current_organization_id()
       AND m.user_id = app.current_user_id()
       AND m.status = 'ACTIVE'
  $$;

-- Whether the current member holds a permission in the current organization.
CREATE FUNCTION app.current_member_holds(p_permission text) RETURNS boolean
  LANGUAGE sql STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, app
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.organization_id = app.current_organization_id()
         AND m.user_id = app.current_user_id()
         AND m.status = 'ACTIVE' AND u.status = 'ACTIVE'
         AND p_permission = ANY (m.permissions))
  $$;

-- A one-person organization (a solo broker) cannot apply the four-eyes principle.
CREATE FUNCTION app.is_single_member_organization() RETURNS boolean
  LANGUAGE sql STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, app
  AS $$
    SELECT count(*) = 1 FROM memberships
     WHERE organization_id = app.current_organization_id() AND status = 'ACTIVE'
  $$;

-- ---------------------------------------------------------------------------------------------
-- Identity verification of natural persons: remotely through a provider (MOCK now, Ondato later)
-- or in person by the broker with an identity document.

CREATE TABLE identity_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT app.current_organization_id(),
  case_id uuid NOT NULL,
  case_party_id uuid NOT NULL REFERENCES case_parties (id),
  party_id uuid NOT NULL,
  method text NOT NULL CHECK (method IN ('REMOTE', 'IN_PERSON')),
  provider text NOT NULL CHECK (provider IN ('MOCK', 'MANUAL', 'ONDATO')),
  status text NOT NULL CHECK (status IN ('PENDING', 'VERIFIED', 'REJECTED', 'FAILED')),
  provider_reference text,
  document_type text
    CHECK (document_type IN ('ID_CARD', 'PASSPORT', 'RESIDENCE_PERMIT', 'OTHER')),
  -- Encrypted by the application, like personal codes.
  document_number_encrypted text,
  document_country text CHECK (document_country ~ '^[A-Z]{2}$'),
  document_expires_on date,
  verified_name text,
  verified_birth_date date,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  failure_reason text,
  legal_regime text NOT NULL CHECK (legal_regime IN ('PPTFPI', 'AMLR')),
  requested_by uuid NOT NULL DEFAULT app.current_user_id(),
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_by uuid,
  completed_at timestamptz,
  FOREIGN KEY (organization_id, case_id) REFERENCES cases (organization_id, id),
  FOREIGN KEY (organization_id, party_id) REFERENCES parties (organization_id, id),
  CHECK ((status = 'PENDING') = (completed_at IS NULL)),
  CHECK (method = 'REMOTE' OR (
    provider = 'MANUAL' AND status = 'VERIFIED' AND document_type IS NOT NULL
    AND document_number_encrypted IS NOT NULL AND document_country IS NOT NULL)),
  CHECK (status <> 'VERIFIED' OR document_type IS NOT NULL)
);

CREATE INDEX identity_verifications_case_party_idx
  ON identity_verifications (case_party_id, requested_at DESC);

SELECT app.enable_tenant_isolation('identity_verifications');
REVOKE DELETE, TRUNCATE ON identity_verifications FROM skydra_app;

CREATE POLICY identity_verification_visibility ON identity_verifications AS RESTRICTIVE
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = identity_verifications.case_id))
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = identity_verifications.case_id));

CREATE FUNCTION app.identity_verifications_before_write() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM case_parties cp JOIN parties p ON p.id = cp.party_id
       WHERE cp.id = NEW.case_party_id AND cp.case_id = NEW.case_id
         AND cp.party_id = NEW.party_id AND cp.removed_at IS NULL
         AND p.party_type = 'NATURAL'
    ) THEN
      RAISE EXCEPTION 'identity verification applies to a natural person who is part of this case'
        USING ERRCODE = '42501';
    END IF;
    NEW.requested_by := app.current_user_id();
    NEW.requested_at := now();
    NEW.completed_by := NULL;
    NEW.completed_at := NULL;
    NEW.legal_regime := CASE WHEN now() < '2027-07-10 00:00:00+03' THEN 'PPTFPI' ELSE 'AMLR' END;
  ELSE
    IF OLD.status <> 'PENDING' THEN
      RAISE EXCEPTION 'a finished identity verification cannot be changed';
    END IF;
    IF NEW.organization_id <> OLD.organization_id OR NEW.case_id <> OLD.case_id
       OR NEW.case_party_id <> OLD.case_party_id OR NEW.party_id <> OLD.party_id
       OR NEW.method <> OLD.method OR NEW.provider <> OLD.provider
       OR NEW.legal_regime <> OLD.legal_regime OR NEW.requested_by <> OLD.requested_by
       OR NEW.requested_at <> OLD.requested_at THEN
      RAISE EXCEPTION 'identity verification identity columns cannot be changed';
    END IF;
  END IF;

  IF NEW.status <> 'PENDING' THEN
    NEW.completed_by := app.current_user_id();
    NEW.completed_at := now();
    -- An expired document cannot verify anyone.
    IF NEW.status = 'VERIFIED' AND NEW.document_expires_on < current_date THEN
      RAISE EXCEPTION 'the identity document has expired' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER identity_verifications_before_write
  BEFORE INSERT OR UPDATE ON identity_verifications
  FOR EACH ROW EXECUTE FUNCTION app.identity_verifications_before_write();

-- ---------------------------------------------------------------------------------------------
-- Approval to proceed after a confirmed PEP or adverse-media match (enhanced due diligence). The
-- decision is taken by a member with the APPROVER permission who is neither the responsible
-- broker nor the requester, unless the organization has a single member.

CREATE TABLE case_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT app.current_organization_id(),
  case_id uuid NOT NULL,
  -- EDD summary: source of wealth and funds, why the relationship is acceptable.
  reason text NOT NULL CHECK (length(btrim(reason)) >= 10),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'APPROVED', 'REJECTED')),
  requested_by uuid NOT NULL DEFAULT app.current_user_id(),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_justification text,
  FOREIGN KEY (organization_id, case_id) REFERENCES cases (organization_id, id),
  CHECK ((status = 'OPEN') = (decided_at IS NULL)),
  CHECK (status = 'OPEN' OR length(btrim(coalesce(decision_justification, ''))) >= 10)
);

CREATE UNIQUE INDEX case_approvals_one_open ON case_approvals (case_id) WHERE status = 'OPEN';

SELECT app.enable_tenant_isolation('case_approvals');
REVOKE DELETE, TRUNCATE ON case_approvals FROM skydra_app;

CREATE POLICY case_approval_visibility ON case_approvals AS RESTRICTIVE
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_approvals.case_id))
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_approvals.case_id));

CREATE FUNCTION app.case_approvals_before_write() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  v_responsible uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.status := 'OPEN';
    NEW.requested_by := app.current_user_id();
    NEW.requested_at := now();
    NEW.decided_by := NULL;
    NEW.decided_at := NULL;
    NEW.decision_justification := NULL;
    RETURN NEW;
  END IF;

  IF NEW.organization_id <> OLD.organization_id OR NEW.case_id <> OLD.case_id
     OR NEW.reason <> OLD.reason OR NEW.requested_by <> OLD.requested_by
     OR NEW.requested_at <> OLD.requested_at THEN
    RAISE EXCEPTION 'approval request columns cannot be changed';
  END IF;
  IF OLD.status <> 'OPEN' THEN
    RAISE EXCEPTION 'this approval has already been decided' USING ERRCODE = '42501';
  END IF;
  IF NOT app.current_member_holds('APPROVER') THEN
    RAISE EXCEPTION 'only a member with the approver permission can decide' USING ERRCODE = '42501';
  END IF;
  SELECT responsible_user_id INTO v_responsible FROM cases WHERE id = NEW.case_id;
  IF app.current_user_id() IN (v_responsible, OLD.requested_by)
     AND NOT app.is_single_member_organization() THEN
    RAISE EXCEPTION 'the approval must come from someone other than the responsible broker'
      USING ERRCODE = '42501';
  END IF;
  NEW.decided_by := app.current_user_id();
  NEW.decided_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER case_approvals_before_write
  BEFORE INSERT OR UPDATE ON case_approvals
  FOR EACH ROW EXECUTE FUNCTION app.case_approvals_before_write();

-- ---------------------------------------------------------------------------------------------
-- Escalation of a suspicion to the AML officer, who either clears the case or records that it was
-- reported to the FIU (FNTT). An open or reported escalation blocks the case.

CREATE TABLE case_escalations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT app.current_organization_id(),
  case_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 10),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLEARED', 'REPORTED')),
  requested_by uuid NOT NULL DEFAULT app.current_user_id(),
  requested_at timestamptz NOT NULL DEFAULT now(),
  resolved_by uuid,
  resolved_at timestamptz,
  resolution_notes text,
  FOREIGN KEY (organization_id, case_id) REFERENCES cases (organization_id, id),
  CHECK ((status = 'OPEN') = (resolved_at IS NULL)),
  CHECK (status = 'OPEN' OR length(btrim(coalesce(resolution_notes, ''))) >= 10)
);

CREATE INDEX case_escalations_case_idx ON case_escalations (case_id);

SELECT app.enable_tenant_isolation('case_escalations');
REVOKE DELETE, TRUNCATE ON case_escalations FROM skydra_app;

CREATE POLICY case_escalation_visibility ON case_escalations AS RESTRICTIVE
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_escalations.case_id))
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_escalations.case_id));

CREATE FUNCTION app.case_escalations_before_write() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.status := 'OPEN';
    NEW.requested_by := app.current_user_id();
    NEW.requested_at := now();
    NEW.resolved_by := NULL;
    NEW.resolved_at := NULL;
    NEW.resolution_notes := NULL;
    RETURN NEW;
  END IF;

  IF NEW.organization_id <> OLD.organization_id OR NEW.case_id <> OLD.case_id
     OR NEW.reason <> OLD.reason OR NEW.requested_by <> OLD.requested_by
     OR NEW.requested_at <> OLD.requested_at THEN
    RAISE EXCEPTION 'escalation columns cannot be changed';
  END IF;
  IF OLD.status <> 'OPEN' THEN
    RAISE EXCEPTION 'this escalation has already been resolved' USING ERRCODE = '42501';
  END IF;
  IF NOT app.current_member_holds('AML_OFFICER') THEN
    RAISE EXCEPTION 'only the AML officer can resolve an escalation' USING ERRCODE = '42501';
  END IF;
  NEW.resolved_by := app.current_user_id();
  NEW.resolved_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER case_escalations_before_write
  BEFORE INSERT OR UPDATE ON case_escalations
  FOR EACH ROW EXECUTE FUNCTION app.case_escalations_before_write();

-- ---------------------------------------------------------------------------------------------
-- The checklist. Rows without a case party are case-level items.

CREATE FUNCTION app.case_checklist(p_case_id uuid)
  RETURNS TABLE (case_party_id uuid, item text, ok boolean)
  LANGUAGE sql STABLE
  AS $$
    WITH active AS (
      SELECT cp.id, cp.cdd_scope, cp.cdd_status, p.party_type
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
    edd AS (
      SELECT max(reviewed_at) AS confirmed_at FROM matches
       WHERE review_status = 'TRUE_POSITIVE' AND NOT ('SANCTIONS' = ANY (categories))
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
      FROM active a WHERE a.party_type = 'NATURAL' AND a.cdd_scope = 'FULL'
    UNION ALL
    SELECT a.id, 'CDD_COMPLETED', a.cdd_status = 'COMPLETED'
      FROM active a WHERE a.cdd_scope = 'FULL'
    UNION ALL
    SELECT NULL, 'NO_CONFIRMED_SANCTIONS',
           NOT EXISTS (SELECT 1 FROM matches
                        WHERE review_status = 'TRUE_POSITIVE' AND 'SANCTIONS' = ANY (categories))
    UNION ALL
    SELECT NULL, 'EDD_APPROVED',
           (SELECT confirmed_at FROM edd) IS NULL
           OR EXISTS (SELECT 1 FROM last_approval la
                       WHERE la.status = 'APPROVED'
                         AND la.decided_at >= (SELECT confirmed_at FROM edd))
    UNION ALL
    SELECT NULL, 'APPROVAL_NOT_REJECTED',
           NOT EXISTS (SELECT 1 FROM last_approval WHERE status = 'REJECTED')
    UNION ALL
    SELECT NULL, 'NO_OPEN_ESCALATION',
           NOT EXISTS (SELECT 1 FROM case_escalations e
                        WHERE e.case_id = p_case_id AND e.status IN ('OPEN', 'REPORTED'))
  $$;

CREATE OR REPLACE FUNCTION app.refresh_case_compliance(p_case_id uuid) RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, app
  AS $$
DECLARE
  v_case cases%ROWTYPE;
  v_failed text[];
  v_status text;
BEGIN
  -- Only a case visible to the caller (the definer itself is not subject to the policies).
  SELECT * INTO v_case FROM cases
   WHERE id = p_case_id AND organization_id = app.current_organization_id()
     AND (app.case_access() = 'ALL'
          OR (app.case_access() = 'OWN'
              AND app.current_user_id() IN (responsible_user_id, created_by)));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case not found' USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(array_agg(DISTINCT item) FILTER (WHERE NOT ok), '{}')
    INTO v_failed FROM app.case_checklist(p_case_id);

  v_status := CASE
    WHEN v_case.aml_applicability = 'NOT_APPLICABLE_RENT_THRESHOLD'
      OR 'PARTIES_ADDED' = ANY (v_failed) THEN 'NOT_STARTED'
    WHEN v_failed && ARRAY['NO_CONFIRMED_SANCTIONS', 'APPROVAL_NOT_REJECTED', 'NO_OPEN_ESCALATION']
      THEN 'BLOCKED'
    WHEN v_failed && ARRAY['MATCHES_REVIEWED', 'EDD_APPROVED'] THEN 'REVIEW_REQUIRED'
    WHEN cardinality(v_failed) = 0 THEN 'COMPLETED'
    ELSE 'IN_PROGRESS'
  END;

  IF v_status <> v_case.compliance_status THEN
    UPDATE cases SET compliance_status = v_status WHERE id = p_case_id;
    INSERT INTO audit_events (action, entity_type, entity_id, before, after)
    VALUES ('case.compliance_changed', 'case', p_case_id::text,
            jsonb_build_object('compliance_status', v_case.compliance_status),
            jsonb_build_object('compliance_status', v_status));
  END IF;
  RETURN v_status;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- CDD of a party can be marked completed only when the data it requires is there.

CREATE FUNCTION app.case_parties_guard_cdd() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  v_type text;
BEGIN
  IF NEW.cdd_status <> 'COMPLETED' OR NEW.removed_at IS NOT NULL
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

CREATE TRIGGER case_parties_guard_cdd
  BEFORE INSERT OR UPDATE ON case_parties
  FOR EACH ROW EXECUTE FUNCTION app.case_parties_guard_cdd();

-- The contract stage requires completed AML checks where AML applies.
CREATE FUNCTION app.cases_guard_stage() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.stage IN ('CONTRACT', 'COMPLETED') AND OLD.stage NOT IN ('CONTRACT', 'COMPLETED')
     AND NEW.aml_applicability <> 'NOT_APPLICABLE_RENT_THRESHOLD'
     AND NEW.compliance_status <> 'COMPLETED' THEN
    RAISE EXCEPTION 'complete the AML checks before moving to the contract'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER cases_guard_stage
  BEFORE UPDATE ON cases
  FOR EACH ROW EXECUTE FUNCTION app.cases_guard_stage();

REVOKE EXECUTE ON FUNCTION
  app.current_member_holds(text),
  app.is_single_member_organization(),
  app.case_checklist(uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.current_member_holds(text),
  app.is_single_member_organization(),
  app.case_checklist(uuid)
TO skydra_app;
