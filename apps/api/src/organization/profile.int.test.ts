import { deflateSync } from 'node:zlib';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveKeys } from '../auth/crypto';
import { addCaseParty, type CaseActor, createCase, updateCaseParty } from '../cases/cases';
import { LOCAL_DEVELOPMENT_KEY } from '../config/env';
import { migrate } from '../database/migrator';
import { type TenantContext, withTenant } from '../database/tenant';
import { createTestDatabase, MIGRATIONS_DIR, type TestDatabase } from '../database/test-database';
import { RuleError } from '../domain-errors';
import { collectReport, exportCase } from '../export/case-report';
import { recordDecision } from '../kyc/decisions';
import { recordInPersonVerification } from '../kyc/identity';
import { createOrganization, withPlatform } from '../platform/platform';
import { assessRisk } from '../risk/risk';
import { MockScreeningProvider } from '../screening/mock-provider';
import { runScreening } from '../screening/screening';
import { MemoryFileStore } from '../storage/file-store';
import { addMember } from './members';
import { getProfile, readLogo, removeLogo, updateProfile, uploadLogo } from './profile';

const keys = deriveKeys(LOCAL_DEVELOPMENT_KEY);

/** A valid 2×2 PNG, small enough for a test and embeddable by the PDF writer. */
function png(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.from([0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 0, 0]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

describe('organization profile', () => {
  let db: TestDatabase;
  let app: Pool;
  let admin: TenantContext;
  let broker: TenantContext;
  const store = new MemoryFileStore();
  const as = <T>(ctx: TenantContext, work: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(app, ctx, work);
  const PROFILE = {
    name: 'UAB „Demo NT“',
    companyCode: '305123456',
    address: 'Gedimino pr. 1, LT-01103 Vilnius',
    phone: '+370 600 00000',
    email: 'info@demont.lt',
    website: 'https://demont.lt',
  };

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
        name: 'Demo',
        planCode: 'AGENCY',
        adminEmail: 'admin@p.lt',
        adminFullName: 'A',
      }),
    );
    await db.superuser.query("UPDATE users SET status = 'ACTIVE'");
    admin = { organizationId: org.organizationId, userId: org.adminUserId };
    const { userId } = await as(admin, (c) =>
      addMember(c, { email: 'b@p.lt', fullName: 'Brokeris', roles: ['BROKER'] }),
    );
    await db.superuser.query("UPDATE users SET status = 'ACTIVE' WHERE id = $1", [userId]);
    broker = { organizationId: org.organizationId, userId };
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('the administrator keeps the details; others read them but cannot change them', async () => {
    const saved = await as(admin, (c) => updateProfile(c, PROFILE));
    expect(saved).toMatchObject({ ...PROFILE, hasLogo: false });
    expect(await as(broker, (c) => getProfile(c))).toMatchObject(PROFILE);

    // The database refuses a member who does not administer the organization.
    await expect(as(broker, (c) => updateProfile(c, { ...PROFILE, name: 'Kita' }))).rejects.toThrow(
      /only an organization administrator/,
    );
    await expect(
      as(broker, (c) =>
        c.query("UPDATE organizations SET plan_code = 'AGENCY_PRO' WHERE id = $1", [
          admin.organizationId,
        ]),
      ),
    ).rejects.toThrow(/permission denied/);
    // An empty field clears it; invalid values are refused.
    expect(await as(admin, (c) => updateProfile(c, { ...PROFILE, website: '' }))).toMatchObject({
      website: null,
    });
    await expect(
      as(admin, (c) => updateProfile(c, { ...PROFILE, website: 'http://demont.lt' })),
    ).rejects.toThrow();
    const { rows } = await db.superuser.query(
      "SELECT action FROM audit_events WHERE action = 'organization.profile_updated'",
    );
    expect(rows).toHaveLength(2);
  });

  it('a PNG or JPEG logo up to 1 MB, a new object each time, checked when read', async () => {
    await expect(as(admin, (c) => uploadLogo(c, store, Buffer.from('GIF89a…')))).rejects.toThrow(
      /PNG or JPEG/,
    );
    await expect(
      as(admin, (c) => uploadLogo(c, store, Buffer.concat([png(), Buffer.alloc(1024 * 1024)]))),
    ).rejects.toThrow(/larger than 1 MB/);
    await expect(as(broker, (c) => uploadLogo(c, store, png()))).rejects.toBeInstanceOf(RuleError);

    const first = await as(admin, (c) => uploadLogo(c, store, png()));
    expect(first.hasLogo).toBe(true);
    await as(admin, (c) => uploadLogo(c, store, png()));
    expect(store.objects.size).toBe(2);
    const logo = await as(broker, (c) => readLogo(c, store));
    expect(logo).toMatchObject({ contentType: 'image/png' });
    expect(logo!.body.equals(png())).toBe(true);

    await as(admin, (c) => removeLogo(c));
    expect(await as(broker, (c) => readLogo(c, store))).toBeNull();
    await as(admin, (c) => uploadLogo(c, store, png()));
  });

  it('the case export carries the details and the logo', async () => {
    const actor: CaseActor = { ...broker, canAssign: false };
    const { id } = await as(broker, (c) =>
      createCase(c, actor, {
        transactionType: 'SALE',
        propertyType: 'HOUSE',
        propertyAddress: 'Sodų g. 1, Vilnius',
        transactionValue: 120000,
      }),
    );
    const { casePartyId } = await as(broker, (c) =>
      addCaseParty(c, keys, actor, id, {
        party: {
          partyType: 'NATURAL',
          firstName: 'Ona',
          lastName: 'Rekvizitė',
          birthDate: '1980-01-01',
          citizenships: ['LT'],
        },
        role: 'BUYER',
        isOurClient: true,
      }),
    );
    await runScreening(app, broker, new MockScreeningProvider(), id, {});
    await as(broker, (c) =>
      recordInPersonVerification(c, keys, id, {
        casePartyId,
        documentType: 'ID_CARD',
        documentNumber: 'AB1234567',
        documentCountry: 'LT',
      }),
    );
    await as(broker, (c) =>
      updateCaseParty(c, id, casePartyId, {
        cddStatus: 'COMPLETED',
        kyc: { version: 1, purpose: 'Būstas', actsOnOwnBehalf: true, pepSelfDeclared: false },
      }),
    );
    await as(broker, (c) => assessRisk(c, id, {}));
    await as(broker, (c) =>
      recordDecision(c, id, {
        decision: 'APPROVE',
        justification: 'Visi reikalavimai įvykdyti',
        suspiciousIndicators: false,
      }),
    );

    const data = await as(broker, (c) => collectReport(c, keys, id, store));
    expect(data.organization).toMatchObject({
      name: PROFILE.name,
      companyCode: PROFILE.companyCode,
    });
    expect(data.logo?.equals(png())).toBe(true);
    const result = await as(broker, (c) => exportCase(c, keys, id, store));
    expect(result.pdf.subarray(0, 5).toString()).toBe('%PDF-');
    // The logo is embedded as an image object.
    expect(result.pdf.toString('latin1')).toMatch(/\/Subtype \/Image/);

    // The same report in English (client answer Q10), with the language on record.
    const english = await as(broker, (c) => exportCase(c, keys, id, store, 'en'));
    const info = english.pdf.toString('latin1');
    expect(info).toContain('AML case');
    expect(result.pdf.toString('latin1')).toContain('AML byla');
    const { rows } = await db.superuser.query(
      "SELECT after FROM audit_events WHERE action = 'case.exported' ORDER BY seq",
    );
    expect(rows.map((r) => r.after.language)).toEqual(['lt', 'en']);
  });
});
