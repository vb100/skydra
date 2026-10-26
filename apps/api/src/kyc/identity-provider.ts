import { randomUUID } from 'node:crypto';
import type { ProviderMode } from '@skydra/shared';
import { RuleError } from '../domain-errors';

/** The person a remote identity check is started for (from the party record). */
export type IdentitySubject = { name: string; birthDate: string | null; countries: string[] };

/** What a finished remote check established about the person and the document. */
export type IdentityResult = {
  status: 'VERIFIED' | 'REJECTED';
  verifiedName: string | null;
  verifiedBirthDate: string | null;
  documentType: 'ID_CARD' | 'PASSPORT' | 'RESIDENCE_PERMIT' | 'OTHER' | null;
  documentCountry: string | null;
  documentExpiresOn: string | null;
  failureReason: string | null;
  details: Record<string, unknown>;
};

/**
 * Remote identity verification: a session the client completes on their own device. The result
 * arrives later (a webhook for Ondato); the MOCK adapter lets the broker simulate it.
 */
export interface IdentityProvider {
  readonly mode: ProviderMode;
  start(subject: IdentitySubject): Promise<{ reference: string; sessionUrl: string | null }>;
  /** Only the simulated provider can produce a result on request. */
  simulate?(subject: IdentitySubject, outcome: 'VERIFIED' | 'REJECTED'): IdentityResult;
}

export const IDENTITY_PROVIDER = Symbol('IDENTITY_PROVIDER');

export class MockIdentityProvider implements IdentityProvider {
  readonly mode = 'MOCK' as const;

  start(): Promise<{ reference: string; sessionUrl: string | null }> {
    return Promise.resolve({ reference: `mock-idv-${randomUUID()}`, sessionUrl: null });
  }

  simulate(subject: IdentitySubject, outcome: 'VERIFIED' | 'REJECTED'): IdentityResult {
    const verified = outcome === 'VERIFIED';
    return {
      status: outcome,
      verifiedName: verified ? subject.name : null,
      verifiedBirthDate: verified ? subject.birthDate : null,
      documentType: 'ID_CARD',
      documentCountry: subject.countries[0] ?? 'LT',
      documentExpiresOn: null,
      failureReason: verified ? null : 'Dokumentas neatitinka asmens (imitacija)',
      details: { simulated: true, liveness: verified ? 'PASSED' : 'FAILED' },
    };
  }
}

/** A configured provider without an adapter yet (Ondato): refuses instead of pretending. */
export class UnavailableIdentityProvider implements IdentityProvider {
  constructor(readonly mode: ProviderMode) {}

  start(): Promise<never> {
    return Promise.reject(
      new RuleError(`remote identity verification (${this.mode}) is not available yet`),
    );
  }
}
