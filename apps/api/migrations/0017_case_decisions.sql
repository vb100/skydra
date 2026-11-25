-- 0017_case_decisions: the broker's final decision on a case (client answers Q25, Q7 and the
-- MVP summary): approve, approve with enhanced measures, decline, or terminate the relationship,
-- always with the reasons and a separate assessment of suspicious indicators.
--
--   * A case is complete only with a final approval taken on its latest risk assessment: a new
--     assessment (e.g. after monitoring found something) needs a new decision.
--   * Approval needs every other requirement met; where enhanced due diligence applied (high
--     risk, or a confirmed PEP or other finding) only "approve with enhanced measures" fits.
--   * Declining (before a relationship) or terminating (after an approval) closes the case: its
--     status becomes CLOSED, the transaction TERMINATED, and no further decision is taken on it.
--     A closed case can still be exported, as its AML file must be kept.
--   * Suspicious indicators found must have been reported to the AML officer first.
--   * Decisions are evidence: added, never changed.

-- ---------------------------------------------------------------------------------------------
-- Decisions

CREATE TABLE case_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT app.current_organization_id(),
  case_id uuid NOT NULL,
  decision text NOT NULL
    CHECK (decision IN ('APPROVE', 'APPROVE_WITH_ENHANCED_MEASURES', 'DECLINE', 'TERMINATE')),
  justification text NOT NULL CHECK (length(btrim(justification)) BETWEEN 10 AND 4000),
  suspicious_indicators boolean NOT NULL,
  suspicion_notes text,
  -- Taken from the latest risk assessment at the time of the decision.
  risk_level text CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH')),
  next_review_on date,
  legal_regime text NOT NULL CHECK (legal_regime IN ('PPTFPI', 'AMLR')),
  decided_by uuid NOT NULL DEFAULT app.current_user_id(),
  decided_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, case_id) REFERENCES cases (organization_id, id),
  CHECK (NOT suspicious_indicators OR length(btrim(coalesce(suspicion_notes, ''))) >= 10),
  CHECK ((decision IN ('APPROVE', 'APPROVE_WITH_ENHANCED_MEASURES')) = (next_review_on IS NOT NULL))
);

CREATE INDEX case_decisions_case_idx ON case_decisions (case_id, decided_at DESC);

SELECT app.enable_tenant_isolation('case_decisions');
REVOKE UPDATE, DELETE, TRUNCATE ON case_decisions FROM skydra_app;
CREATE POLICY case_decision_visibility ON case_decisions AS RESTRICTIVE
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_decisions.case_id))
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_decisions.case_id));

-- Enhanced due diligence applied: high risk, or a confirmed finding other than sanctions (the
-- same condition as EDD_APPROVED in the checklist).
CREATE FUNCTION app.case_enhanced_required(p_case_id uuid) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT EXISTS (
             SELECT 1 FROM (SELECT final_level FROM risk_assessments WHERE case_id = p_case_id
                             ORDER BY assessed_at DESC LIMIT 1) r
              WHERE r.final_level = 'HIGH')
        OR EXISTS (
             SELECT 1 FROM screening_matches m
               JOIN screening_checks s ON s.id = m.check_id
               JOIN case_parties cp ON cp.id = s.case_party_id AND cp.removed_at IS NULL
              WHERE s.case_id = p_case_id AND s.status = 'COMPLETED'
                AND m.review_status = 'TRUE_POSITIVE' AND NOT ('SANCTIONS' = ANY (m.categories)))
  $$;

CREATE FUNCTION app.case_decisions_before_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  v_last case_decisions%ROWTYPE;
  v_risk risk_assessments%ROWTYPE;
  v_missing text;
