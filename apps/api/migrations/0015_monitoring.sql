-- 0015_monitoring: automatic re-screening of open cases (client answer to Q33: ongoing
-- monitoring, a review task when a new potential match appears).
--
--   * A check records what started it: the broker (MANUAL), joining a case (AUTOMATIC) or the
--     monitoring job (MONITORING). Checks made before 0015 have no origin.
--   * A decision is not asked again: a match that a later check finds again (same provider
--     record or article, same categories) carries the earlier decision, with a link to it.
--   * A confirmed match stays in force for the case even when a later check no longer finds it
--     (e.g. the person was delisted). Lifting it needs a decision of its own, which the client
--     has not specified yet; until then the system never lifts it by itself.
--   * A monitoring check asks for a new risk assessment only when it found something new.
--   * The monitoring job learns whom it may act as (app.monitoring_actors) and then works under
--     row-level security like any request. The platform admin sees provider usage per month
--     (app.platform_provider_usage) from counters, never tenant data.

-- ---------------------------------------------------------------------------------------------
-- Origin of a check

ALTER TABLE screening_checks
  ADD COLUMN origin text CHECK (origin IN ('MANUAL', 'AUTOMATIC', 'MONITORING'));
ALTER TABLE screening_checks ALTER COLUMN origin SET DEFAULT 'MANUAL';

-- As in 0007, with the origin and the sources (0014) among the columns that never change.
CREATE OR REPLACE FUNCTION app.screening_checks_before_write() RETURNS trigger
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
    NEW.origin := coalesce(NEW.origin, 'MANUAL');
  ELSE
    IF OLD.status <> 'PENDING' THEN
      RAISE EXCEPTION 'a finished screening check cannot be changed';
    END IF;
    IF NEW.organization_id <> OLD.organization_id OR NEW.case_id <> OLD.case_id
       OR NEW.case_party_id <> OLD.case_party_id OR NEW.party_id <> OLD.party_id
       OR NEW.provider <> OLD.provider OR NEW.subject <> OLD.subject
       OR NEW.legal_regime <> OLD.legal_regime OR NEW.requested_by <> OLD.requested_by
       OR NEW.requested_at <> OLD.requested_at OR NEW.sources <> OLD.sources
       OR NEW.origin IS DISTINCT FROM OLD.origin THEN
      RAISE EXCEPTION 'screening check identity columns cannot be changed';
    END IF;
  END IF;
  IF NEW.status <> 'PENDING' THEN
    NEW.completed_at := coalesce(NEW.completed_at, now());
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Decisions carried to a later check

ALTER TABLE screening_matches ADD COLUMN carried_from uuid REFERENCES screening_matches (id);

-- As in 0012; on insert, the latest decision on the same record (same external id and
-- categories) in an earlier check of the same case party is carried over. The application
-- cannot choose what is carried: the database looks it up.
CREATE OR REPLACE FUNCTION app.screening_matches_before_write() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  v_earlier screening_matches%ROWTYPE;
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
    NEW.carried_from := NULL;
    IF NEW.external_id IS NOT NULL THEN
      SELECT m.* INTO v_earlier
        FROM screening_matches m
        JOIN screening_checks s ON s.id = m.check_id
        JOIN screening_checks n ON n.id = NEW.check_id
       WHERE s.case_party_id = n.case_party_id AND s.id <> n.id AND s.status = 'COMPLETED'
         AND m.external_id = NEW.external_id AND m.review_status <> 'OPEN'
         AND m.categories @> NEW.categories AND m.categories <@ NEW.categories
       ORDER BY m.reviewed_at DESC
       LIMIT 1;
      IF FOUND THEN
        NEW.review_status := v_earlier.review_status;
        NEW.review_justification := v_earlier.review_justification;
        NEW.reviewed_by := v_earlier.reviewed_by;
        NEW.reviewed_at := v_earlier.reviewed_at;
        NEW.carried_from := v_earlier.id;
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.organization_id <> OLD.organization_id OR NEW.check_id <> OLD.check_id
     OR NEW.external_id IS DISTINCT FROM OLD.external_id OR NEW.name <> OLD.name
     OR NEW.score IS DISTINCT FROM OLD.score OR NEW.categories <> OLD.categories
     OR NEW.details <> OLD.details OR NEW.strength <> OLD.strength
     OR NEW.carried_from IS DISTINCT FROM OLD.carried_from THEN
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
-- Risk inputs: as in 0010, except that a monitoring check counts only when it found a new
-- strong match (a carried or weak one changes nothing the risk was assessed on). A failed
-- monitoring attempt changes nothing either.

