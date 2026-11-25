import { existsSync } from 'node:fs';
import { Pool } from 'pg';
import { loadConfig } from '../config/env';
import { createScreeningProvider } from './create-provider';
import { runMonitoring } from './monitoring';

/**
 * The monitoring job (Cloud Run job `skydra-<env>-monitor`, started daily by Cloud Scheduler or
 * by hand): screens again the parties of open cases whose latest check is older than
 * MONITORING_INTERVAL_DAYS. Runs as the application role, under row-level security.
 */
async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const config = loadConfig(process.env);
  const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
  try {
    const summary = await runMonitoring(pool, createScreeningProvider(config), config.monitoring);
    console.log(
      JSON.stringify({ monitoring: summary, intervalDays: config.monitoring.intervalDays }),
    );
    if (summary.errors > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
