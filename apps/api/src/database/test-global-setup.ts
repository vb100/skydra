import { Pool } from 'pg';

/**
 * Cluster-wide roles shared by all integration test databases, created once per run. They mirror
 * production: migrations run as a non-superuser owner (as on Cloud SQL), the API as skydra_app.
 */
export async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set (superuser connection)');
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'skydra_migrator') THEN
          CREATE ROLE skydra_migrator NOLOGIN CREATEROLE;
        END IF;
      END
      $$`);
  } finally {
    await pool.end();
  }
}
