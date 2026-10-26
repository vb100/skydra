import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from './migrator';
import { withTenant } from './tenant';
import { createTestDatabase, MIGRATIONS_DIR, type TestDatabase } from './test-database';

describe('tenant isolation (row-level security)', () => {
  let db: TestDatabase;
  let app: Pool;
  const orgA = randomUUID();
  const orgB = randomUUID();
  const user = randomUUID();

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.owner, MIGRATIONS_DIR);
    await db.owner.query(
      "INSERT INTO organizations (id, name) VALUES ($1, 'Agentūra A'), ($2, 'Agentūra B')",
      [orgA, orgB],
    );
    app = db.appPool();
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('connects as the runtime role, not as the owner', async () => {
    const { rows } = await app.query<{ current_user: string }>('SELECT current_user');
    expect(rows[0]?.current_user).toBe('skydra_app');
  });

  it('returns nothing when no organization context is set (fails closed)', async () => {
    const { rowCount } = await app.query('SELECT * FROM organizations');
    expect(rowCount).toBe(0);
  });

  it('shows only the organization of the current context', async () => {
    const ids = await withTenant(app, { organizationId: orgA, userId: user }, async (c) => {
      const { rows } = await c.query<{ id: string }>('SELECT id FROM organizations');
      return rows.map((r) => r.id);
    });
    expect(ids).toEqual([orgA]);
  });

  it('cannot read another organization even when asking for it explicitly', async () => {
    const count = await withTenant(app, { organizationId: orgA, userId: user }, async (c) => {
      const { rowCount } = await c.query('SELECT * FROM organizations WHERE id = $1', [orgB]);
      return rowCount;
    });
    expect(count).toBe(0);
  });

  it('rejects writing a row that belongs to another organization', async () => {
    await expect(
      withTenant(app, { organizationId: orgA, userId: user }, (c) =>
        c.query("INSERT INTO organizations (id, name) VALUES ($1, 'Svetima')", [randomUUID()]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('rejects moving a row out of the current organization', async () => {
    await expect(
      withTenant(app, { organizationId: orgA, userId: user }, (c) =>
        c.query('UPDATE organizations SET id = $1 WHERE id = $2', [randomUUID(), orgA]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('does not leak the context to the next transaction on the same connection', async () => {
    const single = db.appPool({ max: 1 });
    await withTenant(single, { organizationId: orgA, userId: user }, (c) => c.query('SELECT 1'));
    const { rowCount } = await single.query('SELECT * FROM organizations');
    expect(rowCount).toBe(0);
  });

  it('rolls back the whole transaction when the work fails', async () => {
    await expect(
      withTenant(app, { organizationId: orgA, userId: user }, async (c) => {
        await c.query("UPDATE organizations SET name = 'Pakeista' WHERE id = $1", [orgA]);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const { rows } = await db.owner.query<{ name: string }>(
      'SELECT name FROM organizations WHERE id = $1',
      [orgA],
    );
    expect(rows[0]?.name).toBe('Agentūra A');
  });

  it('cannot disable row-level security or change the schema', async () => {
    await expect(app.query('ALTER TABLE organizations DISABLE ROW LEVEL SECURITY')).rejects.toThrow(
      /must be owner/,
    );
    await expect(app.query('DROP TABLE organizations')).rejects.toThrow(/must be owner/);
  });

  it('refuses a malformed organization id before touching the database', async () => {
    await expect(
      withTenant(app, { organizationId: "x' OR 1=1 --", userId: user }, (c) => c.query('SELECT 1')),
    ).rejects.toThrow();
  });
});
