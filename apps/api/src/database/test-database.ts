import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Pool, type PoolConfig } from 'pg';

export const MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations');

export type TestDatabase = {
  /** Schema owner (superuser in tests): bypasses RLS, used for setup only. */
  owner: Pool;
  /** Connections that act as the runtime role, exactly like the API. */
  appPool: (config?: PoolConfig) => Pool;
  drop: () => Promise<void>;
};

/** Creates a throwaway database so integration tests never touch development data. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) throw new Error('TEST_DATABASE_URL is not set (superuser connection)');

  const name = `skydra_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const owner = new Pool({ connectionString: url.toString(), max: 2 });
  const pools: Pool[] = [owner];

  return {
    owner,
    appPool: (config = {}) => {
      // Connect as the test superuser but switch to skydra_app for the whole session, so RLS and
      // privileges apply exactly as for the real runtime user without managing passwords.
      const pool = new Pool({
        connectionString: url.toString(),
        max: 2,
        options: '-c role=skydra_app',
        ...config,
      });
      pools.push(pool);
      return pool;
    },
    drop: async () => {
      await Promise.all(pools.map((p) => p.end()));
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}
