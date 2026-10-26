-- 0003_organizations_members: plans, users, memberships, platform administrators.
--
-- Model: User <-> Membership <-> Organization -> Plan. A user can belong to several organizations
-- with different roles; a solo broker is a one-member organization on the INDIVIDUAL plan.
--
-- What the runtime role may do is narrowed with column privileges and RLS. Operations that span
-- organizations (creating an organization and its first administrator) are SECURITY DEFINER
-- functions that check platform-admin status themselves, so the API never needs a database login
-- that bypasses row-level security.

-- Plans and their entitlements are data, so platform admins can adjust them without a release.
-- AML/CFT functions are available on every plan; plans only differ in organization management.
CREATE TABLE plans (
  code text PRIMARY KEY CHECK (code IN ('INDIVIDUAL', 'AGENCY', 'AGENCY_PRO')),
  features text[] NOT NULL DEFAULT '{}',
  limits jsonb NOT NULL DEFAULT '{}'::jsonb
);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON plans FROM skydra_app;

-- Provisional values from the client's plan matrix (2026-10-20). Cells marked "limited" or
-- "optional" there are left out until the client defines them.
INSERT INTO plans (code, features, limits) VALUES
  ('INDIVIDUAL', '{}', '{"maxUsers": 1}'),
  ('AGENCY', '{MULTI_USER,TASK_ASSIGNMENT,APPROVAL_WORKFLOW}', '{"maxUsers": null}'),
  ('AGENCY_PRO',
   '{MULTI_USER,TASK_ASSIGNMENT,APPROVAL_WORKFLOW,TEAMS,CUSTOM_RISK_RULES,API_ACCESS,ENTERPRISE_SSO,CUSTOM_WORKFLOW,MULTI_UNIT_OVERSIGHT,PRIORITY_SUPPORT,WHITE_LABEL}',
   '{"maxUsers": null}');

ALTER TABLE organizations
  ADD COLUMN plan_code text NOT NULL DEFAULT 'INDIVIDUAL' REFERENCES plans (code),
  ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  ADD COLUMN country_code text NOT NULL DEFAULT 'LT' CHECK (country_code ~ '^[A-Z]{2}$'),
  ADD COLUMN entitlement_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;

-- An organization may rename itself, but never change its own plan, status or entitlements, and
-- never create or delete organizations.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON organizations FROM skydra_app;
GRANT UPDATE (name) ON organizations TO skydra_app;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (email = lower(btrim(email)) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  full_name text NOT NULL CHECK (length(btrim(full_name)) > 0),
  status text NOT NULL DEFAULT 'INVITED' CHECK (status IN ('INVITED', 'ACTIVE', 'DISABLED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_key ON users (email);

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT app.current_organization_id() REFERENCES organizations (id),
  user_id uuid NOT NULL REFERENCES users (id),
  roles text[] NOT NULL
    CHECK (cardinality(roles) > 0 AND roles <@ ARRAY['ORG_ADMIN', 'MANAGER', 'BROKER']),
  permissions text[] NOT NULL DEFAULT '{}'
    CHECK (permissions <@ ARRAY['AML_OFFICER', 'APPROVER', 'CASE_VIEW_ALL']),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);

CREATE INDEX memberships_user_idx ON memberships (user_id);

SELECT app.enable_tenant_isolation('memberships');

-- Members are disabled, never deleted, so the history of who had access stays intact.
REVOKE DELETE, TRUNCATE ON memberships FROM skydra_app;

-- Users are global (one login, several organizations). Without FORCE the owner (and therefore the
-- SECURITY DEFINER functions below) can look users up by email across organizations; the runtime
-- role only sees itself and the members of the current organization.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_visible ON users FOR SELECT
  USING (
    id = app.current_user_id()
    OR id IN (SELECT user_id FROM memberships WHERE organization_id = app.current_organization_id())
  );

CREATE POLICY users_self_update ON users FOR UPDATE
  USING (id = app.current_user_id())
  WITH CHECK (id = app.current_user_id());

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON users FROM skydra_app;
GRANT UPDATE (full_name) ON users TO skydra_app;

-- SkyDra staff. Platform admins manage organizations but have no membership, hence no access to
-- any organization's AML data.
CREATE TABLE platform_admins (
  user_id uuid PRIMARY KEY REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON platform_admins FROM skydra_app;

CREATE FUNCTION app.is_platform_admin() RETURNS boolean
  LANGUAGE sql STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, app
  AS $$ SELECT EXISTS (SELECT 1 FROM platform_admins WHERE user_id = app.current_user_id()) $$;

REVOKE EXECUTE ON FUNCTION app.is_platform_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_platform_admin() TO skydra_app;

-- Platform admins can list organizations (name, plan, status), nothing inside them.
CREATE POLICY platform_admin_read ON organizations FOR SELECT USING (app.is_platform_admin());

-- Creates an organization with its first administrator and records both in the new
-- organization's audit chain, attributed to the platform admin.
CREATE FUNCTION app.platform_create_organization(
  p_name text,
  p_plan_code text,
  p_admin_email text,
  p_admin_full_name text,
  p_country_code text DEFAULT 'LT'
)
  RETURNS TABLE (organization_id uuid, admin_user_id uuid)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, app
  AS $$
DECLARE
  v_org uuid := gen_random_uuid();
  v_email text := lower(btrim(p_admin_email));
  v_previous_org text := current_setting('app.organization_id', true);
  v_user uuid;
  v_roles text[];
  v_permissions text[];
BEGIN
  IF NOT app.is_platform_admin() THEN
    RAISE EXCEPTION 'platform administrator privileges required' USING ERRCODE = '42501';
  END IF;

  -- Tenant tables are FORCE RLS even for the owner: write them inside the new organization's
  -- context and restore the caller's context afterwards.
  PERFORM set_config('app.organization_id', v_org::text, true);

  INSERT INTO organizations (id, name, plan_code, country_code)
  VALUES (v_org, p_name, p_plan_code, p_country_code);

  SELECT id INTO v_user FROM users WHERE email = v_email;
  IF v_user IS NULL THEN
    INSERT INTO users (email, full_name) VALUES (v_email, p_admin_full_name) RETURNING id INTO v_user;
  END IF;

  -- A solo broker administers the organization, works the cases and, having no colleague,
  -- carries the AML officer and approver responsibilities (self-approval with declaration).
  IF p_plan_code = 'INDIVIDUAL' THEN
    v_roles := ARRAY['ORG_ADMIN', 'BROKER'];
    v_permissions := ARRAY['AML_OFFICER', 'APPROVER'];
  ELSE
    v_roles := ARRAY['ORG_ADMIN'];
    v_permissions := ARRAY[]::text[];
  END IF;

  INSERT INTO memberships (organization_id, user_id, roles, permissions)
  VALUES (v_org, v_user, v_roles, v_permissions);

  INSERT INTO audit_events (action, entity_type, entity_id, after) VALUES
    ('organization.created', 'organization', v_org::text,
     jsonb_build_object('name', p_name, 'planCode', p_plan_code, 'countryCode', p_country_code)),
    ('membership.created', 'membership', v_user::text,
     jsonb_build_object('userId', v_user, 'email', v_email, 'roles', v_roles, 'permissions', v_permissions));

  PERFORM set_config('app.organization_id', coalesce(v_previous_org, ''), true);

  RETURN QUERY SELECT v_org, v_user;
END
$$;

REVOKE EXECUTE ON FUNCTION app.platform_create_organization(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.platform_create_organization(text, text, text, text, text) TO skydra_app;
