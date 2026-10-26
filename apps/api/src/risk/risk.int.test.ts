import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveKeys } from '../auth/crypto';
import {
  addCaseParty,
  type CaseActor,
  createCase,
  getCase,
  updateCase,
  updateCaseParty,
} from '../cases/cases';
import { LOCAL_DEVELOPMENT_KEY } from '../config/env';
import { migrate } from '../database/migrator';
import { type TenantContext, withTenant } from '../database/tenant';
import { createTestDatabase, MIGRATIONS_DIR, type TestDatabase } from '../database/test-database';
import { NotFoundError, RuleError } from '../domain-errors';
import { getChecklist, requestApproval } from '../kyc/decisions';
import { recordInPersonVerification } from '../kyc/identity';
import { addMember } from '../organization/members';
import { createOrganization, withPlatform } from '../platform/platform';
import { MockScreeningProvider } from '../screening/mock-provider';
import { runScreening } from '../screening/screening';
import { assessRisk, riskOverview } from './risk';

const keys = deriveKeys(LOCAL_DEVELOPMENT_KEY);
const SALE = {
  transactionType: 'SALE',
  propertyType: 'HOUSE',
  propertyAddress: 'Kauno g. 2, Vilnius',
  transactionValue: 200000,
  paymentMethod: 'BANK_TRANSFER',
} as const;
const KYC = {
  version: 1 as const,
  purpose: 'Gyventi',
  sourceOfFunds: 'Darbo užmokestis',
  actsOnOwnBehalf: true,
  pepSelfDeclared: false,
};

