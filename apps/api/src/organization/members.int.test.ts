import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadPrincipal } from '../access/principal';
import { migrate } from '../database/migrator';
import { withTenant } from '../database/tenant';
import { createTestDatabase, MIGRATIONS_DIR, type TestDatabase } from '../database/test-database';
import { createOrganization, withPlatform } from '../platform/platform';
import { addMember, listMembers, updateMember } from './members';

describe('member management', () => {
  let db: TestDatabase;
  let app: Pool;
  let platformAdmin: string;

  async function organization(planCode: 'INDIVIDUAL' | 'AGENCY', email: string) {
    const org = await withPlatform(app, platformAdmin, (c) =>
      createOrganization(c, { name: email, planCode, adminEmail: email, adminFullName: 'Admin' }),
    );
    await db.superuser.query("UPDATE users SET status = 'ACTIVE' WHERE id = $1", [org.adminUserId]);
    return { ...org, ctx: { organizationId: org.organizationId, userId: org.adminUserId } };
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
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('adds a new person as an invited member and records it', async () => {
    const org = await organization('AGENCY', 'a1@agency.lt');
    const added = await withTenant(app, org.ctx, (c) =>
      addMember(c, {
        email: ' Broker@Agency.LT ',
        fullName: 'Brokeris',
        roles: ['BROKER'],
        permissions: ['APPROVER'],
      }),
    );
    expect(added.needsInvite).toBe(true);

    const members = await withTenant(app, org.ctx, listMembers);
    expect(members.map((m) => [m.email, m.userStatus, m.roles])).toEqual([
      ['a1@agency.lt', 'ACTIVE', ['ORG_ADMIN']],
      ['broker@agency.lt', 'INVITED', ['BROKER']],
    ]);

    const { rows } = await db.superuser.query(
      "SELECT actor_user_id FROM audit_events WHERE organization_id = $1 AND action = 'membership.created' AND entity_id = $2",
      [org.organizationId, added.userId],
    );
    expect(rows).toEqual([{ actor_user_id: org.adminUserId }]);
  });

  it('adds an existing user without an invitation (they already have credentials)', async () => {
    const other = await organization('AGENCY', 'existing@other.lt');
    const org = await organization('AGENCY', 'a2@agency.lt');
    const added = await withTenant(app, org.ctx, (c) =>
      addMember(c, { email: 'existing@other.lt', fullName: 'X', roles: ['MANAGER'] }),
    );
    expect(added).toEqual({ userId: other.adminUserId, needsInvite: false });
  });

  it('refuses duplicates', async () => {
    const org = await organization('AGENCY', 'a3@agency.lt');
    await expect(
      withTenant(app, org.ctx, (c) =>
        addMember(c, { email: 'a3@agency.lt', fullName: 'X', roles: ['BROKER'] }),
      ),
    ).rejects.toThrow(/already a member/);
  });

  it('enforces the seat limit of the plan, with per-organization overrides', async () => {
    const solo = await organization('INDIVIDUAL', 'solo@seat.lt');
    const add = () =>
      withTenant(app, solo.ctx, (c) =>
        addMember(c, { email: 'second@seat.lt', fullName: 'X', roles: ['BROKER'] }),
      );
    await expect(add()).rejects.toThrow(/allows 1 active member/);

    await db.superuser.query(
      `UPDATE organizations SET entitlement_overrides = '{"maxUsers": 2}' WHERE id = $1`,
      [solo.organizationId],
    );
    await expect(add()).resolves.toMatchObject({ needsInvite: true });
  });

  it('applies the seat limit when re-enabling a member', async () => {
    const solo = await organization('INDIVIDUAL', 'reenable@seat.lt');
    await db.superuser.query(
      `UPDATE organizations SET entitlement_overrides = '{"maxUsers": 2}' WHERE id = $1`,
      [solo.organizationId],
    );
    const b = await withTenant(app, solo.ctx, (c) =>
      addMember(c, { email: 'b@seat.lt', fullName: 'B', roles: ['BROKER'] }),
    );
    await withTenant(app, solo.ctx, (c) => updateMember(c, b.userId, { status: 'DISABLED' }));
    await withTenant(app, solo.ctx, (c) =>
      addMember(c, { email: 'c@seat.lt', fullName: 'C', roles: ['BROKER'] }),
    );
    await expect(
      withTenant(app, solo.ctx, (c) => updateMember(c, b.userId, { status: 'ACTIVE' })),
    ).rejects.toThrow(/allows 2 active member/);
  });

  it('always keeps at least one active administrator', async () => {
    const org = await organization('AGENCY', 'last@admin.lt');
    await expect(
      withTenant(app, org.ctx, (c) => updateMember(c, org.adminUserId, { status: 'DISABLED' })),
    ).rejects.toThrow(/at least one active administrator/);
    await expect(
      withTenant(app, org.ctx, (c) => updateMember(c, org.adminUserId, { roles: ['BROKER'] })),
    ).rejects.toThrow(/at least one active administrator/);

    // With a second administrator the first one may step down.
    const second = await withTenant(app, org.ctx, (c) =>
      addMember(c, { email: 'second@admin.lt', fullName: 'S', roles: ['ORG_ADMIN'] }),
    );
    expect(second.needsInvite).toBe(true);
    await withTenant(app, org.ctx, (c) =>
      updateMember(c, org.adminUserId, { roles: ['BROKER', 'MANAGER'] }),
    );
  });

  it('records role and status changes with before and after values', async () => {
    const org = await organization('AGENCY', 'audit@roles.lt');
    const b = await withTenant(app, org.ctx, (c) =>
      addMember(c, { email: 'b@roles.lt', fullName: 'B', roles: ['BROKER'] }),
    );
    await withTenant(app, org.ctx, (c) =>
      updateMember(c, b.userId, { roles: ['BROKER', 'MANAGER'], permissions: ['CASE_VIEW_ALL'] }),
    );
    const { rows } = await db.superuser.query(
      "SELECT before, after FROM audit_events WHERE organization_id = $1 AND action = 'membership.updated'",
      [org.organizationId],
    );
    expect(rows).toEqual([
      {
        before: { roles: ['BROKER'], permissions: [], status: 'ACTIVE' },
        after: { roles: ['BROKER', 'MANAGER'], permissions: ['CASE_VIEW_ALL'], status: 'ACTIVE' },
      },
    ]);
  });

  it('a disabled member loses access to that organization immediately', async () => {
    const org = await organization('AGENCY', 'disable@me.lt');
    const b = await withTenant(app, org.ctx, (c) =>
      addMember(c, { email: 'gone@me.lt', fullName: 'G', roles: ['BROKER'] }),
    );
    await db.superuser.query("UPDATE users SET status = 'ACTIVE' WHERE id = $1", [b.userId]);
    const asB = { organizationId: org.organizationId, userId: b.userId };
    expect(await withTenant(app, asB, loadPrincipal)).not.toBeNull();
    await withTenant(app, org.ctx, (c) => updateMember(c, b.userId, { status: 'DISABLED' }));
    expect(await withTenant(app, asB, loadPrincipal)).toBeNull();
  });

  describe('enforced in the database, even if the API check were bypassed', () => {
    let org: Awaited<ReturnType<typeof organization>>;
    let broker: string;

    beforeAll(async () => {
      org = await organization('AGENCY', 'db@rules.lt');
      broker = (
        await withTenant(app, org.ctx, (c) =>
          addMember(c, { email: 'broker@rules.lt', fullName: 'B', roles: ['BROKER'] }),
        )
      ).userId;
      await db.superuser.query("UPDATE users SET status = 'ACTIVE' WHERE id = $1", [broker]);
    });

    it('a broker cannot add members or change anyone, including promoting themselves', async () => {
      const asBroker = { organizationId: org.organizationId, userId: broker };
      await expect(
        withTenant(app, asBroker, (c) =>
          addMember(c, { email: 'x@rules.lt', fullName: 'X', roles: ['ORG_ADMIN'] }),
        ),
      ).rejects.toThrow(/only an organization administrator/);
      await expect(
        withTenant(app, asBroker, (c) =>
          c.query("UPDATE memberships SET roles = '{ORG_ADMIN}' WHERE user_id = $1", [broker]),
        ),
      ).rejects.toThrow(/only an organization administrator/);
    });

    it('no one can insert memberships directly or move one to another user', async () => {
      await expect(
        withTenant(app, org.ctx, (c) =>
          c.query("INSERT INTO memberships (user_id, roles) VALUES ($1, '{BROKER}')", [broker]),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        withTenant(app, org.ctx, (c) =>
          c.query('UPDATE memberships SET user_id = $1 WHERE user_id = $2', [
            platformAdmin,
            broker,
          ]),
        ),
      ).rejects.toThrow(/cannot be moved/);
    });
  });
});
