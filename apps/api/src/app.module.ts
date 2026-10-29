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
import {
  IDENTITY_PROVIDER,
  MockIdentityProvider,
  UnavailableIdentityProvider,
} from './kyc/identity-provider';
import { KycController } from './kyc/kyc.controller';
import { MockRegistryProvider } from './ownership/mock-registry';
import { OwnershipController } from './ownership/ownership.controller';
import { REGISTRY_PROVIDER, UnavailableRegistryProvider } from './ownership/registry-provider';
import { PlatformController } from './platform/platform.controller';
import { RiskController } from './risk/risk.controller';
import { MockScreeningProvider } from './screening/mock-provider';
import { SCREENING_PROVIDER, UnavailableScreeningProvider } from './screening/provider';

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
        KycController,
        RiskController,
        OwnershipController,
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
        {
          // MOCK is refused in prod by loadConfig; Ondato and manual entry come later.
          provide: SCREENING_PROVIDER,
          useValue:
            config.providers.screening === 'MOCK'
              ? new MockScreeningProvider()
              : new UnavailableScreeningProvider(config.providers.screening),
        },
        {
          // In-person verification needs no provider; remote verification uses this one.
          provide: IDENTITY_PROVIDER,
          useValue:
            config.providers.identity === 'MOCK'
              ? new MockIdentityProvider()
              : new UnavailableIdentityProvider(config.providers.identity),
        },
        {
          provide: REGISTRY_PROVIDER,
          useValue:
            config.providers.registry === 'MOCK'
              ? new MockRegistryProvider()
              : new UnavailableRegistryProvider(config.providers.registry),
        },
        SessionGuard,
        PlatformAdminGuard,
        OrganizationGuard,
      ],
    };
  }
}
