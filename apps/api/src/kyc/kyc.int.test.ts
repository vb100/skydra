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
import { addMember } from '../organization/members';
import { createOrganization, withPlatform } from '../platform/platform';
import { MockScreeningProvider } from '../screening/mock-provider';
import { listScreenings, reviewMatch, runScreening } from '../screening/screening';
import {
  decideApproval,
  escalate,
  getChecklist,
  listDecisions,
  requestApproval,
  resolveEscalation,
} from './decisions';
import {
  listIdentityVerifications,
  recordInPersonVerification,
  simulateRemoteVerification,
  startRemoteVerification,
} from './identity';
import { MockIdentityProvider, UnavailableIdentityProvider } from './identity-provider';

const keys = deriveKeys(LOCAL_DEVELOPMENT_KEY);
const screening = new MockScreeningProvider();
const idv = new MockIdentityProvider();
const SALE = {
  transactionType: 'SALE',
  propertyType: 'APARTMENT',
  propertyAddress: 'Pilies g. 1, Vilnius',
  transactionValue: 150000,
} as const;
const KYC = {
  version: 1 as const,
  purpose: 'Gyventi',
  actsOnOwnBehalf: true,
  pepSelfDeclared: false,
};
const DOCUMENT = { documentType: 'ID_CARD', documentNumber: 'AB 123-4567', documentCountry: 'lt' };

