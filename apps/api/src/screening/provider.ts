import type { MatchCategory, MatchStrength, ScreeningProviderMode } from '@skydra/shared';
import { RuleError } from '../domain-errors';

/** What is sent to a screening provider. The personal code is never part of it. */
export type ScreeningSubject = {
  partyType: 'NATURAL' | 'LEGAL';
  name: string;
  birthDate: string | null;
  /** ISO country codes: citizenships and residence, or registration country. */
  countries: string[];
  /** Company code, for legal entities only. */
  registrationNumber?: string;
};

export type ProviderMatch = {
  externalId: string | null;
  name: string;
  score: number | null;
  /** STRONG must be reviewed before the case proceeds; WEAK is shown folded. */
  strength: MatchStrength;
  categories: MatchCategory[];
  /** Provider data shown to the reviewer (positions, sanction regimes, sources…). */
  details: Record<string, unknown>;
};

/** One HTTP attempt as kept in screening_requests: what was sent and what came back. */
export type ProviderExchange = {
  /** The source answering (OPENSANCTIONS, BRAVE, GDELT); the check's provider when absent. */
  provider?: string;
  attempt: number;
  /** The request body; credentials are never part of it. */
  request: unknown;
  response: unknown;
  httpStatus: number | null;
  /** SHA-256 (hex) of the response body exactly as received. */
  responseSha256: string | null;
  error: string | null;
  durationMs: number;
  sentAt: Date;
};

export type ProviderResult = {
  reference: string | null;
  matches: ProviderMatch[];
  exchanges?: ProviderExchange[];
};

/** A provider call that failed after its attempts; the attempts are still kept as evidence. */
export class ProviderError extends Error {
  override name = 'ProviderError';
  constructor(
    message: string,
    readonly exchanges: ProviderExchange[],
  ) {
    super(message);
  }
}

/**
 * Every screening source sits behind this interface: the simulated MOCK adapter for local and
 * demo use, OpenSanctions for real checks. Results are stored identically whatever the source.
 */
export interface ScreeningProvider {
  readonly mode: ScreeningProviderMode;
  /** Every source a check searches, recorded with it (e.g. OPENSANCTIONS and BRAVE). */
  readonly sources?: readonly string[];
  screen(subject: ScreeningSubject): Promise<ProviderResult>;
}

export const SCREENING_PROVIDER = Symbol('SCREENING_PROVIDER');

/** A configured provider without an adapter yet: refuses clearly instead of pretending. */
export class UnavailableScreeningProvider implements ScreeningProvider {
  constructor(readonly mode: ScreeningProviderMode) {}

  screen(): Promise<ProviderResult> {
    return Promise.reject(new RuleError(`screening provider ${this.mode} is not available yet`));
  }
}
