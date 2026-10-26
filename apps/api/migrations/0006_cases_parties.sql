-- 0006_cases_parties: transaction cases, reusable parties and their roles in a case.
--
-- One case per transaction with any number of parties (client answers Q20/Q21). The physical or
-- legal type belongs to each party, not to the case. Composite foreign keys tie every link to the
-- same organization, so even an application bug cannot attach a party of agency A to a case of
-- agency B.

-- Who may see which cases is enforced here as well as in the API (access/policy.ts): MANAGER or
-- CASE_VIEW_ALL see all cases of the organization, BROKER sees cases they are responsible for or
-- created, anyone else (e.g. an ORG_ADMIN only) sees none.

-- Per-organization counters for human-readable references (AML-2026-0001, …).
CREATE TABLE organization_counters (
  organization_id uuid NOT NULL REFERENCES organizations (id),
  name text NOT NULL,
  value bigint NOT NULL,
  PRIMARY KEY (organization_id, name)
);

REVOKE ALL ON organization_counters FROM skydra_app;

CREATE TABLE cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT app.current_organization_id() REFERENCES organizations (id),
  reference text NOT NULL,
  transaction_type text NOT NULL CHECK (transaction_type IN ('SALE', 'RENT')),
  property_type text NOT NULL CHECK (property_type IN (
    'APARTMENT', 'HOUSE', 'LAND', 'OFFICE', 'RETAIL', 'INDUSTRIAL', 'WAREHOUSE',
    'HOSPITALITY', 'PARKING', 'OTHER_COMMERCIAL', 'OTHER')),
  property_address text NOT NULL CHECK (length(btrim(property_address)) > 0),
  transaction_value numeric(14, 2) CHECK (transaction_value > 0),
  monthly_rent numeric(12, 2) CHECK (monthly_rent > 0),
  payment_method text CHECK (payment_method IN ('BANK_TRANSFER', 'CASH', 'MIXED', 'LOAN', 'OTHER')),
  payment_method_other text,
  stage text NOT NULL DEFAULT 'INITIAL_CONTACT' CHECK (stage IN (
    'INITIAL_CONTACT', 'DATA_COLLECTION', 'CHECKS_IN_PROGRESS', 'OFFER_ACCEPTED',
    'RESERVATION', 'CONTRACT', 'COMPLETED', 'TERMINATED')),
  -- Under the AMLR the identity verification point for real-estate agents is tied to the
  -- acceptance of an offer, so the moment is recorded explicitly.
  offer_accepted_at timestamptz,
  aml_applicability text NOT NULL CHECK (aml_applicability IN (
    'APPLICABLE', 'NOT_APPLICABLE_RENT_THRESHOLD', 'MANUALLY_ACTIVATED')),
  aml_activation_reason text,
  compliance_status text NOT NULL DEFAULT 'NOT_STARTED' CHECK (compliance_status IN (
    'NOT_STARTED', 'IN_PROGRESS', 'REVIEW_REQUIRED', 'BLOCKED', 'COMPLETED')),
  -- Regime in force when the case was opened; individual checks record their own.
  legal_regime text NOT NULL CHECK (legal_regime IN ('PPTFPI', 'AMLR')),
  responsible_user_id uuid NOT NULL,
  created_by uuid NOT NULL DEFAULT app.current_user_id(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, reference),
  FOREIGN KEY (organization_id, responsible_user_id) REFERENCES memberships (organization_id, user_id),
  CHECK (transaction_type <> 'SALE' OR (transaction_value IS NOT NULL AND monthly_rent IS NULL)),
  CHECK (transaction_type <> 'RENT' OR (monthly_rent IS NOT NULL AND transaction_value IS NULL)),
  CHECK (payment_method <> 'OTHER' OR length(btrim(coalesce(payment_method_other, ''))) > 0),
  -- The applicability flag must agree with the facts (legal threshold: rent of EUR 10 000 per
  -- month; the same rule is implemented in packages/shared for the UI).
  CHECK (
    (aml_applicability = 'APPLICABLE'
       AND (transaction_type = 'SALE' OR monthly_rent >= 10000))
    OR (aml_applicability = 'NOT_APPLICABLE_RENT_THRESHOLD'
       AND transaction_type = 'RENT' AND monthly_rent < 10000)
    OR (aml_applicability = 'MANUALLY_ACTIVATED'
       AND length(btrim(coalesce(aml_activation_reason, ''))) > 0)
  )
);

