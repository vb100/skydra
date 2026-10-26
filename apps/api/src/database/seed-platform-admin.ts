import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Email } from '@skydra/shared';
import { Pool } from 'pg';
import { z } from 'zod';
import { hashToken, randomToken } from '../auth/crypto';

/**
 * Bootstraps a SkyDra platform administrator and prints a one-time activation link, through which
 * the admin sets a password and the second factor like any other user. Runs with the schema owner
 * credentials because no platform admin exists yet who could do this through the application.
 *
 *   pnpm db:seed:platform-admin --email admin@skydra.eu --name "Vardas Pavardė"
 */
async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL is not set');
  const appUrl = z.url().parse(process.env.PUBLIC_APP_URL);

  const { values } = parseArgs({
    options: { email: { type: 'string' }, name: { type: 'string' } },
  });
  const email = Email.parse(values.email);
  const name = z.string().trim().min(1).parse(values.name);

  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await pool.query('BEGIN');
    const { rows } = await pool.query<{ id: string; status: string }>(
      `WITH existing AS (SELECT id, status FROM users WHERE email = $1),
            inserted AS (
              INSERT INTO users (email, full_name)
              SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM existing)
              RETURNING id, status)
       SELECT id, status FROM existing UNION ALL SELECT id, status FROM inserted`,
      [email, name],
    );
    const user = rows[0];
    if (!user) throw new Error('could not create or find the user');
    await pool.query(
      'INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
      [user.id],
    );

    const { rowCount: hasCredentials } = await pool.query(
      'SELECT 1 FROM user_credentials WHERE user_id = $1',
      [user.id],
    );
    if (hasCredentials) {
      await pool.query('COMMIT');
      console.log(`Platform admin ${email} already has a password and second factor.`);
      return;
    }

    const token = randomToken();
    await pool.query(
      `UPDATE auth_links SET revoked_at = now()
        WHERE user_id = $1 AND purpose = 'INVITE' AND used_at IS NULL AND revoked_at IS NULL`,
      [user.id],
    );
    await pool.query(
      `INSERT INTO auth_links (token_hash, user_id, purpose, expires_at)
       VALUES ($1, $2, 'INVITE', now() + interval '72 hours')`,
      [hashToken(token), user.id],
    );
    await pool.query('COMMIT');
    console.log(`Platform admin ${email} created. Activation link (valid 72 h, single use):`);
    console.log(`${new URL(appUrl).origin}/activate#token=${token}`);
  } catch (error) {
    await pool.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
