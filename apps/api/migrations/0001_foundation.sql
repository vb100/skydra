-- 0001_foundation: runtime role, tenant-isolation helpers and the organizations table.
--
-- Migrations run as the schema owner. The API connects as skydra_app, which owns nothing and
-- therefore cannot alter tables, disable row-level security or bypass it.

-- The runtime role. Its LOGIN and password are provisioned per environment (docker init script
-- locally, Terraform in GCP); here we only make sure the role exists so grants can reference it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'skydra_app') THEN
    CREATE ROLE skydra_app NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO skydra_app;

-- Tables created by later migrations (as the owner) are usable by the runtime role by default.
-- Tables that must stay append-only revoke UPDATE/DELETE explicitly.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO skydra_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO skydra_app;

CREATE SCHEMA app;
GRANT USAGE ON SCHEMA app TO skydra_app;

-- Request context. The API sets it with set_config(..., is_local => true) at the start of every
-- transaction, so it disappears at COMMIT/ROLLBACK and never leaks to the next pooled request.
-- Missing or empty context yields NULL, which equals no row: isolation fails closed.
CREATE FUNCTION app.current_organization_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.organization_id', true), '')::uuid $$;

CREATE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

-- Applies the standard tenant policy. FORCE makes it bind the table owner too, so only roles
-- with BYPASSRLS (none at runtime) can see across organizations.
CREATE FUNCTION app.enable_tenant_isolation(target regclass, tenant_column text DEFAULT 'organization_id')
  RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (%I = app.current_organization_id()) WITH CHECK (%I = app.current_organization_id())',
    target, tenant_column, tenant_column
  );
END
$$;

REVOKE EXECUTE ON FUNCTION app.enable_tenant_isolation(regclass, text) FROM PUBLIC;

-- Organizations are the tenants. A request sees only its own organization row; creating
-- organizations is a platform-level operation added together with the platform admin role.
CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

SELECT app.enable_tenant_isolation('organizations', 'id');
