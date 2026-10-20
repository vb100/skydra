import { Controller, Get, Inject } from '@nestjs/common';
import type { HealthResponse } from '@skydra/shared';
import { Pool } from 'pg';
import { APP_CONFIG } from '../config/config.module';
import { type AppConfig, usesSimulatedProviders } from '../config/env';
import { PG_POOL } from '../database/database.module';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  @Get()
  async check(): Promise<HealthResponse> {
    const database = await this.pool
      .query('select 1')
      .then(() => 'ok' as const)
      .catch(() => 'unavailable' as const);

    return {
      status: database === 'ok' ? 'ok' : 'degraded',
      env: this.config.env,
      database,
      simulatedProviders: usesSimulatedProviders(this.config),
    };
  }
}
