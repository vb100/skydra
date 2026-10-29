import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveKeys } from '../auth/crypto';
import { LOCAL_DEVELOPMENT_KEY } from '../config/env';
import { createDemoAgency } from '../database/seed-demo';
import { migrate } from '../database/migrator';
import { type TenantContext, withTenant } from '../database/tenant';
import { createTestDatabase, MIGRATIONS_DIR, type TestDatabase } from '../database/test-database';
import { NotFoundError, RuleError } from '../domain-errors';
import { collectReport, exportCase, listExports } from './case-report';

const keys = deriveKeys(LOCAL_DEVELOPMENT_KEY);

describe('demo agency and case export', () => {
  let db: TestDatabase;
  let app: Pool;
  let organizationId: string;
  let users: Record<'manager' | 'broker' | 'officer', TenantContext>;
  let cases: Map<string, { id: string; status: string; risk: string | null }>;

  const as = <T>(ctx: TenantContext, work: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(app, ctx, work);

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.owner, MIGRATIONS_DIR);
    app = db.appPool({ max: 3 });
    const result = await createDemoAgency(db.owner, app, keys, 'Demo NT agentūra');
    expect(result).toMatchObject({ created: true, cases: 9 });
    organizationId = result.organizationId;

    const { rows } = await db.superuser.query<{ id: string; email: string }>(
      'SELECT id, email FROM users',
    );
    const id = (email: string) => ({
      organizationId,
      userId: rows.find((r) => r.email === email)!.id,
    });
    users = {
      manager: id('vadove@demo.skydra.eu'),
      broker: id('brokeris@demo.skydra.eu'),
      officer: id('aml@demo.skydra.eu'),
    };
    const { rows: all } = await db.superuser.query<{
      reference: string;
      id: string;
      status: string;
      risk: string | null;
    }>(
      `SELECT c.reference, c.id, c.compliance_status AS status,
              (SELECT final_level FROM risk_assessments r WHERE r.case_id = c.id
                ORDER BY assessed_at DESC LIMIT 1) AS risk
         FROM cases c ORDER BY c.reference`,
    );
    cases = new Map(all.map((c) => [c.reference.slice(-4), c]));
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('seeds every demonstrated state through the normal rules, with an intact audit chain', async () => {
    expect([...cases.values()].map((c) => [c.status, c.risk])).toEqual([
      ['COMPLETED', 'LOW'],
      ['REVIEW_REQUIRED', 'HIGH'],
      ['REVIEW_REQUIRED', null],
      ['NOT_STARTED', null],
      ['IN_PROGRESS', null],
      ['IN_PROGRESS', null],
      ['COMPLETED', 'MEDIUM'],
      ['BLOCKED', null],
      ['BLOCKED', null],
    ]);
    const { rows: chain } = await withTenant(app, users.manager, (c) =>
      c.query('SELECT * FROM app.verify_audit_chain()'),
    );
    expect(chain[0]).toMatchObject({ valid: true });
    // Members have to activate their accounts; no credentials exist.
    const { rows } = await db.superuser.query(
      "SELECT count(*)::int AS n FROM users WHERE status = 'INVITED'",
    );
    expect(rows[0].n).toBe(3);
    expect((await db.superuser.query('SELECT 1 FROM user_credentials')).rowCount).toBe(0);

    // Running it again changes nothing.
    expect(await createDemoAgency(db.owner, app, keys, 'Demo NT agentūra')).toMatchObject({
      created: false,
      organizationId,
    });
    expect((await db.superuser.query('SELECT 1 FROM cases')).rowCount).toBe(9);
  });

  it('exports a completed case as a PDF registered with its SHA-256', async () => {
    const completed = cases.get('0001')!;
    const result = await as(users.broker, (c) => exportCase(c, keys, completed.id));
    expect(result.pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const sha256 = createHash('sha256').update(result.pdf).digest('hex');
    expect(result.sha256).toBe(sha256);

    const [registered] = await as(users.broker, (c) => listExports(c, completed.id));
    expect(registered).toMatchObject({
      id: result.exportId,
      sha256,
      sizeBytes: result.pdf.length,
      exportedByName: 'Tomas Brokeraitis',
    });
    const { rows } = await db.superuser.query(
      "SELECT after FROM audit_events WHERE action = 'case.exported' AND entity_id = $1",
      [completed.id],
    );
    expect(rows[0].after).toMatchObject({ exportId: result.exportId, sha256 });
  });

  it('the report shows personal and document numbers only masked', async () => {
    const data = await as(users.broker, (c) => collectReport(c, keys, cases.get('0001')!.id));
    const text = JSON.stringify(data);
    for (const secret of ['38503150101', '47807220202', 'AB1000001', 'personalCodeEncrypted'])
      expect(text).not.toContain(secret);
    expect(text).toContain('•••••••0101');
  });

  it('only a completed case can be exported, also when writing directly', async () => {
    const blocked = cases.get('0008')!;
    await expect(as(users.broker, (c) => exportCase(c, keys, blocked.id))).rejects.toBeInstanceOf(
      RuleError,
    );
    await expect(
      as(users.broker, (c) =>
        c.query(
          `INSERT INTO case_exports (case_id, format, sha256, size_bytes, compliance_status)
           VALUES ($1, 'PDF', repeat('a', 64), 1, 'COMPLETED')`,
          [blocked.id],
        ),
      ),
    ).rejects.toThrow(/complete the AML checks/);
    await expect(
      as(users.broker, (c) => c.query("UPDATE case_exports SET sha256 = repeat('b', 64)")),
    ).rejects.toThrow(/permission denied/);
  });

  it('follows case visibility', async () => {
    const other = { organizationId, userId: users.officer.userId };
    // The AML officer sees all cases; a different organization sees none.
    expect(await as(other, (c) => listExports(c, cases.get('0001')!.id))).toHaveLength(1);
    const { rows } = await db.superuser.query<{ id: string }>(
      "INSERT INTO organizations (name) VALUES ('Kita') RETURNING id",
    );
    await expect(
      as({ organizationId: rows[0]!.id, userId: users.broker.userId }, (c) =>
        listExports(c, cases.get('0001')!.id),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