BEGIN
  SELECT * INTO v_last FROM case_decisions
   WHERE case_id = NEW.case_id ORDER BY decided_at DESC, id DESC LIMIT 1;
  IF v_last.decision IN ('DECLINE', 'TERMINATE') THEN
    RAISE EXCEPTION 'the case is closed by an earlier decision' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_risk FROM risk_assessments
   WHERE case_id = NEW.case_id ORDER BY assessed_at DESC LIMIT 1;

  IF NEW.decision IN ('APPROVE', 'APPROVE_WITH_ENHANCED_MEASURES') THEN
    SELECT string_agg(DISTINCT item, ', ' ORDER BY item) INTO v_missing
      FROM app.case_checklist(NEW.case_id) WHERE NOT ok AND item <> 'DECISION_RECORDED';
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'the case cannot be approved yet: %', v_missing USING ERRCODE = '42501';
    END IF;
    IF v_last.decision IN ('APPROVE', 'APPROVE_WITH_ENHANCED_MEASURES')
       AND v_last.decided_at >= v_risk.assessed_at THEN
      RAISE EXCEPTION 'the case is already approved on its latest risk assessment'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.decision = 'APPROVE' AND app.case_enhanced_required(NEW.case_id) THEN
      RAISE EXCEPTION 'enhanced due diligence applied: approve with enhanced measures'
        USING ERRCODE = '42501';
    END IF;
    NEW.next_review_on := v_risk.next_review_on;
  ELSE
    -- Terminating ends a relationship that was approved; declining refuses one that was not.
    IF NEW.decision = 'TERMINATE' AND NOT EXISTS (
      SELECT 1 FROM case_decisions d WHERE d.case_id = NEW.case_id
         AND d.decision IN ('APPROVE', 'APPROVE_WITH_ENHANCED_MEASURES')
    ) THEN
      RAISE EXCEPTION 'nothing was approved to terminate: decline instead' USING ERRCODE = '42501';
    END IF;
    IF NEW.decision = 'DECLINE' AND v_last.id IS NOT NULL THEN
      RAISE EXCEPTION 'the case was approved: terminate instead' USING ERRCODE = '42501';
    END IF;
    NEW.next_review_on := NULL;
  END IF;

  IF NEW.suspicious_indicators AND NOT EXISTS (
    SELECT 1 FROM case_escalations e WHERE e.case_id = NEW.case_id
  ) THEN
    RAISE EXCEPTION 'report the suspicious indicators to the AML officer first'
      USING ERRCODE = '42501';
  END IF;

  NEW.risk_level := v_risk.final_level;
  NEW.legal_regime := CASE WHEN now() < '2027-07-10 00:00:00+03' THEN 'PPTFPI' ELSE 'AMLR' END;
  NEW.decided_by := app.current_user_id();
  NEW.decided_at := clock_timestamp();
  RETURN NEW;
END
$$;

CREATE TRIGGER case_decisions_before_insert
  BEFORE INSERT ON case_decisions
  FOR EACH ROW EXECUTE FUNCTION app.case_decisions_before_insert();

-- A closing decision ends the transaction.
CREATE FUNCTION app.case_decisions_after_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.decision IN ('DECLINE', 'TERMINATE') THEN
    UPDATE cases SET stage = 'TERMINATED' WHERE id = NEW.case_id AND stage <> 'TERMINATED';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER case_decisions_after_insert
  AFTER INSERT ON case_decisions
  FOR EACH ROW EXECUTE FUNCTION app.case_decisions_after_insert();

-- ---------------------------------------------------------------------------------------------
-- Stage: as in 0008, and a case closed by a decision stays TERMINATED.

