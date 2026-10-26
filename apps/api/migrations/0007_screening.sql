-- 0007_screening: sanctions / PEP / adverse-media screening of case parties, broker review of
-- potential matches and the case compliance status derived from them.
--
-- A check is evidence: once completed, its query and results never change. A broker reviews each
-- potential match once, with a written justification. The compliance status of a case is computed
-- by app.refresh_case_compliance only; the runtime role cannot set it directly.

CREATE TABLE screening_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT app.current_organization_id(),
  case_id uuid NOT NULL,
  case_party_id uuid NOT NULL REFERENCES case_parties (id),
  party_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('MOCK', 'MANUAL', 'ONDATO')),
  status text NOT NULL CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED')),
  -- What was searched (name, birth date, countries); never the personal code.
  subject jsonb NOT NULL,
  provider_reference text,
  match_count integer CHECK (match_count >= 0),
  error text,
  legal_regime text NOT NULL CHECK (legal_regime IN ('PPTFPI', 'AMLR')),
  requested_by uuid NOT NULL DEFAULT app.current_user_id(),
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, case_id) REFERENCES cases (organization_id, id),
  FOREIGN KEY (organization_id, party_id) REFERENCES parties (organization_id, id),
  CHECK ((status = 'COMPLETED') = (match_count IS NOT NULL)),
  CHECK ((status = 'PENDING') = (completed_at IS NULL))
);

CREATE INDEX screening_checks_case_idx ON screening_checks (organization_id, case_id);
CREATE INDEX screening_checks_case_party_idx ON screening_checks (case_party_id, requested_at DESC);

SELECT app.enable_tenant_isolation('screening_checks');
REVOKE DELETE, TRUNCATE ON screening_checks FROM skydra_app;

CREATE POLICY screening_check_visibility ON screening_checks AS RESTRICTIVE
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = screening_checks.case_id))
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = screening_checks.case_id));

CREATE TABLE screening_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT app.current_organization_id(),
  check_id uuid NOT NULL,
  external_id text,
  name text NOT NULL,
  score numeric(5, 2) CHECK (score BETWEEN 0 AND 100),
  categories text[] NOT NULL
    CHECK (cardinality(categories) > 0
           AND categories <@ ARRAY['SANCTIONS', 'PEP', 'PEP_ASSOCIATE', 'ADVERSE_MEDIA', 'OTHER_LIST']),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Same states as the provider's match resolution (Open | FalsePositive | TruePositive).
  review_status text NOT NULL DEFAULT 'OPEN'
    CHECK (review_status IN ('OPEN', 'FALSE_POSITIVE', 'TRUE_POSITIVE')),
  review_justification text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  FOREIGN KEY (organization_id, check_id) REFERENCES screening_checks (organization_id, id),
  CHECK ((review_status = 'OPEN') = (reviewed_at IS NULL)),
  CHECK (review_status = 'OPEN' OR length(btrim(coalesce(review_justification, ''))) >= 10)
);

CREATE INDEX screening_matches_check_idx ON screening_matches (check_id);

SELECT app.enable_tenant_isolation('screening_matches');
REVOKE DELETE, TRUNCATE ON screening_matches FROM skydra_app;

CREATE POLICY screening_match_visibility ON screening_matches AS RESTRICTIVE
  USING (EXISTS (SELECT 1 FROM screening_checks s WHERE s.id = screening_matches.check_id))
  WITH CHECK (EXISTS (SELECT 1 FROM screening_checks s WHERE s.id = screening_matches.check_id));

