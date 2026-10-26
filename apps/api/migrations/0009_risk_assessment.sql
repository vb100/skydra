-- 0009_risk_assessment: versioned risk rule sets (LT-RISK-01) and immutable risk assessments.
--
-- Rules are data: a rule set maps facts about a case to factor levels (LOW / MEDIUM / HIGH, no
-- points; decision D9). The engine that computes the facts and applies the rules lives in the API
-- (apps/api/src/risk). A new methodology is a new rule-set row; assessments keep the version they
-- were made with.

CREATE TABLE risk_rule_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  version text NOT NULL,
  title text NOT NULL,
  -- Demonstration rules, not approved by an AML consultant; shown as such in the interface.
  is_demo boolean NOT NULL,
  definition jsonb NOT NULL,
  valid_from timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, version)
);

-- Reference data shared by all organizations: readable, never writable by the runtime role.
REVOKE ALL ON risk_rule_sets FROM skydra_app;
GRANT SELECT ON risk_rule_sets TO skydra_app;

INSERT INTO risk_rule_sets (code, version, title, is_demo, valid_from, definition) VALUES (
  'LT-RISK-01', 'DEMO-1', 'LT-RISK-01 (demonstracinė versija, laukiama AML konsultanto lentelės)',
  true, '2026-01-01T00:00:00+02:00',
  $json${
    "aggregation": { "mediumCountForHigh": 3 },
    "reviewIntervalMonths": { "LOW": 60, "MEDIUM": 36, "HIGH": 12 },
    "eddLevels": ["HIGH"],
    "lists": {
      "eea": ["AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT","LV",
              "LT","LU","MT","NL","PL","PT","RO","SK","SI","ES","SE","IS","LI","NO"],
      "highRiskThirdCountries": ["AF","BF","CD","CM","DZ","HT","IR","KP","LB","ML","MM","MZ",
                                 "NG","SS","SY","TZ","VE","VN","YE","ZA"]
    },
    "factors": [
      { "code": "PEP", "group": "PEP", "fact": "pep", "is": true,
        "level": "HIGH", "mandatory": true },
      { "code": "SANCTIONS", "group": "SANCTIONS", "fact": "sanctions", "is": true,
        "level": "HIGH", "mandatory": true },
      { "code": "ADVERSE_MEDIA", "group": "SANCTIONS", "fact": "adverseMedia", "is": true,
        "level": "HIGH" },
      { "code": "NOT_OWN_BEHALF", "group": "CUSTOMER", "fact": "notOwnBehalf", "is": true,
        "level": "HIGH" },
      { "code": "LEGAL_ENTITY", "group": "CUSTOMER", "fact": "legalEntityParty", "is": true,
        "level": "MEDIUM" },
      { "code": "REPRESENTATIVE", "group": "CUSTOMER", "fact": "representativeInvolved",
        "is": true, "level": "MEDIUM" },
      { "code": "REMOTE_IDENTIFICATION", "group": "CUSTOMER", "fact": "remoteIdentification",
        "is": true, "level": "MEDIUM" },
      { "code": "HIGH_RISK_COUNTRY", "group": "GEOGRAPHY", "fact": "partyCountries",
        "anyInList": "highRiskThirdCountries", "level": "HIGH", "mandatory": true },
      { "code": "NON_EEA_COUNTRY", "group": "GEOGRAPHY", "fact": "partyCountries",
        "anyNotInList": "eea", "level": "MEDIUM" },
      { "code": "CASH", "group": "PAYMENT", "fact": "paymentMethod", "in": ["CASH"],
        "level": "HIGH" },
      { "code": "MIXED_PAYMENT", "group": "PAYMENT", "fact": "paymentMethod", "in": ["MIXED"],
        "level": "MEDIUM" },
      { "code": "THIRD_PARTY_PAYER", "group": "PAYMENT", "fact": "thirdPartyPayer", "is": true,
        "level": "MEDIUM" },
      { "code": "HIGH_VALUE", "group": "PAYMENT", "fact": "transactionValueEur", "gte": 1000000,
        "level": "MEDIUM" },
      { "code": "SOURCE_OF_FUNDS_MISSING", "group": "PAYMENT", "fact": "sourceOfFundsMissing",
        "is": true, "level": "MEDIUM" }
    ]
  }$json$::jsonb
);

-- ---------------------------------------------------------------------------------------------
-- When the inputs of a risk assessment last changed. Only risk-relevant columns count, so moving
-- a case to the next stage or completing CDD does not make an assessment stale.

ALTER TABLE cases ADD COLUMN risk_inputs_changed_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE case_parties ADD COLUMN risk_inputs_changed_at timestamptz NOT NULL DEFAULT now();

CREATE FUNCTION app.cases_touch_risk_inputs() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (NEW.transaction_type, NEW.property_type, NEW.transaction_value, NEW.monthly_rent,
      NEW.payment_method, NEW.aml_applicability)
     IS DISTINCT FROM
     (OLD.transaction_type, OLD.property_type, OLD.transaction_value, OLD.monthly_rent,
      OLD.payment_method, OLD.aml_applicability) THEN
    NEW.risk_inputs_changed_at := now();
  ELSE
    NEW.risk_inputs_changed_at := OLD.risk_inputs_changed_at;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER cases_touch_risk_inputs
  BEFORE UPDATE ON cases
  FOR EACH ROW EXECUTE FUNCTION app.cases_touch_risk_inputs();

