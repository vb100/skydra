import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveKeys } from '../auth/crypto';
import { addCaseParty, type CaseActor, createCase, removeCaseParty } from '../cases/cases';
import { LOCAL_DEVELOPMENT_KEY } from '../config/env';
import { migrate } from '../database/migrator';
import { type TenantContext, withTenant } from '../database/tenant';
import { createTestDatabase, MIGRATIONS_DIR, type TestDatabase } from '../database/test-database';
import { NotFoundError } from '../domain-errors';
import { uploadDocument } from '../documents/documents';
import { addMember } from '../organization/members';
import { createOrganization, withPlatform } from '../platform/platform';
import { MockScreeningProvider } from '../screening/mock-provider';
import { listScreenings, reviewMatch, runScreening } from '../screening/screening';
import { MemoryFileStore } from '../storage/file-store';
import { getClient, listClients } from './clients';

const keys = deriveKeys(LOCAL_DEVELOPMENT_KEY);
const mock = new MockScreeningProvider();
const SALE = {
  transactionType: 'SALE',
  propertyType: 'APARTMENT',
  propertyAddress: 'Klevų g. 2, Vilnius',
  transactionValue: 150000,
} as const;

describe('clients list', () => {
  let db: TestDatabase;
  let app: Pool;
  let broker: TenantContext;
  let colleague: TenantContext;
  let manager: TenantContext;
  const as = <T>(ctx: TenantContext, work: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(app, ctx, work);
  const actor = (ctx: TenantContext): CaseActor => ({ ...ctx, canAssign: false });

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
        name: 'Klientai',
        planCode: 'AGENCY',
        adminEmail: 'admin@k.lt',
        adminFullName: 'A',
      }),
    );
    await db.superuser.query("UPDATE users SET status = 'ACTIVE'");
    const admin = { organizationId: org.organizationId, userId: org.adminUserId };
    const member = async (email: string, roles: ('BROKER' | 'MANAGER')[]) => {
      const { userId } = await withTenant(app, admin, (c) =>
        addMember(c, { email, fullName: email, roles }),
      );
      await db.superuser.query("UPDATE users SET status = 'ACTIVE' WHERE id = $1", [userId]);
      return { organizationId: org.organizationId, userId };
    };
    broker = await member('b1@k.lt', ['BROKER']);
    colleague = await member('b2@k.lt', ['BROKER']);
    manager = await member('v@k.lt', ['MANAGER']);
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('one person in several cases is one client, with the most serious screening status', async () => {
    const first = await as(broker, (c) => createCase(c, actor(broker), SALE));
    const { casePartyId, partyId } = await as(broker, (c) =>
      addCaseParty(c, keys, actor(broker), first.id, {
        party: {
          partyType: 'NATURAL',
          firstName: 'Paulius',
          lastName: 'Politikas',
          personalCode: '38001010001',
          birthDate: '1980-01-01',
          citizenships: ['LT'],
        },
        role: 'BUYER',
        isOurClient: true,
      }),
    );
    await runScreening(app, broker, mock, first.id, {});
    const [check] = await as(broker, (c) => listScreenings(c, first.id));
    await as(broker, (c) =>
      reviewMatch(c, first.id, check!.matches[0]!.id, {
        decision: 'TRUE_POSITIVE',
        justification: 'Sutampa gimimo data ir pilietybė',
      }),
    );
    // The same person sells in a second case, not yet screened there.
    const second = await as(broker, (c) => createCase(c, actor(broker), SALE));
    await as(broker, (c) =>
      addCaseParty(c, keys, actor(broker), second.id, {
        partyId,
        role: 'SELLER',
        isOurClient: false,
      }),
    );
    const company = await as(broker, (c) =>
      addCaseParty(c, keys, actor(broker), second.id, {
        party: {
          partyType: 'LEGAL',
          companyName: 'UAB Klientė',
          companyCode: '300000001',
          registrationCountry: 'LT',
        },
        role: 'BUYER',
        isOurClient: true,
      }),
    );

    const list = await as(broker, (c) => listClients(c, keys));
    const person = list.find((x) => x.id === partyId)!;
    expect(person).toMatchObject({
      partyType: 'NATURAL',
      displayName: 'Paulius Politikas',
      code: '•••••••0001',
      countries: ['LT'],
      roles: ['BUYER', 'SELLER'],
      isOurClient: true,
      cases: 2,
      openCases: 2,
      screening: 'ORANGE',
    });
    expect(JSON.stringify(list)).not.toContain('38001010001');
    expect(list.find((x) => x.id === company.partyId)).toMatchObject({
      partyType: 'LEGAL',
      code: '300000001',
      cases: 1,
      screening: 'NOT_SCREENED',
    });

    // The client card: both cases, the documents of the person in any of them.
    const store = new MemoryFileStore();
    const { seller } = await listLinks();
    await as(broker, (c) =>
      uploadDocument(
        c,
        store,
        second.id,
        { category: 'IDENTITY', fileName: 'pasas.pdf', casePartyId: seller },
        Buffer.from('%PDF-1.7 pasas'),
      ),
    );
    const detail = await as(broker, (c) => getClient(c, keys, partyId));
    expect(detail.party).toMatchObject({
      displayName: 'Paulius Politikas',
      personalCodeMasked: '•••••••0001',
    });
    expect(detail.screening).toBe('ORANGE');
    expect(detail.cases.map((x) => [x.reference, x.role, x.screening])).toEqual([
      [second.reference, 'SELLER', 'NOT_SCREENED'],
      [first.reference, 'BUYER', 'ORANGE'],
    ]);
    expect(detail.documents).toMatchObject([
      { fileName: 'pasas.pdf', reference: second.reference },
    ]);

    // A removed link stays on the card as history, and no longer counts.
    await as(broker, (c) => removeCaseParty(c, first.id, casePartyId));
    const after = await as(broker, (c) => getClient(c, keys, partyId));
    expect(after.cases.at(-1)).toMatchObject({ reference: first.reference });
    expect(after.cases.at(-1)!.removedAt).not.toBeNull();
    expect(
      (await as(broker, (c) => listClients(c, keys))).find((x) => x.id === partyId),
    ).toMatchObject({ cases: 1, roles: ['SELLER'] });

    async function listLinks() {
      const { rows } = await db.superuser.query<{ id: string }>(
        "SELECT id FROM case_parties WHERE case_id = $1 AND role = 'SELLER'",
        [second.id],
      );
      return { seller: rows[0]!.id };
    }
  });

  it('a broker sees the clients of their own cases; a manager sees all', async () => {
    const own = await as(colleague, (c) => createCase(c, actor(colleague), SALE));
    const { partyId } = await as(colleague, (c) =>
      addCaseParty(c, keys, actor(colleague), own.id, {
        party: {
          partyType: 'NATURAL',
          firstName: 'Rūta',
          lastName: 'Kolegos',
          birthDate: '1990-02-02',
        },
        role: 'BUYER',
        isOurClient: true,
      }),
    );
    expect((await as(broker, (c) => listClients(c, keys))).map((x) => x.id)).not.toContain(partyId);
    await expect(as(broker, (c) => getClient(c, keys, partyId))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect((await as(manager, (c) => listClients(c, keys))).map((x) => x.id)).toContain(partyId);
  });
});