CREATE INDEX cases_responsible_idx ON cases (organization_id, responsible_user_id);
SELECT app.enable_tenant_isolation('cases');
REVOKE DELETE, TRUNCATE ON cases FROM skydra_app;

-- 'ALL', 'OWN' or NULL (no access to cases) for the current member.
CREATE FUNCTION app.case_access() RETURNS text
  LANGUAGE sql STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, app
  AS $$
    SELECT CASE
             WHEN 'MANAGER' = ANY (m.roles) OR 'CASE_VIEW_ALL' = ANY (m.permissions) THEN 'ALL'
             WHEN 'BROKER' = ANY (m.roles) THEN 'OWN'
           END
      FROM memberships m
     WHERE m.organization_id = app.current_organization_id()
       AND m.user_id = app.current_user_id()
       AND m.status = 'ACTIVE'
  $$;

CREATE POLICY case_visibility ON cases AS RESTRICTIVE
  USING (
    app.case_access() = 'ALL'
    OR (app.case_access() = 'OWN'
        AND app.current_user_id() IN (responsible_user_id, created_by)))
  WITH CHECK (
    app.case_access() = 'ALL'
    OR (app.case_access() = 'OWN'
        AND app.current_user_id() IN (responsible_user_id, created_by)));

-- Assigns the reference, regime and AML applicability; keeps identity columns immutable; the
-- responsible person must be an active broker or manager of the organization.
CREATE FUNCTION app.cases_before_write() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, app
  AS $$
DECLARE
  v_next bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO organization_counters (organization_id, name, value)
    VALUES (NEW.organization_id, 'case', 1)
    ON CONFLICT (organization_id, name) DO UPDATE SET value = organization_counters.value + 1
    RETURNING value INTO v_next;
    NEW.reference := format('AML-%s-%s', to_char(now(), 'YYYY'), lpad(v_next::text, 4, '0'));
    NEW.created_by := app.current_user_id();
    NEW.created_at := now();
    -- Regulation (EU) 2024/1624 applies from 10 July 2027; until then the national law (PPTFPĮ).
    NEW.legal_regime := CASE WHEN now() < '2027-07-10 00:00:00+03' THEN 'PPTFPI' ELSE 'AMLR' END;
  ELSE
    IF NEW.organization_id <> OLD.organization_id OR NEW.reference <> OLD.reference
       OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
       OR NEW.legal_regime <> OLD.legal_regime THEN
      RAISE EXCEPTION 'case identity columns cannot be changed';
    END IF;
    IF OLD.aml_applicability = 'MANUALLY_ACTIVATED'
       AND NEW.aml_applicability <> 'MANUALLY_ACTIVATED' THEN
      RAISE EXCEPTION 'AML procedures activated manually cannot be switched off'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Rent below EUR 10 000 per month is outside the AML scope for real-estate agents, unless the
  -- broker activates the procedures anyway (same rule as amlApplicability() in packages/shared).
  IF NEW.aml_applicability IS DISTINCT FROM 'MANUALLY_ACTIVATED' THEN
    NEW.aml_applicability := CASE
      WHEN NEW.transaction_type = 'RENT' AND NEW.monthly_rent < 10000
        THEN 'NOT_APPLICABLE_RENT_THRESHOLD'
      ELSE 'APPLICABLE'
    END;
    NEW.aml_activation_reason := NULL;
  END IF;

  IF TG_OP = 'INSERT' OR NEW.responsible_user_id <> OLD.responsible_user_id THEN
    -- Assigning a case to someone else is a manager's decision (the API additionally requires
    -- the plan's TASK_ASSIGNMENT feature).
    IF NEW.responsible_user_id <> app.current_user_id()
       AND app.case_access() IS DISTINCT FROM 'ALL' THEN
      RAISE EXCEPTION 'only a manager can assign a case to another member'
        USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.organization_id = NEW.organization_id AND m.user_id = NEW.responsible_user_id
         AND m.status = 'ACTIVE' AND u.status = 'ACTIVE'
         AND m.roles && ARRAY['BROKER', 'MANAGER']
    ) THEN
      RAISE EXCEPTION 'the responsible person must be an active broker or manager'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER cases_before_write
  BEFORE INSERT OR UPDATE ON cases
  FOR EACH ROW EXECUTE FUNCTION app.cases_before_write();

