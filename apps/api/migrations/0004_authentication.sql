-- 0004_authentication: credentials, sessions, one-time links (invite / password reset).
--
-- Authentication happens before any organization is chosen, so these tables are not tenant
-- scoped. Secrets are never stored in usable form: passwords as argon2id hashes, TOTP secrets
-- encrypted by the application (AES-256-GCM), session/link tokens and recovery codes as hashes.
-- Steps that cross organizations (finding a user by e-mail, issuing and consuming links) are
-- SECURITY DEFINER functions that enforce their own rules.

CREATE TABLE user_credentials (
  user_id uuid PRIMARY KEY REFERENCES users (id),
  password_hash text NOT NULL,
  totp_secret_encrypted text NOT NULL,
  -- Last accepted TOTP time step: a code can never be used twice.
  totp_last_step bigint NOT NULL DEFAULT 0,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id),
  code_hash text NOT NULL UNIQUE,
  used_at timestamptz
);

CREATE INDEX recovery_codes_user_idx ON recovery_codes (user_id) WHERE used_at IS NULL;

CREATE TABLE sessions (
  -- SHA-256 of the cookie token; the token itself is never stored.
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  mfa_verified boolean NOT NULL DEFAULT false,
  active_organization_id uuid REFERENCES organizations (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip text,
  user_agent text
);

CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE auth_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users (id),
  purpose text NOT NULL CHECK (purpose IN ('INVITE', 'PASSWORD_RESET')),
  organization_id uuid REFERENCES organizations (id),
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  -- TOTP secret proposed to the user while completing the link (encrypted by the application).
  pending_totp_secret_encrypted text
);

-- The authentication service reads and writes credentials and sessions directly; links are only
-- issued, inspected and consumed through the functions below.
REVOKE DELETE, TRUNCATE ON user_credentials, sessions FROM skydra_app;
REVOKE ALL ON auth_links FROM skydra_app;

-- The SECURITY DEFINER functions run as the table owner and must see memberships across
-- organizations: e.g. refusing a password reset because the user also belongs to another
-- organization. With FORCE that check would only ever see the current organization and silently
-- pass. RLS keeps binding the runtime role; the owner is used only by migrations and by these
-- functions, which enforce their own rules. audit_events keeps FORCE.
ALTER TABLE memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE organizations NO FORCE ROW LEVEL SECURITY;

-- Before login there is no user context, so the users table (RLS: self + own organization) cannot
-- be queried. Returns only what the login step needs.
CREATE FUNCTION app.auth_find_user(p_email text)
  RETURNS TABLE (user_id uuid, status text)
  LANGUAGE sql STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, app
  AS $$ SELECT id, status FROM users WHERE email = lower(btrim(p_email)) $$;

-- Organizations the current user can switch to.
CREATE FUNCTION app.auth_user_memberships()
  RETURNS TABLE (organization_id uuid, organization_name text, plan_code text, roles text[], permissions text[])
  LANGUAGE sql STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, app
  AS $$
    SELECT o.id, o.name, o.plan_code, m.roles, m.permissions
      FROM memberships m
      JOIN organizations o ON o.id = m.organization_id
     WHERE m.user_id = app.current_user_id()
       AND m.status = 'ACTIVE'
       AND o.status = 'ACTIVE'
     ORDER BY o.name
  $$;

-- Issues a one-time link. Rules:
--   * platform admins may issue links for any member of the given organization;
--   * an organization admin may only act inside the current organization, never for a platform
--     admin, and a password reset only for users who belong to no other organization —
--     otherwise the admin of agency A could take over an account that agency B relies on;
--   * an invite is only possible while the user has not activated the account (an existing
--     active user added to another organization simply logs in and sees it).
-- Previous unused links of the same purpose for the user are revoked.
CREATE FUNCTION app.auth_issue_link(
  p_user_id uuid,
  p_organization_id uuid,
  p_purpose text,
  p_token_hash text,
  p_ttl interval
)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, app
  AS $$