CREATE OR REPLACE FUNCTION app.case_risk_inputs_changed_at(p_case_id uuid) RETURNS timestamptz
  LANGUAGE sql STABLE
  AS $$
    SELECT greatest(
      (SELECT risk_inputs_changed_at FROM cases WHERE id = p_case_id),
      (SELECT max(cp.risk_inputs_changed_at) FROM case_parties cp WHERE cp.case_id = p_case_id),
      (SELECT max(p.updated_at) FROM case_parties cp JOIN parties p ON p.id = cp.party_id
        WHERE cp.case_id = p_case_id AND cp.removed_at IS NULL),
      (SELECT max(s.completed_at) FROM screening_checks s
        WHERE s.case_id = p_case_id
          AND (s.origin IS DISTINCT FROM 'MONITORING'
               OR (s.status = 'COMPLETED'
                   AND EXISTS (SELECT 1 FROM screening_matches m
                                WHERE m.check_id = s.id AND m.carried_from IS NULL
                                  AND m.strength = 'STRONG')))),
      (SELECT max(m.reviewed_at) FROM screening_matches m
         JOIN screening_checks s ON s.id = m.check_id WHERE s.case_id = p_case_id),
      (SELECT max(completed_at) FROM identity_verifications WHERE case_id = p_case_id))
  $$;

-- ---------------------------------------------------------------------------------------------
-- Checklist: as in 0013, except that confirmed matches of every completed check of an active
-- party count (sanctions block, PEP and other confirmed findings need the approval), not only
-- those of the latest check. Open matches to review are still those of the latest check.

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
  $$;

-- ---------------------------------------------------------------------------------------------
-- Who the monitoring job may act as. Cases and checks are bound by row-level security for every
-- role, so the job cannot list them across organizations; it asks only for the active members
-- with case access in each organization, then works through the ordinary tenant context as
-- them: a member with access to all cases sees every open case, a broker their own.

CREATE FUNCTION app.monitoring_actors()
  RETURNS TABLE (organization_id uuid, user_id uuid, all_cases boolean)
  LANGUAGE sql STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, app
  AS $$
    SELECT m.organization_id, m.user_id,
           'MANAGER' = ANY (m.roles)
             OR m.permissions && ARRAY['CASE_VIEW_ALL', 'APPROVER', 'AML_OFFICER']
      FROM memberships m JOIN organizations o ON o.id = m.organization_id
     WHERE m.status = 'ACTIVE' AND o.status = 'ACTIVE'
       AND (m.roles && ARRAY['MANAGER', 'BROKER']
            OR m.permissions && ARRAY['CASE_VIEW_ALL', 'APPROVER', 'AML_OFFICER'])
     ORDER BY m.organization_id, 3 DESC, m.created_at, m.user_id
  $$;

REVOKE EXECUTE ON FUNCTION app.monitoring_actors() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.monitoring_actors() TO skydra_app;

-- ---------------------------------------------------------------------------------------------
-- Provider usage per month and organization, for the platform admin (cost overview): finished
-- checks by origin and answered requests (HTTP 200, what providers bill) per source. Kept as
-- counters by triggers, because the platform admin cannot read tenant data; only these totals
-- leave the organizations.

CREATE TABLE screening_usage (
  organization_id uuid NOT NULL REFERENCES organizations (id),
  month date NOT NULL CHECK (month = date_trunc('month', month)::date),
  checks integer NOT NULL DEFAULT 0,
  monitoring_checks integer NOT NULL DEFAULT 0,
  failed_checks integer NOT NULL DEFAULT 0,
  opensanctions_requests integer NOT NULL DEFAULT 0,
  brave_requests integer NOT NULL DEFAULT 0,
  gdelt_requests integer NOT NULL DEFAULT 0,
  PRIMARY KEY (organization_id, month)
);
-- Written and read only through the functions below: it spans organizations, so the
-- application role (which new tables are granted to by default) must not reach it.
REVOKE ALL ON screening_usage FROM PUBLIC, skydra_app;

CREATE FUNCTION app.usage_month(at timestamptz) RETURNS date
  LANGUAGE sql IMMUTABLE
  AS $$ SELECT date_trunc('month', at AT TIME ZONE 'Europe/Vilnius')::date $$;

CREATE FUNCTION app.screening_checks_count_usage() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, app
  AS $$
