import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveKeys } from '../auth/crypto';
import { addCaseParty, type CaseActor, createCase, getCase, removeCaseParty } from '../cases/cases';
import { LOCAL_DEVELOPMENT_KEY } from '../config/env';
import { migrate } from '../database/migrator';
import { type TenantContext, withTenant } from '../database/tenant';
import { createTestDatabase, MIGRATIONS_DIR, type TestDatabase } from '../database/test-database';
import { NotFoundError, RuleError } from '../domain-errors';
import { getChecklist } from '../kyc/decisions';
import { addMember } from '../organization/members';
import { createOrganization, withPlatform } from '../platform/platform';
import { riskOverview } from '../risk/risk';
import { MockRegistryProvider } from './mock-registry';
import { fetchOwnership, linkBeneficialOwners, listOwnership, resolveOwnership } from './ownership';
import { UnavailableRegistryProvider } from './registry-provider';

const keys = deriveKeys(LOCAL_DEVELOPMENT_KEY);
const registry = new MockRegistryProvider();
const SALE = {
  transactionType: 'SALE',
  propertyType: 'OFFICE',
  propertyAddress: 'Konstitucijos pr. 7, Vilnius',
  transactionValue: 900000,
} as const;
const RESOLUTION = {
  resolution: 'CLIENT_DOCUMENTS_ACCEPTED',
  notes: 'Klientas pateikė akcininkų sąrašą ir sutartį; antrasis akcininkas nustatytas.',
  evidence: 'Akcininkų sąrašas 2026-10-29',
} as const;

