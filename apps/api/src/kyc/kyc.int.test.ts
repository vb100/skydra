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
import { MockRegistryProvider } from '../ownership/mock-registry';
import { fetchOwnership, linkBeneficialOwners } from '../ownership/ownership';
import { assessRisk } from '../risk/risk';
import { MockScreeningProvider } from '../screening/mock-provider';
import { listScreenings, reviewMatch, runScreening } from '../screening/screening';
import type { CaseDecision } from '@skydra/shared';
import { exportCase } from '../export/case-report';
import {
  decideApproval,
  escalate,
  getChecklist,
  listDecisions,
  recordDecision,
  requestApproval,
  resolveEscalation,
} from './decisions';
import { reopenCase } from './revisions';
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

  const assess = (caseId: string, ctx = broker) => as(ctx, (c) => assessRisk(c, caseId, {}));

  async function verifyAndComplete(caseId: string, casePartyId: string, ctx = broker) {
    await as(ctx, (c) =>
      recordInPersonVerification(c, keys, caseId, { casePartyId, ...DOCUMENT } as never),
    );
    await as(ctx, (c) =>
      updateCaseParty(c, caseId, casePartyId, { kyc: KYC, cddStatus: 'COMPLETED' }),
    );
    await assess(caseId, ctx);
  }

  const reopen = (caseId: string, reason: string, ctx = broker) =>
    as(ctx, (c) => reopenCase(c, keys, caseId, { reason }));

  /** The broker's final decision (approve unless said otherwise). */
  const finalDecision = (
    caseId: string,
    decision: CaseDecision = 'APPROVE',
    ctx = broker,
    more: { suspiciousIndicators?: boolean; suspicionNotes?: string } = {},
  ) =>
    as(ctx, (c) =>
      recordDecision(c, caseId, {
        decision,
        justification: 'Sprendimas pagrįstas bylos duomenimis',
        suspiciousIndicators: false,
        ...more,
      }),
    );

  async function confirmFirstMatch(caseId: string, ctx = broker) {
    const [check] = await as(ctx, (c) => listScreenings(c, caseId));
    await as(ctx, (c) =>
      reviewMatch(c, caseId, check!.matches[0]!.id, {
        decision: 'TRUE_POSITIVE',
        justification: 'Sutampa gimimo data ir pilietybė',
      }),
    );
    // A confirmed match is new evidence: the risk is assessed again (HIGH for a PEP).
    await assess(caseId, ctx);
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
      expect(await failing(caseId)).toEqual([
        'IDENTITY_VERIFIED',
        'CDD_COMPLETED',
        'RISK_ASSESSED',
        'DECISION_RECORDED',
      ]);
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
      // Only the broker's final decision remains; it completes the case.
      expect(await failing(caseId)).toEqual(['DECISION_RECORDED']);
      expect(await status(caseId)).toBe('IN_PROGRESS');
      expect((await finalDecision(caseId)).complianceStatus).toBe('COMPLETED');
      expect(await failing(caseId)).toEqual([]);

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
      // Not before the final decision either.
      await expect(
        as(broker, (c) => updateCase(c, actor(broker), caseId, { stage: 'CONTRACT' })),
      ).rejects.toThrow(/complete the AML checks/);
      await finalDecision(caseId);
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
            new UnavailableIdentityProvider('DOKOBIT'),
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
      expect(await failing(caseId)).toEqual([
        'CDD_COMPLETED',
        'RISK_ASSESSED',
        'DECISION_RECORDED',
      ]);

      await expect(
        startRemoteVerification(app, broker, new UnavailableIdentityProvider('DOKOBIT'), caseId, {
          casePartyId,
        }),
      ).rejects.toBeInstanceOf(RuleError);
    });

    it('a legal person needs no identity verification, and a colleague cannot act', async () => {
      const { id } = await as(broker, (c) => createCase(c, actor(broker), SALE));
      const { casePartyId } = await as(broker, (c) =>
        addCaseParty(c, keys, actor(broker), id, {
          party: {
            partyType: 'LEGAL',
            companyName: 'UAB Paprasta įmonė',
            companyCode: '300000001',
            registrationCountry: 'LT',
          },
          role: 'BUYER',
          isOurClient: true,
        }),
      );
      await expect(
        as(broker, (c) =>
          recordInPersonVerification(c, keys, id, { casePartyId, ...DOCUMENT } as never),
        ),
      ).rejects.toThrow(/natural persons/);
      // Its beneficial owner comes from the registries and is screened with the others.
      const { snapshotId } = await fetchOwnership(
        app,
        broker,
        keys,
        new MockRegistryProvider(),
        id,
        casePartyId,
      );
      await as(broker, (c) => linkBeneficialOwners(c, keys, broker.organizationId, id, snapshotId));
      await runScreening(app, broker, screening, id, {});
      await as(broker, (c) =>
        updateCaseParty(c, id, casePartyId, { kyc: KYC, cddStatus: 'COMPLETED' }),
      );
      await assess(id);
      expect((await finalDecision(id)).complianceStatus).toBe('COMPLETED');

      await expect(as(colleague, (c) => getChecklist(c, id))).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        as(colleague, (c) => escalate(c, id, { reason: 'Įtartinas mokėjimas grynaisiais' })),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('enhanced due diligence approval', () => {
    it('a confirmed PEP needs another member to approve, then an approval with enhanced measures', async () => {
      const { caseId, casePartyId } = await screenedCase('Politikienė');
      await verifyAndComplete(caseId, casePartyId);
      await expect(
        as(broker, (c) => requestApproval(c, caseId, { reason: 'Nereikia, bet bandau' })),
      ).rejects.toThrow(/does not need an approval/);

      await confirmFirstMatch(caseId);
      expect(await status(caseId)).toBe('REVIEW_REQUIRED');
      expect(await failing(caseId)).toEqual(['EDD_APPROVED', 'DECISION_RECORDED']);

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

      expect((await decide(approver)).complianceStatus).toBe('IN_PROGRESS');
      await expect(decide(approver)).rejects.toThrow(/already been decided/);
      // Enhanced due diligence applied, so a plain approval does not fit.
      await expect(finalDecision(caseId)).rejects.toThrow(/approve with enhanced measures/);
      expect((await finalDecision(caseId, 'APPROVE_WITH_ENHANCED_MEASURES')).complianceStatus).toBe(
        'COMPLETED',
      );

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

    it('confirmed sanctions cannot be taken to an approver', async () => {
      const { caseId, casePartyId } = await screenedCase('Sankcijonienė');
      await verifyAndComplete(caseId, casePartyId);
      await confirmFirstMatch(caseId);
      expect(await status(caseId)).toBe('BLOCKED');
      await expect(
        as(broker, (c) => requestApproval(c, caseId, { reason: 'Bandau patvirtinti sankcijas' })),
      ).rejects.toThrow(/confirmed sanctions/);
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
      expect(result.complianceStatus).toBe('IN_PROGRESS');
      expect(
        (await finalDecision(caseId, 'APPROVE_WITH_ENHANCED_MEASURES', solo)).complianceStatus,
      ).toBe('COMPLETED');
    });
  });

  describe('escalation to the AML officer', () => {
    it('blocks the case until the AML officer clears it; a report keeps it blocked', async () => {
      const { caseId, casePartyId } = await screenedCase('Eskaluojama');
      await verifyAndComplete(caseId, casePartyId);
      expect((await finalDecision(caseId)).complianceStatus).toBe('COMPLETED');

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

  describe('final decision', () => {
    it('approves only when everything else is done; a decline closes the case for good', async () => {
      const { caseId } = await screenedCase('Atsisakomoji');
      await expect(finalDecision(caseId)).rejects.toThrow(
        /cannot be approved yet: CDD_COMPLETED, IDENTITY_VERIFIED, RISK_ASSESSED/,
      );
      await expect(finalDecision(caseId, 'TERMINATE')).rejects.toThrow(/decline instead/);

      const declined = await finalDecision(caseId, 'DECLINE');
      expect(declined.complianceStatus).toBe('CLOSED');
      const closed = await as(broker, (c) => getCase(c, keys, caseId));
      expect(closed).toMatchObject({ stage: 'TERMINATED', complianceStatus: 'CLOSED' });

      // Nothing more is decided, and the transaction cannot be taken up again.
      await expect(finalDecision(caseId, 'DECLINE')).rejects.toThrow(/closed by an earlier/);
      await expect(
        as(broker, (c) => updateCase(c, actor(broker), caseId, { stage: 'RESERVATION' })),
      ).rejects.toThrow(/closed by a decision/);
      // Its AML file is still exported (and kept).
      const exported = await as(broker, (c) => exportCase(c, keys, caseId));
      expect(exported.pdf.subarray(0, 5).toString()).toBe('%PDF-');

      const { final } = await as(broker, (c) => listDecisions(c, caseId));
      expect(final).toMatchObject([
        {
          decision: 'DECLINE',
          suspiciousIndicators: false,
          decidedBy: broker.userId,
          nextReviewOn: null,
        },
      ]);
      await expect(
        as(broker, (c) =>
          c.query("UPDATE case_decisions SET decision = 'APPROVE' WHERE case_id = $1", [caseId]),
        ),
      ).rejects.toThrow(/permission denied/);
      const { rows } = await db.superuser.query(
        "SELECT after FROM audit_events WHERE action = 'case.decided' AND entity_id = $1",
        [caseId],
      );
      expect(rows[0].after).toMatchObject({ decision: 'DECLINE' });
    });

    it('a new risk assessment needs a new decision; a terminated relationship closes the case', async () => {
      const { caseId, casePartyId } = await screenedCase('Patvirtinamoji');
      await verifyAndComplete(caseId, casePartyId);
      const approved = await finalDecision(caseId);
      expect(approved.complianceStatus).toBe('COMPLETED');
      await expect(finalDecision(caseId)).rejects.toThrow(/already approved/);
      await expect(finalDecision(caseId, 'DECLINE')).rejects.toThrow(/terminate instead/);
      const { final } = await as(broker, (c) => listDecisions(c, caseId));
      // The decision records the risk it was taken on and when the case is next reviewed.
      expect(final[0]).toMatchObject({ decision: 'APPROVE', riskLevel: 'MEDIUM' });
      expect(final[0]!.nextReviewOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      // A completed case is read-only: new information needs the case reopened (Q26).
      await expect(
        as(broker, (c) => updateCase(c, actor(broker), caseId, { transactionValue: 160000 })),
      ).rejects.toThrow(/reopen it to make changes/);
      await expect(reopen(caseId, 'Trumpai')).rejects.toThrow();
      const reopened = await reopen(caseId, 'Pasikeitė sandorio kaina po derybų');
      expect(reopened.complianceStatus).toBe('IN_PROGRESS');
      await expect(reopen(caseId, 'Antras atidarymas tuo pačiu metu')).rejects.toThrow(
        /only a completed case is reopened|already reopened/,
      );
      await as(broker, (c) => updateCase(c, actor(broker), caseId, { transactionValue: 160000 }));
      await assess(caseId);
      expect(await failing(caseId)).toEqual(['DECISION_RECORDED']);
      expect((await finalDecision(caseId)).complianceStatus).toBe('COMPLETED');

      // The reopening is on record with the state it left, and closed by the new decision.
      const { revisions, final: decisions } = await as(broker, (c) => listDecisions(c, caseId));
      expect(revisions).toMatchObject([
        {
          reason: 'Pasikeitė sandorio kaina po derybų',
          openedBy: broker.userId,
          closedByDecision: decisions[0]!.id,
          snapshot: {
            complianceStatus: 'COMPLETED',
            riskLevel: 'MEDIUM',
            decision: { decision: 'APPROVE' },
            transaction: { value: '150000.00' },
          },
        },
      ]);
      await expect(
        as(broker, (c) =>
          c.query(
            'UPDATE case_revisions SET closed_at = NULL, closed_by_decision = NULL WHERE case_id = $1',
            [caseId],
          ),
        ),
      ).rejects.toThrow(/closed only by a decision/);

      // Terminating needs no reopening.
      expect((await finalDecision(caseId, 'TERMINATE')).complianceStatus).toBe('CLOSED');
    });

    it('a completed case keeps its stage, screening, reports and exports, but not its data', async () => {
      const { caseId, casePartyId } = await screenedCase('Užrakinta');
      await verifyAndComplete(caseId, casePartyId);
      await finalDecision(caseId);
      const locked = /reopen it to make changes/;
      // Refused: data, parties, identity, KYC, risk, approvals.
      await expect(
        as(broker, (c) =>
          addCaseParty(c, keys, actor(broker), caseId, {
            party: { partyType: 'NATURAL', firstName: 'Nauja', lastName: 'Šalis' },
            role: 'SELLER',
            isOurClient: false,
          }),
        ),
      ).rejects.toThrow(locked);
      await expect(
        as(broker, (c) =>
          updateCaseParty(c, caseId, casePartyId, { kyc: { ...KYC, purpose: 'Kitas tikslas' } }),
        ),
      ).rejects.toThrow(locked);
      await expect(
        as(broker, (c) =>
          recordInPersonVerification(c, keys, caseId, { casePartyId, ...DOCUMENT } as never),
        ),
      ).rejects.toThrow(locked);
      await expect(assess(caseId)).rejects.toThrow(locked);
      // Still possible: the transaction's stage, a new check, a report to the AML officer.
      await as(broker, (c) => updateCase(c, actor(broker), caseId, { stage: 'CONTRACT' }));
      await runScreening(app, broker, screening, caseId, {});
      expect(await status(caseId)).toBe('COMPLETED');
      const raised = await as(broker, (c) =>
        escalate(c, caseId, { reason: 'Nauji įtarimai po užbaigimo' }),
      );
      expect(raised.complianceStatus).toBe('BLOCKED');
    });

    it('suspicious indicators must have been reported to the AML officer first', async () => {
      const { caseId } = await screenedCase('Įtartinoji');
      const suspicion = {
        suspiciousIndicators: true,
        suspicionNotes: 'Mokėjimas per trečiąjį asmenį',
      };
      await expect(finalDecision(caseId, 'DECLINE', broker, suspicion)).rejects.toThrow(
        /report the suspicious indicators/,
      );
      await expect(
        finalDecision(caseId, 'DECLINE', broker, { suspiciousIndicators: true }),
      ).rejects.toThrow(/describe the suspicious indicators/);
      await as(broker, (c) => escalate(c, caseId, { reason: 'Mokėjimas per trečiąjį asmenį' }));
      expect((await finalDecision(caseId, 'DECLINE', broker, suspicion)).complianceStatus).toBe(
        'CLOSED',
      );
      // Another broker cannot decide on this case.
      await expect(finalDecision(caseId, 'DECLINE', colleague)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });
});
