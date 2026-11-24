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
import { recordInPersonVerification } from '../kyc/identity';
import { assessRisk } from '../risk/risk';
import { migrate } from '../database/migrator';
import { type TenantContext, withTenant } from '../database/tenant';
import { createTestDatabase, MIGRATIONS_DIR, type TestDatabase } from '../database/test-database';
import { NotFoundError, RuleError } from '../domain-errors';
import { addMember } from '../organization/members';
import { createOrganization, withPlatform } from '../platform/platform';
import { MockScreeningProvider } from './mock-provider';
import {
  type ProviderExchange,
  ProviderError,
  type ScreeningProvider,
  UnavailableScreeningProvider,
} from './provider';
import { screeningStatus } from '@skydra/shared';
import { autoScreen, listScreenings, reviewMatch, runScreening } from './screening';
import { type MediaSource, WithAdverseMedia } from './adverse-media';

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

  /** Identity seen in person, KYC answers given, CDD marked completed. */
  async function completeCdd(caseId: string, casePartyId: string, ctx = broker) {
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

    await completeCdd(caseId, casePartyId);
    expect(await status(caseId)).toBe('COMPLETED');
  });

  it('a potential match needs a justified review; a false positive clears it', async () => {
    const { caseId, casePartyId } = await caseWith('Petras Politikas');
    await completeCdd(caseId, casePartyId);
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
    // The review is new evidence, so the risk is assessed again before the case completes.
    expect(reviewed.complianceStatus).toBe('IN_PROGRESS');
    expect((await as(broker, (c) => assessRisk(c, caseId, {}))).complianceStatus).toBe('COMPLETED');

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
    const colour = async (caseId: string) =>
      screeningStatus(await as(broker, (c) => listScreenings(c, caseId))).status;
    expect(await colour(sanctioned.caseId)).toBe('RED');

    const pep = await caseWith('Ona Politikė');
    await completeCdd(pep.caseId, pep.casePartyId);
    await screen(pep.caseId);
    const [p] = await as(broker, (c) => listScreenings(c, pep.caseId));
    const confirmed = await as(broker, (c) =>
      reviewMatch(c, pep.caseId, p!.matches[0]!.id, {
        decision: 'TRUE_POSITIVE',
        justification: 'Asmuo patvirtino einantis pareigas Seime',
      }),
    );
    expect(confirmed.complianceStatus).toBe('REVIEW_REQUIRED');
    expect(await colour(pep.caseId)).toBe('ORANGE');
    // The enhanced-due-diligence approval is what the case waits for.
    const waiting = (await as(broker, (c) => getCase(c, keys, pep.caseId))).complianceStatus;
    expect(waiting).toBe('REVIEW_REQUIRED');
  });

  it('screens automatically: new parties at once, nothing where AML does not apply', async () => {
    const { caseId, casePartyId } = await caseWith('Aurelija Automatinė');
    expect(await as(broker, (c) => listScreenings(c, caseId))).toEqual([]);
    expect(await autoScreen(app, broker, mock, caseId, [casePartyId])).toBe('SCREENED');
    const [check] = await as(broker, (c) => listScreenings(c, caseId));
    expect(check).toMatchObject({ casePartyId, status: 'COMPLETED', provider: 'MOCK' });

    const { id: lease } = await as(broker, (c) =>
      createCase(c, actor(broker), { ...SALE, transactionType: 'RENT', monthlyRent: 900 }),
    );
    expect(await autoScreen(app, broker, mock, lease)).toBe('SKIPPED');

    // A provider outage is still on record as a failed check, never as "no matches".
    const down: ScreeningProvider = {
      mode: 'OPENSANCTIONS',
      screen: () => Promise.reject(new ProviderError('OpenSanctions: timeout', [])),
    };
    expect(await autoScreen(app, broker, down, caseId, [casePartyId])).toBe('SCREENED');
    const [latest] = await as(broker, (c) => listScreenings(c, caseId));
    expect(latest).toMatchObject({ status: 'FAILED' });
    expect(screeningStatus(await as(broker, (c) => listScreenings(c, caseId)))).toEqual({
      status: 'GREEN',
      lastAttemptFailed: true,
    });

    // Another broker's case is not screened.
    expect(await autoScreen(app, colleague, mock, caseId, [casePartyId])).toBe('SKIPPED');
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
      mode: 'OPENSANCTIONS',
      screen: () => Promise.reject(new Error('timeout')),
    };
    const result = await screen(caseId, failing);
    expect(result.complianceStatus).toBe('IN_PROGRESS');
    const [check] = await as(broker, (c) => listScreenings(c, caseId));
    expect(check).toMatchObject({ status: 'FAILED', error: 'provider_error', matchCount: null });

    await expect(
      screen(caseId, new UnavailableScreeningProvider('OPENSANCTIONS')),
    ).rejects.toBeInstanceOf(RuleError);
    expect(await as(broker, (c) => listScreenings(c, caseId))).toHaveLength(1);
  });

  const exchange = (attempt: number, over: Partial<ProviderExchange> = {}): ProviderExchange => ({
    attempt,
    request: { url: '/match/default', body: { queries: { q: { schema: 'Person' } } } },
    response: { responses: { q: { status: 200, results: [] } } },
    httpStatus: 200,
    responseSha256: 'a'.repeat(64),
    error: null,
    durationMs: 120,
    sentAt: new Date(),
    ...over,
  });

  it('only strong matches must be reviewed; weak ones are listed after them', async () => {
    const { caseId } = await caseWith('Rūta Panaši');
    const provider: ScreeningProvider = {
      mode: 'OPENSANCTIONS',
      screen: () =>
        Promise.resolve({
          reference: null,
          matches: [
            {
              externalId: 'w1',
              name: 'Rūta Panašioji',
              score: 61,
              strength: 'WEAK',
              categories: ['PEP'],
              details: {},
            },
            {
              externalId: 's1',
              name: 'Rūta Panaši',
              score: 91,
              strength: 'STRONG',
              categories: ['PEP'],
              details: {},
            },
          ],
          exchanges: [exchange(1)],
        }),
    };
    expect((await screen(caseId, provider)).complianceStatus).toBe('REVIEW_REQUIRED');
    const [check] = await as(broker, (c) => listScreenings(c, caseId));
    expect(check!.matches.map((m) => [m.externalId, m.strength])).toEqual([
      ['s1', 'STRONG'],
      ['w1', 'WEAK'],
    ]);

    const strong = check!.matches[0]!;
    const { complianceStatus } = await as(broker, (c) =>
      reviewMatch(c, caseId, strong.id, {
        decision: 'FALSE_POSITIVE',
        justification: 'Kita gimimo data ir pilietybė',
      }),
    );
    // The weak match is still open, yet nothing waits for it.
    expect(complianceStatus).toBe('IN_PROGRESS');

    const weakOnly: ScreeningProvider = {
      mode: 'OPENSANCTIONS',
      screen: () =>
        Promise.resolve({
          reference: null,
          matches: [
            {
              externalId: 'w2',
              name: 'R. Panaši',
              score: 55,
              strength: 'WEAK',
              categories: ['SANCTIONS'],
              details: {},
            },
          ],
        }),
    };
    expect((await screen(caseId, weakOnly)).complianceStatus).toBe('IN_PROGRESS');
  });

  it('keeps every provider exchange, also of a failed call, and never changes them', async () => {
    const { caseId } = await caseWith('Linas Kartojamas');
    const provider: ScreeningProvider = {
      mode: 'OPENSANCTIONS',
      screen: () =>
        Promise.reject(
          new ProviderError('OpenSanctions: HTTP 503', [
            exchange(1, { httpStatus: 503, error: 'HTTP 503', response: { detail: 'busy' } }),
            exchange(2, {
              httpStatus: null,
              error: 'timeout',
              response: null,
              responseSha256: null,
            }),
          ]),
        ),
    };
    await screen(caseId, provider);
    const [check] = await as(broker, (c) => listScreenings(c, caseId));
    expect(check).toMatchObject({ status: 'FAILED', matchCount: null });

    const rows = await as(
      broker,
      async (c) =>
        (
          await c.query<{
            attempt: number;
            http_status: number | null;
            error: string;
            response: unknown;
          }>(
            'SELECT attempt, http_status, error, response FROM screening_requests WHERE check_id = $1 ORDER BY attempt',
            [check!.id],
          )
        ).rows,
    );
    expect(rows).toEqual([
      { attempt: 1, http_status: 503, error: 'HTTP 503', response: { detail: 'busy' } },
      { attempt: 2, http_status: null, error: 'timeout', response: null },
    ]);

    await expect(
      as(broker, (c) =>
        c.query("UPDATE screening_requests SET error = 'x' WHERE check_id = $1", [check!.id]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(broker, (c) => c.query('DELETE FROM screening_requests WHERE check_id = $1', [check!.id])),
    ).rejects.toThrow(/permission denied/);
    // A finished check takes no further exchanges.
    await expect(
      as(broker, (c) =>
        c.query(
          `INSERT INTO screening_requests (check_id, provider, attempt, request, duration_ms, sent_at)
           VALUES ($1, 'OPENSANCTIONS', 3, '{}', 1, now())`,
          [check!.id],
        ),
      ),
    ).rejects.toThrow(/pending check/);
  });

  it('an article is reviewed with its own decisions; the sources searched are recorded', async () => {
    const { caseId, casePartyId } = await caseWith('Jonas Straipsnelis');
    await completeCdd(caseId, casePartyId);
    const lists: ScreeningProvider = {
      mode: 'OPENSANCTIONS',
      sources: ['OPENSANCTIONS'],
      screen: () =>
        Promise.resolve({
          reference: null,
          matches: [
            {
              externalId: 'NK-pep',
              name: 'Jonas Straipsnelis',
              score: 88,
              strength: 'STRONG',
              categories: ['PEP'],
              details: {},
            },
          ],
          exchanges: [exchange(1, { provider: 'OPENSANCTIONS' })],
        }),
    };
    const brave: MediaSource = {
      code: 'BRAVE',
      search: () =>
        Promise.resolve({
          articles: [
            {
              url: 'https://www.lrt.lt/naujienos/1',
              title: 'Jonas Straipsnelis laimėjo konkursą',
              snippet: 'Jonas Straipsnelis apdovanotas',
              domain: 'lrt.lt',
              publishedAt: '2026-10-01T10:00:00.000Z',
              source: 'BRAVE',
            },
          ],
          exchanges: [exchange(1, { provider: 'BRAVE', request: { url: '/news/search?q=x' } })],
        }),
    };
    await screen(caseId, new WithAdverseMedia(lists, [brave]));

    const [check] = await as(broker, (c) => listScreenings(c, caseId));
    expect(check).toMatchObject({
      provider: 'OPENSANCTIONS',
      sources: ['OPENSANCTIONS', 'BRAVE'],
      matchCount: 2,
    });
    const pep = check!.matches.find((m) => m.categories.includes('PEP'))!;
    const article = check!.matches.find((m) => m.categories.includes('ADVERSE_MEDIA'))!;
    expect(article).toMatchObject({
      externalId: 'lrt.lt/naujienos/1',
      strength: 'STRONG',
      score: null,
      details: { kind: 'article', sourceUrl: 'https://www.lrt.lt/naujienos/1', source: 'Brave' },
    });
    const { rows: sent } = await db.superuser.query<{ provider: string }>(
      'SELECT provider FROM screening_requests WHERE check_id = $1 ORDER BY provider',
      [check!.id],
    );
    expect(sent.map((r) => r.provider)).toEqual(['BRAVE', 'OPENSANCTIONS']);

    // "Not relevant" is for articles only, in the API and in the database.
    await expect(
      as(broker, (c) =>
        reviewMatch(c, caseId, pep.id, {
          decision: 'NOT_RELEVANT',
          justification: 'Straipsnis neaktualus rizikai',
        }),
      ),
    ).rejects.toBeInstanceOf(RuleError);
    await expect(
      as(broker, (c) =>
        c.query(
          `UPDATE screening_matches SET review_status = 'NOT_RELEVANT',
                  review_justification = 'Neaktualu rizikai' WHERE id = $1`,
          [pep.id],
        ),
      ),
    ).rejects.toThrow(/not_relevant_article/);

    await as(broker, (c) =>
      reviewMatch(c, caseId, article.id, {
        decision: 'NOT_RELEVANT',
        justification: 'Apie šį asmenį, bet tai apdovanojimas, ne rizika',
      }),
    );
    await as(broker, (c) =>
      reviewMatch(c, caseId, pep.id, {
        decision: 'FALSE_POSITIVE',
        justification: 'Kita gimimo data nei PEP sąraše',
      }),
    );
    const [after] = await as(broker, (c) => listScreenings(c, caseId));
    expect(screeningStatus([after!]).status).toBe('GREEN');
    expect((await as(broker, (c) => assessRisk(c, caseId, {}))).complianceStatus).toBe('COMPLETED');
  });

  it('a check that fails in one source is FAILED, with every source attempt kept', async () => {
    const { caseId } = await caseWith('Ona Nepasiekiama');
    const lists: ScreeningProvider = {
      mode: 'OPENSANCTIONS',
      screen: () =>
        Promise.resolve({
          reference: null,
          matches: [],
          exchanges: [exchange(1, { provider: 'OPENSANCTIONS' })],
        }),
    };
    const gdelt: MediaSource = {
      code: 'GDELT',
      search: () =>
        Promise.reject(
          new ProviderError('GDELT: timeout', [
            exchange(1, {
              provider: 'GDELT',
              httpStatus: null,
              error: 'timeout',
              response: null,
              responseSha256: null,
            }),
          ]),
        ),
    };
    await screen(caseId, new WithAdverseMedia(lists, [gdelt]));
    const [check] = await as(broker, (c) => listScreenings(c, caseId));
    expect(check).toMatchObject({ status: 'FAILED', sources: ['OPENSANCTIONS', 'GDELT'] });
    expect(check!.matches).toEqual([]);
    const { rows } = await db.superuser.query<{ provider: string; error: string | null }>(
      'SELECT provider, error FROM screening_requests WHERE check_id = $1 ORDER BY provider',
      [check!.id],
    );
    expect(rows).toEqual([
      { provider: 'GDELT', error: 'timeout' },
      { provider: 'OPENSANCTIONS', error: null },
    ]);
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