CREATE OR REPLACE FUNCTION app.cases_guard_stage() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.stage IN ('CONTRACT', 'COMPLETED') AND OLD.stage NOT IN ('CONTRACT', 'COMPLETED')
     AND NEW.aml_applicability <> 'NOT_APPLICABLE_RENT_THRESHOLD'
     AND NEW.compliance_status <> 'COMPLETED' THEN
    RAISE EXCEPTION 'complete the AML checks before moving to the contract'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.stage = 'TERMINATED' AND NEW.stage <> 'TERMINATED' AND EXISTS (
    SELECT 1 FROM case_decisions d WHERE d.case_id = NEW.id AND d.decision IN ('DECLINE', 'TERMINATE')
  ) THEN
    RAISE EXCEPTION 'the case is closed by a decision' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Checklist: as in 0015, with the final decision.

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
    confirmed AS (
      SELECT m.reviewed_at, m.categories
        FROM screening_matches m
        JOIN screening_checks s ON s.id = m.check_id
        JOIN active a ON a.id = s.case_party_id
       WHERE s.status = 'COMPLETED' AND m.review_status = 'TRUE_POSITIVE'
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
               (SELECT max(reviewed_at) FROM confirmed
                 WHERE NOT ('SANCTIONS' = ANY (categories))),
               (SELECT assessed_at FROM risk WHERE final_level = 'HIGH')) AS needed_since
    ),
    last_approval AS (
      SELECT status, decided_at FROM case_approvals
       WHERE case_id = p_case_id ORDER BY requested_at DESC LIMIT 1
    ),
    last_decision AS (
      SELECT decision, decided_at FROM case_decisions
       WHERE case_id = p_case_id ORDER BY decided_at DESC, id DESC LIMIT 1
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
     WHERE a.party_type = 'NATURAL' AND a.cdd_scope = 'FULL'
       AND a.role NOT IN ('BENEFICIAL_OWNER', 'DIRECTOR')
    UNION ALL
    SELECT a.id, 'CDD_COMPLETED', a.cdd_status = 'COMPLETED'
      FROM active a WHERE a.cdd_scope = 'FULL' AND a.role NOT IN ('BENEFICIAL_OWNER', 'DIRECTOR')
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
           NOT EXISTS (SELECT 1 FROM confirmed WHERE 'SANCTIONS' = ANY (categories))
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
    UNION ALL
    -- The broker's final decision, taken on the latest risk assessment (a new assessment, e.g.
    -- after monitoring found something, needs a new decision).
    SELECT NULL, 'DECISION_RECORDED',
           EXISTS (SELECT 1 FROM last_decision d
                    WHERE d.decision IN ('APPROVE', 'APPROVE_WITH_ENHANCED_MEASURES')
                      AND d.decided_at >= coalesce((SELECT assessed_at FROM risk), '-infinity'))
  $$;

-- ---------------------------------------------------------------------------------------------
-- Compliance status: as in 0008, with CLOSED for a declined or terminated case.

ALTER TABLE cases DROP CONSTRAINT cases_compliance_status_check;
ALTER TABLE cases ADD CONSTRAINT cases_compliance_status_check CHECK (compliance_status IN (
  'NOT_STARTED', 'IN_PROGRESS', 'REVIEW_REQUIRED', 'BLOCKED', 'COMPLETED', 'CLOSED'));

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
    WHEN (SELECT decision FROM case_decisions WHERE case_id = p_case_id
           ORDER BY decided_at DESC, id DESC LIMIT 1) IN ('DECLINE', 'TERMINATE') THEN 'CLOSED'
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
-- Export: a completed or a closed case (its AML file is kept either way).

CREATE OR REPLACE FUNCTION app.case_exports_before_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  v_status text := (SELECT compliance_status FROM cases WHERE id = NEW.case_id);
BEGIN
  IF v_status NOT IN ('COMPLETED', 'CLOSED') THEN
    RAISE EXCEPTION 'complete the AML checks before exporting the case' USING ERRCODE = '42501';
  END IF;
  NEW.compliance_status := v_status;
  NEW.exported_by := app.current_user_id();
  NEW.exported_at := now();
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Cases completed before this migration have no final decision, so they are no longer complete.
-- The change is recorded in each organization's audit trail as a system event; nothing is
-- decided on the broker's behalf. Row-level security binds the owner too, so it is lifted on
-- cases for this transaction only.

ALTER TABLE cases NO FORCE ROW LEVEL SECURITY;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT id, organization_id FROM cases WHERE compliance_status = 'COMPLETED' LOOP
    PERFORM set_config('app.organization_id', r.organization_id::text, true);
    UPDATE cases SET compliance_status = 'IN_PROGRESS' WHERE id = r.id;
    INSERT INTO audit_events (organization_id, actor_user_id, action, entity_type, entity_id,
                              before, after, metadata)
    VALUES (r.organization_id, NULL, 'case.compliance_changed', 'case', r.id::text,
            jsonb_build_object('compliance_status', 'COMPLETED'),
            jsonb_build_object('compliance_status', 'IN_PROGRESS'),
            jsonb_build_object('reason', 'a final decision is now required (migration 0017)'));
  END LOOP;
  PERFORM set_config('app.organization_id', '', true);
END
$$;
ALTER TABLE cases FORCE ROW LEVEL SECURITY;
