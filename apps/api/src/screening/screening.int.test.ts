import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveKeys } from '../auth/crypto';
import {
  activateAml,
  addCaseParty,
  type CaseActor,
  createCase,
  getCase,
  removeCaseParty,
  updateCaseParty,
} from '../cases/cases';
import { LOCAL_DEVELOPMENT_KEY } from '../config/env';
import { migrate } from '../database/migrator';
import { type TenantContext, withTenant } from '../database/tenant';
import { createTestDatabase, MIGRATIONS_DIR, type TestDatabase } from '../database/test-database';
import { NotFoundError, RuleError } from '../domain-errors';
import { addMember } from '../organization/members';
import { createOrganization, withPlatform } from '../platform/platform';
import { MockScreeningProvider } from './mock-provider';
import { type ScreeningProvider, UnavailableScreeningProvider } from './provider';
import { listScreenings, reviewMatch, runScreening } from './screening';

const keys = deriveKeys(LOCAL_DEVELOPMENT_KEY);
const mock = new MockScreeningProvider();
const SALE = {
  transactionType: 'SALE',
  propertyType: 'HOUSE',
  propertyAddress: 'Vilniaus g. 5, Vilnius',
  transactionValue: 300000,
} as const;

describe('screening', () => {
  let db: TestDatabase;
  let app: Pool;
  let broker: TenantContext;
  let colleague: TenantContext;

  const as = <T>(ctx: TenantContext, work: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(app, ctx, work);
  const actor = (ctx: TenantContext): CaseActor => ({ ...ctx, canAssign: false });

  /** A sale case with one party of the given name; returns ids. */
  async function caseWith(name: string, ctx = broker) {
    const { id } = await as(ctx, (c) => createCase(c, actor(ctx), SALE));
    const [firstName, lastName] = name.split(' ') as [string, string];
    const { casePartyId } = await as(ctx, (c) =>
      addCaseParty(c, keys, actor(ctx), id, {
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

  const status = async (caseId: string, ctx = broker) =>
    (await as(ctx, (c) => getCase(c, keys, caseId))).complianceStatus;
  const screen = (caseId: string, provider: ScreeningProvider = mock, ctx = broker) =>
    runScreening(app, ctx, provider, caseId, {});

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
        name: 'S',
        planCode: 'AGENCY',
        adminEmail: 'admin@s.lt',
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
    broker = await member('b1@s.lt');
    colleague = await member('b2@s.lt');
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('a clean result plus completed CDD completes the case', async () => {
    const { caseId, casePartyId } = await caseWith('Jonas Švarus');
    expect(await status(caseId)).toBe('IN_PROGRESS');

    const result = await screen(caseId);
    expect(result.complianceStatus).toBe('IN_PROGRESS');
    const [check] = await as(broker, (c) => listScreenings(c, caseId));
    expect(check).toMatchObject({
      status: 'COMPLETED',
      provider: 'MOCK',
      matchCount: 0,
      matches: [],
      requestedBy: broker.userId,
      subject: { name: 'Jonas Švarus', birthDate: '1980-01-01', countries: ['LT'] },
    });
    // The personal code is never sent to the provider or stored with the check.
    expect(JSON.stringify(check!.subject)).not.toMatch(/\d{11}/);

    await as(broker, (c) => updateCaseParty(c, caseId, casePartyId, { cddStatus: 'COMPLETED' }));
    expect(await status(caseId)).toBe('COMPLETED');
  });

  it('a potential match needs a justified review; a false positive clears it', async () => {
    const { caseId, casePartyId } = await caseWith('Petras Politikas');
    await as(broker, (c) => updateCaseParty(c, caseId, casePartyId, { cddStatus: 'COMPLETED' }));
    expect((await screen(caseId)).complianceStatus).toBe('REVIEW_REQUIRED');

    const [check] = await as(broker, (c) => listScreenings(c, caseId));
    const match = check!.matches[0]!;
    expect(match).toMatchObject({ categories: ['PEP'], reviewStatus: 'OPEN' });

    await expect(
      as(broker, (c) =>
        reviewMatch(c, caseId, match.id, { decision: 'FALSE_POSITIVE', justification: 'ne' }),
      ),
    ).rejects.toThrow();

    const reviewed = await as(broker, (c) =>
      reviewMatch(c, caseId, match.id, {
        decision: 'FALSE_POSITIVE',
        justification: 'Kita gimimo data ir pilietybė nei sąraše',
      }),
    );
    expect(reviewed.complianceStatus).toBe('COMPLETED');

    const [after] = await as(broker, (c) => listScreenings(c, caseId));
    expect(after!.matches[0]).toMatchObject({
      reviewStatus: 'FALSE_POSITIVE',
      reviewedBy: broker.userId,
    });

    // The decision is final, through the API and in the database.
    await expect(
      as(broker, (c) =>
        reviewMatch(c, caseId, match.id, {
          decision: 'TRUE_POSITIVE',
          justification: 'Persigalvojau, tai tas pats asmuo',
        }),
      ),
    ).rejects.toBeInstanceOf(RuleError);
    await expect(
      as(broker, (c) =>
        c.query("UPDATE screening_matches SET review_status = 'OPEN' WHERE id = $1", [match.id]),
      ),
    ).rejects.toThrow(/already been reviewed/);

    const { rows } = await db.superuser.query(
      "SELECT after FROM audit_events WHERE action = 'screening.match_reviewed' AND entity_id = $1",
      [caseId],
    );
    expect(rows[0].after).toMatchObject({ reviewStatus: 'FALSE_POSITIVE', categories: ['PEP'] });
  });

  it('a confirmed sanctions match blocks the case; a confirmed PEP needs further review', async () => {
    const sanctioned = await caseWith('Ivan Sankcijonis');
    await screen(sanctioned.caseId);
    const [s] = await as(broker, (c) => listScreenings(c, sanctioned.caseId));
    const blocked = await as(broker, (c) =>
      reviewMatch(c, sanctioned.caseId, s!.matches[0]!.id, {
        decision: 'TRUE_POSITIVE',
        justification: 'Sutampa vardas, gimimo data ir pilietybė',
      }),
    );
    expect(blocked.complianceStatus).toBe('BLOCKED');

    const pep = await caseWith('Ona Politikė');
    await as(broker, (c) =>
      updateCaseParty(c, pep.caseId, pep.casePartyId, { cddStatus: 'COMPLETED' }),
    );
    await screen(pep.caseId);
    const [p] = await as(broker, (c) => listScreenings(c, pep.caseId));
    const confirmed = await as(broker, (c) =>
      reviewMatch(c, pep.caseId, p!.matches[0]!.id, {
        decision: 'TRUE_POSITIVE',
        justification: 'Asmuo patvirtino einantis pareigas Seime',
      }),
    );
    expect(confirmed.complianceStatus).toBe('REVIEW_REQUIRED');
  });

  it('removing the party recomputes the status', async () => {
    const { caseId, casePartyId } = await caseWith('Rimas Skandalingas');
    await screen(caseId);
    expect(await status(caseId)).toBe('REVIEW_REQUIRED');
    await as(broker, (c) => removeCaseParty(c, caseId, casePartyId));
    expect(await status(caseId)).toBe('NOT_STARTED');
  });

  it('requires AML to apply and the parties to be added', async () => {
    const { id: lease } = await as(broker, (c) =>
      createCase(c, actor(broker), { ...SALE, transactionType: 'RENT', monthlyRent: 900 }),
    );
    await expect(screen(lease)).rejects.toThrow(/activate them first/);
    await as(broker, (c) =>
      activateAml(c, lease, { reason: 'Nuomos mokėtojas – trečiasis asmuo' }),
    );
    await expect(screen(lease)).rejects.toThrow(/add the parties/);
  });

  it('a provider failure is recorded as a failed check; an unavailable provider stores nothing', async () => {
    const { caseId } = await caseWith('Tomas Klaidingas');
    const failing: ScreeningProvider = {
      mode: 'ONDATO',
      screen: () => Promise.reject(new Error('timeout')),
    };
    const result = await screen(caseId, failing);
    expect(result.complianceStatus).toBe('IN_PROGRESS');
    const [check] = await as(broker, (c) => listScreenings(c, caseId));
    expect(check).toMatchObject({ status: 'FAILED', error: 'provider_error', matchCount: null });

    await expect(screen(caseId, new UnavailableScreeningProvider('ONDATO'))).rejects.toBeInstanceOf(
      RuleError,
    );
    expect(await as(broker, (c) => listScreenings(c, caseId))).toHaveLength(1);
  });

  it('results and status are evidence: not editable, not deletable, not settable', async () => {
    const { caseId } = await caseWith('Gintaras Politikas');
    await screen(caseId);
    const [check] = await as(broker, (c) => listScreenings(c, caseId));
    const attempts = [
      [
        "UPDATE screening_matches SET name = 'X' WHERE id = $1",
        check!.matches[0]!.id,
        /cannot be changed/,
      ],
      ['UPDATE screening_checks SET match_count = 0 WHERE id = $1', check!.id, /cannot be changed/],
      ['DELETE FROM screening_checks WHERE id = $1', check!.id, /permission denied/],
      ["UPDATE cases SET compliance_status = 'COMPLETED' WHERE id = $1", caseId, /derived/],
    ] as const;
    for (const [sql, id, error] of attempts)
      await expect(as(broker, (c) => c.query(sql, [id]))).rejects.toThrow(error);
  });

  it("a colleague can neither see, run nor review screenings of another broker's case", async () => {
    const { caseId } = await caseWith('Darius Politikas');
    await screen(caseId);
    const [check] = await as(broker, (c) => listScreenings(c, caseId));

    expect(await as(colleague, (c) => listScreenings(c, caseId))).toEqual([]);
    await expect(screen(caseId, mock, colleague)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      as(colleague, (c) =>
        reviewMatch(c, caseId, check!.matches[0]!.id, {
          decision: 'FALSE_POSITIVE',
          justification: 'Bandau peržiūrėti ne savo bylą',
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      as(colleague, (c) => c.query('SELECT app.refresh_case_compliance($1)', [caseId])),
    ).rejects.toThrow(/case not found/);
  });
});