BEGIN
  INSERT INTO screening_usage AS u (organization_id, month, checks, monitoring_checks, failed_checks)
  VALUES (NEW.organization_id, app.usage_month(NEW.requested_at), 1,
          (NEW.origin = 'MONITORING')::int, (NEW.status = 'FAILED')::int)
  ON CONFLICT (organization_id, month) DO UPDATE
    SET checks = u.checks + 1,
        monitoring_checks = u.monitoring_checks + excluded.monitoring_checks,
        failed_checks = u.failed_checks + excluded.failed_checks;
  RETURN NULL;
END
$$;

CREATE TRIGGER screening_checks_count_usage
  AFTER UPDATE OF status ON screening_checks
  FOR EACH ROW WHEN (OLD.status = 'PENDING' AND NEW.status <> 'PENDING')
  EXECUTE FUNCTION app.screening_checks_count_usage();

CREATE FUNCTION app.screening_requests_count_usage() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, app
  AS $$
BEGIN
  INSERT INTO screening_usage AS u (organization_id, month, opensanctions_requests,
                                    brave_requests, gdelt_requests)
  VALUES (NEW.organization_id, app.usage_month(NEW.sent_at),
          (NEW.provider = 'OPENSANCTIONS')::int, (NEW.provider = 'BRAVE')::int,
          (NEW.provider = 'GDELT')::int)
  ON CONFLICT (organization_id, month) DO UPDATE
    SET opensanctions_requests = u.opensanctions_requests + excluded.opensanctions_requests,
        brave_requests = u.brave_requests + excluded.brave_requests,
        gdelt_requests = u.gdelt_requests + excluded.gdelt_requests;
  RETURN NULL;
END
$$;

CREATE TRIGGER screening_requests_count_usage
  AFTER INSERT ON screening_requests
  FOR EACH ROW WHEN (NEW.http_status = 200)
  EXECUTE FUNCTION app.screening_requests_count_usage();

REVOKE EXECUTE ON FUNCTION app.screening_checks_count_usage(),
  app.screening_requests_count_usage() FROM PUBLIC;

-- Earlier checks and requests. Row-level security binds the owner too, so it is lifted for the
-- duration of this transaction only.
ALTER TABLE screening_checks NO FORCE ROW LEVEL SECURITY;
ALTER TABLE screening_requests NO FORCE ROW LEVEL SECURITY;
INSERT INTO screening_usage (organization_id, month, checks, monitoring_checks, failed_checks)
SELECT organization_id, app.usage_month(requested_at), count(*), 0,
       count(*) FILTER (WHERE status = 'FAILED')
  FROM screening_checks WHERE status <> 'PENDING'
 GROUP BY 1, 2;
INSERT INTO screening_usage AS u (organization_id, month, opensanctions_requests,
                                  brave_requests, gdelt_requests)
SELECT organization_id, app.usage_month(sent_at),
       count(*) FILTER (WHERE provider = 'OPENSANCTIONS'), count(*) FILTER (WHERE provider = 'BRAVE'),
       count(*) FILTER (WHERE provider = 'GDELT')
  FROM screening_requests WHERE http_status = 200
 GROUP BY 1, 2
ON CONFLICT (organization_id, month) DO UPDATE
  SET opensanctions_requests = excluded.opensanctions_requests,
      brave_requests = excluded.brave_requests,
      gdelt_requests = excluded.gdelt_requests;
ALTER TABLE screening_checks FORCE ROW LEVEL SECURITY;
ALTER TABLE screening_requests FORCE ROW LEVEL SECURITY;

CREATE FUNCTION app.platform_provider_usage(p_from date)
  RETURNS TABLE (
    month date,
    organization_id uuid,
    organization text,
    checks integer,
    monitoring_checks integer,
    failed_checks integer,
    opensanctions_requests integer,
    brave_requests integer,
    gdelt_requests integer
  )
  LANGUAGE plpgsql STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, app
  AS $$
BEGIN
  IF NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'platform administrators only' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT u.month, o.id, o.name, u.checks, u.monitoring_checks, u.failed_checks,
           u.opensanctions_requests, u.brave_requests, u.gdelt_requests
      FROM screening_usage u JOIN organizations o ON o.id = u.organization_id
     WHERE u.month >= date_trunc('month', p_from)::date
     ORDER BY u.month DESC, o.name;
END
$$;

REVOKE EXECUTE ON FUNCTION app.platform_provider_usage(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.platform_provider_usage(date) TO skydra_app;
