import { existsSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { migrate } from './migrator';

// Runs as the schema owner. The API itself never receives these credentials.
async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL is not set');

  // src/database and dist/database are both two levels below the package root.
  const dir = path.resolve(__dirname, '../../migrations');
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const applied = await migrate(pool, dir);
    console.log(applied.length > 0 ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
