import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from './migrator';
import { createTestDatabase, MIGRATIONS_DIR, type TestDatabase } from './test-database';

describe('migrator', () => {
  let db: TestDatabase;
  let dir: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    dir = await mkdtemp(path.join(tmpdir(), 'skydra-migrations-'));
  });

  afterAll(async () => {
    await db?.drop();
    await rm(dir, { recursive: true, force: true });
  });

  it('applies the real migrations on an empty database and is idempotent', async () => {
    const scratch = await createTestDatabase();
    try {
      expect(await migrate(scratch.owner, MIGRATIONS_DIR)).toContain('0001_foundation');
      expect(await migrate(scratch.owner, MIGRATIONS_DIR)).toEqual([]);
    } finally {
      await scratch.drop();
    }
  });

  it('applies pending migrations in order', async () => {
    await writeFile(path.join(dir, '0001_first.sql'), 'CREATE TABLE first (id int);');
    await writeFile(path.join(dir, '0002_second.sql'), 'CREATE TABLE second (id int);');
    expect(await migrate(db.owner, dir)).toEqual(['0001_first', '0002_second']);
  });

  it('rolls back a failing migration completely', async () => {
    await writeFile(path.join(dir, '0003_bad.sql'), 'CREATE TABLE third (id int); SELECT 1/0;');
    await expect(migrate(db.owner, dir)).rejects.toThrow(/0003_bad failed/);
    const { rowCount } = await db.owner.query("SELECT 1 FROM pg_tables WHERE tablename = 'third'");
    expect(rowCount).toBe(0);
    await unlink(path.join(dir, '0003_bad.sql'));
  });

  it('refuses to run when an applied migration was edited', async () => {
    await writeFile(path.join(dir, '0001_first.sql'), 'CREATE TABLE first (id bigint);');
    await expect(migrate(db.owner, dir)).rejects.toThrow(/0001_first was modified/);
    await writeFile(path.join(dir, '0001_first.sql'), 'CREATE TABLE first (id int);');
  });

  it('refuses to run when an applied migration disappeared', async () => {
    await unlink(path.join(dir, '0002_second.sql'));
    await expect(migrate(db.owner, dir)).rejects.toThrow(/missing from disk: 0002_second/);
  });
});
