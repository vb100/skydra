import { z } from 'zod';

/** What a potential match was found in (from OpenSanctions topics: sanction, role.pep, role.rca…). */
export const MatchCategory = z.enum([
  'SANCTIONS',
  'PEP',
  'PEP_ASSOCIATE',
  'ADVERSE_MEDIA',
  'OTHER_LIST',
]);
export type MatchCategory = z.infer<typeof MatchCategory>;

/** STRONG: the provider counts it as a match (score at or above the threshold); WEAK: below. */
export const MatchStrength = z.enum(['STRONG', 'WEAK']);
export type MatchStrength = z.infer<typeof MatchStrength>;

export const ReviewStatus = z.enum(['OPEN', 'FALSE_POSITIVE', 'TRUE_POSITIVE']);
export type ReviewStatus = z.infer<typeof ReviewStatus>;

export const RunScreeningInput = z.object({
  /** One party of the case; all active parties when omitted. */
  casePartyId: z.uuid().optional(),
});
export type RunScreeningInput = z.input<typeof RunScreeningInput>;

export const ReviewMatchInput = z.object({
  decision: z.enum(['FALSE_POSITIVE', 'TRUE_POSITIVE']),
  /** Why the broker concluded so, e.g. a different date of birth. Kept as evidence. */
  justification: z.string().trim().min(10).max(4000),
});
export type ReviewMatchInput = z.input<typeof ReviewMatchInput>;

/**
 * A person's screening outcome at a glance (client specification, 2026-11-24):
 *   GREEN   screened, nothing left: no strong match, or every strong match ruled out;
 *   YELLOW  a strong match awaits review, or confirmed adverse media / another risk list;
 *   ORANGE  confirmed PEP or PEP associate: enhanced due diligence;
 *   RED     confirmed sanctions: the transaction stops, report to the FIU;
 *   FAILED  the provider could not be reached and no earlier result exists;
 *   NOT_SCREENED.
 * Taken from the latest completed check, as the case checklist does. Weak matches do not count.
 */
export const ScreeningStatus = z.enum([
  'NOT_SCREENED',
  'FAILED',
  'GREEN',
  'YELLOW',
  'ORANGE',
  'RED',
]);
export type ScreeningStatus = z.infer<typeof ScreeningStatus>;

type CheckSummary = {
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  matches: { strength: MatchStrength; reviewStatus: ReviewStatus; categories: readonly string[] }[];
};

/** `checks` of one person, newest first. `lastAttemptFailed` flags a failed re-check. */
export function screeningStatus(checks: readonly CheckSummary[]): {
  status: ScreeningStatus;
  lastAttemptFailed: boolean;
} {
  const lastAttemptFailed = checks[0]?.status === 'FAILED';
  const completed = checks.find((c) => c.status === 'COMPLETED');
  if (!completed)
    return {
      status: checks.some((c) => c.status === 'FAILED') ? 'FAILED' : 'NOT_SCREENED',
      lastAttemptFailed,
    };
  const confirmed = completed.matches.filter((m) => m.reviewStatus === 'TRUE_POSITIVE');
  const has = (...categories: string[]) =>
    confirmed.some((m) => m.categories.some((c) => categories.includes(c)));
  const status: ScreeningStatus = has('SANCTIONS')
    ? 'RED'
    : has('PEP', 'PEP_ASSOCIATE')
      ? 'ORANGE'
      : confirmed.length > 0 ||
          completed.matches.some((m) => m.strength === 'STRONG' && m.reviewStatus === 'OPEN')
        ? 'YELLOW'
        : 'GREEN';
  return { status, lastAttemptFailed };
}
