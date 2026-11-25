-- 0016_documents_manual_screening: files kept with a case, and a manual screening record for
-- when the automatic check cannot be made.
--
--   * Documents (client answers Q11, Q44): identity copies, registry extracts, the client's
--     questionnaire, screening evidence and other files, each with its SHA-256. The file itself
--     is in Cloud Storage; here is what it is, whose case and who added it. Documents are
--     evidence: the application can add them but never change or remove them.
--   * Manual screening (client answer Q28, AC4): a controlled fallback when the automatic check
--     is not available. It records the source, the date searched, the result and the reasons,
--     and needs evidence: a link to the source or an uploaded document.
--   * The case export can also be a ZIP with the report and every document (Q44).

-- ---------------------------------------------------------------------------------------------
-- Documents

CREATE TABLE case_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT app.current_organization_id(),
  case_id uuid NOT NULL,
  -- The person or company it concerns, when it concerns one.
  case_party_id uuid REFERENCES case_parties (id),
  category text NOT NULL CHECK (category IN ('IDENTITY', 'UBO', 'CLIENT', 'SCREENING', 'OTHER')),
  file_name text NOT NULL CHECK (length(btrim(file_name)) BETWEEN 1 AND 200),
  content_type text NOT NULL
    CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 20971520),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- Object name in the documents bucket: <organization>/<case>/<document id>.
  storage_key text NOT NULL UNIQUE,
  description text CHECK (description IS NULL OR length(description) <= 1000),
  uploaded_by uuid NOT NULL DEFAULT app.current_user_id(),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, case_id) REFERENCES cases (organization_id, id),
  CHECK (storage_key = organization_id || '/' || case_id || '/' || id)
);

CREATE INDEX case_documents_case_idx ON case_documents (case_id, uploaded_at);

SELECT app.enable_tenant_isolation('case_documents');
REVOKE UPDATE, DELETE, TRUNCATE ON case_documents FROM skydra_app;
CREATE POLICY case_document_visibility ON case_documents AS RESTRICTIVE
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_documents.case_id))
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_documents.case_id));

CREATE FUNCTION app.case_documents_before_insert() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.case_party_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM case_parties cp
     WHERE cp.id = NEW.case_party_id AND cp.case_id = NEW.case_id AND cp.removed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'the party is not part of this case' USING ERRCODE = '42501';
  END IF;
  NEW.uploaded_by := app.current_user_id();
  NEW.uploaded_at := now();
  RETURN NEW;
END
$$;

CREATE TRIGGER case_documents_before_insert
  BEFORE INSERT ON case_documents
  FOR EACH ROW EXECUTE FUNCTION app.case_documents_before_insert();

-- ---------------------------------------------------------------------------------------------
-- Manual screening

ALTER TABLE screening_checks
  -- {source, sourceUrl?, searchedOn, result: NO_MATCH | POTENTIAL_MATCH, justification}
  ADD COLUMN manual jsonb,
  ADD COLUMN evidence_document_id uuid,
  ADD FOREIGN KEY (organization_id, evidence_document_id)
    REFERENCES case_documents (organization_id, id),
  ADD CHECK ((provider = 'MANUAL') = (manual IS NOT NULL)),
  ADD CHECK (manual IS NULL OR (
    length(btrim(coalesce(manual ->> 'source', ''))) > 0
    AND length(btrim(coalesce(manual ->> 'justification', ''))) >= 10
    AND manual ->> 'result' IN ('NO_MATCH', 'POTENTIAL_MATCH')
    AND (manual ->> 'searchedOn') ~ '^\d{4}-\d{2}-\d{2}$'
    AND (evidence_document_id IS NOT NULL OR (manual ->> 'sourceUrl') ~ '^https://')));

-- As in 0015, with the manual record and its evidence among the columns that never change, and
-- the evidence required to belong to the same case.
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
    IF NEW.evidence_document_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM case_documents d
       WHERE d.id = NEW.evidence_document_id AND d.case_id = NEW.case_id
    ) THEN
      RAISE EXCEPTION 'the evidence is not a document of this case' USING ERRCODE = '42501';
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
       OR NEW.origin IS DISTINCT FROM OLD.origin OR NEW.manual IS DISTINCT FROM OLD.manual
       OR NEW.evidence_document_id IS DISTINCT FROM OLD.evidence_document_id THEN
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
-- ZIP export

ALTER TABLE case_exports DROP CONSTRAINT case_exports_format_check;
ALTER TABLE case_exports ADD CONSTRAINT case_exports_format_check CHECK (format IN ('PDF', 'ZIP'));