-- A person or company, reusable across the organization's cases. Personal codes are stored
-- encrypted by the application, with a keyed hash (blind index) to find duplicates.
CREATE TABLE parties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT app.current_organization_id() REFERENCES organizations (id),
  party_type text NOT NULL CHECK (party_type IN ('NATURAL', 'LEGAL')),
  display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
  first_name text,
  last_name text,
  birth_date date CHECK (birth_date > '1900-01-01' AND birth_date <= current_date),
  personal_code_encrypted text,
  personal_code_index text,
  citizenships text[] NOT NULL DEFAULT '{}',
  residence_country text CHECK (residence_country ~ '^[A-Z]{2}$'),
  company_name text,
  company_code text,
  legal_form text,
  registration_country text CHECK (registration_country ~ '^[A-Z]{2}$'),
  registered_address text,
  created_by uuid NOT NULL DEFAULT app.current_user_id(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  CHECK (
    (party_type = 'NATURAL' AND first_name IS NOT NULL AND last_name IS NOT NULL
       AND company_name IS NULL AND company_code IS NULL)
    OR (party_type = 'LEGAL' AND company_name IS NOT NULL AND registration_country IS NOT NULL
       AND first_name IS NULL AND last_name IS NULL AND personal_code_encrypted IS NULL)
  ),
  CHECK ((personal_code_encrypted IS NULL) = (personal_code_index IS NULL))
);

CREATE UNIQUE INDEX parties_personal_code_key
  ON parties (organization_id, personal_code_index) WHERE personal_code_index IS NOT NULL;
CREATE UNIQUE INDEX parties_company_code_key
  ON parties (organization_id, registration_country, company_code) WHERE company_code IS NOT NULL;
CREATE INDEX parties_name_idx ON parties (organization_id, lower(display_name));

SELECT app.enable_tenant_isolation('parties');
-- Like memberships (0004): app.find_party runs as the owner and must see parties the caller cannot,
-- so the owner is not subject to the policies. The runtime role still is.
ALTER TABLE parties NO FORCE ROW LEVEL SECURITY;
REVOKE DELETE, TRUNCATE ON parties FROM skydra_app;

CREATE FUNCTION app.parties_before_write() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := app.current_user_id();
    NEW.created_at := now();
  ELSIF NEW.organization_id <> OLD.organization_id OR NEW.party_type <> OLD.party_type
        OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'party identity columns cannot be changed';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER parties_before_write
  BEFORE INSERT OR UPDATE ON parties
  FOR EACH ROW EXECUTE FUNCTION app.parties_before_write();

-- A party's role in one case, with the CDD approach for that party.
CREATE TABLE case_parties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT app.current_organization_id(),
  case_id uuid NOT NULL,
  party_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN (
    'BUYER', 'SELLER', 'TENANT', 'LANDLORD', 'REPRESENTATIVE', 'PAYER', 'OTHER')),
  is_our_client boolean NOT NULL,
  represented_by_other_broker boolean NOT NULL DEFAULT false,
  -- Same CDD for every party, or documented reliance on another obliged entity (AMLR art. 48–50).
  cdd_scope text NOT NULL DEFAULT 'FULL' CHECK (cdd_scope IN ('FULL', 'RELIANCE')),
  reliance jsonb,
  cdd_status text NOT NULL DEFAULT 'NOT_STARTED'
    CHECK (cdd_status IN ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED')),
  -- Transaction-specific answers (purpose, source of funds, acting on own behalf…), validated by
  -- a versioned schema in the application.
  kyc jsonb NOT NULL DEFAULT '{}'::jsonb,
  added_by uuid NOT NULL DEFAULT app.current_user_id(),
  added_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_by uuid,
  FOREIGN KEY (organization_id, case_id) REFERENCES cases (organization_id, id),
  FOREIGN KEY (organization_id, party_id) REFERENCES parties (organization_id, id),
  CHECK (cdd_scope <> 'RELIANCE' OR reliance IS NOT NULL),
  CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);

