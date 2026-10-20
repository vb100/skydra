import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { loadConfig } from './config/env';

async function bootstrap(): Promise<void> {
  // Local development reads apps/api/.env; cloud environments inject variables directly.
  if (existsSync('.env')) process.loadEnvFile('.env');

  // Fail fast before anything starts if the configuration is invalid or unsafe.
  const config = loadConfig(process.env);

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(config),
    new FastifyAdapter(),
  );
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();

  await app.listen(config.port, '0.0.0.0');
}

void bootstrap();
