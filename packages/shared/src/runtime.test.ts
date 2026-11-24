import { describe, expect, it } from 'vitest';
import {
  AppEnv,
  IdentityProviderMode,
  RegistryProviderMode,
  ScreeningProviderMode,
} from './runtime';

describe('runtime enums', () => {
  it('accepts only known environments', () => {
    expect(AppEnv.safeParse('prod').success).toBe(true);
    expect(AppEnv.safeParse('staging').success).toBe(false);
  });

  it('accepts only the provider codes of each integration', () => {
    expect(ScreeningProviderMode.safeParse('MOCK').success).toBe(true);
    expect(ScreeningProviderMode.safeParse('mock').success).toBe(false);
    expect(ScreeningProviderMode.safeParse('OPENSANCTIONS').success).toBe(true);
    expect(ScreeningProviderMode.safeParse('ONDATO').success).toBe(false);
    expect(IdentityProviderMode.safeParse('DOKOBIT').success).toBe(true);
    expect(IdentityProviderMode.safeParse('OPENSANCTIONS').success).toBe(false);
    expect(RegistryProviderMode.safeParse('REGISTRU_CENTRAS').success).toBe(true);
  });
});