describe('risk assessment', () => {
  let db: TestDatabase;
  let app: Pool;
  let broker: TenantContext;
  let colleague: TenantContext;
  let approver: TenantContext;

  const as = <T>(ctx: TenantContext, work: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(app, ctx, work);
  const actor = (ctx: TenantContext): CaseActor => ({ ...ctx, canAssign: false });
  const missing = async (caseId: string) =>
    (await as(broker, (c) => getChecklist(c, caseId))).filter((e) => !e.ok).map((e) => e.item);

  /** A sale with one verified, screened party whose CDD is complete; risk not yet assessed. */
  async function readyCase(
    kyc: Partial<typeof KYC> = {},
    sale: { paymentMethod?: 'BANK_TRANSFER' | 'MIXED' } = {},
  ) {
    const { id } = await as(broker, (c) => createCase(c, actor(broker), { ...SALE, ...sale }));
    const { casePartyId } = await as(broker, (c) =>
      addCaseParty(c, keys, actor(broker), id, {
        party: {
          partyType: 'NATURAL',
          firstName: 'Rasa',
          lastName: 'Rizikaitė',
          citizenships: ['LT'],
          residenceCountry: 'LT',
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
        documentNumber: 'AA1111111',
        documentCountry: 'LT',
      }),
    );
    await as(broker, (c) =>
      updateCaseParty(c, id, casePartyId, { kyc: { ...KYC, ...kyc }, cddStatus: 'COMPLETED' }),
    );
    return { caseId: id, casePartyId };
  }

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
        name: 'R',
        planCode: 'AGENCY',
        adminEmail: 'admin@r.lt',
        adminFullName: 'A',
      }),
    );
    await db.superuser.query("UPDATE users SET status = 'ACTIVE'");
    const admin = { organizationId: org.organizationId, userId: org.adminUserId };
    const member = async (email: string, permissions: 'APPROVER'[] = []) => {
      const { userId } = await withTenant(app, admin, (c) =>
        addMember(c, { email, fullName: email, roles: ['BROKER'], permissions }),
      );
      await db.superuser.query("UPDATE users SET status = 'ACTIVE' WHERE id = $1", [userId]);
      return { organizationId: org.organizationId, userId };
    };
    broker = await member('broker@r.lt');
    colleague = await member('colleague@r.lt');
    approver = await member('approver@r.lt', ['APPROVER']);
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('previews, records with the rule-set version and completes a low-risk case', async () => {
    const { caseId } = await readyCase();
    expect(await missing(caseId)).toEqual(['RISK_ASSESSED']);

    const overview = await as(broker, (c) => riskOverview(c, caseId));
    expect(overview).toMatchObject({
      ruleSet: { code: 'LT-RISK-01', version: 'DEMO-1', isDemo: true },
      preview: { calculatedLevel: 'LOW', mandatoryLevel: null },
      current: null,
      stale: false,
    });
    expect(overview.preview.facts).toMatchObject({
      partyCountries: ['LT'],
      paymentMethod: 'BANK_TRANSFER',
      transactionValueEur: 200000,
    });

    const result = await as(broker, (c) => assessRisk(c, caseId, {}));
    expect(result).toMatchObject({ finalLevel: 'LOW', complianceStatus: 'COMPLETED' });

    const after = await as(broker, (c) => riskOverview(c, caseId));
    const fiveYears = new Date();
    fiveYears.setUTCFullYear(fiveYears.getUTCFullYear() + 5);
    expect(after.current).toMatchObject({
      ruleSetVersion: 'DEMO-1',
      calculatedLevel: 'LOW',
      finalLevel: 'LOW',
      assessedBy: broker.userId,
      nextReviewOn: fiveYears.toISOString().slice(0, 10),
    });
    expect((await as(broker, (c) => getCase(c, keys, caseId))).riskLevel).toBe('LOW');

    const { rows } = await db.superuser.query(
      "SELECT after FROM audit_events WHERE action = 'risk.assessed' AND entity_id = $1",
      [caseId],
    );
    expect(rows[0].after).toMatchObject({ ruleSet: 'LT-RISK-01/DEMO-1', finalLevel: 'LOW' });
  });

  it('a change of risk inputs requires a new assessment; workflow changes do not', async () => {
    const { caseId } = await readyCase();
    await as(broker, (c) => assessRisk(c, caseId, {}));
    await as(broker, (c) => updateCase(c, actor(broker), caseId, { stage: 'OFFER_ACCEPTED' }));
    expect(await missing(caseId)).toEqual([]);

    await as(broker, (c) => updateCase(c, actor(broker), caseId, { paymentMethod: 'CASH' }));
    expect(await missing(caseId)).toEqual(['RISK_ASSESSED']);
    const overview = await as(broker, (c) => riskOverview(c, caseId));
    expect(overview).toMatchObject({ stale: true, preview: { calculatedLevel: 'HIGH' } });

    // HIGH needs the enhanced-due-diligence approval.
    await as(broker, (c) => assessRisk(c, caseId, {}));
    expect(await missing(caseId)).toEqual(['EDD_APPROVED']);
    expect((await as(broker, (c) => getCase(c, keys, caseId))).complianceStatus).toBe(
      'REVIEW_REQUIRED',
    );
  });

  it('the approval request needs a current risk assessment', async () => {
    const { caseId } = await readyCase({ pepSelfDeclared: true });
    // Until the risk is assessed the system does not know an approval is needed.
    expect(await missing(caseId)).toEqual(['RISK_ASSESSED']);
    await expect(
      as(broker, (c) =>
        requestApproval(c, caseId, { reason: 'Klientas yra PEP, lėšos pagrįstos' }),
      ),
    ).rejects.toThrow(/assess the risk/);
    expect((await as(broker, (c) => assessRisk(c, caseId, {}))).finalLevel).toBe('HIGH');
    expect(await missing(caseId)).toEqual(['EDD_APPROVED']);
    await as(broker, (c) =>
      requestApproval(c, caseId, { reason: 'Klientas yra PEP, lėšos pagrįstos' }),
    );
  });

  it('raising needs a justification; lowering needs another approver; never below the minimum', async () => {
    const { caseId } = await readyCase({}, { paymentMethod: 'MIXED' });
    expect((await as(broker, (c) => riskOverview(c, caseId))).preview.calculatedLevel).toBe(
      'MEDIUM',
    );

    await expect(
      as(broker, (c) => assessRisk(c, caseId, { finalLevel: 'HIGH' })),
    ).rejects.toBeInstanceOf(RuleError);
    const raised = await as(broker, (c) =>
      assessRisk(c, caseId, {
        finalLevel: 'HIGH',
        justification: 'Nenuoseklūs kliento paaiškinimai',
      }),
    );
    expect(raised.finalLevel).toBe('HIGH');

    await expect(
      as(broker, (c) =>
        assessRisk(c, caseId, { finalLevel: 'LOW', justification: 'Manau, kad rizika maža' }),
      ),
    ).rejects.toThrow(/needs an approver/);
    const lowered = await as(approver, (c) =>
      assessRisk(c, caseId, {
        finalLevel: 'LOW',
        justification: 'Mišrus mokėjimas – banko pavedimas ir paskola',
      }),
    );
    expect(lowered.finalLevel).toBe('LOW');

    const pep = await readyCase({ pepSelfDeclared: true });
    await expect(
      as(approver, (c) =>
        assessRisk(c, pep.caseId, { finalLevel: 'MEDIUM', justification: 'Bandau sumažinti PEP' }),
      ),
    ).rejects.toThrow(/mandatory minimum/);
    // Even writing directly, the database refuses it.
    await expect(
      as(approver, (c) =>
        c.query(
          `INSERT INTO risk_assessments (case_id, rule_set_id, facts, factors, calculated_level,
                                         mandatory_level, final_level, justification, next_review_on)
           SELECT $1, id, '{}', '[]', 'HIGH', 'HIGH', 'LOW', 'Tiesioginis įrašas', current_date
             FROM risk_rule_sets LIMIT 1`,
          [pep.caseId],
        ),
      ),
    ).rejects.toThrow(/mandatory minimum/);
  });

  it('assessments are immutable and follow case visibility', async () => {
    const { caseId } = await readyCase();
    const { id } = await as(broker, (c) => assessRisk(c, caseId, {}));
    await expect(
      as(broker, (c) =>
        c.query("UPDATE risk_assessments SET final_level = 'HIGH' WHERE id = $1", [id]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(broker, (c) => c.query('DELETE FROM risk_assessments WHERE id = $1', [id])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(broker, (c) => c.query('UPDATE risk_rule_sets SET is_demo = false')),
    ).rejects.toThrow(/permission denied/);

    await expect(as(colleague, (c) => riskOverview(c, caseId))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(as(colleague, (c) => assessRisk(c, caseId, {}))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('is not needed where AML does not apply', async () => {
    const { id } = await as(broker, (c) =>
      createCase(c, actor(broker), {
        ...SALE,
        transactionType: 'RENT',
        transactionValue: undefined,
        monthlyRent: 700,
      }),
    );
    await expect(as(broker, (c) => assessRisk(c, id, {}))).rejects.toThrow(/activate them first/);
  });
});
