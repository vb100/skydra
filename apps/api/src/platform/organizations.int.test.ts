import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadPrincipal } from '../access/principal';
import { verifyAuditChain } from '../audit/audit';
import { migrate } from '../database/migrator';
import { withTenant } from '../database/tenant';
import { createTestDatabase, MIGRATIONS_DIR, type TestDatabase } from '../database/test-database';
import { createOrganization, withPlatform } from './platform';

describe('organizations, members and platform administration', () => {
  let db: TestDatabase;
  let app: Pool;
  let platformAdmin: string;

  async function activate(userId: string) {
    await db.superuser.query("UPDATE users SET status = 'ACTIVE' WHERE id = $1", [userId]);
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.owner, MIGRATIONS_DIR);
    const { rows } = await db.superuser.query<{ id: string }>(
      "INSERT INTO users (email, full_name, status) VALUES ('admin@skydra.eu', 'Platform Admin', 'ACTIVE') RETURNING id",
    );
    platformAdmin = rows[0]!.id;
    await db.superuser.query('INSERT INTO platform_admins (user_id) VALUES ($1)', [platformAdmin]);
    app = db.appPool();
  });

  afterAll(async () => {
    await db?.drop();
  });

  describe('creating organizations', () => {
    it('is refused for anyone who is not a platform admin', async () => {
      await expect(
        withPlatform(app, randomUUID(), (c) =>
          createOrganization(c, {
            name: 'X',
            planCode: 'AGENCY',
            adminEmail: 'x@x.lt',
            adminFullName: 'X',
          }),
        ),
      ).rejects.toThrow(/platform administrator privileges required/);
    });

    it('creates a solo broker organization with the full set of duties and an audit trail', async () => {
      const { organizationId, adminUserId } = await withPlatform(app, platformAdmin, (c) =>
        createOrganization(c, {
          name: 'Brokerė Rūta',
          planCode: 'INDIVIDUAL',
          adminEmail: '  Ruta@Example.LT ',
          adminFullName: 'Rūta Brokerė',
        }),
      );

      const { rows: members } = await db.superuser.query(
        'SELECT roles, permissions, status FROM memberships WHERE organization_id = $1',
        [organizationId],
      );
      expect(members).toEqual([
        {
          roles: ['ORG_ADMIN', 'BROKER'],
          permissions: ['AML_OFFICER', 'APPROVER'],
          status: 'ACTIVE',
        },
      ]);

      const { rows: users } = await db.superuser.query(
        'SELECT email, status FROM users WHERE id = $1',
        [adminUserId],
      );
      expect(users).toEqual([{ email: 'ruta@example.lt', status: 'INVITED' }]);

      const { rows: events } = await db.superuser.query(
        'SELECT action, actor_user_id FROM audit_events WHERE organization_id = $1 ORDER BY seq',
        [organizationId],
      );
      expect(events).toEqual([
        { action: 'organization.created', actor_user_id: platformAdmin },
        { action: 'membership.created', actor_user_id: platformAdmin },
      ]);

      const chain = await withTenant(
        app,
        { organizationId, userId: adminUserId },
        verifyAuditChain,
      );
      expect(chain).toMatchObject({ valid: true, checked: 2 });
    });

    it('gives an agency administrator administration only', async () => {
      const { organizationId } = await withPlatform(app, platformAdmin, (c) =>
        createOrganization(c, {
          name: 'Agentūra A',
          planCode: 'AGENCY',
          adminEmail: 'vadove@agentura.lt',
          adminFullName: 'Vadovė',
        }),
      );
      const { rows } = await db.superuser.query(
        'SELECT roles, permissions FROM memberships WHERE organization_id = $1',
        [organizationId],
      );
      expect(rows).toEqual([{ roles: ['ORG_ADMIN'], permissions: [] }]);
    });

    it('reuses an existing user, who then belongs to two organizations', async () => {
      const first = await withPlatform(app, platformAdmin, (c) =>
        createOrganization(c, {
          name: 'Pirma',
          planCode: 'AGENCY',
          adminEmail: 'dvigubas@example.lt',
          adminFullName: 'Dvigubas',
        }),
      );
      const second = await withPlatform(app, platformAdmin, (c) =>
        createOrganization(c, {
          name: 'Antra',
          planCode: 'AGENCY_PRO',
          adminEmail: 'DVIGUBAS@example.lt',
          adminFullName: 'Dvigubas',
        }),
      );
      expect(second.adminUserId).toBe(first.adminUserId);
    });

    it('rejects invalid input before reaching the database', async () => {
      await expect(
        withPlatform(app, platformAdmin, (c) =>
          createOrganization(c, {
            name: ' ',
            planCode: 'GOLD' as 'AGENCY',
            adminEmail: 'not-an-email',
            adminFullName: '',
          }),
        ),
      ).rejects.toThrow();
    });

    it('leaves no organization context behind for the rest of the transaction', async () => {
      const context = await withPlatform(app, platformAdmin, async (c) => {
        await createOrganization(c, {
          name: 'Kontekstas',
          planCode: 'AGENCY',
          adminEmail: 'ctx@example.lt',
          adminFullName: 'Ctx',
        });
        const { rows } = await c.query<{ org: string | null }>(
          'SELECT app.current_organization_id() AS org',
        );
        return rows[0]?.org;
      });
      expect(context).toBeNull();
    });
  });

  describe('visibility', () => {
    it('lets a platform admin list organizations but not read their members or audit', async () => {
      const seen = await withPlatform(app, platformAdmin, async (c) => {
        const orgs = await c.query('SELECT id FROM organizations');
        const members = await c.query('SELECT id FROM memberships');
        const audit = await c.query('SELECT id FROM audit_events');
        return [orgs.rowCount, members.rowCount, audit.rowCount];
      });
      expect(seen[0]).toBeGreaterThan(0);
      expect(seen.slice(1)).toEqual([0, 0]);
    });

    it('shows a member only the users of their own organization', async () => {
      const a = await withPlatform(app, platformAdmin, (c) =>
        createOrganization(c, {
          name: 'Matomumas A',
          planCode: 'AGENCY',
          adminEmail: 'a@vis.lt',
          adminFullName: 'A',
        }),
      );
      await withPlatform(app, platformAdmin, (c) =>
        createOrganization(c, {
          name: 'Matomumas B',
          planCode: 'AGENCY',
          adminEmail: 'b@vis.lt',
          adminFullName: 'B',
        }),
      );
      const emails = await withTenant(
        app,
        { organizationId: a.organizationId, userId: a.adminUserId },
        async (c) => {
          const { rows } = await c.query<{ email: string }>(
            'SELECT email FROM users ORDER BY email',
          );
          return rows.map((r) => r.email);
        },
      );
      expect(emails).toEqual(['a@vis.lt']);
    });
  });

  describe('what the runtime role cannot do', () => {
    let org: { organizationId: string; adminUserId: string };
    const ctx = () => ({ organizationId: org.organizationId, userId: org.adminUserId });

    beforeAll(async () => {
      org = await withPlatform(app, platformAdmin, (c) =>
        createOrganization(c, {
          name: 'Ribos',
          planCode: 'INDIVIDUAL',
          adminEmail: 'ribos@example.lt',
          adminFullName: 'Ribos',
        }),
      );
    });

    it('may rename its organization but not change plan, status or entitlements', async () => {
      await withTenant(app, ctx(), (c) => c.query("UPDATE organizations SET name = 'Ribos UAB'"));
      for (const sql of [
        "UPDATE organizations SET plan_code = 'AGENCY_PRO'",
        "UPDATE organizations SET status = 'ACTIVE'",
        `UPDATE organizations SET entitlement_overrides = '{"maxUsers": 99}'`,
      ]) {
        await expect(withTenant(app, ctx(), (c) => c.query(sql))).rejects.toThrow(
          /permission denied/,
        );
      }
    });

    it('cannot create organizations or users, delete members, or see platform admins', async () => {
      for (const sql of [
        "INSERT INTO organizations (name) VALUES ('Nauja')",
        "INSERT INTO users (email, full_name) VALUES ('n@n.lt', 'N')",
        'DELETE FROM memberships',
        'SELECT * FROM platform_admins',
        "UPDATE plans SET limits = '{}'",
      ]) {
        await expect(withTenant(app, ctx(), (c) => c.query(sql))).rejects.toThrow(
          /permission denied/,
        );
      }
    });

    it('cannot change another user, only its own name', async () => {
      await withTenant(app, ctx(), (c) => c.query("UPDATE users SET full_name = 'Naujas vardas'"));
      await expect(
        withTenant(app, ctx(), (c) => c.query("UPDATE users SET email = 'kitas@example.lt'")),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe('loading the acting member', () => {
    it('returns roles, permissions and plan entitlements of an active member', async () => {
      const org = await withPlatform(app, platformAdmin, (c) =>
        createOrganization(c, {
          name: 'Principal',
          planCode: 'INDIVIDUAL',
          adminEmail: 'principal@example.lt',
          adminFullName: 'P',
        }),
      );
      const ctx = { organizationId: org.organizationId, userId: org.adminUserId };

      // Invited users have not activated their account yet.
      expect(await withTenant(app, ctx, loadPrincipal)).toBeNull();

      await activate(org.adminUserId);
      const p = await withTenant(app, ctx, loadPrincipal);
      expect(p && [...p.roles]).toEqual(['ORG_ADMIN', 'BROKER']);
      expect(p?.entitlements).toMatchObject({ plan: 'INDIVIDUAL', maxUsers: 1 });

      await db.superuser.query("UPDATE organizations SET status = 'SUSPENDED' WHERE id = $1", [
        org.organizationId,
      ]);
      expect(await withTenant(app, ctx, loadPrincipal)).toBeNull();
    });

    it('returns null for a user who is not a member of the organization', async () => {
      const org = await withPlatform(app, platformAdmin, (c) =>
        createOrganization(c, {
          name: 'Svetima',
          planCode: 'AGENCY',
          adminEmail: 'svetima@example.lt',
          adminFullName: 'S',
        }),
      );
      expect(
        await withTenant(
          app,
          { organizationId: org.organizationId, userId: platformAdmin },
          loadPrincipal,
        ),
      ).toBeNull();
    });
  });
});
