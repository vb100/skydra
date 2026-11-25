-- 0019_case_revisions: a completed case is read-only; changing it means reopening it (client
-- answer Q26): Completed → Reopened → Updated → Completed, with every earlier state kept.
--
--   * While a case is COMPLETED and not reopened, its data, parties, identity, KYC, risk,
--     registry data, documents and approval requests cannot change. What stays possible: the
--     transaction's stage (contract, completion), screening (ongoing monitoring), a report to the
--     AML officer, terminating the relationship, and exporting.
--   * Reopening records the reason, who and when, and a summary of the state it reopens; the case
--     then needs a new final decision, taken after the reopening. That decision closes it.
--   * Which checks the changes call for follows from the checklist as always: a new party needs
--     its own checks, changed risk inputs a new risk assessment.
--   * Ongoing monitoring (or a re-check) that finds something new puts the case out of COMPLETED
--     by itself, so the review needs no reopening; one that finds nothing new changes nothing.

-- ---------------------------------------------------------------------------------------------
-- Reopenings

CREATE TABLE case_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT app.current_organization_id(),
  case_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 2000),
  -- The state reopened: status, stage, risk, decision, parties (masked), as the API summarised it.
  snapshot jsonb NOT NULL,
  opened_by uuid NOT NULL DEFAULT app.current_user_id(),
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  closed_by_decision uuid REFERENCES case_decisions (id),
  FOREIGN KEY (organization_id, case_id) REFERENCES cases (organization_id, id),
  CHECK ((closed_at IS NULL) = (closed_by_decision IS NULL))
);

-- At most one open reopening per case.
CREATE UNIQUE INDEX case_revisions_open_idx ON case_revisions (case_id) WHERE closed_at IS NULL;
CREATE INDEX case_revisions_case_idx ON case_revisions (case_id, opened_at DESC);

SELECT app.enable_tenant_isolation('case_revisions');
REVOKE UPDATE, DELETE, TRUNCATE ON case_revisions FROM skydra_app;
-- Closing is the only change, made by the decision trigger below.
GRANT UPDATE (closed_at, closed_by_decision) ON case_revisions TO skydra_app;
CREATE POLICY case_revision_visibility ON case_revisions AS RESTRICTIVE
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_revisions.case_id))
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_revisions.case_id));

CREATE FUNCTION app.case_revisions_before_write() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (SELECT compliance_status FROM cases WHERE id = NEW.case_id) <> 'COMPLETED' THEN
      RAISE EXCEPTION 'only a completed case is reopened' USING ERRCODE = '42501';
    END IF;
    NEW.opened_by := app.current_user_id();
    NEW.opened_at := clock_timestamp();
    NEW.closed_at := NULL;
    NEW.closed_by_decision := NULL;
    RETURN NEW;
  END IF;
  IF OLD.closed_at IS NOT NULL OR NEW.closed_by_decision IS NULL OR NOT EXISTS (
    SELECT 1 FROM case_decisions d
     WHERE d.id = NEW.closed_by_decision AND d.case_id = NEW.case_id
       AND d.decided_at >= OLD.opened_at
  ) THEN
    RAISE EXCEPTION 'a reopening is closed only by a decision taken in it' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER case_revisions_before_write
  BEFORE INSERT OR UPDATE ON case_revisions
  FOR EACH ROW EXECUTE FUNCTION app.case_revisions_before_write();

-- ---------------------------------------------------------------------------------------------
-- The lock

CREATE FUNCTION app.case_is_locked(p_case_id uuid) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT EXISTS (SELECT 1 FROM cases WHERE id = p_case_id AND compliance_status = 'COMPLETED')
       AND NOT EXISTS (SELECT 1 FROM case_revisions
                        WHERE case_id = p_case_id AND closed_at IS NULL)
  $$;

-- Parties, identity, risk, registry data, documents, approval requests of a locked case.
CREATE FUNCTION app.guard_locked_case() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF app.case_is_locked(NEW.case_id) THEN
    RAISE EXCEPTION 'the case is completed: reopen it to make changes' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER case_parties_guard_locked BEFORE INSERT OR UPDATE ON case_parties
  FOR EACH ROW EXECUTE FUNCTION app.guard_locked_case();
CREATE TRIGGER identity_verifications_guard_locked BEFORE INSERT ON identity_verifications
  FOR EACH ROW EXECUTE FUNCTION app.guard_locked_case();
CREATE TRIGGER risk_assessments_guard_locked BEFORE INSERT ON risk_assessments
  FOR EACH ROW EXECUTE FUNCTION app.guard_locked_case();
CREATE TRIGGER case_documents_guard_locked BEFORE INSERT ON case_documents
  FOR EACH ROW EXECUTE FUNCTION app.guard_locked_case();
