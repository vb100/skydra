import { z } from 'zod';

export const AppEnv = z.enum(['local', 'demo', 'prod']);
export type AppEnv = z.infer<typeof AppEnv>;

/**
 * Every external integration (screening, identity verification, registries) runs through an
 * adapter. MOCK returns simulated results and must never be active in production; MANUAL means
 * the broker enters the result.
 */
export const ScreeningProviderMode = z.enum(['MOCK', 'MANUAL', 'OPENSANCTIONS']);
export const IdentityProviderMode = z.enum(['MOCK', 'MANUAL', 'DOKOBIT']);
export const RegistryProviderMode = z.enum(['MOCK', 'MANUAL', 'REGISTRU_CENTRAS']);
export type ScreeningProviderMode = z.infer<typeof ScreeningProviderMode>;
export type IdentityProviderMode = z.infer<typeof IdentityProviderMode>;
export type RegistryProviderMode = z.infer<typeof RegistryProviderMode>;
export type ProviderMode = ScreeningProviderMode | IdentityProviderMode | RegistryProviderMode;

export const HealthResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  env: AppEnv,
  database: z.enum(['ok', 'unavailable']),
  simulatedProviders: z.boolean(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
