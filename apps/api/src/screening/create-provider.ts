import type { AppConfig } from '../config/env';
import { withMedia } from './adverse-media';
import { MockScreeningProvider } from './mock-provider';
import { OpenSanctionsProvider } from './opensanctions-provider';
import { type ScreeningProvider, UnavailableScreeningProvider } from './provider';

/**
 * The configured screening provider, the same for the API and the monitoring job. MOCK is
 * refused in prod by loadConfig; manual entry comes later.
 */
export function createScreeningProvider(config: AppConfig): ScreeningProvider {
  if (config.providers.screening === 'MOCK') return new MockScreeningProvider();
  if (config.openSanctions)
    return withMedia(new OpenSanctionsProvider(config.openSanctions), config.adverseMedia);
  return new UnavailableScreeningProvider(config.providers.screening);
}
