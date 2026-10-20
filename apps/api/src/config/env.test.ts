import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, usesSimulatedProviders } from './env';

const base = {
  APP_ENV: 'local',
  DATABASE_URL: 'postgres://skydra:skydra@localhost:5432/skydra',
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
      SCREENING_PROVIDER: 'ONDATO',
      IDENTITY_PROVIDER: 'MANUAL',
    });
    expect(usesSimulatedProviders(config)).toBe(false);
  });

  it('rejects unknown values with a readable message', () => {
    expect(() => loadConfig({ ...base, APP_ENV: 'staging' })).toThrow(/APP_ENV/);
  });
});
