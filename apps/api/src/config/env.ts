import { AppEnv, ProviderMode } from '@skydra/shared';
import { z } from 'zod';

const EnvSchema = z.object({
  APP_ENV: AppEnv,
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url(),
  // Origin the browser uses (links in invitations, Origin check for state-changing requests).
  PUBLIC_APP_URL: z.url(),
  // 32 random bytes, base64. Encrypts TOTP secrets and keys recovery-code hashes.
  SECRET_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded'),
  // Built web app to serve from the same origin (the container image); unset in development.
  WEB_DIST_DIR: z.string().min(1).optional(),
  SCREENING_PROVIDER: ProviderMode,
  IDENTITY_PROVIDER: ProviderMode,
  REGISTRY_PROVIDER: ProviderMode,
});

export type AppConfig = {
  env: AppEnv;
  port: number;
  databaseUrl: string;
  publicAppUrl: string;
  secretEncryptionKey: string;
  webDistDir: string | null;
  providers: {
    screening: ProviderMode;
    identity: ProviderMode;
    registry: ProviderMode;
  };
};

/** The key published in .env.example for local development. Never acceptable elsewhere. */
export const LOCAL_DEVELOPMENT_KEY = 'Z8hzHf+pb3kjsnM+F2d6M4dOgyCtk50GkW/f8Af5R44=';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Parses process environment into typed config and refuses unsafe combinations.
 * A production instance must never start with simulated (MOCK) providers, otherwise a broker
 * could rely on checks that were never performed.
 */
export function loadConfig(source: NodeJS.ProcessEnv): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid environment configuration:\n  ${issues.join('\n  ')}`);
  }

  const e = parsed.data;
  const config: AppConfig = {
    env: e.APP_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    publicAppUrl: new URL(e.PUBLIC_APP_URL).origin,
    secretEncryptionKey: e.SECRET_ENCRYPTION_KEY,
    webDistDir: e.WEB_DIST_DIR ?? null,
    providers: {
      screening: e.SCREENING_PROVIDER,
      identity: e.IDENTITY_PROVIDER,
      registry: e.REGISTRY_PROVIDER,
    },
  };

  if (config.env !== 'local' && config.secretEncryptionKey === LOCAL_DEVELOPMENT_KEY) {
    throw new ConfigError('SECRET_ENCRYPTION_KEY is the public local development key');
  }

  if (config.env === 'prod') {
    const mocked = Object.entries(config.providers)
      .filter(([, mode]) => mode === 'MOCK')
      .map(([name]) => name);
    if (mocked.length > 0) {
      throw new ConfigError(`MOCK providers are not allowed in prod: ${mocked.join(', ')}`);
    }
  }

  return config;
}

export function usesSimulatedProviders(config: AppConfig): boolean {
  return Object.values(config.providers).includes('MOCK');
}
