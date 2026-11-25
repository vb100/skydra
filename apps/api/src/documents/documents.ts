import { createHash, randomUUID } from 'node:crypto';
import {
  type DocumentCategory,
  type DocumentMime,
  MAX_DOCUMENT_BYTES,
  UploadDocumentInput,
} from '@skydra/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { recordAudit } from '../audit/audit';
import { NotFoundError, RuleError, translateDbError } from '../domain-errors';
import type { FileStore } from '../storage/file-store';

export type CaseDocument = {
  id: string;
  casePartyId: string | null;
  category: DocumentCategory;
  fileName: string;
  contentType: DocumentMime;
  sizeBytes: number;
  sha256: string;
  description: string | null;
  uploadedBy: string;
  uploadedByName: string;
  uploadedAt: string;
};

/**
 * The type a file really is, from its first bytes: what the browser declares is not trusted, and
 * anything else than a PDF or a photo (e.g. HTML or a script) is refused.
 */
export function detectType(body: Buffer): DocumentMime | null {
  const ascii = (from: number, to: number) => body.subarray(from, to).toString('latin1');
  if (ascii(0, 5) === '%PDF-') return 'application/pdf';
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg';
  if (body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(4, 8) === 'ftyp' && ['heic', 'heix', 'mif1', 'msf1', 'heis'].includes(ascii(8, 12)))
    return 'image/heic';
  return null;
}

/** A name safe for a header and a ZIP entry: no paths, no control characters. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).at(-1) ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '_').trim();
  return (clean || 'dokumentas').slice(0, 200);
}

const LIST = `
  SELECT d.id, d.case_party_id AS "casePartyId", d.category, d.file_name AS "fileName",
         d.content_type AS "contentType", d.size_bytes AS "sizeBytes", d.sha256,
         d.description, d.uploaded_by AS "uploadedBy", u.full_name AS "uploadedByName",
         d.uploaded_at AS "uploadedAt"
    FROM case_documents d JOIN users u ON u.id = d.uploaded_by`;

async function visibleCase(client: PoolClient, caseId: string) {
  const { rows } = await client.query<{ organization_id: string }>(
    'SELECT organization_id FROM cases WHERE id = $1',
    [caseId],
  );
  if (!rows[0]) throw new NotFoundError('case not found');
  return rows[0].organization_id;
}

/**
 * Adds a file to a case: the record and the stored object together, in the caller's transaction.
 * The object is written before the transaction commits, so a document on record always has its
 * file; a failed upload leaves no record.
 */
export async function uploadDocument(
  client: PoolClient,
  store: FileStore,
  caseId: string,
  input: UploadDocumentInput,
  body: Buffer,
): Promise<CaseDocument> {
  const id = z.uuid().parse(caseId);
  const meta = UploadDocumentInput.parse(input);
  if (body.length === 0) throw new RuleError('the file is empty');
  if (body.length > MAX_DOCUMENT_BYTES) throw new RuleError('the file is larger than 20 MB');
  const contentType = detectType(body);
  if (!contentType) throw new RuleError('only PDF, JPEG, PNG, WEBP and HEIC files are accepted');

  const organizationId = await visibleCase(client, id);
  const documentId = randomUUID();
  const storageKey = `${organizationId}/${id}/${documentId}`;
  const sha256 = createHash('sha256').update(body).digest('hex');
  const fileName = safeFileName(meta.fileName);
  try {
    await client.query(
      `INSERT INTO case_documents (id, case_id, case_party_id, category, file_name, content_type,
                                   size_bytes, sha256, storage_key, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        documentId,
        id,
        meta.casePartyId ?? null,
        meta.category,
        fileName,
        contentType,
        body.length,
        sha256,
        storageKey,
        meta.description || null,
      ],
    );
  } catch (error) {
    translateDbError(error);
  }
  await store.put(storageKey, body, contentType);
  await recordAudit(client, {
    action: 'document.uploaded',
    entityType: 'case',
    entityId: id,
    after: {
      documentId,
      category: meta.category,
      casePartyId: meta.casePartyId ?? null,
      fileName,
      contentType,
      sizeBytes: body.length,
      sha256,
    },
  });
  const [document] = await listDocuments(client, id, documentId);
  return document!;
}

export async function listDocuments(
  client: PoolClient,
  caseId: string,
  documentId?: string,
): Promise<CaseDocument[]> {
  const id = z.uuid().parse(caseId);
  await visibleCase(client, id);
  const { rows } = await client.query<CaseDocument>(
    `${LIST} WHERE d.case_id = $1 AND ($2::uuid IS NULL OR d.id = $2) ORDER BY d.uploaded_at, d.id`,
    [id, documentId ?? null],
  );
  return rows;
}

/**
 * A document's file, checked against its recorded SHA-256 (a changed object is refused, not
 * served). Every download is recorded in the audit trail.
 */
export async function readDocument(
  client: PoolClient,
  store: FileStore,
  caseId: string,
  documentId: string,
  options: { audit?: boolean } = {},
): Promise<{ document: CaseDocument; body: Buffer }> {
  const id = z.uuid().parse(caseId);
  const docId = z.uuid().parse(documentId);
  await visibleCase(client, id);
  const { rows } = await client.query<{ storage_key: string }>(
    'SELECT storage_key FROM case_documents WHERE case_id = $1 AND id = $2',
    [id, docId],
  );
  const [document] = await listDocuments(client, id, docId);
  if (!rows[0] || !document) throw new NotFoundError('document not found');
  const found = document;
  const body = await store.get(rows[0].storage_key);
  if (createHash('sha256').update(body).digest('hex') !== found.sha256)
    throw new Error(`document ${docId}: the stored file does not match its SHA-256`);
  if (options.audit !== false)
    await recordAudit(client, {
      action: 'document.downloaded',
      entityType: 'case',
      entityId: id,
      after: { documentId: docId, sha256: found.sha256 },
    });
  return { document, body };
}
