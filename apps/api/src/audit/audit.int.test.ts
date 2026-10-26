import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../database/migrator';
import { withTenant } from '../database/tenant';
import { createTestDatabase, MIGRATIONS_DIR, type TestDatabase } from '../database/test-database';
import { recordAudit, verifyAuditChain } from './audit';

describe('audit trail', () => {
  let db: TestDatabase;
  let app: Pool;
  const orgA = randomUUID();
  const orgB = randomUUID();
  const user = randomUUID();
  const asA = { organizationId: orgA, userId: user };

  const event = (n: number) => ({
    action: 'case.updated',
    entityType: 'case',
    entityId: `case-${n}`,
    after: { n },
  });

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.owner, MIGRATIONS_DIR);
    await db.superuser.query("INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B')", [
      orgA,
      orgB,
    ]);
    app = db.appPool({ max: 10 });
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('assigns sequence, time, actor and a hash linked to the previous event', async () => {
    const first = await withTenant(app, asA, (c) => recordAudit(c, event(1)));
    const second = await withTenant(app, asA, (c) => recordAudit(c, event(2)));
    expect([first.seq, second.seq]).toEqual(['1', '2']);

    const { rows } = await db.superuser.query<{
      organization_id: string;
      actor_user_id: string;
      prev_hash: string;
    }>(
      "SELECT organization_id, actor_user_id, encode(prev_hash, 'hex') AS prev_hash FROM audit_events WHERE seq = 2 AND organization_id = $1",
      [orgA],
    );
    expect(rows[0]).toEqual({ organization_id: orgA, actor_user_id: user, prev_hash: first.hash });
  });

  it('stores redacted values', async () => {
    await withTenant(app, asA, (c) =>
      recordAudit(c, {
        action: 'user.password_changed',
        entityType: 'user',
        after: { passwordHash: 'secret' },
      }),
    );
    const { rows } = await db.superuser.query<{ after: unknown }>(
      "SELECT after FROM audit_events WHERE action = 'user.password_changed'",
    );
    expect(rows[0]?.after).toEqual({ passwordHash: '[REDACTED]' });
  });

  it('ignores attempts by the application to choose its own seq, time or hash', async () => {
    const forged = await withTenant(app, asA, async (c) => {
      const { rows } = await c.query<{ seq: string; occurred_at: Date }>(
        `INSERT INTO audit_events (action, entity_type, seq, occurred_at, prev_hash, hash)
         VALUES ('case.updated', 'case', 999, '2000-01-01', '\\x00', '\\x00')
         RETURNING seq::text, occurred_at`,
      );
      return rows[0];
    });
    expect(forged?.seq).not.toBe('999');
    expect(forged?.occurred_at.getFullYear()).toBeGreaterThan(2000);
  });

  it('is append-only for the runtime role', async () => {
    for (const sql of [
      "UPDATE audit_events SET action = 'case.deleted'",
      'DELETE FROM audit_events',
      'TRUNCATE audit_events',
    ]) {
      await expect(withTenant(app, asA, (c) => c.query(sql))).rejects.toThrow(/permission denied/);
    }
  });

  it('is append-only even for a database superuser', async () => {
    await expect(db.superuser.query("UPDATE audit_events SET action = 'x.y'")).rejects.toThrow(
      /append-only/,
    );
    await expect(db.superuser.query('DELETE FROM audit_events')).rejects.toThrow(/append-only/);
    await expect(db.superuser.query('TRUNCATE audit_events')).rejects.toThrow(/append-only/);
  });

  it('keeps organizations apart and cannot write into another one', async () => {
    const seenByB = await withTenant(app, { organizationId: orgB, userId: user }, async (c) => {
      const { rowCount } = await c.query('SELECT 1 FROM audit_events');
      return rowCount;
    });
    expect(seenByB).toBe(0);

    await expect(
      withTenant(app, asA, (c) =>
        c.query(
          "INSERT INTO audit_events (organization_id, action, entity_type) VALUES ($1, 'case.updated', 'case')",
          [orgB],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot record an event without organization context', async () => {
    await expect(
      app.query("INSERT INTO audit_events (action, entity_type) VALUES ('case.updated', 'case')"),
    ).rejects.toThrow();
  });

  it('records nothing when the surrounding transaction rolls back', async () => {
    const before = await withTenant(app, asA, verifyAuditChain);
    await expect(
      withTenant(app, asA, async (c) => {
        await recordAudit(c, event(100));
        throw new Error('business change failed');
      }),
    ).rejects.toThrow('business change failed');
    const after = await withTenant(app, asA, verifyAuditChain);
    expect(after).toEqual({ ...before, valid: true });
  });

  it('keeps a gapless chain under concurrent writers', async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => withTenant(app, asA, (c) => recordAudit(c, event(i)))),
    );
    const result = await withTenant(app, asA, verifyAuditChain);
    expect(result.valid).toBe(true);
    const { rows } = await db.superuser.query<{ n: string; max: string }>(
      'SELECT count(*)::text AS n, max(seq)::text AS max FROM audit_events WHERE organization_id = $1',
      [orgA],
    );
    expect(rows[0]?.n).toBe(rows[0]?.max);
  });

  describe('tamper detection (simulating someone with database superuser access)', () => {
    // Each case runs in its own database so the tampering does not affect the others.
    async function tamperedChain(tamper: (superuser: Pool, org: string) => Promise<unknown>) {
      const scratch = await createTestDatabase();
      try {
        await migrate(scratch.owner, MIGRATIONS_DIR);
        const org = randomUUID();
        await scratch.superuser.query("INSERT INTO organizations (id, name) VALUES ($1, 'T')", [
          org,
        ]);
        const pool = scratch.appPool();
        const ctx = { organizationId: org, userId: user };
        for (let i = 1; i <= 3; i++) await withTenant(pool, ctx, (c) => recordAudit(c, event(i)));
        expect((await withTenant(pool, ctx, verifyAuditChain)).valid).toBe(true);

        await scratch.superuser.query('ALTER TABLE audit_events DISABLE TRIGGER USER');
        await tamper(scratch.superuser, org);
        await scratch.superuser.query('ALTER TABLE audit_events ENABLE TRIGGER USER');
        return await withTenant(pool, ctx, verifyAuditChain);
      } finally {
        await scratch.drop();
      }
    }

    it('detects an edited event', async () => {
      const result = await tamperedChain((superuser) =>
        superuser.query(`UPDATE audit_events SET after = '{"n": 42}' WHERE seq = 2`),
      );
      expect(result).toMatchObject({ valid: false, firstInvalidSeq: 2 });
    });

    it('detects a deleted event in the middle', async () => {
      const result = await tamperedChain((superuser) =>
        superuser.query('DELETE FROM audit_events WHERE seq = 2'),
      );
      expect(result).toMatchObject({ valid: false, firstInvalidSeq: 2, reason: 'missing event' });
    });

    it('detects removed events at the end of the chain', async () => {
      const result = await tamperedChain((superuser) =>
        superuser.query('DELETE FROM audit_events WHERE seq = 3'),
      );
      expect(result).toMatchObject({ valid: false, reason: 'events missing at the end' });
    });
  });
});
