-- 0018_organization_profile: the agency's details and logo for the case export (client answer
-- Q43): taken from the organization profile, so they are not entered for every case.
--
--   * Company code, address and contacts; the logo is a PNG or JPEG in the documents bucket,
--     recorded with its SHA-256. A new logo is a new object (stored files are never replaced).
--   * Only an organization administrator changes the profile; the plan, status and entitlements
--     stay out of the organization's reach as before (0003).

ALTER TABLE organizations
  ADD COLUMN company_code text CHECK (company_code ~ '^[0-9A-Za-z-]{5,20}$'),
  ADD COLUMN address text CHECK (length(address) <= 300),
  ADD COLUMN phone text CHECK (phone ~ '^\+?[0-9 ()-]{5,30}$'),
  ADD COLUMN email text CHECK (length(email) <= 254 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  ADD COLUMN website text CHECK (length(website) <= 300 AND website ~ '^https://'),
  ADD COLUMN logo_storage_key text,
  ADD COLUMN logo_content_type text CHECK (logo_content_type IN ('image/png', 'image/jpeg')),
  ADD COLUMN logo_sha256 text CHECK (logo_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN logo_updated_at timestamptz,
  ADD CHECK ((logo_storage_key IS NULL) = (logo_content_type IS NULL)
             AND (logo_storage_key IS NULL) = (logo_sha256 IS NULL)
             AND (logo_storage_key IS NULL) = (logo_updated_at IS NULL)),
  ADD CHECK (logo_storage_key IS NULL OR logo_storage_key LIKE id || '/organization/logo/%');

GRANT UPDATE (company_code, address, phone, email, website, logo_storage_key, logo_content_type,
              logo_sha256, logo_updated_at)
  ON organizations TO skydra_app;

-- Row-level security already limits an update to the member's own organization; this also
-- requires the member to administer it.
CREATE FUNCTION app.organizations_guard_profile() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF current_user = 'skydra_app' AND NOT EXISTS (
    SELECT 1 FROM memberships m
     WHERE m.organization_id = NEW.id AND m.user_id = app.current_user_id()
       AND m.status = 'ACTIVE' AND 'ORG_ADMIN' = ANY (m.roles)
  ) THEN
    RAISE EXCEPTION 'only an organization administrator can change its profile'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.logo_storage_key IS DISTINCT FROM OLD.logo_storage_key THEN
    NEW.logo_updated_at := CASE WHEN NEW.logo_storage_key IS NULL THEN NULL ELSE now() END;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER organizations_guard_profile
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION app.organizations_guard_profile();
