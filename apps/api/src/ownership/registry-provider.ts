import type { ProviderMode } from '@skydra/shared';
import { RuleError } from '../domain-errors';

/** A person as registries describe them (JAR manager, JADIS shareholder, JANGIS UBO). */
export type RegistryPerson = {
  firstName: string;
  lastName: string;
  birthDate: string | null;
  personalCode: string | null;
  citizenship: string | null;
};

export type Shareholder =
  | { kind: 'NATURAL'; person: RegistryPerson; sharePercent: number }
  | { kind: 'LEGAL'; name: string; code: string; country: string; sharePercent: number };

export type DeclaredUbo = {
  person: RegistryPerson;
  basis: 'OWNERSHIP' | 'CONTROL' | 'SENIOR_MANAGING_OFFICIAL';
  sharePercent: number | null;
};

/** One company from the registries: JAR (registration), JADIS (shareholders), JANGIS (UBOs). */
export type CompanyRecord = {
  code: string;
  country: string;
  name: string;
  legalForm: string | null;
  address: string | null;
  manager: RegistryPerson | null;
  shareholders: Shareholder[];
  declaredUbos: DeclaredUbo[];
  /** Provider references of the extracts, kept as evidence. */
  references: Record<string, string>;
};

/**
 * Company and ownership data. MOCK returns synthetic companies now; Ondato (KYB, JADIS / JANGIS)
 * or direct registry access replace it later without changes to the flow.
 */
export interface RegistryProvider {
  readonly mode: ProviderMode;
  /** null when the registry has no such company. */
  company(country: string, code: string): Promise<CompanyRecord | null>;
}

export const REGISTRY_PROVIDER = Symbol('REGISTRY_PROVIDER');

export class UnavailableRegistryProvider implements RegistryProvider {
  constructor(readonly mode: ProviderMode) {}

  company(): Promise<never> {
    return Promise.reject(new RuleError(`registry provider ${this.mode} is not available yet`));
  }
}
