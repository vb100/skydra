import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Email } from '@skydra/shared';
import { Pool } from 'pg';
import { z } from 'zod';

/**
 * Bootstraps a SkyDra platform administrator. Runs with the schema owner credentials because no
 * platform admin exists yet who could grant the role through the application.
 *
 *   pnpm db:seed:platform-admin --email admin@skydra.eu --name "Vardas Pavardė"
 */
async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL is not set');

  const { values } = parseArgs({
    options: { email: { type: 'string' }, name: { type: 'string' } },
  });
  const email = Email.parse(values.email);
  const name = z.string().trim().min(1).parse(values.name);

  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const { rows } = await pool.query<{ id: string }>(
      `WITH existing AS (SELECT id FROM users WHERE email = $1),
            inserted AS (
              INSERT INTO users (email, full_name, status)
              SELECT $1, $2, 'ACTIVE' WHERE NOT EXISTS (SELECT 1 FROM existing)
              RETURNING id)
       SELECT id FROM existing UNION ALL SELECT id FROM inserted`,
      [email, name],
    );
    const userId = rows[0]?.id;
    if (!userId) throw new Error('could not create or find the user');
    await pool.query(
      'INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
      [userId],
    );
    console.log(`Platform admin ready: ${email} (${userId})`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
