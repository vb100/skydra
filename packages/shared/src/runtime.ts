import { z } from 'zod';

export const AppEnv = z.enum(['local', 'demo', 'prod']);
export type AppEnv = z.infer<typeof AppEnv>;

/**
 * Every external integration (screening, identity verification, registries) runs through an
 * adapter. MOCK returns simulated results and must never be active in production.
 */
export const ProviderMode = z.enum(['MOCK', 'MANUAL', 'ONDATO']);
export type ProviderMode = z.infer<typeof ProviderMode>;

export const HealthResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  env: AppEnv,
  database: z.enum(['ok', 'unavailable']),
  simulatedProviders: z.boolean(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