describe('ownership and beneficial owners', () => {
  let db: TestDatabase;
  let app: Pool;
  let broker: TenantContext;
  let colleague: TenantContext;

  const as = <T>(ctx: TenantContext, work: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(app, ctx, work);
  const actor = (ctx: TenantContext): CaseActor => ({ ...ctx, canAssign: false });
  const missing = async (caseId: string) =>
    (await as(broker, (c) => getChecklist(c, caseId))).filter((e) => !e.ok).map((e) => e.item);

  /** A sale to a company with the given registry code. */
  async function companyCase(companyCode: string | null) {
    const { id } = await as(broker, (c) => createCase(c, actor(broker), SALE));
    const { casePartyId } = await as(broker, (c) =>
      addCaseParty(c, keys, actor(broker), id, {
        party: {
          partyType: 'LEGAL',
          companyName: `Įmonė ${companyCode}`,
          companyCode,
          registrationCountry: 'LT',
        },
        role: 'BUYER',
        isOurClient: true,
      }),
    );
    return { caseId: id, casePartyId };
  }
  const fetch = (caseId: string, casePartyId: string, ctx = broker) =>
    fetchOwnership(app, ctx, keys, registry, caseId, casePartyId);
  const link = (caseId: string, snapshotId: string) =>
    as(broker, (c) => linkBeneficialOwners(c, keys, broker.organizationId, caseId, snapshotId));
  const view = async (caseId: string) => (await as(broker, (c) => listOwnership(c, caseId)))[0]!;

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
        name: 'O',
        planCode: 'AGENCY',
        adminEmail: 'admin@o.lt',
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
    broker = await member('broker@o.lt');
    colleague = await member('colleague@o.lt');
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('a simple company: fetch, link the owner as a party, codes never stored in clear', async () => {
    const { caseId, casePartyId } = await companyCase('300000001');
    expect(await missing(caseId)).toContain('OWNERSHIP_FETCHED');

    const { snapshotId } = await fetch(caseId, casePartyId);
    const before = await missing(caseId);
    expect(before).toContain('UBOS_LINKED');
    expect(before).not.toContain('OWNERSHIP_FETCHED');
    expect(before).not.toContain('OWNERSHIP_RESOLVED');

    const v = await view(caseId);
    expect(v).toMatchObject({
      provider: 'MOCK',
      company: { name: 'UAB „Paprasta įmonė“', references: { JANGIS: 'MOCK-JANGIS-300000001' } },
      incomplete: false,
      discrepancy: false,
      ubos: [
        {
          basis: 'OWNERSHIP',
          effectivePercent: 100,
          linked: false,
          person: { lastName: 'Savininkas', personalCodeMasked: '•••••••0011' },
        },
      ],
    });
    expect(JSON.stringify(v)).not.toContain('personalCodeEncrypted');
    expect(v.fetchedAt).toBeInstanceOf(Date);

    expect((await link(caseId, snapshotId)).linked).toBe(1);
    expect((await link(caseId, snapshotId)).linked).toBe(0);
    expect(await missing(caseId)).not.toContain('UBOS_LINKED');
    // The owner is a party now: it must be screened, but needs no face-to-face identification.
    const owners = (await as(broker, (c) => getCase(c, keys, caseId))).parties.filter(
      (p) => p.role === 'BENEFICIAL_OWNER',
    );
    expect(owners).toMatchObject([{ party: { displayName: 'Jonas Savininkas' } }]);
    const items = (await as(broker, (c) => getChecklist(c, caseId))).filter(
      (e) => e.casePartyId === owners[0]!.id,
    );
    expect(items.map((e) => e.item)).toEqual(['SCREENED', 'MATCHES_REVIEWED']);

    for (const table of ['ownership_snapshots', 'audit_events']) {
      const { rows } = await db.superuser.query(`SELECT * FROM ${table}`);
      expect(JSON.stringify(rows)).not.toContain('37503140011');
    }
  });

  it('a chain through a holding company: indirect shares and a risk factor', async () => {
    const { caseId, casePartyId } = await companyCase('300000002');
    const { snapshotId } = await fetch(caseId, casePartyId);
    const v = await view(caseId);
    expect(v.analysis.depth).toBe(2);
    expect(v.ubos.map((u) => [u.person.lastName, u.effectivePercent])).toEqual([
      ['Holdingas', 60],
      ['Akcininkė', 40],
    ]);
    await link(caseId, snapshotId);
    const risk = await as(broker, (c) => riskOverview(c, caseId));
    expect(risk.ruleSet.version).toBe('DEMO-2');
    expect(risk.preview.factors.filter((f) => f.matched).map((f) => f.code)).toEqual(
      expect.arrayContaining(['LEGAL_ENTITY', 'COMPLEX_OWNERSHIP']),
    );
  });

  it('a discrepancy blocks completion until resolved with method and evidence, once', async () => {
    const { caseId, casePartyId } = await companyCase('300000003');
    const { snapshotId } = await fetch(caseId, casePartyId);
    const v = await view(caseId);
    expect(v).toMatchObject({ discrepancy: true, incomplete: false });
    expect(v.ubos.find((u) => u.person.lastName === 'Nedeklaruota')).toMatchObject({
      computed: true,
      declared: false,
    });
    expect(await missing(caseId)).toContain('OWNERSHIP_RESOLVED');

    await expect(
      as(broker, (c) => resolveOwnership(c, caseId, snapshotId, { ...RESOLUTION, notes: 'Gerai' })),
    ).rejects.toThrow();
    await as(broker, (c) => resolveOwnership(c, caseId, snapshotId, RESOLUTION));
    expect(await missing(caseId)).not.toContain('OWNERSHIP_RESOLVED');
    expect((await view(caseId)).resolution).toMatchObject({
      resolution: 'CLIENT_DOCUMENTS_ACCEPTED',
      resolvedByName: 'broker@o.lt',
    });
    await expect(
      as(broker, (c) => resolveOwnership(c, caseId, snapshotId, RESOLUTION)),
    ).rejects.toThrow(/already been resolved/);

    // Both owners are linked: the undeclared one too.
    expect((await link(caseId, snapshotId)).linked).toBe(2);
  });

  it('an untraceable foreign owner: incomplete chain, manager and declared controller to screen', async () => {
    const { caseId, casePartyId } = await companyCase('300000004');
    const { snapshotId } = await fetch(caseId, casePartyId);
    const v = await view(caseId);
    expect(v).toMatchObject({ incomplete: true });
    expect(v.analysis.tree[0]).toMatchObject({ name: 'Gulf Holdings FZE', unresolved: true });
    expect(v.ubos.map((u) => [u.person.lastName, u.basis])).toEqual([
      ['Vadovas', 'SENIOR_MANAGING_OFFICIAL'],
      ['Al-Faris', 'CONTROL'],
    ]);
    await link(caseId, snapshotId);
    // Legal entity, complex ownership and a non-EEA owner: three MEDIUM factors make it HIGH.
    const risk = await as(broker, (c) => riskOverview(c, caseId));
    expect(risk.preview).toMatchObject({ calculatedLevel: 'HIGH', escalatedByMediumCount: true });
  });

  it('only the latest registry data can be acted on; nothing to resolve without an issue', async () => {
    const { caseId, casePartyId } = await companyCase('300000001');
    const first = await fetch(caseId, casePartyId);
    await expect(
      as(broker, (c) => resolveOwnership(c, caseId, first.snapshotId, RESOLUTION)),
    ).rejects.toThrow(/no discrepancy to resolve/);
    await fetch(caseId, casePartyId);
    await expect(link(caseId, first.snapshotId)).rejects.toThrow(/newer registry data/);
  });

  it('removing the company removes its beneficial owners', async () => {
    const { caseId, casePartyId } = await companyCase('300000002');
    const { snapshotId } = await fetch(caseId, casePartyId);
    await link(caseId, snapshotId);
    await as(broker, (c) => removeCaseParty(c, caseId, casePartyId));
    expect((await as(broker, (c) => getCase(c, keys, caseId))).parties).toEqual([]);
  });

  it('beneficial owners come only from registry data', async () => {
    const { caseId, casePartyId } = await companyCase('300000001');
    await expect(
      as(broker, (c) =>
        addCaseParty(c, keys, actor(broker), caseId, {
          party: { partyType: 'NATURAL', firstName: 'Rankinis', lastName: 'UBO' },
          role: 'BENEFICIAL_OWNER',
          isOurClient: false,
        }),
      ),
    ).rejects.toThrow(/added from registry data/);

    // Directly: a beneficial owner must be a natural person linked to a legal entity of the case.
    const { rows } = await as(broker, (c) =>
      c.query<{ party_id: string }>('SELECT party_id FROM case_parties WHERE id = $1', [
        casePartyId,
      ]),
    );
    await expect(
      as(broker, (c) =>
        c.query(
          `INSERT INTO case_parties (case_id, party_id, role, is_our_client, beneficial_owner_of, ubo_key)
           VALUES ($1, $2, 'BENEFICIAL_OWNER', false, $3, 'x')`,
          [caseId, rows[0]!.party_id, casePartyId],
        ),
      ),
    ).rejects.toThrow(/natural person/);
    await expect(
      as(broker, (c) =>
        c.query('UPDATE ownership_snapshots SET discrepancy = false WHERE case_id = $1', [caseId]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('refuses natural persons, missing codes, unavailable providers and other brokers', async () => {
    const noCode = await companyCase(null);
    await expect(fetch(noCode.caseId, noCode.casePartyId)).rejects.toThrow(/company code/);

    const { id } = await as(broker, (c) => createCase(c, actor(broker), SALE));
    const person = await as(broker, (c) =>
      addCaseParty(c, keys, actor(broker), id, {
        party: { partyType: 'NATURAL', firstName: 'Fizinis', lastName: 'Asmuo' },
        role: 'BUYER',
        isOurClient: true,
      }),
    );
    await expect(fetch(id, person.casePartyId)).rejects.toThrow(/legal entities/);

    const { caseId, casePartyId } = await companyCase('300000001');
    await expect(
      fetchOwnership(
        app,
        broker,
        keys,
        new UnavailableRegistryProvider('ONDATO'),
        caseId,
        casePartyId,
      ),
    ).rejects.toBeInstanceOf(RuleError);
    await expect(fetch(caseId, casePartyId, colleague)).rejects.toBeInstanceOf(NotFoundError);
    await fetch(caseId, casePartyId);
    expect(await as(colleague, (c) => listOwnership(c, caseId))).toEqual([]);
  });
});
