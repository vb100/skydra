import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { createApp } from './app.factory';
import { loadConfig } from './config/env';

async function bootstrap(): Promise<void> {
  // Local development reads apps/api/.env; cloud environments inject variables directly.
  if (existsSync('.env')) process.loadEnvFile('.env');

  // Fail fast before anything starts if the configuration is invalid or unsafe.
  const config = loadConfig(process.env);
  const app = await createApp(config);
  await app.listen(config.port, '0.0.0.0');
}

void bootstrap();
