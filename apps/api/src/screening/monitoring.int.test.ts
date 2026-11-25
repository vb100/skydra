import { screeningStatus } from '@skydra/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveKeys } from '../auth/crypto';
import {
  addCaseParty,
  type CaseActor,
  createCase,
  getCase,
  listCases,
  updateCase,
  updateCaseParty,
} from '../cases/cases';
import { LOCAL_DEVELOPMENT_KEY } from '../config/env';
import { migrate } from '../database/migrator';
import { type TenantContext, withTenant } from '../database/tenant';
import { createTestDatabase, MIGRATIONS_DIR, type TestDatabase } from '../database/test-database';
import { recordInPersonVerification } from '../kyc/identity';
import { addMember, updateMember } from '../organization/members';
import { createOrganization, withPlatform } from '../platform/platform';
import { assessRisk } from '../risk/risk';
import { MockScreeningProvider } from './mock-provider';
import { runMonitoring } from './monitoring';
import type { ProviderMatch, ScreeningProvider } from './provider';
import { listScreenings, reviewMatch, runScreening } from './screening';

const keys = deriveKeys(LOCAL_DEVELOPMENT_KEY);
const mock = new MockScreeningProvider();
const DAY = 86_400_000;
const SALE = {
  transactionType: 'SALE',
  propertyType: 'HOUSE',
  propertyAddress: 'Pušų g. 1, Vilnius',
  transactionValue: 300000,
} as const;

/** The mock, plus `extra` for names containing `marker` (a record that appears later). */
const withExtra = (marker: string, extra: ProviderMatch): ScreeningProvider => ({
  mode: 'MOCK',
  screen: async (s) => {
    const result = await mock.screen(s);
    return s.name.includes(marker) ? { ...result, matches: [...result.matches, extra] } : result;
  },
});
const pep = (externalId: string, categories: ProviderMatch['categories'] = ['PEP']) => ({
  externalId,
  name: 'Įrašas',
  score: 90,
  strength: 'STRONG' as const,
  categories,
  details: {},
});

