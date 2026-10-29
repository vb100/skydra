-- 0011_case_exports: register of exported AML case files.
--
-- Each PDF export of a case is recorded with the SHA-256 of the exact bytes handed out, so a file
-- presented later (to the FIU or an inspector) can be checked against the register.

CREATE TABLE case_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT app.current_organization_id(),
  case_id uuid NOT NULL,
  format text NOT NULL CHECK (format IN ('PDF')),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  compliance_status text NOT NULL,
  exported_by uuid NOT NULL DEFAULT app.current_user_id(),
  exported_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, case_id) REFERENCES cases (organization_id, id)
);

CREATE INDEX case_exports_case_idx ON case_exports (case_id, exported_at DESC);

SELECT app.enable_tenant_isolation('case_exports');
REVOKE UPDATE, DELETE, TRUNCATE ON case_exports FROM skydra_app;

CREATE POLICY case_export_visibility ON case_exports AS RESTRICTIVE
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_exports.case_id))
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_exports.case_id));

CREATE FUNCTION app.case_exports_before_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  -- An AML case file is exported only once the case is compliant (client requirement).
  IF (SELECT compliance_status FROM cases WHERE id = NEW.case_id) <> 'COMPLETED' THEN
    RAISE EXCEPTION 'complete the AML checks before exporting the case' USING ERRCODE = '42501';
  END IF;
  NEW.compliance_status := 'COMPLETED';
  NEW.exported_by := app.current_user_id();
  NEW.exported_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER case_exports_before_insert
  BEFORE INSERT ON case_exports
  FOR EACH ROW EXECUTE FUNCTION app.case_exports_before_insert();
