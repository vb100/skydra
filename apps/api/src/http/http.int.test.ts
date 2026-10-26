import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, CSRF_HEADER } from '../app.factory';
import { hashToken, randomToken } from '../auth/crypto';
import { currentTotpCode } from '../auth/totp';
import { loadConfig } from '../config/env';
import { migrate } from '../database/migrator';
import { createTestDatabase, MIGRATIONS_DIR, type TestDatabase } from '../database/test-database';

const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'labai ilgas ir saugus slaptažodis';

describe('HTTP API: authentication, CSRF and guards', () => {
  let db: TestDatabase;
  let app: NestFastifyApplication;

  // Responses are asserted field by field in tests, so loose typing is intentional here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Res = { statusCode: number; json: () => any; headers: Record<string, unknown> };

  async function call(
    method: 'GET' | 'POST',
    url: string,
    options: { body?: unknown; cookie?: string; csrf?: boolean; origin?: string } = {},
  ): Promise<Res> {
    const headers: Record<string, string> = { origin: options.origin ?? ORIGIN };
    if (options.csrf !== false) headers[CSRF_HEADER] = '1';
    if (options.cookie) headers.cookie = options.cookie;
    return app.inject({ method, url, headers, payload: options.body as object }) as unknown as Res;
  }

  function sessionCookie(res: Res): string {
    const raw = res.headers['set-cookie'];
    const header = (Array.isArray(raw) ? raw : [raw]).find((c) =>
      String(c).startsWith('skydra_session='),
    );
    if (!header) throw new Error('no session cookie');
    return String(header).split(';')[0]!;
  }

  async function activateThroughApi(token: string) {
    const start = await call('POST', '/api/auth/links/start', { body: { token } });
    expect(start.statusCode).toBe(200);
    const { secret } = start.json();
    const done = await call('POST', '/api/auth/links/complete', {
      body: { token, password: PASSWORD, totpCode: currentTotpCode(secret) },
    });
    expect(done.statusCode).toBe(200);
    return secret as string;
  }

  async function signInThroughApi(email: string, secret: string) {
    await db.superuser.query(
      'UPDATE user_credentials SET totp_last_step = 0 WHERE user_id = (SELECT id FROM users WHERE email = $1)',
      [email],
    );
    const loginRes = await call('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
    expect(loginRes.statusCode).toBe(200);
    const mfa = await call('POST', '/api/auth/second-factor', {
      cookie: sessionCookie(loginRes),
      body: { code: currentTotpCode(secret) },
    });
    expect(mfa.statusCode).toBe(200);
    return sessionCookie(mfa);
  }

  let adminCookie: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.owner, MIGRATIONS_DIR);
    const config = loadConfig({
      APP_ENV: 'local',
      DATABASE_URL: 'postgres://unused@localhost/unused',
      PUBLIC_APP_URL: ORIGIN,
      SECRET_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      SCREENING_PROVIDER: 'MOCK',
      IDENTITY_PROVIDER: 'MOCK',
      REGISTRY_PROVIDER: 'MOCK',
    });
    app = await createApp(config, { pool: db.appPool({ max: 5 }), logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const { rows } = await db.superuser.query<{ id: string }>(
      "INSERT INTO users (email, full_name) VALUES ('admin@skydra.eu', 'Admin') RETURNING id",
    );
    await db.superuser.query('INSERT INTO platform_admins (user_id) VALUES ($1)', [rows[0]!.id]);
    const token = randomToken();
    await db.superuser.query(
      "INSERT INTO auth_links (token_hash, user_id, purpose, expires_at) VALUES ($1, $2, 'INVITE', now() + interval '1 hour')",
      [hashToken(token), rows[0]!.id],
    );
    const secret = await activateThroughApi(token);
    adminCookie = await signInThroughApi('admin@skydra.eu', secret);
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  describe('CSRF protection', () => {
    it('rejects state-changing requests without the CSRF header', async () => {
      const res = await call('POST', '/api/auth/login', {
        csrf: false,
        body: { email: 'a@b.lt', password: 'x' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'csrf_rejected' });
    });

    it('rejects requests from another origin', async () => {
      const res = await call('POST', '/api/auth/logout', {
        origin: 'https://evil.example',
        cookie: adminCookie,
      });
      expect(res.statusCode).toBe(403);
    });

    it('does not require the header for safe methods', async () => {
      const res = await call('GET', '/api/health', { csrf: false });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('session cookie', () => {
    it('is HttpOnly and SameSite=Lax', async () => {
      const res = await call('POST', '/api/auth/login', {
        body: { email: 'admin@skydra.eu', password: PASSWORD },
      });
      const header = String((res.headers['set-cookie'] as string[] | string) ?? '');
      expect(header).toMatch(/HttpOnly/i);
      expect(header).toMatch(/SameSite=Lax/i);
    });

    it('a password-only session cannot use the API', async () => {
      const loginRes = await call('POST', '/api/auth/login', {
        body: { email: 'admin@skydra.eu', password: PASSWORD },
      });
      const me = await call('GET', '/api/auth/me', { cookie: sessionCookie(loginRes) });
      expect(me.statusCode).toBe(401);
      expect(me.json()).toEqual({ error: 'mfa_required' });
    });

    it('rejects anonymous requests and wrong credentials with no details', async () => {
      expect((await call('GET', '/api/auth/me')).statusCode).toBe(401);
      const res = await call('POST', '/api/auth/login', {
        body: { email: 'admin@skydra.eu', password: 'neteisingas slaptažodis' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'invalid_credentials' });
    });
  });

  describe('end-to-end: platform admin onboards an agency', () => {
    it('creates the organization, the admin activates, signs in and selects it', async () => {
      const me = await call('GET', '/api/auth/me', { cookie: adminCookie });
      expect(me.json()).toMatchObject({ isPlatformAdmin: true, memberships: [] });

      const created = await call('POST', '/api/platform/organizations', {
        cookie: adminCookie,
        body: {
          name: 'Agentūra X',
          planCode: 'AGENCY',
          adminEmail: 'vadove@x.lt',
          adminFullName: 'Vadovė X',
        },
      });
      expect(created.statusCode).toBe(201);
      const { inviteUrl, organizationId } = created.json();
      expect(inviteUrl).toMatch(new RegExp(`^${ORIGIN}/activate#token=`));

      const token = String(inviteUrl).split('#token=')[1]!;
      expect((await call('POST', '/api/auth/links/inspect', { body: { token } })).json()).toEqual({
        purpose: 'INVITE',
        email: 'vadove@x.lt',
        fullName: 'Vadovė X',
      });
      const secret = await activateThroughApi(token);
      const cookie = await signInThroughApi('vadove@x.lt', secret);

      const before = (await call('GET', '/api/auth/me', { cookie })).json();
      expect(before).toMatchObject({ isPlatformAdmin: false, activeOrganizationId: null });
      expect(before.memberships).toEqual([
        expect.objectContaining({ organizationId, roles: ['ORG_ADMIN'] }),
      ]);

      // Organization endpoints need an active organization.
      const noOrg = await call(
        'POST',
        `/api/organization/members/${before.user.id}/password-reset`,
        {
          cookie,
        },
      );
      expect(noOrg.json()).toEqual({ error: 'organization_required' });

      const chosen = await call('POST', '/api/auth/organization', {
        cookie,
        body: { organizationId },
      });
      expect(chosen.statusCode).toBe(204);
      expect((await call('GET', '/api/auth/me', { cookie })).json().activeOrganizationId).toBe(
        organizationId,
      );

      // A non-platform user cannot use platform endpoints.
      expect((await call('GET', '/api/platform/organizations', { cookie })).statusCode).toBe(403);

      const logout = await call('POST', '/api/auth/logout', { cookie });
      expect(logout.statusCode).toBe(204);
      expect((await call('GET', '/api/auth/me', { cookie })).statusCode).toBe(401);
    });

    it('lets an organization admin manage members through the API', async () => {
      const created = (
        await call('POST', '/api/platform/organizations', {
          cookie: adminCookie,
          body: {
            name: 'Solo',
            planCode: 'INDIVIDUAL',
            adminEmail: 'solo@x.lt',
            adminFullName: 'Solo',
          },
        })
      ).json();
      const token = String(created.inviteUrl).split('#token=')[1]!;
      const cookie = await signInThroughApi('solo@x.lt', await activateThroughApi(token));
      await call('POST', '/api/auth/organization', {
        cookie,
        body: { organizationId: created.organizationId },
      });

      // The INDIVIDUAL plan has one seat: the rule is reported, not hidden.
      const full = await call('POST', '/api/organization/members', {
        cookie,
        body: { email: 'helper@x.lt', fullName: 'Helper', roles: ['BROKER'] },
      });
      expect(full.statusCode).toBe(422);
      expect(full.json()).toMatchObject({ error: 'rule_violation' });

      await db.superuser.query(
        `UPDATE organizations SET entitlement_overrides = '{"maxUsers": 3}' WHERE id = $1`,
        [created.organizationId],
      );
      const added = await call('POST', '/api/organization/members', {
        cookie,
        body: { email: 'helper@x.lt', fullName: 'Helper', roles: ['BROKER'] },
      });
      expect(added.statusCode).toBe(201);
      expect(added.json().inviteUrl).toMatch(/#token=/);

      const list = (await call('GET', '/api/organization/members', { cookie })).json();
      expect(list.map((m: { email: string }) => m.email).sort()).toEqual([
        'helper@x.lt',
        'solo@x.lt',
      ]);

      // The helper (a broker) may not manage members.
      const helperToken = String(added.json().inviteUrl).split('#token=')[1]!;
      const helper = await signInThroughApi('helper@x.lt', await activateThroughApi(helperToken));
      await call('POST', '/api/auth/organization', {
        cookie: helper,
        body: { organizationId: created.organizationId },
      });
      expect((await call('GET', '/api/organization/members', { cookie: helper })).statusCode).toBe(
        403,
      );
    });

    it('lets brokers work on cases, each only on their own', async () => {
      const created = (
        await call('POST', '/api/platform/organizations', {
          cookie: adminCookie,
          body: {
            name: 'Agentūra Y',
            planCode: 'AGENCY',
            adminEmail: 'admin@y.lt',
            adminFullName: 'Admin Y',
          },
        })
      ).json();
      const { organizationId } = created;
      const enter = async (inviteUrl: string, email: string) => {
        const token = String(inviteUrl).split('#token=')[1]!;
        const cookie = await signInThroughApi(email, await activateThroughApi(token));
        await call('POST', '/api/auth/organization', { cookie, body: { organizationId } });
        return cookie;
      };
      const admin = await enter(created.inviteUrl, 'admin@y.lt');
      const addBroker = async (email: string) => {
        const res = await call('POST', '/api/organization/members', {
          cookie: admin,
          body: { email, fullName: email, roles: ['BROKER'] },
        });
        return enter(res.json().inviteUrl, email);
      };
      const broker1 = await addBroker('b1@y.lt');
      const broker2 = await addBroker('b2@y.lt');

      // Administration is separate from AML work.
      expect((await call('GET', '/api/cases', { cookie: admin })).statusCode).toBe(403);

      const invalid = await call('POST', '/api/cases', {
        cookie: broker1,
        body: { transactionType: 'SALE', propertyType: 'HOUSE', propertyAddress: 'X' },
      });
      expect(invalid.statusCode).toBe(400);

      const res = await call('POST', '/api/cases', {
        cookie: broker1,
        body: {
          transactionType: 'SALE',
          propertyType: 'HOUSE',
          propertyAddress: 'Laisvės al. 10, Kaunas',
          transactionValue: '250000',
        },
      });
      expect(res.statusCode).toBe(201);
      const { id, reference } = res.json();
      expect(reference).toMatch(/^AML-\d{4}-0001$/);

      const party = await call('POST', `/api/cases/${id}/parties`, {
        cookie: broker1,
        body: {
          party: {
            partyType: 'NATURAL',
            firstName: 'Petras',
            lastName: 'Petraitis',
            personalCode: '39001010003',
          },
          role: 'SELLER',
          isOurClient: true,
        },
      });
      expect(party.statusCode).toBe(201);

      const detail = await call('GET', `/api/cases/${id}`, { cookie: broker1 });
      expect(detail.json()).toMatchObject({
        reference,
        amlApplicability: 'APPLICABLE',
        parties: [{ role: 'SELLER', party: { personalCodeMasked: '•••••••0003' } }],
      });
      expect(JSON.stringify(detail.json())).not.toContain('39001010003');

      // A rule refusal is reported as such.
      const activate = await call('POST', `/api/cases/${id}/activate-aml`, {
        cookie: broker1,
        body: { reason: 'Rizikos požymiai sandoryje' },
      });
      expect(activate.statusCode).toBe(422);

      // Screening with the simulated provider; CDD is not finished yet.
      const screened = await call('POST', `/api/cases/${id}/screenings`, { cookie: broker1 });
      expect(screened.statusCode).toBe(201);
      expect(screened.json().complianceStatus).toBe('IN_PROGRESS');
      const checks = (await call('GET', `/api/cases/${id}/screenings`, { cookie: broker1 })).json();
      expect(checks).toMatchObject([{ provider: 'MOCK', status: 'COMPLETED', matchCount: 0 }]);
      expect(
        (await call('POST', `/api/cases/${id}/screenings`, { cookie: broker2 })).statusCode,
      ).toBe(404);

      // Another broker's case does not exist for broker 2.
      expect((await call('GET', `/api/cases/${id}`, { cookie: broker2 })).statusCode).toBe(404);
      expect((await call('GET', '/api/cases', { cookie: broker2 })).json()).toEqual([]);
      expect((await call('GET', '/api/parties?query=Petr', { cookie: broker2 })).json()).toEqual(
        [],
      );
    });

    it('lists organizations for the platform admin', async () => {
      const res = await call('GET', '/api/platform/organizations', { cookie: adminCookie });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Agentūra X', planCode: 'AGENCY' }),
        ]),
      );
    });
  });

  it('answers malformed input with 400 and never leaks internals', async () => {
    const res = await call('POST', '/api/auth/links/complete', { body: { token: 'short' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_input' });
  });
});
