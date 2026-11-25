import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveKeys } from '../auth/crypto';
import { addCaseParty, type CaseActor, createCase, getCase, updateCaseParty } from '../cases/cases';
import { LOCAL_DEVELOPMENT_KEY } from '../config/env';
import { migrate } from '../database/migrator';
import { type TenantContext, withTenant } from '../database/tenant';
import { createTestDatabase, MIGRATIONS_DIR, type TestDatabase } from '../database/test-database';
import { NotFoundError, RuleError } from '../domain-errors';
import { exportCaseZip, listExports } from '../export/case-report';
import { recordDecision } from '../kyc/decisions';
import { recordInPersonVerification } from '../kyc/identity';
import { addMember } from '../organization/members';
import { createOrganization, withPlatform } from '../platform/platform';
import { assessRisk } from '../risk/risk';
import { ProviderError, type ScreeningProvider } from '../screening/provider';
import {
  listScreenings,
  recordManualScreening,
  reviewMatch,
  runScreening,
} from '../screening/screening';
import { MemoryFileStore } from '../storage/file-store';
import { detectType, listDocuments, readDocument, safeFileName, uploadDocument } from './documents';

const keys = deriveKeys(LOCAL_DEVELOPMENT_KEY);
const PDF = Buffer.from('%PDF-1.7\nkliento anketa');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const down: ScreeningProvider = {
  mode: 'OPENSANCTIONS',
  screen: () => Promise.reject(new ProviderError('OpenSanctions: HTTP 503', [])),
};
const today = new Date().toISOString().slice(0, 10);