describe('ongoing monitoring', () => {
  let db: TestDatabase;
  let app: Pool;
  let platformAdmin: string;
  let admin: TenantContext;
  let broker: TenantContext;
  let manager: TenantContext;

  const as = <T>(ctx: TenantContext, work: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(app, ctx, work);
  const actor = (ctx: TenantContext): CaseActor => ({ ...ctx, canAssign: false });
  const status = async (caseId: string) =>
    (await as(manager, (c) => getCase(c, keys, caseId))).complianceStatus;
  const checks = (caseId: string) => as(manager, (c) => listScreenings(c, caseId));
  const monitor = (provider: ScreeningProvider, days: number) =>
    runMonitoring(app, provider, {
      intervalDays: 7,
      batch: 100,
      now: new Date(Date.now() + days * DAY),
    });

  /** A sale case with one party, screened (made by the broker unless given). */
  async function caseWith(name: string, ctx = broker, provider: ScreeningProvider = mock) {
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
    await runScreening(app, ctx, provider, id, {}, { origin: 'AUTOMATIC' });
    return { caseId: id, casePartyId };
  }

  /** Every open strong match ruled out, identity seen, CDD completed, risk assessed. */
  async function complete(caseId: string, casePartyId: string, ctx = broker) {
    const [latest] = await as(ctx, (c) => listScreenings(c, caseId));
    for (const m of latest!.matches.filter((x) => x.reviewStatus === 'OPEN'))
      await as(ctx, (c) =>
        reviewMatch(c, caseId, m.id, {
          decision: 'FALSE_POSITIVE',
          justification: 'Kita gimimo data nei sąraše',
        }),
      );
    await as(ctx, (c) =>
      recordInPersonVerification(c, keys, caseId, {
        casePartyId,
        documentType: 'ID_CARD',
        documentNumber: 'AB1234567',
        documentCountry: 'LT',
      }),
    );
    await as(ctx, (c) =>
      updateCaseParty(c, caseId, casePartyId, {
        cddStatus: 'COMPLETED',
        kyc: { version: 1, purpose: 'Būstas', actsOnOwnBehalf: true, pepSelfDeclared: false },
      }),
    );
    await as(ctx, (c) => assessRisk(c, caseId, {}));
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

    const org = await withPlatform(app, platformAdmin, (c) =>
      createOrganization(c, {
        name: 'Stebėsena',
        planCode: 'AGENCY',
        adminEmail: 'admin@m.lt',
        adminFullName: 'A',
      }),
    );
    await db.superuser.query("UPDATE users SET status = 'ACTIVE'");
    admin = { organizationId: org.organizationId, userId: org.adminUserId };
    const member = async (email: string, roles: ('BROKER' | 'MANAGER')[]) => {
      const { userId } = await withTenant(app, admin, (c) =>
        addMember(c, { email, fullName: email, roles }),
      );
      await db.superuser.query("UPDATE users SET status = 'ACTIVE' WHERE id = $1", [userId]);
      return { organizationId: org.organizationId, userId };
    };
    manager = await member('vadove@m.lt', ['MANAGER']);
    broker = await member('brokeris@m.lt', ['BROKER']);
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('carries a decision to a later check of the same record; a changed record is asked again', async () => {
    const { caseId, casePartyId } = await caseWith('Petras Politikas');
    await complete(caseId, casePartyId);
    expect(await status(caseId)).toBe('COMPLETED');
    const [first] = await checks(caseId);

    await runScreening(app, broker, mock, caseId, {});
    const [again] = await checks(caseId);
    expect(again!.id).not.toBe(first!.id);
    expect(again!.matches[0]).toMatchObject({
      reviewStatus: 'FALSE_POSITIVE',
      reviewJustification: 'Kita gimimo data nei sąraše',
      reviewedBy: broker.userId,
      carriedFrom: first!.matches[0]!.id,
    });
    // The same record now on a sanctions list is a new finding.
    const sanctioned: ScreeningProvider = {
      mode: 'MOCK',
      screen: async (s) => {
        const r = await mock.screen(s);
        return { ...r, matches: r.matches.map((m) => ({ ...m, categories: ['SANCTIONS'] })) };
      },
    };
    await runScreening(app, broker, sanctioned, caseId, {});
    const [changed] = await checks(caseId);
    expect(changed!.matches[0]).toMatchObject({ reviewStatus: 'OPEN', carriedFrom: null });
    expect(await status(caseId)).toBe('REVIEW_REQUIRED');
  });

  it('keeps a confirmation in force when a later check no longer finds the record', async () => {
    const { caseId } = await caseWith('Ivan Sankcijonis');
    const [first] = await checks(caseId);
    await as(broker, (c) =>
      reviewMatch(c, caseId, first!.matches[0]!.id, {
        decision: 'TRUE_POSITIVE',
        justification: 'Sutampa vardas, gimimo data ir pilietybė',
      }),
    );
    expect(await status(caseId)).toBe('BLOCKED');

    const delisted: ScreeningProvider = {
      mode: 'MOCK',
      screen: () => Promise.resolve({ reference: null, matches: [] }),
    };
    await runScreening(app, broker, delisted, caseId, {});
    expect(await status(caseId)).toBe('BLOCKED');
    expect(screeningStatus(await checks(caseId)).status).toBe('RED');
  });

  it('screens open cases again: nothing new changes nothing, a new match asks for review', async () => {
    const clean = await caseWith('Jonas Švarus');
    await complete(clean.caseId, clean.casePartyId);
    const reviewed = await caseWith('Rūta Politikė');
    await complete(reviewed.caseId, reviewed.casePartyId);
    // A finished transaction is no longer monitored.
    const closed = await caseWith('Ona Baigta');
    await complete(closed.caseId, closed.casePartyId);
    await as(broker, (c) => updateCase(c, actor(broker), closed.caseId, { stage: 'COMPLETED' }));
    expect([await status(clean.caseId), await status(reviewed.caseId)]).toEqual([
      'COMPLETED',
      'COMPLETED',
    ]);

    // Nothing is due yet.
    expect((await monitor(mock, 0)).due).toBe(0);

    const before = (await checks(closed.caseId)).length;
    const first = await monitor(mock, 8);
    expect(first).toMatchObject({ errors: 0, failed: 0, newMatches: 0 });
    expect(first.screened).toBe(first.due);
    expect((await checks(closed.caseId)).length).toBe(before);
    const [cleanCheck] = await checks(clean.caseId);
    const [reviewedCheck] = await checks(reviewed.caseId);
    expect(cleanCheck).toMatchObject({ origin: 'MONITORING', requestedBy: broker.userId });
    expect(reviewedCheck!.matches[0]).toMatchObject({ reviewStatus: 'FALSE_POSITIVE' });
    // The decisions stand and the risk need not be assessed again.
    expect([await status(clean.caseId), await status(reviewed.caseId)]).toEqual([
      'COMPLETED',
      'COMPLETED',
    ]);

    // A week later a new record appears for one person.
    const second = await monitor(withExtra('Švarus', pep('NK-new')), 16);
    expect(second.newMatches).toBe(1);
    expect(await status(clean.caseId)).toBe('REVIEW_REQUIRED');
    expect(await status(reviewed.caseId)).toBe('COMPLETED');
    const list = await as(broker, (c) => listCases(c));
    expect(list.find((c) => c.id === clean.caseId)!.monitoringAlert).toBe(true);
    expect(list.find((c) => c.id === reviewed.caseId)!.monitoringAlert).toBe(false);

    // Until it is reviewed the person is not screened again, so the alert cannot vanish when a
    // later answer happens not to contain the record.
    const [alerted] = await checks(clean.caseId);
    await monitor(mock, 24);
    expect((await checks(clean.caseId))[0]!.id).toBe(alerted!.id);
    expect(await status(clean.caseId)).toBe('REVIEW_REQUIRED');

    // Reviewing it ends the alert.
    const fresh = alerted!.matches.find((m) => m.externalId === 'NK-new')!;
    await as(broker, (c) =>
      reviewMatch(c, clean.caseId, fresh.id, {
        decision: 'FALSE_POSITIVE',
        justification: 'Kitas asmuo, kita gimimo data',
      }),
    );
    const after = await as(broker, (c) => listCases(c));
    expect(after.find((c) => c.id === clean.caseId)!.monitoringAlert).toBe(false);

    const { rows } = await db.superuser.query(
      `SELECT after FROM audit_events WHERE action = 'screening.completed' AND entity_id = $1
        ORDER BY occurred_at DESC LIMIT 1`,
      [clean.caseId],
    );
    expect(rows[0].after).toMatchObject({ origin: 'MONITORING', newStrongMatches: 1 });
  });

  it('acts through someone with access to all cases when the broker is no longer active', async () => {
    const other = await withTenant(app, admin, (c) =>
      addMember(c, { email: 'isejes@m.lt', fullName: 'Išėjęs', roles: ['BROKER'] }),
    );
    await db.superuser.query("UPDATE users SET status = 'ACTIVE' WHERE id = $1", [other.userId]);
    const leaving = { organizationId: admin.organizationId, userId: other.userId };
    const { caseId } = await caseWith('Tomas Paliktas', leaving);
    await withTenant(app, admin, (c) => updateMember(c, other.userId, { status: 'DISABLED' }));

    await monitor(mock, 40);
    const [latest] = await checks(caseId);
    expect(latest).toMatchObject({ origin: 'MONITORING', requestedBy: manager.userId });
  });

  it('counts checks and requests per month for the platform admin only', async () => {
    const usage = await withPlatform(
      app,
      platformAdmin,
      async (c) =>
        (await c.query('SELECT * FROM app.platform_provider_usage($1)', ['2026-01-01'])).rows,
    );
    const mine = usage.filter((u) => u.organization_id === admin.organizationId);
    const total = (k: string) => mine.reduce((n, u) => n + Number(u[k]), 0);
    const { rows } = await db.superuser.query<{ n: number; m: number }>(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE origin = 'MONITORING')::int AS m
         FROM screening_checks WHERE organization_id = $1 AND status <> 'PENDING'`,
      [admin.organizationId],
    );
    expect(total('checks')).toBe(rows[0]!.n);
    expect(total('monitoring_checks')).toBe(rows[0]!.m);

    await expect(
      as(broker, (c) => c.query('SELECT * FROM app.platform_provider_usage($1)', ['2026-01-01'])),
    ).rejects.toThrow(/platform administrators only/);
    await expect(as(broker, (c) => c.query('SELECT * FROM screening_usage'))).rejects.toThrow(
      /permission denied/,
    );
  });
});
