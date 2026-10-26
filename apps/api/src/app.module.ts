import { DynamicModule, Module } from '@nestjs/common';
import type { Pool } from 'pg';
import { AuthController } from './auth/auth.controller';
import { AUTH_DEPS } from './auth/auth.module-tokens';
import { deriveKeys } from './auth/crypto';
import { CasesController } from './cases/cases.controller';
import { APP_CONFIG, ConfigModule } from './config/config.module';
import type { AppConfig } from './config/env';
import { DatabaseModule, PG_POOL } from './database/database.module';
import { HealthController } from './health/health.controller';
import { OrganizationGuard, PlatformAdminGuard, SessionGuard } from './http/session';
import { OrganizationController } from './organization/organization.controller';
import { PlatformController } from './platform/platform.controller';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig, pool?: Pool): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigModule.forRoot(config), DatabaseModule.forRoot(pool)],
      controllers: [
        HealthController,
        AuthController,
        PlatformController,
        OrganizationController,
        CasesController,
      ],
      providers: [
        {
          provide: AUTH_DEPS,
          inject: [PG_POOL, APP_CONFIG],
          useFactory: (db: Pool, cfg: AppConfig) => ({
            pool: db,
            keys: deriveKeys(cfg.secretEncryptionKey),
          }),
        },
        SessionGuard,
        PlatformAdminGuard,
        OrganizationGuard,
      ],
    };
  }
}
