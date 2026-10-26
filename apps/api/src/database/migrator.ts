import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';

export type Migration = { version: string; sql: string; checksum: string };

const FILE_PATTERN = /^(\d{4}_[a-z0-9_]+)\.sql$/;

// Arbitrary constant: serializes concurrent migration runs (e.g. two deploys starting at once).
const ADVISORY_LOCK_ID = 7_212_026;

export class MigrationError extends Error {
  override name = 'MigrationError';
}

export async function loadMigrations(dir: string): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    const match = FILE_PATTERN.exec(file);
    if (!match?.[1]) throw new MigrationError(`Unexpected migration file name: ${file}`);
    const sql = await readFile(path.join(dir, file), 'utf8');
    migrations.push({
      version: match[1],
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  return migrations;
}

/**
 * Applies pending migrations in order, each in its own transaction. Already applied migrations
 * must be unchanged: a different checksum means history was edited, which we refuse rather than
 * silently diverging environments. Returns the versions applied by this run.
 */
export async function migrate(pool: Pool, dir: string): Promise<string[]> {
  const migrations = await loadMigrations(dir);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations',
    );
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));

    const known = new Set(migrations.map((m) => m.version));
    const missing = [...applied.keys()].filter((v) => !known.has(v));
    if (missing.length > 0) {
      throw new MigrationError(`Applied migrations missing from disk: ${missing.join(', ')}`);
    }

    const done: string[] = [];
    for (const m of migrations) {
      const existing = applied.get(m.version);
      if (existing !== undefined) {
        if (existing !== m.checksum) {
          throw new MigrationError(`Migration ${m.version} was modified after being applied`);
        }
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
          m.version,
          m.checksum,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new MigrationError(`Migration ${m.version} failed: ${(error as Error).message}`);
      }
      done.push(m.version);
    }
    return done;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}