-- A party can hold a role in a case once at a time; removed links stay for the history.
CREATE UNIQUE INDEX case_parties_active_key
  ON case_parties (case_id, party_id, role) WHERE removed_at IS NULL;
CREATE INDEX case_parties_case_idx ON case_parties (organization_id, case_id);

SELECT app.enable_tenant_isolation('case_parties');
REVOKE DELETE, TRUNCATE ON case_parties FROM skydra_app;

-- Links follow the visibility of their case (the foreign key alone would accept any case of the
-- organization).
CREATE POLICY case_party_visibility ON case_parties AS RESTRICTIVE
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_parties.case_id))
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_parties.case_id));

CREATE FUNCTION app.case_parties_before_write() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.added_by := app.current_user_id();
    NEW.added_at := now();
    NEW.removed_at := NULL;
    NEW.removed_by := NULL;
  ELSE
    IF NEW.organization_id <> OLD.organization_id OR NEW.case_id <> OLD.case_id
       OR NEW.party_id <> OLD.party_id OR NEW.role <> OLD.role
       OR NEW.added_by <> OLD.added_by OR NEW.added_at <> OLD.added_at THEN
      RAISE EXCEPTION 'case party identity columns cannot be changed';
    END IF;
    IF OLD.removed_at IS NOT NULL THEN
      RAISE EXCEPTION 'a removed case party cannot be changed';
    END IF;
    IF NEW.removed_at IS NOT NULL THEN
      NEW.removed_at := now();
      NEW.removed_by := app.current_user_id();
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER case_parties_before_write
  BEFORE INSERT OR UPDATE ON case_parties
  FOR EACH ROW EXECUTE FUNCTION app.case_parties_before_write();

-- Parties are visible to those who can see all cases, to whoever created them and through any
-- case the member can see. This keeps one broker's clients away from another broker.
CREATE POLICY party_visibility ON parties AS RESTRICTIVE
  USING (
    app.case_access() = 'ALL'
    OR (app.case_access() = 'OWN'
        AND (created_by = app.current_user_id()
             OR EXISTS (SELECT 1 FROM case_parties cp WHERE cp.party_id = parties.id))))
  WITH CHECK (app.case_access() IS NOT NULL);

-- The same person must not be entered twice in an organization. A broker who enters a personal or
-- company code that already exists, possibly from a colleague's case, gets the existing party to
-- link to their case; they learn nothing they did not type themselves until it is linked.
CREATE FUNCTION app.find_party(
  p_personal_code_index text,
  p_registration_country text,
  p_company_code text
) RETURNS uuid
  LANGUAGE plpgsql STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, app
  AS $$
DECLARE
  v_id uuid;
BEGIN
  IF app.case_access() IS NULL THEN
    RAISE EXCEPTION 'no access to cases' USING ERRCODE = '42501';
  END IF;
  SELECT id INTO v_id FROM parties
   WHERE organization_id = app.current_organization_id()
     AND ((p_personal_code_index IS NOT NULL AND personal_code_index = p_personal_code_index)
       OR (p_company_code IS NOT NULL AND registration_country = p_registration_country
           AND company_code = p_company_code));
  RETURN v_id;
END
$$;

REVOKE EXECUTE ON FUNCTION app.case_access(), app.find_party(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.case_access(), app.find_party(text, text, text) TO skydra_app;
REVOKE EXECUTE ON FUNCTION app.cases_before_write() FROM PUBLIC;