CREATE TRIGGER ownership_snapshots_guard_locked BEFORE INSERT ON ownership_snapshots
  FOR EACH ROW EXECUTE FUNCTION app.guard_locked_case();
CREATE TRIGGER ownership_resolutions_guard_locked BEFORE INSERT ON ownership_resolutions
  FOR EACH ROW EXECUTE FUNCTION app.guard_locked_case();
CREATE TRIGGER case_approvals_guard_locked BEFORE INSERT ON case_approvals
  FOR EACH ROW EXECUTE FUNCTION app.guard_locked_case();

-- The case's own data; its stage, responsible broker and derived status may still change.
CREATE FUNCTION app.cases_guard_locked() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF app.case_is_locked(NEW.id)
     AND (NEW.transaction_type, NEW.property_type, NEW.property_address, NEW.transaction_value,
          NEW.monthly_rent, NEW.payment_method, NEW.payment_method_other, NEW.aml_applicability)
         IS DISTINCT FROM
         (OLD.transaction_type, OLD.property_type, OLD.property_address, OLD.transaction_value,
          OLD.monthly_rent, OLD.payment_method, OLD.payment_method_other, OLD.aml_applicability)
  THEN
    RAISE EXCEPTION 'the case is completed: reopen it to make changes' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER cases_guard_locked BEFORE UPDATE ON cases
  FOR EACH ROW EXECUTE FUNCTION app.cases_guard_locked();

-- ---------------------------------------------------------------------------------------------
-- Decisions: as in 0017, a new approval is possible in a reopened case, and a decision closes
-- the reopening.

CREATE OR REPLACE FUNCTION app.case_decisions_before_insert() RETURNS trigger
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
       AND v_last.decided_at >= v_risk.assessed_at
       AND NOT EXISTS (SELECT 1 FROM case_revisions v
                        WHERE v.case_id = NEW.case_id AND v.closed_at IS NULL) THEN
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

CREATE OR REPLACE FUNCTION app.case_decisions_after_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.decision IN ('DECLINE', 'TERMINATE') THEN
    UPDATE cases SET stage = 'TERMINATED' WHERE id = NEW.case_id AND stage <> 'TERMINATED';
  END IF;
  -- A decision ends the reopening it was taken in.
  UPDATE case_revisions SET closed_at = NEW.decided_at, closed_by_decision = NEW.id
   WHERE case_id = NEW.case_id AND closed_at IS NULL;
  RETURN NULL;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Checklist: as in 0017, the final decision must also postdate the latest reopening.

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
    ),
    last_reopening AS (
      SELECT max(opened_at) AS opened_at FROM case_revisions WHERE case_id = p_case_id
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
    -- The broker's final decision, taken on the latest risk assessment and after the latest
    -- reopening (a new assessment or a reopened case needs a new decision).
    SELECT NULL, 'DECISION_RECORDED',
           EXISTS (SELECT 1 FROM last_decision d
                    WHERE d.decision IN ('APPROVE', 'APPROVE_WITH_ENHANCED_MEASURES')
                      AND d.decided_at >= greatest(
                            coalesce((SELECT assessed_at FROM risk), '-infinity'),
                            coalesce((SELECT opened_at FROM last_reopening), '-infinity')))
  $$;

-- ---------------------------------------------------------------------------------------------
-- Risk inputs: as in 0015, but for every check, not only monitoring: a check changes what the
-- risk was assessed on only when it finds a new strong match (a match's review counts on its
-- own). A broker's re-check of a completed case that finds nothing new leaves it completed
-- instead of reopening it without a recorded reason.

CREATE OR REPLACE FUNCTION app.case_risk_inputs_changed_at(p_case_id uuid) RETURNS timestamptz
  LANGUAGE sql STABLE
  AS $$
    SELECT greatest(
      (SELECT risk_inputs_changed_at FROM cases WHERE id = p_case_id),
      (SELECT max(cp.risk_inputs_changed_at) FROM case_parties cp WHERE cp.case_id = p_case_id),
      (SELECT max(p.updated_at) FROM case_parties cp JOIN parties p ON p.id = cp.party_id
        WHERE cp.case_id = p_case_id AND cp.removed_at IS NULL),
      (SELECT max(s.completed_at) FROM screening_checks s
        WHERE s.case_id = p_case_id AND s.status = 'COMPLETED'
          AND EXISTS (SELECT 1 FROM screening_matches m
                       WHERE m.check_id = s.id AND m.carried_from IS NULL
                         AND m.strength = 'STRONG')),
      (SELECT max(m.reviewed_at) FROM screening_matches m
         JOIN screening_checks s ON s.id = m.check_id WHERE s.case_id = p_case_id),
      (SELECT max(completed_at) FROM identity_verifications WHERE case_id = p_case_id))
  $$;
