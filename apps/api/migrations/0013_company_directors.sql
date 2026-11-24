-- 0013_company_directors: the manager (vadovas) of a legal entity, from registry data, as a case
-- party with role DIRECTOR linked to the entity, so that the manager is screened like the
-- beneficial owners. Like them, a director is not verified face to face and gives no transaction
-- answers: the entity's CDD covers them.

ALTER TABLE case_parties DROP CONSTRAINT case_parties_role_check;
ALTER TABLE case_parties ADD CONSTRAINT case_parties_role_check CHECK (role IN (
  'BUYER', 'SELLER', 'TENANT', 'LANDLORD', 'REPRESENTATIVE', 'PAYER', 'BENEFICIAL_OWNER',
  'DIRECTOR', 'OTHER'));

-- ubo_key (keyed hash of the registry identity) also identifies which manager a director link is.
ALTER TABLE case_parties
  ADD COLUMN director_of uuid REFERENCES case_parties (id),
  ADD CONSTRAINT case_parties_director_link CHECK (
    (role = 'DIRECTOR') = (director_of IS NOT NULL)
    AND (director_of IS NULL OR ubo_key IS NOT NULL));

-- The same person may hold one role for each of several legal entities in a case.
DROP INDEX case_parties_active_key;
CREATE UNIQUE INDEX case_parties_active_key
  ON case_parties (case_id, party_id, role,
                   coalesce(beneficial_owner_of, director_of,
                            '00000000-0000-0000-0000-000000000000'))
  WHERE removed_at IS NULL;

CREATE FUNCTION app.case_parties_check_director() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.director_of IS NOT NULL AND (TG_OP = 'INSERT' OR
     NEW.director_of IS DISTINCT FROM OLD.director_of) THEN
    IF NOT EXISTS (
      SELECT 1 FROM case_parties e JOIN parties p ON p.id = e.party_id
       WHERE e.id = NEW.director_of AND e.case_id = NEW.case_id
         AND e.removed_at IS NULL AND p.party_type = 'LEGAL'
    ) THEN
      RAISE EXCEPTION 'a director must belong to a legal entity of the same case'
        USING ERRCODE = '42501';
    END IF;
    IF (SELECT party_type FROM parties WHERE id = NEW.party_id) <> 'NATURAL' THEN
      RAISE EXCEPTION 'a director is a natural person' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.director_of IS DISTINCT FROM OLD.director_of THEN
    RAISE EXCEPTION 'case party identity columns cannot be changed';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER case_parties_check_director
  BEFORE INSERT OR UPDATE ON case_parties
  FOR EACH ROW EXECUTE FUNCTION app.case_parties_check_director();

-- ---------------------------------------------------------------------------------------------
-- CDD guard: as in 0010, directors exempt like beneficial owners.

CREATE OR REPLACE FUNCTION app.case_parties_guard_cdd() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  v_type text;
BEGIN
  IF NEW.cdd_status <> 'COMPLETED' OR NEW.removed_at IS NOT NULL
     OR NEW.role IN ('BENEFICIAL_OWNER', 'DIRECTOR')
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


-- ---------------------------------------------------------------------------------------------
-- Checklist: as in 0012, with directors exempt from identity verification and CDD.

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
