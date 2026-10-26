import type { MatchCategory, ProviderMode } from '@skydra/shared';
import { RuleError } from '../domain-errors';

/** What is sent to a screening provider. The personal code is never part of it. */
export type ScreeningSubject = {
  partyType: 'NATURAL' | 'LEGAL';
  name: string;
  birthDate: string | null;
  /** ISO country codes: citizenships and residence, or registration country. */
  countries: string[];
};

export type ProviderMatch = {
  externalId: string | null;
  name: string;
  score: number | null;
  categories: MatchCategory[];
  /** Provider data shown to the reviewer (positions, sanction regimes, sources…). */
  details: Record<string, unknown>;
};

export type ProviderResult = { reference: string | null; matches: ProviderMatch[] };

/**
 * Every screening source sits behind this interface: the simulated MOCK adapter now, Ondato once
 * the contract and sandbox are in place. Results are stored identically whatever the source.
 */
export interface ScreeningProvider {
  readonly mode: ProviderMode;
  screen(subject: ScreeningSubject): Promise<ProviderResult>;
}

export const SCREENING_PROVIDER = Symbol('SCREENING_PROVIDER');

/** A configured provider without an adapter yet: refuses clearly instead of pretending. */
export class UnavailableScreeningProvider implements ScreeningProvider {
  constructor(readonly mode: ProviderMode) {}

  screen(): Promise<ProviderResult> {
    return Promise.reject(new RuleError(`screening provider ${this.mode} is not available yet`));
  }
}
