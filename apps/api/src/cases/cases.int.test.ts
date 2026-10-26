import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveKeys } from '../auth/crypto';
import { LOCAL_DEVELOPMENT_KEY } from '../config/env';
import { migrate } from '../database/migrator';
import { type TenantContext, withTenant } from '../database/tenant';
import { createTestDatabase, MIGRATIONS_DIR, type TestDatabase } from '../database/test-database';
import { NotFoundError, RuleError } from '../domain-errors';
import { addMember } from '../organization/members';
import { createOrganization, withPlatform } from '../platform/platform';
import {
  activateAml,
  addCaseParty,
  type CaseActor,
  createCase,
  getCase,
  listCases,
  removeCaseParty,
  updateCase,
  updateCaseParty,
} from './cases';
import { searchParties } from './parties';

const keys = deriveKeys(LOCAL_DEVELOPMENT_KEY);
const SALE = {
  transactionType: 'SALE',
  propertyType: 'APARTMENT',
  propertyAddress: 'Gedimino pr. 1, Vilnius',
  transactionValue: 185000,
} as const;
const PERSON = {
  partyType: 'NATURAL' as const,
  firstName: 'Jonas',
  lastName: 'Jonaitis',
  personalCode: '38001010001',
  citizenships: ['LT'],
};

describe('cases and parties', () => {
  let db: TestDatabase;
  let app: Pool;
  let platformAdmin: string;

  type Org = {
    organizationId: string;
    admin: TenantContext;
    member: (roles: ('BROKER' | 'MANAGER' | 'ORG_ADMIN')[]) => Promise<TenantContext>;
  };

  async function organization(email: string): Promise<Org> {
    const org = await withPlatform(app, platformAdmin, (c) =>
      createOrganization(c, {
        name: email,
        planCode: 'AGENCY',
        adminEmail: email,
        adminFullName: 'Admin',
      }),
    );
    await db.superuser.query("UPDATE users SET status = 'ACTIVE' WHERE id = $1", [org.adminUserId]);
    const admin = { organizationId: org.organizationId, userId: org.adminUserId };
    let n = 0;
    return {
      organizationId: org.organizationId,
      admin,
      member: async (roles) => {
        n += 1;
        const { userId } = await withTenant(app, admin, (c) =>
          addMember(c, { email: `m${n}.${email}`, fullName: `Member ${n}`, roles }),
        );
        await db.superuser.query("UPDATE users SET status = 'ACTIVE' WHERE id = $1", [userId]);
        return { organizationId: org.organizationId, userId };
      },
    };
  }

  const actor = (ctx: TenantContext, canAssign = false): CaseActor => ({ ...ctx, canAssign });
  const as = <T>(ctx: TenantContext, work: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(app, ctx, work);

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.owner, MIGRATIONS_DIR);
    const { rows } = await db.superuser.query<{ id: string }>(
      "INSERT INTO users (email, full_name, status) VALUES ('admin@skydra.eu', 'P', 'ACTIVE') RETURNING id",
    );
    platformAdmin = rows[0]!.id;
    await db.superuser.query('INSERT INTO platform_admins (user_id) VALUES ($1)', [platformAdmin]);
    app = db.appPool({ max: 5 });
  });

  afterAll(async () => {
    await db?.drop();
  });

  describe('a case', () => {
    let org: Org;
    let broker: TenantContext;

    beforeAll(async () => {
      org = await organization('a@cases.lt');
      broker = await org.member(['BROKER']);
    });

    it('gets a per-organization reference, the regime in force and AML applicability', async () => {
      const first = await as(broker, (c) => createCase(c, actor(broker), SALE));
      const second = await as(broker, (c) => createCase(c, actor(broker), SALE));
      const year = new Date().getFullYear();
      expect(first.reference).toBe(`AML-${year}-0001`);
      expect(second.reference).toBe(`AML-${year}-0002`);

      const detail = await as(broker, (c) => getCase(c, keys, first.id));
      expect(detail).toMatchObject({
        amlApplicability: 'APPLICABLE',
        complianceStatus: 'NOT_STARTED',
        stage: 'INITIAL_CONTACT',
        legalRegime: new Date() < new Date('2027-07-10T00:00:00+03:00') ? 'PPTFPI' : 'AMLR',
        responsibleUserId: broker.userId,
        createdBy: broker.userId,
        transactionValue: '185000.00',
        parties: [],
      });

      const { rows } = await db.superuser.query(
        "SELECT actor_user_id, after->>'reference' AS reference FROM audit_events WHERE action = 'case.created' AND entity_id = $1",
        [first.id],
      );
      expect(rows).toEqual([{ actor_user_id: broker.userId, reference: first.reference }]);
    });

    it('applies the EUR 10 000 rent threshold, which only the database decides', async () => {
      const low = await as(broker, (c) =>
        createCase(c, actor(broker), { ...SALE, transactionType: 'RENT', monthlyRent: 9999.99 }),
      );
      const high = await as(broker, (c) =>
        createCase(c, actor(broker), { ...SALE, transactionType: 'RENT', monthlyRent: 10000 }),
      );
      expect((await as(broker, (c) => getCase(c, keys, low.id))).amlApplicability).toBe(
        'NOT_APPLICABLE_RENT_THRESHOLD',
      );
      expect((await as(broker, (c) => getCase(c, keys, high.id))).amlApplicability).toBe(
        'APPLICABLE',
      );

      // A client claiming "applicable" (or not) is overruled by the facts.
      await as(broker, (c) =>
        c.query("UPDATE cases SET aml_applicability = 'APPLICABLE' WHERE id = $1", [low.id]),
      );
      expect((await as(broker, (c) => getCase(c, keys, low.id))).amlApplicability).toBe(
        'NOT_APPLICABLE_RENT_THRESHOLD',
      );

      // Raising the rent brings the case into scope.
      await as(broker, (c) => updateCase(c, actor(broker), low.id, { monthlyRent: 12000 }));
      expect((await as(broker, (c) => getCase(c, keys, low.id))).amlApplicability).toBe(
        'APPLICABLE',
      );
    });

    it('can activate AML procedures below the threshold, permanently and with a reason', async () => {
      const lease = await as(broker, (c) =>
        createCase(c, actor(broker), { ...SALE, transactionType: 'RENT', monthlyRent: 800 }),
      );
      await expect(
        as(broker, (c) => activateAml(c, lease.id, { reason: 'short' })),
      ).rejects.toThrow();
      await as(broker, (c) =>
        activateAml(c, lease.id, { reason: 'Mokėjimas grynaisiais iš trečiųjų šalių' }),
      );
      const detail = await as(broker, (c) => getCase(c, keys, lease.id));
      expect(detail).toMatchObject({
        amlApplicability: 'MANUALLY_ACTIVATED',
        amlActivationReason: 'Mokėjimas grynaisiais iš trečiųjų šalių',
      });

      await expect(
        as(broker, (c) => activateAml(c, lease.id, { reason: 'Dar kartą aktyvuojama' })),
      ).rejects.toBeInstanceOf(RuleError);
      await expect(
        as(broker, (c) =>
          c.query(
            "UPDATE cases SET aml_applicability = 'NOT_APPLICABLE_RENT_THRESHOLD' WHERE id = $1",
            [lease.id],
          ),
        ),
      ).rejects.toThrow(/cannot be switched off/);
    });

    it('records only the changed fields and sets the offer acceptance time', async () => {
      const { id } = await as(broker, (c) => createCase(c, actor(broker), SALE));
      await as(broker, (c) =>
        updateCase(c, actor(broker), id, { stage: 'OFFER_ACCEPTED', paymentMethod: 'LOAN' }),
      );
      const detail = await as(broker, (c) => getCase(c, keys, id));
      expect(detail.offerAcceptedAt).not.toBeNull();

      const { rows } = await db.superuser.query(
        "SELECT before, after FROM audit_events WHERE action = 'case.updated' AND entity_id = $1",
        [id],
      );
      expect(Object.keys(rows[0].after).sort()).toEqual([
        'offer_accepted_at',
        'payment_method',
        'stage',
      ]);
      expect(rows[0].before).toMatchObject({ stage: 'INITIAL_CONTACT', payment_method: null });
    });

    it('switching to a letting requires the rent and clears the sale value', async () => {
      const { id } = await as(broker, (c) => createCase(c, actor(broker), SALE));
      await expect(
        as(broker, (c) => updateCase(c, actor(broker), id, { transactionType: 'RENT' })),
      ).rejects.toThrow(/incomplete/);
      await as(broker, (c) =>
        updateCase(c, actor(broker), id, { transactionType: 'RENT', monthlyRent: 700 }),
      );
      expect(await as(broker, (c) => getCase(c, keys, id))).toMatchObject({
        transactionValue: null,
        monthlyRent: '700.00',
        amlApplicability: 'NOT_APPLICABLE_RENT_THRESHOLD',
      });
    });

    it('keeps the reference, author and regime immutable', async () => {
      const { id } = await as(broker, (c) => createCase(c, actor(broker), SALE));
      for (const sql of [
        "UPDATE cases SET reference = 'X' WHERE id = $1",
        "UPDATE cases SET legal_regime = 'AMLR' WHERE id = $1",
        "UPDATE cases SET created_by = '00000000-0000-0000-0000-000000000000' WHERE id = $1",
      ])
        await expect(as(broker, (c) => c.query(sql, [id]))).rejects.toThrow(/cannot be changed/);
      await expect(
        as(broker, (c) => c.query('DELETE FROM cases WHERE id = $1', [id])),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe('who sees and assigns cases', () => {
    let org: Org;
    let brokerA: TenantContext;
    let brokerB: TenantContext;
    let manager: TenantContext;
    let caseA: string;

    beforeAll(async () => {
      org = await organization('v@cases.lt');
      brokerA = await org.member(['BROKER']);
      brokerB = await org.member(['BROKER']);
      manager = await org.member(['MANAGER']);
      caseA = (await as(brokerA, (c) => createCase(c, actor(brokerA), SALE))).id;
    });

    it('a broker sees only their own cases; a manager sees all; an administrator none', async () => {
      expect((await as(brokerA, listCases)).map((c) => c.id)).toEqual([caseA]);
      expect(await as(brokerB, listCases)).toEqual([]);
      expect((await as(manager, listCases)).map((c) => c.id)).toEqual([caseA]);
      expect(await as(org.admin, listCases)).toEqual([]);

      await expect(as(brokerB, (c) => getCase(c, keys, caseA))).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(
        as(brokerB, (c) => updateCase(c, actor(brokerB), caseA, { stage: 'TERMINATED' })),
      ).rejects.toBeInstanceOf(NotFoundError);
      const { rowCount } = await as(brokerB, (c) =>
        c.query("UPDATE cases SET stage = 'TERMINATED' WHERE id = $1", [caseA]),
      );
      expect(rowCount).toBe(0);
    });

    it('CASE_VIEW_ALL gives a broker sight of every case', async () => {
      const auditor = await org.member(['BROKER']);
      await as(org.admin, (c) =>
        c.query("UPDATE memberships SET permissions = '{CASE_VIEW_ALL}' WHERE user_id = $1", [
          auditor.userId,
        ]),
      );
      expect((await as(auditor, listCases)).map((c) => c.id)).toContain(caseA);
    });

    it('a broker cannot hand a case to someone else, or create one in their name', async () => {
      await expect(
        as(brokerA, (c) =>
          updateCase(c, actor(brokerA), caseA, { responsibleUserId: brokerB.userId }),
        ),
      ).rejects.toBeInstanceOf(RuleError);
      await expect(
        as(brokerA, (c) =>
          createCase(c, actor(brokerA), { ...SALE, responsibleUserId: brokerB.userId }),
        ),
      ).rejects.toBeInstanceOf(RuleError);
      // Even writing directly, a broker cannot create a case that is invisible to them.
      await expect(
        as(brokerA, (c) =>
          c.query(
            `INSERT INTO cases (transaction_type, property_type, property_address,
                                transaction_value, responsible_user_id)
             VALUES ('SALE', 'HOUSE', 'X', 1, $1)`,
            [brokerB.userId],
          ),
        ),
      ).rejects.toThrow(/only a manager can assign/);
    });

    it('a manager with task assignment can reassign, only to an active broker or manager', async () => {
      await as(manager, (c) =>
        updateCase(c, actor(manager, true), caseA, { responsibleUserId: brokerB.userId }),
      );
      expect((await as(brokerB, listCases)).map((c) => c.id)).toEqual([caseA]);
      // Broker A created it and still sees it.
      expect((await as(brokerA, listCases)).map((c) => c.id)).toEqual([caseA]);

      await expect(
        as(manager, (c) =>
          updateCase(c, actor(manager, true), caseA, { responsibleUserId: org.admin.userId }),
        ),
      ).rejects.toThrow(/active broker or manager/);
    });
  });

  describe('parties', () => {
    let org: Org;
    let brokerA: TenantContext;
    let brokerB: TenantContext;
    let caseA: string;
    let caseB: string;

    beforeAll(async () => {
      org = await organization('p@cases.lt');
      brokerA = await org.member(['BROKER']);
      brokerB = await org.member(['BROKER']);
      caseA = (await as(brokerA, (c) => createCase(c, actor(brokerA), SALE))).id;
      caseB = (await as(brokerB, (c) => createCase(c, actor(brokerB), SALE))).id;
    });

    it('any number of parties with different roles and CDD approaches', async () => {
      await as(brokerA, (c) =>
        addCaseParty(c, keys, actor(brokerA), caseA, {
          party: PERSON,
          role: 'SELLER',
          isOurClient: true,
          kyc: { purpose: 'Pardavimas', sourceOfFunds: null, pepSelfDeclared: false },
        }),
      );
      await as(brokerA, (c) =>
        addCaseParty(c, keys, actor(brokerA), caseA, {
          party: { ...PERSON, firstName: 'Ona', lastName: 'Onaitė', personalCode: '48502020002' },
          role: 'BUYER',
          isOurClient: false,
          representedByOtherBroker: true,
          cddScope: 'RELIANCE',
          reliance: { entityName: 'UAB Kitas brokeris', entityCode: '123456789' },
        }),
      );
      await as(brokerA, (c) =>
        addCaseParty(c, keys, actor(brokerA), caseA, {
          party: {
            partyType: 'LEGAL',
            companyName: 'UAB Bankas',
            companyCode: '112233445',
            registrationCountry: 'lt',
          },
          role: 'PAYER',
          isOurClient: false,
        }),
      );

      const detail = await as(brokerA, (c) => getCase(c, keys, caseA));
      expect(detail.parties.map((p) => [p.role, p.party.displayName, p.cddScope])).toEqual([
        ['SELLER', 'Jonas Jonaitis', 'FULL'],
        ['BUYER', 'Ona Onaitė', 'RELIANCE'],
        ['PAYER', 'UAB Bankas', 'FULL'],
      ]);
      expect(detail.parties[0]!.party.personalCodeMasked).toBe('•••••••0001');
      expect(detail.parties[2]!.party.registrationCountry).toBe('LT');
    });

    it('reliance must be described', async () => {
      await expect(
        as(brokerA, (c) =>
          addCaseParty(c, keys, actor(brokerA), caseA, {
            party: { ...PERSON, personalCode: null, firstName: 'Be' },
            role: 'OTHER',
            isOurClient: false,
            cddScope: 'RELIANCE',
          }),
        ),
      ).rejects.toThrow();
    });

    it('stores personal codes encrypted and keeps them out of the audit trail', async () => {
      const { rows } = await db.superuser.query(
        "SELECT personal_code_encrypted, personal_code_index FROM parties WHERE display_name = 'Jonas Jonaitis'",
      );
      expect(rows[0].personal_code_encrypted).toMatch(/^v1\./);
      expect(JSON.stringify(rows)).not.toContain('38001010001');

      const { rows: audit } = await db.superuser.query(
        'SELECT before, after, metadata FROM audit_events WHERE organization_id = $1',
        [org.organizationId],
      );
      expect(JSON.stringify(audit)).not.toContain('38001010001');
    });

    it("a broker cannot find a colleague's client, but entering the same code links that party", async () => {
      expect(await as(brokerB, (c) => searchParties(c, keys, org.organizationId, 'Jonas'))).toEqual(
        [],
      );
      expect(
        await as(brokerB, (c) => searchParties(c, keys, org.organizationId, '38001010001')),
      ).toEqual([]);

      const added = await as(brokerB, (c) =>
        addCaseParty(c, keys, actor(brokerB), caseB, {
          party: { ...PERSON, personalCode: '3800101-0001', firstName: 'Kitaip' },
          role: 'BUYER',
          isOurClient: true,
        }),
      );
      const detail = await as(brokerB, (c) => getCase(c, keys, caseB));
      expect(detail.parties[0]).toMatchObject({
        party: { id: added.partyId, displayName: 'Jonas Jonaitis' },
      });
      // Now it is part of broker B's case and therefore visible to them.
      expect(
        (await as(brokerB, (c) => searchParties(c, keys, org.organizationId, '38001010001'))).map(
          (p) => p.displayName,
        ),
      ).toEqual(['Jonas Jonaitis']);
    });

    it('a party holds a role in a case once; removal keeps the history', async () => {
      const [seller] = (await as(brokerA, (c) => getCase(c, keys, caseA))).parties;
      await expect(
        as(brokerA, (c) =>
          addCaseParty(c, keys, actor(brokerA), caseA, {
            partyId: seller!.party.id,
            role: 'SELLER',
            isOurClient: true,
          }),
        ),
      ).rejects.toThrow(/already has this role/);

      await as(brokerA, (c) => removeCaseParty(c, caseA, seller!.id));
      expect((await as(brokerA, (c) => getCase(c, keys, caseA))).parties).toHaveLength(2);
      await expect(
        as(brokerA, (c) => removeCaseParty(c, caseA, seller!.id)),
      ).rejects.toBeInstanceOf(NotFoundError);
      const { rows } = await db.superuser.query(
        'SELECT removed_by FROM case_parties WHERE id = $1',
        [seller!.id],
      );
      expect(rows).toEqual([{ removed_by: brokerA.userId }]);

      // The same party may be added again afterwards.
      await as(brokerA, (c) =>
        addCaseParty(c, keys, actor(brokerA), caseA, {
          partyId: seller!.party.id,
          role: 'SELLER',
          isOurClient: true,
        }),
      );
    });

    it('updates KYC answers and CDD status with an audit record', async () => {
      const [, buyer] = (await as(brokerA, (c) => getCase(c, keys, caseA))).parties;
      await as(brokerA, (c) =>
        updateCaseParty(c, caseA, buyer!.id, {
          cddStatus: 'IN_PROGRESS',
          kyc: { version: 1, purpose: 'Gyvenimui', sourceOfFunds: 'Būsto paskola' },
        }),
      );
      const updated = (await as(brokerA, (c) => getCase(c, keys, caseA))).parties.find(
        (p) => p.id === buyer!.id,
      );
      expect(updated).toMatchObject({
        cddStatus: 'IN_PROGRESS',
        kyc: { purpose: 'Gyvenimui', sourceOfFunds: 'Būsto paskola' },
      });
      await expect(
        as(brokerB, (c) => updateCaseParty(c, caseA, buyer!.id, { cddStatus: 'COMPLETED' })),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('nothing crosses organizations, even with known ids', async () => {
      const other = await organization('x@cases.lt');
      const outsider = await other.member(['MANAGER']);
      const otherCase = (await as(outsider, (c) => createCase(c, actor(outsider), SALE))).id;
      const [, buyer] = (await as(brokerA, (c) => getCase(c, keys, caseA))).parties;

      await expect(
        as(outsider, (c) =>
          addCaseParty(c, keys, actor(outsider), otherCase, {
            partyId: buyer!.party.id,
            role: 'BUYER',
            isOurClient: true,
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        as(outsider, (c) =>
          c.query(
            "INSERT INTO case_parties (case_id, party_id, role, is_our_client) VALUES ($1, $2, 'BUYER', true)",
            [otherCase, buyer!.party.id],
          ),
        ),
      ).rejects.toThrow(/foreign key/);

      // The same personal code in another agency is a separate party there.
      const there = await as(outsider, (c) =>
        addCaseParty(c, keys, actor(outsider), otherCase, {
          party: PERSON,
          role: 'SELLER',
          isOurClient: true,
        }),
      );
      expect(there.partyId).not.toBe(buyer!.party.id);
      expect(await as(outsider, listCases)).toHaveLength(1);
    });
  });
});