CREATE FUNCTION app.case_parties_touch_risk_inputs() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (NEW.is_our_client, NEW.represented_by_other_broker, NEW.cdd_scope, NEW.reliance, NEW.kyc,
      NEW.removed_at)
     IS DISTINCT FROM
     (OLD.is_our_client, OLD.represented_by_other_broker, OLD.cdd_scope, OLD.reliance, OLD.kyc,
      OLD.removed_at) THEN
    NEW.risk_inputs_changed_at := now();
  ELSE
    NEW.risk_inputs_changed_at := OLD.risk_inputs_changed_at;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER case_parties_touch_risk_inputs
  BEFORE UPDATE ON case_parties
  FOR EACH ROW EXECUTE FUNCTION app.case_parties_touch_risk_inputs();

CREATE FUNCTION app.case_risk_inputs_changed_at(p_case_id uuid) RETURNS timestamptz
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
      (SELECT max(completed_at) FROM identity_verifications WHERE case_id = p_case_id))
  $$;

-- ---------------------------------------------------------------------------------------------

CREATE TABLE risk_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT app.current_organization_id(),
  case_id uuid NOT NULL,
  rule_set_id uuid NOT NULL REFERENCES risk_rule_sets (id),
  -- Facts the rules were applied to and the result per factor, kept as evidence.
  facts jsonb NOT NULL,
  factors jsonb NOT NULL,
  calculated_level text NOT NULL CHECK (calculated_level IN ('LOW', 'MEDIUM', 'HIGH')),
  -- The level no one may go below (e.g. HIGH for a PEP); NULL when no mandatory factor applies.
  mandatory_level text CHECK (mandatory_level IN ('LOW', 'MEDIUM', 'HIGH')),
  final_level text NOT NULL CHECK (final_level IN ('LOW', 'MEDIUM', 'HIGH')),
  justification text,
  next_review_on date NOT NULL,
  legal_regime text NOT NULL CHECK (legal_regime IN ('PPTFPI', 'AMLR')),
  assessed_by uuid NOT NULL DEFAULT app.current_user_id(),
  assessed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, case_id) REFERENCES cases (organization_id, id),
  CHECK (final_level = calculated_level
         OR length(btrim(coalesce(justification, ''))) >= 10)
);

CREATE INDEX risk_assessments_case_idx ON risk_assessments (case_id, assessed_at DESC);

SELECT app.enable_tenant_isolation('risk_assessments');
-- Assessments are never changed: a correction is a new assessment.
REVOKE UPDATE, DELETE, TRUNCATE ON risk_assessments FROM skydra_app;

CREATE POLICY risk_assessment_visibility ON risk_assessments AS RESTRICTIVE
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = risk_assessments.case_id))
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = risk_assessments.case_id));

CREATE FUNCTION app.risk_level_rank(p_level text) RETURNS integer
  LANGUAGE sql IMMUTABLE
  AS $$ SELECT array_position(ARRAY['LOW', 'MEDIUM', 'HIGH'], p_level) $$;

-- Lowering the calculated level is a second person's decision (an approver who is not the
-- responsible broker, except in a one-member organization); the mandatory minimum cannot be
-- lowered by anyone.
CREATE FUNCTION app.risk_assessments_before_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  v_responsible uuid;
BEGIN
  NEW.assessed_by := app.current_user_id();
  NEW.assessed_at := now();
  NEW.legal_regime := CASE WHEN now() < '2027-07-10 00:00:00+03' THEN 'PPTFPI' ELSE 'AMLR' END;

  IF NEW.mandatory_level IS NOT NULL
     AND app.risk_level_rank(NEW.final_level) < app.risk_level_rank(NEW.mandatory_level) THEN
    RAISE EXCEPTION 'the risk level cannot be set below the mandatory minimum'
      USING ERRCODE = '42501';
  END IF;
  IF app.risk_level_rank(NEW.final_level) < app.risk_level_rank(NEW.calculated_level) THEN
    SELECT responsible_user_id INTO v_responsible FROM cases WHERE id = NEW.case_id;
    IF NOT app.current_member_holds('APPROVER')
       OR (app.current_user_id() = v_responsible AND NOT app.is_single_member_organization()) THEN
      RAISE EXCEPTION 'lowering the calculated risk needs an approver other than the responsible broker'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER risk_assessments_before_insert
  BEFORE INSERT ON risk_assessments
  FOR EACH ROW EXECUTE FUNCTION app.risk_assessments_before_insert();

-- ---------------------------------------------------------------------------------------------
-- Checklist: the current risk must be assessed after the last change of its inputs, and a HIGH
-- final risk needs the same enhanced-due-diligence approval as a confirmed PEP.

CREATE OR REPLACE FUNCTION app.case_checklist(p_case_id uuid)
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
      FROM active a WHERE a.party_type = 'NATURAL' AND a.cdd_scope = 'FULL'
    UNION ALL
    SELECT a.id, 'CDD_COMPLETED', a.cdd_status = 'COMPLETED'
      FROM active a WHERE a.cdd_scope = 'FULL'
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

REVOKE EXECUTE ON FUNCTION
  app.case_risk_inputs_changed_at(uuid),
  app.risk_level_rank(text)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.case_risk_inputs_changed_at(uuid),
  app.risk_level_rank(text)
TO skydra_app;