DECLARE
  v_caller uuid := app.current_user_id();
  v_caller_is_platform boolean := app.is_platform_admin();
  v_status text;
  v_link uuid;
  v_previous_org text := current_setting('app.organization_id', true);
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'authenticated user required' USING ERRCODE = '42501';
  END IF;
  IF p_ttl > interval '7 days' OR p_ttl <= interval '0' THEN
    RAISE EXCEPTION 'link lifetime must be between 0 and 7 days';
  END IF;

  SELECT status INTO v_status FROM users WHERE id = p_user_id;
  IF v_status IS NULL OR NOT EXISTS (
    SELECT 1 FROM memberships WHERE user_id = p_user_id AND organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'user is not a member of the organization' USING ERRCODE = '42501';
  END IF;

  IF NOT v_caller_is_platform THEN
    IF p_organization_id IS DISTINCT FROM app.current_organization_id()
       OR NOT EXISTS (
         SELECT 1 FROM memberships
          WHERE user_id = v_caller AND organization_id = p_organization_id
            AND status = 'ACTIVE' AND 'ORG_ADMIN' = ANY (roles))
       OR EXISTS (SELECT 1 FROM platform_admins WHERE user_id = p_user_id) THEN
      RAISE EXCEPTION 'not allowed to issue links for this user' USING ERRCODE = '42501';
    END IF;
    IF p_purpose = 'PASSWORD_RESET' AND EXISTS (
      SELECT 1 FROM memberships
       WHERE user_id = p_user_id AND organization_id <> p_organization_id AND status = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'user belongs to another organization; a platform admin must reset the password'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF p_purpose = 'INVITE' AND v_status <> 'INVITED' THEN
    RAISE EXCEPTION 'user has already activated the account' USING ERRCODE = '42501';
  ELSIF p_purpose = 'PASSWORD_RESET' AND v_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'password reset is only possible for active users' USING ERRCODE = '42501';
  ELSIF p_purpose NOT IN ('INVITE', 'PASSWORD_RESET') THEN
    RAISE EXCEPTION 'unknown link purpose';
  END IF;

  UPDATE auth_links SET revoked_at = now()
   WHERE user_id = p_user_id AND purpose = p_purpose AND used_at IS NULL AND revoked_at IS NULL;

  INSERT INTO auth_links (token_hash, user_id, purpose, organization_id, created_by, expires_at)
  VALUES (p_token_hash, p_user_id, p_purpose, p_organization_id, v_caller, now() + p_ttl)
  RETURNING id INTO v_link;

  PERFORM set_config('app.organization_id', p_organization_id::text, true);
  INSERT INTO audit_events (action, entity_type, entity_id, after)
  VALUES (
    CASE p_purpose WHEN 'INVITE' THEN 'auth.invite_issued' ELSE 'auth.password_reset_issued' END,
    'user', p_user_id::text,
    jsonb_build_object('linkId', v_link, 'expiresAt', now() + p_ttl)
  );
  PERFORM set_config('app.organization_id', coalesce(v_previous_org, ''), true);

  RETURN v_link;
END
$$;

-- Validates a link without using it up (the user opens it and sees what it is for).
CREATE FUNCTION app.auth_peek_link(p_token_hash text)
  RETURNS TABLE (link_id uuid, user_id uuid, purpose text, email text, full_name text, pending_totp_secret_encrypted text)
  LANGUAGE sql STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, app
  AS $$
    SELECT l.id, u.id, l.purpose, u.email, u.full_name, l.pending_totp_secret_encrypted
      FROM auth_links l JOIN users u ON u.id = l.user_id
     WHERE l.token_hash = p_token_hash
       AND l.used_at IS NULL AND l.revoked_at IS NULL AND l.expires_at > now()
       AND u.status <> 'DISABLED'
  $$;

-- Stores the TOTP secret shown to the user while the link is open, so completion can verify the
-- code against exactly that secret.
CREATE FUNCTION app.auth_set_link_totp(p_token_hash text, p_secret_encrypted text)
  RETURNS boolean
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, app
  AS $$
    WITH updated AS (
      UPDATE auth_links SET pending_totp_secret_encrypted = p_secret_encrypted
       WHERE token_hash = p_token_hash
         AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
      RETURNING 1)
    SELECT EXISTS (SELECT 1 FROM updated)
  $$;

-- Completes a link in one transaction: marks it used, stores the new password and TOTP secret,
-- replaces recovery codes, activates the user and revokes all existing sessions. The caller has
-- already verified the TOTP code against the pending secret it decrypted; that code's time step is
-- recorded so it cannot be replayed for a login.
CREATE FUNCTION app.auth_complete_link(
  p_token_hash text,
  p_password_hash text,
  p_recovery_code_hashes text[],
  p_totp_step bigint
)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, app
  AS $$
DECLARE
  v_link auth_links%ROWTYPE;
  v_previous_org text := current_setting('app.organization_id', true);
  v_previous_user text := current_setting('app.user_id', true);
BEGIN
  SELECT * INTO v_link FROM auth_links
   WHERE token_hash = p_token_hash
     AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
   FOR UPDATE;
  IF NOT FOUND OR v_link.pending_totp_secret_encrypted IS NULL THEN
    RAISE EXCEPTION 'link is invalid, expired or already used' USING ERRCODE = '42501';
  END IF;
  IF cardinality(p_recovery_code_hashes) < 8 THEN
    RAISE EXCEPTION 'at least 8 recovery codes are required';
  END IF;

  UPDATE auth_links SET used_at = now() WHERE id = v_link.id;

  INSERT INTO user_credentials (user_id, password_hash, totp_secret_encrypted, totp_last_step)
  VALUES (v_link.user_id, p_password_hash, v_link.pending_totp_secret_encrypted, p_totp_step)
  ON CONFLICT (user_id) DO UPDATE
    SET password_hash = EXCLUDED.password_hash,
        totp_secret_encrypted = EXCLUDED.totp_secret_encrypted,
        totp_last_step = EXCLUDED.totp_last_step, failed_attempts = 0, locked_until = NULL,
        updated_at = now();

  DELETE FROM recovery_codes WHERE user_id = v_link.user_id;
  INSERT INTO recovery_codes (user_id, code_hash)
  SELECT v_link.user_id, unnest(p_recovery_code_hashes);

  UPDATE users SET status = 'ACTIVE' WHERE id = v_link.user_id AND status = 'INVITED';
  UPDATE sessions SET revoked_at = now() WHERE user_id = v_link.user_id AND revoked_at IS NULL;

  IF v_link.organization_id IS NOT NULL THEN
    PERFORM set_config('app.organization_id', v_link.organization_id::text, true);
    PERFORM set_config('app.user_id', v_link.user_id::text, true);
    INSERT INTO audit_events (action, entity_type, entity_id, after)
    VALUES (
      CASE v_link.purpose WHEN 'INVITE' THEN 'auth.account_activated' ELSE 'auth.password_reset_completed' END,
      'user', v_link.user_id::text, jsonb_build_object('linkId', v_link.id)
    );
    PERFORM set_config('app.organization_id', coalesce(v_previous_org, ''), true);
    PERFORM set_config('app.user_id', coalesce(v_previous_user, ''), true);
  END IF;

  RETURN v_link.user_id;
END
$$;

REVOKE EXECUTE ON FUNCTION
  app.auth_find_user(text),
  app.auth_user_memberships(),
  app.auth_issue_link(uuid, uuid, text, text, interval),
  app.auth_peek_link(text),
  app.auth_set_link_totp(text, text),
  app.auth_complete_link(text, text, text[], bigint)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  app.auth_find_user(text),
  app.auth_user_memberships(),
  app.auth_issue_link(uuid, uuid, text, text, interval),
  app.auth_peek_link(text),
  app.auth_set_link_totp(text, text),
  app.auth_complete_link(text, text, text[], bigint)
TO skydra_app;