describe('case documents', () => {
  let db: TestDatabase;
  let app: Pool;
  let broker: TenantContext;
  let colleague: TenantContext;
  const store = new MemoryFileStore();

  const as = <T>(ctx: TenantContext, work: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(app, ctx, work);
  const actor = (ctx: TenantContext): CaseActor => ({ ...ctx, canAssign: false });

  async function caseWith(name: string) {
    const { id } = await as(broker, (c) =>
      createCase(c, actor(broker), {
        transactionType: 'SALE',
        propertyType: 'HOUSE',
        propertyAddress: 'Sodų g. 3, Vilnius',
        transactionValue: 200000,
      }),
    );
    const [firstName, lastName] = name.split(' ') as [string, string];
    const { casePartyId } = await as(broker, (c) =>
      addCaseParty(c, keys, actor(broker), id, {
        party: {
          partyType: 'NATURAL',
          firstName,
          lastName,
          personalCode: `3${Math.floor(Math.random() * 1e10)
            .toString()
            .padStart(10, '0')}`,
          birthDate: '1980-01-01',
          citizenships: ['LT'],
        },
        role: 'BUYER',
        isOurClient: true,
      }),
    );
    return { caseId: id, casePartyId };
  }
  const upload = (caseId: string, body: Buffer, more: object = {}, ctx = broker) =>
    as(ctx, (c) =>
      uploadDocument(
        c,
        store,
        caseId,
        { category: 'CLIENT', fileName: 'anketa.pdf', ...more },
        body,
      ),
    );
  const status = async (caseId: string) =>
    (await as(broker, (c) => getCase(c, keys, caseId))).complianceStatus;

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.owner, MIGRATIONS_DIR);
    const { rows } = await db.superuser.query<{ id: string }>(
      "INSERT INTO users (email, full_name, status) VALUES ('admin@skydra.eu', 'P', 'ACTIVE') RETURNING id",
    );
    await db.superuser.query('INSERT INTO platform_admins (user_id) VALUES ($1)', [rows[0]!.id]);
    app = db.appPool({ max: 5 });
    const org = await withPlatform(app, rows[0]!.id, (c) =>
      createOrganization(c, {
        name: 'Dokumentai',
        planCode: 'AGENCY',
        adminEmail: 'admin@d.lt',
        adminFullName: 'A',
      }),
    );
    await db.superuser.query("UPDATE users SET status = 'ACTIVE'");
    const admin = { organizationId: org.organizationId, userId: org.adminUserId };
    const member = async (email: string) => {
      const { userId } = await withTenant(app, admin, (c) =>
        addMember(c, { email, fullName: email, roles: ['BROKER'] }),
      );
      await db.superuser.query("UPDATE users SET status = 'ACTIVE' WHERE id = $1", [userId]);
      return { organizationId: org.organizationId, userId };
    };
    broker = await member('b1@d.lt');
    colleague = await member('b2@d.lt');
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('recognises PDF and photos from their bytes, nothing else', () => {
    expect(detectType(PDF)).toBe('application/pdf');
    expect(detectType(JPEG)).toBe('image/jpeg');
    expect(detectType(Buffer.from('<html><script>alert(1)</script>'))).toBeNull();
    expect(safeFileName('../../etc/"passwd"\n.pdf')).toBe('_passwd__.pdf');
  });

  it('keeps a file with its hash, for the case only, and never changes it', async () => {
    const { caseId, casePartyId } = await caseWith('Jonas Dokumentas');
    const doc = await upload(caseId, PDF, { casePartyId, description: 'Pasirašyta anketa' });
    expect(doc).toMatchObject({
      category: 'CLIENT',
      fileName: 'anketa.pdf',
      contentType: 'application/pdf',
      sizeBytes: PDF.length,
      casePartyId,
      uploadedBy: broker.userId,
    });
    expect(store.objects.size).toBe(1);
    const read = await as(broker, (c) => readDocument(c, store, caseId, doc.id));
    expect(read.body.equals(PDF)).toBe(true);

    // Refused: what is not a PDF or a photo, an empty file, another case's party.
    await expect(upload(caseId, Buffer.from('<html>'))).rejects.toBeInstanceOf(RuleError);
    await expect(upload(caseId, Buffer.alloc(0))).rejects.toBeInstanceOf(RuleError);
    const other = await caseWith('Ona Kita');
    await expect(upload(caseId, JPEG, { casePartyId: other.casePartyId })).rejects.toThrow(
      /not part of this case/,
    );
    expect(store.objects.size).toBe(1);

    // Another broker's case does not exist for them.
    await expect(upload(caseId, PDF, {}, colleague)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      as(colleague, (c) => readDocument(c, store, caseId, doc.id)),
    ).rejects.toBeInstanceOf(NotFoundError);

    // Evidence: no change, no removal, and a changed stored file is not served.
    await expect(
      as(broker, (c) =>
        c.query("UPDATE case_documents SET file_name = 'x' WHERE id = $1", [doc.id]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(broker, (c) => c.query('DELETE FROM case_documents WHERE id = $1', [doc.id])),
    ).rejects.toThrow(/permission denied/);
    const [key] = [...store.objects.keys()];
    store.objects.get(key!)!.body = Buffer.from('%PDF-1.7\npakeista');
    await expect(as(broker, (c) => readDocument(c, store, caseId, doc.id))).rejects.toThrow(
      /does not match its SHA-256/,
    );
    store.objects.get(key!)!.body = PDF;

    const { rows } = await db.superuser.query(
      `SELECT action FROM audit_events WHERE entity_id = $1 AND action LIKE 'document.%' ORDER BY seq`,
      [caseId],
    );
    expect(rows.map((r) => r.action)).toEqual(['document.uploaded', 'document.downloaded']);
  });

  it('records a manual check only when the automatic one cannot be made, with evidence', async () => {
    const { caseId, casePartyId } = await caseWith('Petras Rankinis');
    const manual = (more: object = {}) =>
      as(broker, (c) =>
        recordManualScreening(c, caseId, {
          casePartyId,
          source: 'ES sankcijų žemėlapis',
          sourceUrl: 'https://www.sanctionsmap.eu/',
          searchedOn: today,
          result: 'NO_MATCH',
          justification: 'Vardo ir pavardės paieška rezultatų negrąžino',
          ...more,
        }),
      );
    // Evidence is required.
    await expect(manual({ sourceUrl: undefined })).rejects.toThrow(/link to the source/);

    // The provider is down: the check is FAILED, so a manual record is allowed.
    await runScreening(app, broker, down, caseId, {});
    const evidence = await upload(caseId, JPEG, { category: 'SCREENING', fileName: 'ekranas.jpg' });
    const recorded = await manual({ sourceUrl: undefined, evidenceDocumentId: evidence.id });
    const [check] = await as(broker, (c) => listScreenings(c, caseId));
    expect(check).toMatchObject({
      id: recorded.checkId,
      provider: 'MANUAL',
      origin: 'MANUAL',
      sources: ['MANUAL'],
      status: 'COMPLETED',
      matchCount: 0,
      evidenceDocumentId: evidence.id,
      manual: { source: 'ES sankcijų žemėlapis', result: 'NO_MATCH', searchedOn: today },
    });

    // Now a result is in force: no second manual record over it.
    await expect(manual()).rejects.toThrow(/latest check of this party is complete/);

    // Evidence from another case is refused by the database.
    const other = await caseWith('Rūta Kitoje');
    const foreign = await upload(other.caseId, PDF);
    await runScreening(app, broker, down, caseId, {});
    await expect(manual({ evidenceDocumentId: foreign.id })).rejects.toThrow(
      /not a document of this case/,
    );

    // A potential match found by hand is reviewed like any other.
    const found = await manual({
      result: 'POTENTIAL_MATCH',
      match: { name: 'Petras Rankinis', category: 'PEP' },
    });
    expect(found.complianceStatus).toBe('REVIEW_REQUIRED');
    const [withMatch] = await as(broker, (c) => listScreenings(c, caseId));
    expect(withMatch!.matches[0]).toMatchObject({
      categories: ['PEP'],
      strength: 'STRONG',
      reviewStatus: 'OPEN',
      details: { kind: 'manual', source: 'ES sankcijų žemėlapis' },
    });
    await as(broker, (c) =>
      reviewMatch(c, caseId, withMatch!.matches[0]!.id, {
        decision: 'FALSE_POSITIVE',
        justification: 'Bendrapavardis, kita gimimo data',
      }),
    );
    expect(await status(caseId)).not.toBe('REVIEW_REQUIRED');

    const { rows } = await db.superuser.query(
      `SELECT after FROM audit_events WHERE entity_id = $1 AND action = 'screening.completed'
        AND after ->> 'manual' = 'true' ORDER BY seq`,
      [caseId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].after).toMatchObject({ provider: 'MANUAL', source: 'ES sankcijų žemėlapis' });
  });

  it('exports the complete case as a ZIP with the report and every document', async () => {
    const { caseId, casePartyId } = await caseWith('Lina Eksportuojama');
    await runScreening(
      app,
      broker,
      { mode: 'MOCK', screen: async () => ({ reference: null, matches: [] }) },
      caseId,
      {},
    );
    await as(broker, (c) =>
      recordInPersonVerification(c, keys, caseId, {
        casePartyId,
        documentType: 'ID_CARD',
        documentNumber: 'AB7654321',
        documentCountry: 'LT',
      }),
    );
    await as(broker, (c) =>
      updateCaseParty(c, caseId, casePartyId, {
        cddStatus: 'COMPLETED',
        kyc: { version: 1, purpose: 'Būstas', actsOnOwnBehalf: true, pepSelfDeclared: false },
      }),
    );
    await as(broker, (c) => assessRisk(c, caseId, {}));
    await upload(caseId, JPEG, {
      category: 'IDENTITY',
      fileName: 'Tapatybės kortelė.jpg',
      casePartyId,
    });
    await upload(caseId, PDF, { category: 'CLIENT', fileName: 'anketa.pdf' });
    await upload(caseId, PDF, { category: 'CLIENT', fileName: 'anketa.pdf' });
    // Not exportable before the final decision.
    await expect(as(broker, (c) => exportCaseZip(c, keys, store, caseId))).rejects.toBeInstanceOf(
      RuleError,
    );
    await as(broker, (c) =>
      recordDecision(c, caseId, {
        decision: 'APPROVE',
        justification: 'Visi AML reikalavimai įvykdyti',
        suspiciousIndicators: false,
      }),
    );
    expect(await status(caseId)).toBe('COMPLETED');

    const result = await as(broker, (c) => exportCaseZip(c, keys, store, caseId));
    const archive = result.zip;
    expect(archive.readUInt32LE(0)).toBe(0x04034b50);
    const text = archive.toString('utf8');
    for (const name of [
      'Case_Report.pdf',
      'Attachments/Identity/Tapatybės kortelė.jpg',
      'Attachments/Client_Documents/anketa.pdf',
      'Attachments/Client_Documents/anketa (2).pdf',
    ])
      expect(text).toContain(name);

    const exports = await as(broker, (c) => listExports(c, caseId));
    expect(exports[0]).toMatchObject({
      format: 'ZIP',
      sha256: result.sha256,
      sizeBytes: archive.length,
    });
    const docs = await as(broker, (c) => listDocuments(c, caseId));
    const { rows } = await db.superuser.query(
      `SELECT after FROM audit_events WHERE entity_id = $1 AND action = 'case.exported'`,
      [caseId],
    );
    expect(rows[0].after.documents).toHaveLength(docs.length);
  });
});