describe('KYC completion', () => {
  let db: TestDatabase;
  let app: Pool;
  let platformAdmin: string;
  let broker: TenantContext;
  let colleague: TenantContext;
  let approver: TenantContext;
  let officer: TenantContext;

  const as = <T>(ctx: TenantContext, work: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(app, ctx, work);
  const actor = (ctx: TenantContext): CaseActor => ({ ...ctx, canAssign: false });
  const status = async (caseId: string, ctx = broker) =>
    (await as(ctx, (c) => getCase(c, keys, caseId))).complianceStatus;
  const failing = async (caseId: string, ctx = broker) =>
    (await as(ctx, (c) => getChecklist(c, caseId))).filter((e) => !e.ok).map((e) => e.item);

  async function organization(email: string, planCode: 'AGENCY' | 'INDIVIDUAL') {
    const org = await withPlatform(app, platformAdmin, (c) =>
      createOrganization(c, { name: email, planCode, adminEmail: email, adminFullName: 'A' }),
    );
    await db.superuser.query("UPDATE users SET status = 'ACTIVE' WHERE id = $1", [org.adminUserId]);
    return { organizationId: org.organizationId, userId: org.adminUserId };
  }

  async function member(
    admin: TenantContext,
    email: string,
    permissions: ('APPROVER' | 'AML_OFFICER')[] = [],
  ) {
    const { userId } = await as(admin, (c) =>
      addMember(c, { email, fullName: email, roles: ['BROKER'], permissions }),
    );
    await db.superuser.query("UPDATE users SET status = 'ACTIVE' WHERE id = $1", [userId]);
    return { organizationId: admin.organizationId, userId };
  }

  /** A sale with one natural-person party, screened. */
  async function screenedCase(lastName: string, ctx = broker) {
    const { id } = await as(ctx, (c) => createCase(c, actor(ctx), SALE));
    const { casePartyId } = await as(ctx, (c) =>
      addCaseParty(c, keys, actor(ctx), id, {
        party: { partyType: 'NATURAL', firstName: 'Asta', lastName, birthDate: '1985-05-05' },
        role: 'BUYER',
        isOurClient: true,
      }),
    );
    await runScreening(app, ctx, screening, id, {});
    return { caseId: id, casePartyId };
  }

  async function verifyAndComplete(caseId: string, casePartyId: string, ctx = broker) {
    await as(ctx, (c) =>
      recordInPersonVerification(c, keys, caseId, { casePartyId, ...DOCUMENT } as never),
    );
    await as(ctx, (c) =>
      updateCaseParty(c, caseId, casePartyId, { kyc: KYC, cddStatus: 'COMPLETED' }),
    );
  }

  async function confirmFirstMatch(caseId: string, ctx = broker) {
    const [check] = await as(ctx, (c) => listScreenings(c, caseId));
    await as(ctx, (c) =>
      reviewMatch(c, caseId, check!.matches[0]!.id, {
        decision: 'TRUE_POSITIVE',
        justification: 'Sutampa gimimo data ir pilietybė',
      }),
    );
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.owner, MIGRATIONS_DIR);
    const { rows } = await db.superuser.query<{ id: string }>(
      "INSERT INTO users (email, full_name, status) VALUES ('admin@skydra.eu', 'P', 'ACTIVE') RETURNING id",
    );
    platformAdmin = rows[0]!.id;
    await db.superuser.query('INSERT INTO platform_admins (user_id) VALUES ($1)', [platformAdmin]);
    app = db.appPool({ max: 5 });

    const admin = await organization('admin@kyc.lt', 'AGENCY');
    broker = await member(admin, 'broker@kyc.lt');
    colleague = await member(admin, 'colleague@kyc.lt');
    approver = await member(admin, 'approver@kyc.lt', ['APPROVER']);
    officer = await member(admin, 'officer@kyc.lt', ['AML_OFFICER']);
  });

  afterAll(async () => {
    await db?.drop();
  });

  describe('identity verification and CDD', () => {
    it('lists what is missing and completes the case once everything is done', async () => {
      const { caseId, casePartyId } = await screenedCase('Švarutė');
      expect(await failing(caseId)).toEqual(['IDENTITY_VERIFIED', 'CDD_COMPLETED']);
      expect(await status(caseId)).toBe('IN_PROGRESS');

      // CDD cannot be marked completed before the identity is verified and KYC answered.
      await expect(
        as(broker, (c) => updateCaseParty(c, caseId, casePartyId, { cddStatus: 'COMPLETED' })),
      ).rejects.toThrow(/purpose, acting on own behalf/);
      await expect(
        as(broker, (c) =>
          updateCaseParty(c, caseId, casePartyId, { kyc: KYC, cddStatus: 'COMPLETED' }),
        ),
      ).rejects.toThrow(/identity has not been verified/);

      await verifyAndComplete(caseId, casePartyId);
      expect(await failing(caseId)).toEqual([]);
      expect(await status(caseId)).toBe('COMPLETED');

      const [v] = await as(broker, (c) => listIdentityVerifications(c, keys, caseId));
      expect(v).toMatchObject({
        method: 'IN_PERSON',
        provider: 'MANUAL',
        status: 'VERIFIED',
        documentCountry: 'LT',
        documentNumberMasked: '•••••4567',
        completedBy: broker.userId,
      });
      const { rows } = await db.superuser.query(
        'SELECT document_number_encrypted FROM identity_verifications WHERE id = $1',
        [v!.id],
      );
      expect(rows[0].document_number_encrypted).toMatch(/^v1\./);
      const { rows: audit } = await db.superuser.query(
        "SELECT after FROM audit_events WHERE entity_id = $1 AND action LIKE 'identity.%'",
        [caseId],
      );
      expect(JSON.stringify(audit)).not.toContain('4567');
    });

    it('the contract stage needs completed AML checks', async () => {
      const { caseId, casePartyId } = await screenedCase('Sutartinė');
      await expect(
        as(broker, (c) => updateCase(c, actor(broker), caseId, { stage: 'CONTRACT' })),
      ).rejects.toThrow(/complete the AML checks/);
      await verifyAndComplete(caseId, casePartyId);
      await as(broker, (c) => updateCase(c, actor(broker), caseId, { stage: 'CONTRACT' }));
    });

    it('refuses an expired document', async () => {
      const { caseId, casePartyId } = await screenedCase('Pasibaigusi');
      await expect(
        as(broker, (c) =>
          recordInPersonVerification(c, keys, caseId, {
            casePartyId,
            ...DOCUMENT,
            documentExpiresOn: '2020-01-01',
          } as never),
        ),
      ).rejects.toThrow(/expired/);
    });

    it('a remote session can be simulated with the MOCK provider only', async () => {
      const { caseId, casePartyId } = await screenedCase('Nuotolinė');
      const started = await startRemoteVerification(app, broker, idv, caseId, { casePartyId });
      expect(await failing(caseId)).toContain('IDENTITY_VERIFIED');

      await expect(
        as(broker, (c) =>
          simulateRemoteVerification(
            c,
            new UnavailableIdentityProvider('ONDATO'),
            caseId,
            started.id,
            {
              outcome: 'VERIFIED',
            },
          ),
        ),
      ).rejects.toBeInstanceOf(RuleError);

      await as(broker, (c) =>
        simulateRemoteVerification(c, idv, caseId, started.id, { outcome: 'REJECTED' }),
      );
      expect(await failing(caseId)).toContain('IDENTITY_VERIFIED');

      // A finished session is evidence: it cannot be re-simulated or edited.
      await expect(
        as(broker, (c) =>
          simulateRemoteVerification(c, idv, caseId, started.id, { outcome: 'VERIFIED' }),
        ),
      ).rejects.toBeInstanceOf(RuleError);
      await expect(
        as(broker, (c) =>
          c.query("UPDATE identity_verifications SET status = 'VERIFIED' WHERE id = $1", [
            started.id,
          ]),
        ),
      ).rejects.toThrow(/cannot be changed/);

      const second = await startRemoteVerification(app, broker, idv, caseId, { casePartyId });
      await as(broker, (c) =>
        simulateRemoteVerification(c, idv, caseId, second.id, { outcome: 'VERIFIED' }),
      );
      expect(await failing(caseId)).toEqual(['CDD_COMPLETED']);

      await expect(
        startRemoteVerification(app, broker, new UnavailableIdentityProvider('ONDATO'), caseId, {
          casePartyId,
        }),
      ).rejects.toBeInstanceOf(RuleError);
    });

    it('a legal person needs no identity verification, and a colleague cannot act', async () => {
      const { id } = await as(broker, (c) => createCase(c, actor(broker), SALE));
      const { casePartyId } = await as(broker, (c) =>
        addCaseParty(c, keys, actor(broker), id, {
          party: { partyType: 'LEGAL', companyName: 'UAB Pirkėjas', registrationCountry: 'LT' },
          role: 'BUYER',
          isOurClient: true,
        }),
      );
      await expect(
        as(broker, (c) =>
          recordInPersonVerification(c, keys, id, { casePartyId, ...DOCUMENT } as never),
        ),
      ).rejects.toThrow(/natural persons/);
      await runScreening(app, broker, screening, id, {});
      await as(broker, (c) =>
        updateCaseParty(c, id, casePartyId, { kyc: KYC, cddStatus: 'COMPLETED' }),
      );
      expect(await status(id)).toBe('COMPLETED');

      await expect(as(colleague, (c) => getChecklist(c, id))).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        as(colleague, (c) => escalate(c, id, { reason: 'Įtartinas mokėjimas grynaisiais' })),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('enhanced due diligence approval', () => {
    it('a confirmed PEP needs another member to approve; the approval completes the case', async () => {
      const { caseId, casePartyId } = await screenedCase('Politikienė');
      await verifyAndComplete(caseId, casePartyId);
      await expect(
        as(broker, (c) => requestApproval(c, caseId, { reason: 'Nereikia, bet bandau' })),
      ).rejects.toThrow(/does not need an approval/);

      await confirmFirstMatch(caseId);
      expect(await status(caseId)).toBe('REVIEW_REQUIRED');
      expect(await failing(caseId)).toEqual(['EDD_APPROVED']);

      const { id: approvalId } = await as(broker, (c) =>
        requestApproval(c, caseId, { reason: 'Lėšos iš darbo užmokesčio, pateikta pažyma' }),
      );
      await expect(
        as(broker, (c) => requestApproval(c, caseId, { reason: 'Antras prašymas tam pačiam' })),
      ).rejects.toThrow(/already open/);

      const decide = (ctx: TenantContext) =>
        as(ctx, (c) =>
          decideApproval(c, caseId, approvalId, {
            decision: 'APPROVED',
            justification: 'Lėšų kilmė pagrįsta dokumentais',
          }),
        );
      // Not the broker themselves, and only someone with the approver permission.
      await expect(decide(broker)).rejects.toThrow(/approver permission/);
      await expect(decide(colleague)).rejects.toBeInstanceOf(NotFoundError);

      expect((await decide(approver)).complianceStatus).toBe('COMPLETED');
      await expect(decide(approver)).rejects.toThrow(/already been decided/);

      const { approvals } = await as(broker, (c) => listDecisions(c, caseId));
      expect(approvals[0]).toMatchObject({ status: 'APPROVED', decidedBy: approver.userId });
    });

    it('an approver who is the responsible broker cannot approve their own case', async () => {
      const { caseId, casePartyId } = await screenedCase('Politikas', approver);
      await verifyAndComplete(caseId, casePartyId, approver);
      await confirmFirstMatch(caseId, approver);
      const { id } = await as(approver, (c) =>
        requestApproval(c, caseId, { reason: 'Prašau patvirtinti santykius su PEP' }),
      );
      await expect(
        as(approver, (c) =>
          decideApproval(c, caseId, id, {
            decision: 'APPROVED',
            justification: 'Tvirtinu pats savo bylą',
          }),
        ),
      ).rejects.toThrow(/someone other than the responsible broker/);
    });

    it('a rejected approval blocks the case', async () => {
      const { caseId, casePartyId } = await screenedCase('Skandalingoji');
      await verifyAndComplete(caseId, casePartyId);
      await confirmFirstMatch(caseId);
      const { id } = await as(broker, (c) =>
        requestApproval(c, caseId, { reason: 'Neigiama informacija, prašau vertinti' }),
      );
      const result = await as(approver, (c) =>
        decideApproval(c, caseId, id, {
          decision: 'REJECTED',
          justification: 'Rizika per didelė, santykių nemezgame',
        }),
      );
      expect(result.complianceStatus).toBe('BLOCKED');
    });

    it('a solo broker approves their own case', async () => {
      const solo = await organization('solo@kyc.lt', 'INDIVIDUAL');
      const { caseId, casePartyId } = await screenedCase('Politikaitė', solo);
      await verifyAndComplete(caseId, casePartyId, solo);
      await confirmFirstMatch(caseId, solo);
      const { id } = await as(solo, (c) =>
        requestApproval(c, caseId, { reason: 'Lėšos iš paveldėjimo, pateikti dokumentai' }),
      );
      const result = await as(solo, (c) =>
        decideApproval(c, caseId, id, {
          decision: 'APPROVED',
          justification: 'Vienintelis organizacijos narys, deklaruoju',
        }),
      );
      expect(result.complianceStatus).toBe('COMPLETED');
    });
  });

  describe('escalation to the AML officer', () => {
    it('blocks the case until the AML officer clears it; a report keeps it blocked', async () => {
      const { caseId, casePartyId } = await screenedCase('Eskaluojama');
      await verifyAndComplete(caseId, casePartyId);
      expect(await status(caseId)).toBe('COMPLETED');

      const first = await as(broker, (c) =>
        escalate(c, caseId, { reason: 'Klientas nori mokėti grynaisiais per trečiąjį asmenį' }),
      );
      expect(first.complianceStatus).toBe('BLOCKED');

      const resolve = (ctx: TenantContext, id: string, resolution: 'CLEARED' | 'REPORTED') =>
        as(ctx, (c) =>
          resolveEscalation(c, caseId, id, {
            resolution,
            notes: 'Paaiškinimai ir dokumentai gauti',
          }),
        );
      await expect(resolve(approver, first.id, 'CLEARED')).rejects.toThrow(/AML officer/);
      expect((await resolve(officer, first.id, 'CLEARED')).complianceStatus).toBe('COMPLETED');

      const second = await as(broker, (c) =>
        escalate(c, caseId, { reason: 'Nauji įtarimai dėl lėšų kilmės' }),
      );
      expect((await resolve(officer, second.id, 'REPORTED')).complianceStatus).toBe('BLOCKED');
      await expect(resolve(officer, second.id, 'CLEARED')).rejects.toThrow(/already been resolved/);

      const { escalations } = await as(officer, (c) => listDecisions(c, caseId));
      expect(escalations.map((e) => e.status)).toEqual(['REPORTED', 'CLEARED']);
    });
  });
});