-- Checks: the link fields must agree with the case party, the regime is the one in force, and a
-- finished check cannot change.
CREATE FUNCTION app.screening_checks_before_write() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM case_parties cp
       WHERE cp.id = NEW.case_party_id AND cp.case_id = NEW.case_id
         AND cp.party_id = NEW.party_id AND cp.removed_at IS NULL
    ) THEN
      RAISE EXCEPTION 'the party is not part of this case' USING ERRCODE = '42501';
    END IF;
    NEW.requested_by := app.current_user_id();
    NEW.requested_at := now();
    NEW.legal_regime := CASE WHEN now() < '2027-07-10 00:00:00+03' THEN 'PPTFPI' ELSE 'AMLR' END;
  ELSE
    IF OLD.status <> 'PENDING' THEN
      RAISE EXCEPTION 'a finished screening check cannot be changed';
    END IF;
    IF NEW.organization_id <> OLD.organization_id OR NEW.case_id <> OLD.case_id
       OR NEW.case_party_id <> OLD.case_party_id OR NEW.party_id <> OLD.party_id
       OR NEW.provider <> OLD.provider OR NEW.subject <> OLD.subject
       OR NEW.legal_regime <> OLD.legal_regime OR NEW.requested_by <> OLD.requested_by
       OR NEW.requested_at <> OLD.requested_at THEN
      RAISE EXCEPTION 'screening check identity columns cannot be changed';
    END IF;
  END IF;
  IF NEW.status <> 'PENDING' THEN
    NEW.completed_at := coalesce(NEW.completed_at, now());
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER screening_checks_before_write
  BEFORE INSERT OR UPDATE ON screening_checks
  FOR EACH ROW EXECUTE FUNCTION app.screening_checks_before_write();

-- Matches: results are fixed; only an open match can be reviewed, once, by the current member.
CREATE FUNCTION app.screening_matches_before_write() RETURNS trigger
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
     OR NEW.details <> OLD.details THEN
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

CREATE TRIGGER screening_matches_before_write
  BEFORE INSERT OR UPDATE ON screening_matches
  FOR EACH ROW EXECUTE FUNCTION app.screening_matches_before_write();

-- Compliance status of a case, from its active parties and their latest completed check:
--   NOT_STARTED      AML does not apply, or no parties yet;
--   BLOCKED          a confirmed sanctions match: the transaction must not proceed;
--   REVIEW_REQUIRED  an unreviewed match, or a confirmed PEP / adverse-media match that calls
--                    for enhanced due diligence;
--   COMPLETED        every party screened without open matches and, where we do CDD ourselves,
--                    CDD completed;
--   IN_PROGRESS      otherwise.
CREATE FUNCTION app.refresh_case_compliance(p_case_id uuid) RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, app
  AS $$
DECLARE
  v_case cases%ROWTYPE;
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

  WITH active AS (
    SELECT cp.id, cp.cdd_scope, cp.cdd_status FROM case_parties cp
     WHERE cp.case_id = p_case_id AND cp.removed_at IS NULL
  ),
  latest AS (
    SELECT DISTINCT ON (s.case_party_id) s.case_party_id, s.id
      FROM screening_checks s JOIN active a ON a.id = s.case_party_id
     WHERE s.status = 'COMPLETED'
     ORDER BY s.case_party_id, s.requested_at DESC
  ),
  matches AS (
    SELECT m.* FROM screening_matches m JOIN latest l ON l.id = m.check_id
  )
  SELECT CASE
           WHEN v_case.aml_applicability = 'NOT_APPLICABLE_RENT_THRESHOLD'
             OR NOT EXISTS (SELECT 1 FROM active) THEN 'NOT_STARTED'
           WHEN EXISTS (SELECT 1 FROM matches
                         WHERE review_status = 'TRUE_POSITIVE' AND 'SANCTIONS' = ANY (categories))
             THEN 'BLOCKED'
           WHEN EXISTS (SELECT 1 FROM matches WHERE review_status IN ('OPEN', 'TRUE_POSITIVE'))
             THEN 'REVIEW_REQUIRED'
           WHEN NOT EXISTS (SELECT 1 FROM active a
                             WHERE NOT EXISTS (SELECT 1 FROM latest l WHERE l.case_party_id = a.id)
                                OR (a.cdd_scope = 'FULL' AND a.cdd_status <> 'COMPLETED'))
             THEN 'COMPLETED'
           ELSE 'IN_PROGRESS'
         END
    INTO v_status;

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

-- The runtime role cannot set the compliance status itself (the function above runs as owner).
CREATE FUNCTION app.cases_guard_compliance() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF current_user = 'skydra_app' AND NEW.compliance_status IS DISTINCT FROM
     (CASE WHEN TG_OP = 'INSERT' THEN 'NOT_STARTED' ELSE OLD.compliance_status END) THEN
    RAISE EXCEPTION 'the compliance status is derived and cannot be set directly'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER cases_guard_compliance
  BEFORE INSERT OR UPDATE ON cases
  FOR EACH ROW EXECUTE FUNCTION app.cases_guard_compliance();

REVOKE EXECUTE ON FUNCTION app.refresh_case_compliance(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.refresh_case_compliance(uuid) TO skydra_app;
