import { describe, expect, it } from 'vitest';
import { ConfigError, LOCAL_DEVELOPMENT_KEY, loadConfig, usesSimulatedProviders } from './env';

const base = {
  APP_ENV: 'local',
  DATABASE_URL: 'postgres://skydra:skydra@localhost:5432/skydra',
  PUBLIC_APP_URL: 'http://localhost:5173',
  SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  SCREENING_PROVIDER: 'MOCK',
  IDENTITY_PROVIDER: 'MOCK',
  REGISTRY_PROVIDER: 'MANUAL',
};

describe('loadConfig', () => {
  it('parses a valid local configuration', () => {
    const config = loadConfig(base);
    expect(config.port).toBe(3000);
    expect(config.providers.registry).toBe('MANUAL');
    expect(usesSimulatedProviders(config)).toBe(true);
  });

  it('allows MOCK providers in demo', () => {
    expect(() => loadConfig({ ...base, APP_ENV: 'demo' })).not.toThrow();
  });

  it('refuses MOCK providers in prod and names them', () => {
    expect(() => loadConfig({ ...base, APP_ENV: 'prod' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, APP_ENV: 'prod' })).toThrow(/screening, identity/);
  });

  it('accepts prod without MOCK providers', () => {
    const config = loadConfig({
      ...base,
      APP_ENV: 'prod',
      SCREENING_PROVIDER: 'OPENSANCTIONS',
      OPENSANCTIONS_API_KEY: 'test-key',
      IDENTITY_PROVIDER: 'MANUAL',
    });
    expect(usesSimulatedProviders(config)).toBe(false);
    expect(config.openSanctions).toEqual({
      apiKey: 'test-key',
      baseUrl: 'https://api.opensanctions.org',
      threshold: 0.7,
    });
  });

  it('requires the OpenSanctions key only when OpenSanctions screens', () => {
    expect(() => loadConfig({ ...base, SCREENING_PROVIDER: 'OPENSANCTIONS' })).toThrow(
      /OPENSANCTIONS_API_KEY/,
    );
    expect(loadConfig(base).openSanctions).toBeNull();
    expect(
      loadConfig({
        ...base,
        SCREENING_PROVIDER: 'OPENSANCTIONS',
        OPENSANCTIONS_API_KEY: 'k',
        OPENSANCTIONS_THRESHOLD: '0.8',
        OPENSANCTIONS_URL: 'https://example.test/',
      }).openSanctions,
    ).toMatchObject({ threshold: 0.8, baseUrl: 'https://example.test' });
    expect(() =>
      loadConfig({
        ...base,
        SCREENING_PROVIDER: 'OPENSANCTIONS',
        OPENSANCTIONS_API_KEY: 'k',
        OPENSANCTIONS_THRESHOLD: '0.2',
      }),
    ).toThrow(/OPENSANCTIONS_THRESHOLD/);
  });

  it('searches the media only alongside OpenSanctions, Brave with a key, GDELT when enabled', () => {
    const media = { BRAVE_API_KEY: 'brave-key', GDELT_ENABLED: 'true' };
    // Simulated screening never calls real media services.
    expect(loadConfig({ ...base, ...media }).adverseMedia).toEqual({ brave: null, gdelt: null });
    const os = { ...base, SCREENING_PROVIDER: 'OPENSANCTIONS', OPENSANCTIONS_API_KEY: 'k' };
    expect(loadConfig(os).adverseMedia).toEqual({ brave: null, gdelt: null });
    expect(loadConfig({ ...os, ...media }).adverseMedia).toEqual({
      brave: { apiKey: 'brave-key', baseUrl: 'https://api.search.brave.com/res/v1' },
      gdelt: { baseUrl: 'https://api.gdeltproject.org' },
    });
    expect(() => loadConfig({ ...os, GDELT_ENABLED: 'yes' })).toThrow(/GDELT_ENABLED/);
  });

  it('monitors weekly by default, within bounds', () => {
    expect(loadConfig(base).monitoring).toEqual({ intervalDays: 7, batch: 200 });
    expect(
      loadConfig({ ...base, MONITORING_INTERVAL_DAYS: '1', MONITORING_BATCH: '50' }).monitoring,
    ).toEqual({ intervalDays: 1, batch: 50 });
    expect(() => loadConfig({ ...base, MONITORING_INTERVAL_DAYS: '0' })).toThrow(
      /MONITORING_INTERVAL_DAYS/,
    );
  });

  it('accepts each provider code only for its own integration', () => {
    expect(() => loadConfig({ ...base, SCREENING_PROVIDER: 'ONDATO' })).toThrow(
      /SCREENING_PROVIDER/,
    );
    expect(() => loadConfig({ ...base, IDENTITY_PROVIDER: 'OPENSANCTIONS' })).toThrow(
      /IDENTITY_PROVIDER/,
    );
    expect(
      loadConfig({ ...base, IDENTITY_PROVIDER: 'DOKOBIT', REGISTRY_PROVIDER: 'REGISTRU_CENTRAS' })
        .providers,
    ).toEqual({
      screening: 'MOCK',
      identity: 'DOKOBIT',
      registry: 'REGISTRU_CENTRAS',
    });
  });

  it('rejects unknown values with a readable message', () => {
    expect(() => loadConfig({ ...base, APP_ENV: 'staging' })).toThrow(/APP_ENV/);
  });

  it('refuses the public local development key outside local', () => {
    expect(() =>
      loadConfig({ ...base, SECRET_ENCRYPTION_KEY: LOCAL_DEVELOPMENT_KEY }),
    ).not.toThrow();
    expect(() =>
      loadConfig({ ...base, APP_ENV: 'demo', SECRET_ENCRYPTION_KEY: LOCAL_DEVELOPMENT_KEY }),
    ).toThrow(/local development key/);
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => loadConfig({ ...base, SECRET_ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow(/32 bytes/);
  });
});
