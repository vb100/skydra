import { describe, expect, it } from 'vitest';
import { AppEnv, ProviderMode } from './runtime';

describe('runtime enums', () => {
  it('accepts only known environments', () => {
    expect(AppEnv.safeParse('prod').success).toBe(true);
    expect(AppEnv.safeParse('staging').success).toBe(false);
  });

  it('accepts only known provider modes', () => {
    expect(ProviderMode.safeParse('MOCK').success).toBe(true);
    expect(ProviderMode.safeParse('mock').success).toBe(false);
  });
});
