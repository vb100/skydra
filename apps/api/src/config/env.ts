import {
  AppEnv,
  IdentityProviderMode,
  RegistryProviderMode,
  ScreeningProviderMode,
} from '@skydra/shared';
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
  SCREENING_PROVIDER: ScreeningProviderMode,
  IDENTITY_PROVIDER: IdentityProviderMode,
  REGISTRY_PROVIDER: RegistryProviderMode,
  // OpenSanctions (screening). The key comes from Secret Manager, never from code.
  OPENSANCTIONS_API_KEY: z.string().min(1).optional(),
  OPENSANCTIONS_URL: z.url().default('https://api.opensanctions.org'),
  // Score (0–1) from which a result counts as a match that must be reviewed; below it, a weak one.
  OPENSANCTIONS_THRESHOLD: z.coerce.number().min(0.5).max(0.99).default(0.7),
  // Adverse media, searched together with OpenSanctions. Brave is on when its key is set.
  BRAVE_API_KEY: z.string().min(1).optional(),
  BRAVE_URL: z.url().default('https://api.search.brave.com/res/v1'),
  // GDELT needs no key; it stays off until the client's DPIA covers it.
  GDELT_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  GDELT_URL: z.url().default('https://api.gdeltproject.org'),
  // Ongoing monitoring: a party of an open case is screened again once its latest check is this
  // many days old; one run handles at most MONITORING_BATCH parties (the rest on the next run).
  MONITORING_INTERVAL_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  MONITORING_BATCH: z.coerce.number().int().min(1).max(5000).default(200),
  // Case documents: a private Cloud Storage bucket. Locally the emulator of infra/docker
  // (STORAGE_EMULATOR_HOST=http://localhost:4443). Without a bucket documents cannot be added.
  STORAGE_BUCKET: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/)
    .optional(),
  STORAGE_EMULATOR_HOST: z.url().optional(),
});

export type AppConfig = {
  env: AppEnv;
  port: number;
  databaseUrl: string;
  publicAppUrl: string;
  secretEncryptionKey: string;
  webDistDir: string | null;
  providers: {
    screening: ScreeningProviderMode;
    identity: IdentityProviderMode;
    registry: RegistryProviderMode;
  };
  /** Set when screening uses OpenSanctions. */
  openSanctions: { apiKey: string; baseUrl: string; threshold: number } | null;
  /** Media sources searched with OpenSanctions; both null otherwise (never with MOCK). */
  adverseMedia: {
    brave: { apiKey: string; baseUrl: string } | null;
    gdelt: { baseUrl: string } | null;
  };
  monitoring: { intervalDays: number; batch: number };
  storage: { bucket: string; endpoint: string; emulator: boolean } | null;
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
    openSanctions: null,
    adverseMedia: { brave: null, gdelt: null },
    monitoring: { intervalDays: e.MONITORING_INTERVAL_DAYS, batch: e.MONITORING_BATCH },
    storage: e.STORAGE_BUCKET
      ? {
          bucket: e.STORAGE_BUCKET,
          endpoint: (e.STORAGE_EMULATOR_HOST ?? 'https://storage.googleapis.com').replace(
            /\/+$/,
            '',
          ),
          emulator: Boolean(e.STORAGE_EMULATOR_HOST),
        }
      : null,
  };

  if (config.storage?.emulator && config.env !== 'local')
    throw new ConfigError('STORAGE_EMULATOR_HOST is for local development only');

  if (config.providers.screening === 'OPENSANCTIONS') {
    if (!e.OPENSANCTIONS_API_KEY)
      throw new ConfigError(
        'OPENSANCTIONS_API_KEY is required when SCREENING_PROVIDER=OPENSANCTIONS',
      );
    config.openSanctions = {
      apiKey: e.OPENSANCTIONS_API_KEY,
      baseUrl: e.OPENSANCTIONS_URL.replace(/\/+$/, ''),
      threshold: e.OPENSANCTIONS_THRESHOLD,
    };
    config.adverseMedia = {
      brave: e.BRAVE_API_KEY
        ? { apiKey: e.BRAVE_API_KEY, baseUrl: e.BRAVE_URL.replace(/\/+$/, '') }
        : null,
      gdelt: e.GDELT_ENABLED ? { baseUrl: e.GDELT_URL.replace(/\/+$/, '') } : null,
    };
  }

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
