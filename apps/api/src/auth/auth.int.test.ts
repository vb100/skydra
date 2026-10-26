import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadPrincipal } from '../access/principal';
import { migrate } from '../database/migrator';
import { withTenant } from '../database/tenant';
import { createTestDatabase, MIGRATIONS_DIR, type TestDatabase } from '../database/test-database';
import { createOrganization, withPlatform } from '../platform/platform';
import {
  type AuthDeps,
  completeLink,
  describeLink,
  describeUser,
  getSession,
  issueLink,
  login,
  logout,
  selectOrganization,
  startLink,
  verifySecondFactor,
} from './auth.service';
import { deriveKeys, hashToken, randomToken } from './crypto';
import { currentTotpCode } from './totp';

const PASSWORD = 'labai ilgas ir saugus slaptažodis';

describe('authentication', () => {
  let db: TestDatabase;
  let deps: AuthDeps;
  let platformAdmin: { userId: string; secret: string };

  /** Activates an account through a link the way the browser flow does. */
  async function activate(token: string, password = PASSWORD) {
    const { secret } = await startLink(deps, token);
    const { recoveryCodes } = await completeLink(deps, {
      token,
      password,
      totpCode: currentTotpCode(secret),
    });
    return { secret, recoveryCodes };
  }

  /**
   * Each TOTP code works once, so several sign-ins of one user within the same 30 s would be
   * refused. Tests simulate time passing by clearing the last used step.
   */
  async function nextTotpWindow(email: string) {
    await db.superuser.query(
      'UPDATE user_credentials SET totp_last_step = 0 WHERE user_id = (SELECT id FROM users WHERE email = lower(btrim($1)))',
      [email],
    );
  }

  async function signIn(email: string, secret: string) {
    await nextTotpWindow(email);
    const { pendingToken } = await login(deps, { email, password: PASSWORD });
    const code = currentTotpCode(secret);
    const { sessionToken } = await verifySecondFactor(deps, pendingToken, { code });
    return sessionToken;
  }

  async function newOrganization(planCode: 'INDIVIDUAL' | 'AGENCY', email: string) {
    const org = await withPlatform(deps.pool, platformAdmin.userId, (c) =>
      createOrganization(c, {
        name: `Org ${email}`,
        planCode,
        adminEmail: email,
        adminFullName: email,
      }),
    );
    const { token } = await issueLink(
      deps,
      { userId: platformAdmin.userId, activeOrganizationId: null },
      { userId: org.adminUserId, organizationId: org.organizationId, purpose: 'INVITE' },
    );
    return { ...org, token };
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.owner, MIGRATIONS_DIR);
    deps = { pool: db.appPool({ max: 5 }), keys: deriveKeys(randomBytes(32).toString('base64')) };

    // Bootstrap exactly like the seed script: invited platform admin + activation link.
    const { rows } = await db.superuser.query<{ id: string }>(
      "INSERT INTO users (email, full_name) VALUES ('admin@skydra.eu', 'Admin') RETURNING id",
    );
    const userId = rows[0]!.id;
    await db.superuser.query('INSERT INTO platform_admins (user_id) VALUES ($1)', [userId]);
    const token = randomToken();
    await db.superuser.query(
      "INSERT INTO auth_links (token_hash, user_id, purpose, expires_at) VALUES ($1, $2, 'INVITE', now() + interval '1 hour')",
      [hashToken(token), userId],
    );
    const { secret } = await activate(token);
    platformAdmin = { userId, secret };
  });

  afterAll(async () => {
    await db?.drop();
  });

  describe('activation link', () => {
    it('activates the account, stores only hashes and encrypted secrets', async () => {
      const org = await newOrganization('INDIVIDUAL', 'solo@example.lt');
      expect(await describeLink(deps, org.token)).toEqual({
        purpose: 'INVITE',
        email: 'solo@example.lt',
        fullName: 'solo@example.lt',
      });
      const { secret, recoveryCodes } = await activate(org.token);
      expect(recoveryCodes).toHaveLength(10);

      const { rows } = await db.superuser.query(
        `SELECT u.status, c.password_hash, c.totp_secret_encrypted,
                (SELECT count(*)::int FROM recovery_codes r WHERE r.user_id = u.id) AS codes
           FROM users u JOIN user_credentials c ON c.user_id = u.id WHERE u.id = $1`,
        [org.adminUserId],
      );
      const r = rows[0];
      expect(r.status).toBe('ACTIVE');
      expect(r.password_hash).toMatch(/^\$argon2id\$/);
      expect(r.totp_secret_encrypted).not.toContain(secret);
      expect(r.codes).toBe(10);
    });

    it('can be used only once', async () => {
      const org = await newOrganization('AGENCY', 'once@example.lt');
      await activate(org.token);
      await expect(describeLink(deps, org.token)).rejects.toThrow('invalid_link');
      await expect(startLink(deps, org.token)).rejects.toThrow('invalid_link');
    });

    it('expires', async () => {
      const org = await newOrganization('AGENCY', 'expired@example.lt');
      await db.superuser.query(
        "UPDATE auth_links SET expires_at = now() - interval '1 second' WHERE token_hash = $1",
        [hashToken(org.token)],
      );
      await expect(startLink(deps, org.token)).rejects.toThrow('invalid_link');
    });

    it('is revoked when a newer link is issued for the same purpose', async () => {
      const org = await newOrganization('AGENCY', 'reissue@example.lt');
      await issueLink(
        deps,
        { userId: platformAdmin.userId, activeOrganizationId: null },
        { userId: org.adminUserId, organizationId: org.organizationId, purpose: 'INVITE' },
      );
      await expect(describeLink(deps, org.token)).rejects.toThrow('invalid_link');
    });

    it('requires a valid TOTP code from the proposed secret and a strong password', async () => {
      const org = await newOrganization('AGENCY', 'weak@example.lt');
      const { secret } = await startLink(deps, org.token);
      await expect(
        completeLink(deps, { token: org.token, password: PASSWORD, totpCode: '000000' }),
      ).rejects.toThrow('invalid_code');
      await expect(
        completeLink(deps, {
          token: org.token,
          password: 'trumpas',
          totpCode: currentTotpCode(secret),
        }),
      ).rejects.toThrow(/12 simbolių/);
    });
  });

  describe('sign-in', () => {
    let solo: {
      organizationId: string;
      adminUserId: string;
      secret: string;
      recoveryCodes: string[];
    };

    beforeAll(async () => {
      const org = await newOrganization('INDIVIDUAL', 'login@example.lt');
      solo = { ...org, ...(await activate(org.token)) };
    });

    it('requires both factors and then resolves an active session', async () => {
      const token = await signIn('LOGIN@example.lt ', solo.secret);
      const session = await getSession(deps, token);
      expect(session).toMatchObject({ userId: solo.adminUserId, mfaVerified: true });
    });

    it('gives the same answer for an unknown e-mail and a wrong password', async () => {
      await expect(login(deps, { email: 'nera@example.lt', password: PASSWORD })).rejects.toThrow(
        'invalid_credentials',
      );
      await expect(
        login(deps, { email: 'login@example.lt', password: 'neteisingas slaptažodis' }),
      ).rejects.toThrow('invalid_credentials');
    });

    it('does not let a password-only session in', async () => {
      const { pendingToken } = await login(deps, { email: 'login@example.lt', password: PASSWORD });
      expect(await getSession(deps, pendingToken)).toMatchObject({ mfaVerified: false });
    });

    it('replaces the session token after the second factor (no session fixation)', async () => {
      await nextTotpWindow('login@example.lt');
      const { pendingToken } = await login(deps, { email: 'login@example.lt', password: PASSWORD });
      const { sessionToken } = await verifySecondFactor(deps, pendingToken, {
        code: currentTotpCode(solo.secret),
      });
      expect(sessionToken).not.toBe(pendingToken);
      expect(await getSession(deps, pendingToken)).toBeNull();
    });

    it('rejects a TOTP code that was already used', async () => {
      await nextTotpWindow('login@example.lt');
      const code = currentTotpCode(solo.secret);
      const first = await login(deps, { email: 'login@example.lt', password: PASSWORD });
      await verifySecondFactor(deps, first.pendingToken, { code });
      const second = await login(deps, { email: 'login@example.lt', password: PASSWORD });
      await expect(verifySecondFactor(deps, second.pendingToken, { code })).rejects.toThrow(
        'invalid_code',
      );
    });

    it('accepts each recovery code exactly once', async () => {
      const recoveryCode = solo.recoveryCodes[0]!.toLowerCase();
      const first = await login(deps, { email: 'login@example.lt', password: PASSWORD });
      await verifySecondFactor(deps, first.pendingToken, { recoveryCode });
      const second = await login(deps, { email: 'login@example.lt', password: PASSWORD });
      await expect(verifySecondFactor(deps, second.pendingToken, { recoveryCode })).rejects.toThrow(
        'invalid_code',
      );
    });

    it('locks the account after 5 failures, even for the right password', async () => {
      const org = await newOrganization('AGENCY', 'lock@example.lt');
      const { secret } = await activate(org.token);
      for (let i = 0; i < 5; i++) {
        await expect(
          login(deps, { email: 'lock@example.lt', password: 'neteisingas slaptažodis' }),
        ).rejects.toThrow('invalid_credentials');
      }
      await expect(login(deps, { email: 'lock@example.lt', password: PASSWORD })).rejects.toThrow(
        'invalid_credentials',
      );
      await db.superuser.query(
        "UPDATE user_credentials SET locked_until = now() - interval '1 second' WHERE user_id = $1",
        [org.adminUserId],
      );
      expect(await signIn('lock@example.lt', secret)).toBeTruthy();
    });

    it('counts wrong second-factor codes towards the lockout', async () => {
      const org = await newOrganization('AGENCY', 'mfalock@example.lt');
      await activate(org.token);
      for (let i = 0; i < 5; i++) {
        const { pendingToken } = await login(deps, {
          email: 'mfalock@example.lt',
          password: PASSWORD,
        });
        await expect(verifySecondFactor(deps, pendingToken, { code: '123456' })).rejects.toThrow(
          'invalid_code',
        );
      }
      await expect(
        login(deps, { email: 'mfalock@example.lt', password: PASSWORD }),
      ).rejects.toThrow('invalid_credentials');
    });

    it('ends sessions on logout, after idle time and when the user is disabled', async () => {
      const a = await signIn('login@example.lt', solo.secret);
      await logout(deps, a);
      expect(await getSession(deps, a)).toBeNull();

      const b = await signIn('login@example.lt', solo.secret);
      await db.superuser.query(
        "UPDATE sessions SET last_seen_at = now() - interval '31 minutes' WHERE id = $1",
        [hashToken(b)],
      );
      expect(await getSession(deps, b)).toBeNull();

      const c = await signIn('login@example.lt', solo.secret);
      await db.superuser.query("UPDATE users SET status = 'DISABLED' WHERE id = $1", [
        solo.adminUserId,
      ]);
      expect(await getSession(deps, c)).toBeNull();
      await db.superuser.query("UPDATE users SET status = 'ACTIVE' WHERE id = $1", [
        solo.adminUserId,
      ]);
    });

    it('lets a member choose only their own organizations, then acts within it', async () => {
      const token = await signIn('login@example.lt', solo.secret);
      const session = (await getSession(deps, token))!;
      const me = await describeUser(deps, session.userId);
      expect(me.memberships.map((m) => m.organizationId)).toEqual([solo.organizationId]);

      const other = await newOrganization('AGENCY', 'other-org@example.lt');
      await expect(selectOrganization(deps, session, other.organizationId)).rejects.toThrow(
        'forbidden',
      );

      await selectOrganization(deps, session, solo.organizationId);
      const active = (await getSession(deps, token))!;
      const principal = await withTenant(
        deps.pool,
        { organizationId: active.activeOrganizationId!, userId: active.userId },
        loadPrincipal,
      );
      expect(principal && [...principal.roles]).toEqual(['ORG_ADMIN', 'BROKER']);
    });
  });

  describe('who may issue links', () => {
    it('lets an organization admin reset passwords of its own single-organization members', async () => {
      const org = await newOrganization('AGENCY', 'boss@example.lt');
      await activate(org.token);
      // A broker added directly to this organization (member management comes in a later PR).
      const { rows } = await db.superuser.query<{ id: string }>(
        "INSERT INTO users (email, full_name, status) VALUES ('broker@example.lt', 'Broker', 'ACTIVE') RETURNING id",
      );
      const broker = rows[0]!.id;
      await db.superuser.query(
        "INSERT INTO memberships (organization_id, user_id, roles) VALUES ($1, $2, '{BROKER}')",
        [org.organizationId, broker],
      );
      const { token } = await issueLink(
        deps,
        { userId: org.adminUserId, activeOrganizationId: org.organizationId },
        { userId: broker, organizationId: org.organizationId, purpose: 'PASSWORD_RESET' },
      );
      expect(await describeLink(deps, token)).toMatchObject({ purpose: 'PASSWORD_RESET' });

      const { rows: audit } = await db.superuser.query(
        "SELECT actor_user_id FROM audit_events WHERE organization_id = $1 AND action = 'auth.password_reset_issued'",
        [org.organizationId],
      );
      expect(audit).toEqual([{ actor_user_id: org.adminUserId }]);
    });

    it('refuses an organization admin resetting a user who also belongs to another organization', async () => {
      const a = await newOrganization('AGENCY', 'admin-a@example.lt');
      await activate(a.token);
      const b = await newOrganization('AGENCY', 'admin-b@example.lt');
      await activate(b.token);
      // admin-b also becomes a member of organization A.
      await db.superuser.query(
        "INSERT INTO memberships (organization_id, user_id, roles) VALUES ($1, $2, '{BROKER}')",
        [a.organizationId, b.adminUserId],
      );
      await expect(
        issueLink(
          deps,
          { userId: a.adminUserId, activeOrganizationId: a.organizationId },
          { userId: b.adminUserId, organizationId: a.organizationId, purpose: 'PASSWORD_RESET' },
        ),
      ).rejects.toThrow(/belongs to another organization/);

      // A platform admin can still help.
      await expect(
        issueLink(
          deps,
          { userId: platformAdmin.userId, activeOrganizationId: null },
          { userId: b.adminUserId, organizationId: a.organizationId, purpose: 'PASSWORD_RESET' },
        ),
      ).resolves.toBeTruthy();
    });

    it('refuses links for other organizations, for platform admins, and invites for active users', async () => {
      const a = await newOrganization('AGENCY', 'rules-a@example.lt');
      await activate(a.token);
      const b = await newOrganization('AGENCY', 'rules-b@example.lt');
      const actor = { userId: a.adminUserId, activeOrganizationId: a.organizationId };

      await expect(
        issueLink(deps, actor, {
          userId: b.adminUserId,
          organizationId: b.organizationId,
          purpose: 'INVITE',
        }),
      ).rejects.toMatchObject({ code: 'forbidden' });

      await db.superuser.query(
        "INSERT INTO memberships (organization_id, user_id, roles) VALUES ($1, $2, '{BROKER}')",
        [a.organizationId, platformAdmin.userId],
      );
      await expect(
        issueLink(deps, actor, {
          userId: platformAdmin.userId,
          organizationId: a.organizationId,
          purpose: 'PASSWORD_RESET',
        }),
      ).rejects.toMatchObject({ code: 'forbidden' });

      await expect(
        issueLink(deps, actor, {
          userId: a.adminUserId,
          organizationId: a.organizationId,
          purpose: 'INVITE',
        }),
      ).rejects.toThrow(/already activated/);
    });

    it('refuses anyone who is neither an organization admin nor a platform admin', async () => {
      const org = await newOrganization('AGENCY', 'plain@example.lt');
      await expect(
        issueLink(
          deps,
          { userId: org.adminUserId, activeOrganizationId: null },
          { userId: org.adminUserId, organizationId: org.organizationId, purpose: 'INVITE' },
        ),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });
  });

  it('a completed reset signs the user out everywhere', async () => {
    const org = await newOrganization('INDIVIDUAL', 'reset@example.lt');
    const { secret } = await activate(org.token);
    const before = await signIn('reset@example.lt', secret);
    const { token } = await issueLink(
      deps,
      { userId: platformAdmin.userId, activeOrganizationId: null },
      { userId: org.adminUserId, organizationId: org.organizationId, purpose: 'PASSWORD_RESET' },
    );
    await activate(token);
    expect(await getSession(deps, before)).toBeNull();
  });

  it('the runtime role cannot read links or delete credentials and sessions', async () => {
    for (const sql of [
      'SELECT * FROM auth_links',
      'DELETE FROM user_credentials',
      'DELETE FROM sessions',
    ]) {
      await expect(deps.pool.query(sql)).rejects.toThrow(/permission denied/);
    }
  });
});
