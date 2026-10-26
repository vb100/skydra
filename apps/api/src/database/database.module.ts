import { DynamicModule, Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env';

export const PG_POOL = Symbol('PG_POOL');
const OWNS_POOL = Symbol('OWNS_POOL');

@Global()
@Module({})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(OWNS_POOL) private readonly ownsPool: boolean,
  ) {}

  /** `pool` lets tests inject a connection that acts as the runtime role; its owner closes it. */
  static forRoot(pool?: Pool): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        { provide: OWNS_POOL, useValue: !pool },
        pool
          ? { provide: PG_POOL, useValue: pool }
          : {
              provide: PG_POOL,
              inject: [APP_CONFIG],
              useFactory: (config: AppConfig) =>
                new Pool({ connectionString: config.databaseUrl, max: 10 }),
            },
      ],
      exports: [PG_POOL],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
