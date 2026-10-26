-- 0005_member_management: adding, changing and disabling members of an organization.
--
-- Rules enforced in the database (defense in depth on top of can() in the API):
--   * only an active ORG_ADMIN of the current organization may change memberships;
--   * an organization always keeps at least one active ORG_ADMIN;
--   * the plan's seat limit applies when adding a member and when re-enabling one.

-- New members are added through app.org_add_member (it may need to create the user, which the
-- runtime role cannot do); existing memberships are updated directly under the checks below.
REVOKE INSERT ON memberships FROM skydra_app;

-- Effective seat limit: an explicit `maxUsers` override (null = unlimited) wins over the plan.
CREATE FUNCTION app.organization_seat_limit(p_organization_id uuid) RETURNS integer
  LANGUAGE sql STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, app
  AS $$
    SELECT CASE
             WHEN o.entitlement_overrides ? 'maxUsers'
               THEN (o.entitlement_overrides ->> 'maxUsers')::integer
             ELSE (p.limits ->> 'maxUsers')::integer
           END
      FROM organizations o JOIN plans p ON p.code = o.plan_code
     WHERE o.id = p_organization_id
  $$;

CREATE FUNCTION app.assert_seat_available(p_organization_id uuid) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, app
  AS $$
DECLARE
  v_limit integer := app.organization_seat_limit(p_organization_id);
  v_active integer;
BEGIN
  IF v_limit IS NULL THEN
    RETURN;
  END IF;
  SELECT count(*) INTO v_active FROM memberships
   WHERE organization_id = p_organization_id AND status = 'ACTIVE';
  IF v_active >= v_limit THEN
    RAISE EXCEPTION 'the plan allows % active member(s); upgrade the plan to add more', v_limit
      USING ERRCODE = '42501';
  END IF;
END
$$;

CREATE FUNCTION app.is_org_admin(p_organization_id uuid) RETURNS boolean
  LANGUAGE sql STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, app
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM memberships
       WHERE organization_id = p_organization_id
         AND user_id = app.current_user_id()
         AND status = 'ACTIVE'
         AND 'ORG_ADMIN' = ANY (roles))
  $$;

-- Guards direct updates by the runtime role (definer functions run as the owner and do their own
-- checks): who may change a membership, seat limit on re-enabling, immutable identity columns.
CREATE FUNCTION app.memberships_guard_update() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF current_user = 'skydra_app' AND NOT app.is_org_admin(OLD.organization_id) THEN
    RAISE EXCEPTION 'only an organization administrator can change memberships'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.organization_id <> OLD.organization_id OR NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION 'a membership cannot be moved to another user or organization';
  END IF;
  IF NEW.status = 'ACTIVE' AND OLD.status <> 'ACTIVE' THEN
    PERFORM app.assert_seat_available(NEW.organization_id);
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER memberships_guard_update
  BEFORE UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION app.memberships_guard_update();

-- Checked after the change, so it also catches an admin demoting or disabling themselves.
CREATE FUNCTION app.memberships_keep_an_admin() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, app
  AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM memberships
     WHERE organization_id = NEW.organization_id
       AND status = 'ACTIVE' AND 'ORG_ADMIN' = ANY (roles)
  ) THEN
    RAISE EXCEPTION 'an organization must keep at least one active administrator'
      USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER memberships_keep_an_admin
  AFTER UPDATE ON memberships
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION app.memberships_keep_an_admin();

-- Adds a member to the current organization. Creates the user when the e-mail is new (status
-- INVITED, an invitation link follows); an existing user simply gains the membership and sees the
-- organization at the next sign-in, so no link is issued that could reset their credentials.
CREATE FUNCTION app.org_add_member(
  p_email text,
  p_full_name text,
  p_roles text[],
  p_permissions text[]
)
  RETURNS TABLE (user_id uuid, needs_invite boolean)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, app
  AS $$
DECLARE
  v_org uuid := app.current_organization_id();
  v_email text := lower(btrim(p_email));
  v_user uuid;
  v_status text;
BEGIN
  IF v_org IS NULL OR NOT app.is_org_admin(v_org) THEN
    RAISE EXCEPTION 'only an organization administrator can add members' USING ERRCODE = '42501';
  END IF;

  SELECT id, status INTO v_user, v_status FROM users WHERE email = v_email;
  IF v_user IS NOT NULL AND EXISTS (
    SELECT 1 FROM memberships m WHERE m.organization_id = v_org AND m.user_id = v_user
  ) THEN
    RAISE EXCEPTION 'this person is already a member of the organization' USING ERRCODE = '42501';
  END IF;
  IF v_status = 'DISABLED' THEN
    RAISE EXCEPTION 'this account is disabled; contact SkyDra support' USING ERRCODE = '42501';
  END IF;

  PERFORM app.assert_seat_available(v_org);

  IF v_user IS NULL THEN
    INSERT INTO users (email, full_name) VALUES (v_email, p_full_name)
    RETURNING id, status INTO v_user, v_status;
  END IF;

  INSERT INTO memberships (organization_id, user_id, roles, permissions)
  VALUES (v_org, v_user, p_roles, coalesce(p_permissions, '{}'));

  INSERT INTO audit_events (action, entity_type, entity_id, after)
  VALUES ('membership.created', 'membership', v_user::text,
          jsonb_build_object('userId', v_user, 'email', v_email,
                             'roles', p_roles, 'permissions', coalesce(p_permissions, '{}')));

  RETURN QUERY SELECT v_user, v_status = 'INVITED';
END
$$;

REVOKE EXECUTE ON FUNCTION
  app.organization_seat_limit(uuid),
  app.assert_seat_available(uuid),
  app.is_org_admin(uuid),
  app.org_add_member(text, text, text[], text[])
FROM PUBLIC;

-- assert_seat_available only raises, so the runtime role may call it (the update guard runs as
-- the caller).
GRANT EXECUTE ON FUNCTION
  app.assert_seat_available(uuid),
  app.is_org_admin(uuid),
  app.org_add_member(text, text, text[], text[])
TO skydra_app;
