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

/** NOT_RELEVANT applies to adverse-media articles only (e.g. a namesake's unrelated news). */
export const ReviewStatus = z.enum(['OPEN', 'FALSE_POSITIVE', 'TRUE_POSITIVE', 'NOT_RELEVANT']);
export type ReviewStatus = z.infer<typeof ReviewStatus>;

/** What started a check: the broker, a party joining the case, or ongoing monitoring. */
export const ScreeningOrigin = z.enum(['MANUAL', 'AUTOMATIC', 'MONITORING']);
export type ScreeningOrigin = z.infer<typeof ScreeningOrigin>;

export const RunScreeningInput = z.object({
  /** One party of the case; all active parties when omitted. */
  casePartyId: z.uuid().optional(),
});
export type RunScreeningInput = z.input<typeof RunScreeningInput>;

export const ReviewMatchInput = z.object({
  decision: z.enum(['FALSE_POSITIVE', 'TRUE_POSITIVE', 'NOT_RELEVANT']),
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
 * Open matches are those of the latest completed check; confirmed ones count from every completed
 * check, so a confirmation stays in force when a later check no longer finds the record (as in
 * the case checklist, migration 0015). Weak matches do not count.
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
  const confirmed = checks
    .filter((c) => c.status === 'COMPLETED')
    .flatMap((c) => c.matches)
    .filter((m) => m.reviewStatus === 'TRUE_POSITIVE');
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

/**
 * Price per answered request in EUR, for the cost overview; null where it depends on the plan
 * (Brave). OpenSanctions: €0.10 per credit, the first 2 000 free (docs/integrations).
 */
export const PROVIDER_PRICE_EUR = { OPENSANCTIONS: 0.1, BRAVE: null, GDELT: 0 } as const;

/**
 * A manual screening record (client answer Q28, AC4): the controlled fallback when the
 * automatic check is not available. Evidence is required: a link to the source or a document
 * uploaded to the case. A potential match found by hand is then reviewed like any other.
 */
export const ManualScreeningInput = z
  .object({
    casePartyId: z.uuid(),
    source: z.string().trim().min(2).max(300),
    sourceUrl: z
      .url({ protocol: /^https$/ })
      .max(2000)
      .optional(),
    searchedOn: z.iso.date(),
    result: z.enum(['NO_MATCH', 'POTENTIAL_MATCH']),
    /** For a potential match: what was found. */
    match: z
      .object({
        name: z.string().trim().min(2).max(300),
        category: MatchCategory,
      })
      .optional(),
    justification: z.string().trim().min(10).max(4000),
    evidenceDocumentId: z.uuid().optional(),
  })
  .refine((v) => v.sourceUrl || v.evidenceDocumentId, {
    message: 'a link to the source or a document is required',
    path: ['sourceUrl'],
  })
  .refine((v) => (v.result === 'POTENTIAL_MATCH') === Boolean(v.match), {
    message: 'describe the match found, and only then',
    path: ['match'],
  });
export type ManualScreeningInput = z.input<typeof ManualScreeningInput>;

/** From the least to the most serious: what a person's several cases add up to. */
const SEVERITY: readonly ScreeningStatus[] = [
  'NOT_SCREENED',
  'GREEN',
  'FAILED',
  'YELLOW',
  'ORANGE',
  'RED',
];

/**
 * The most serious status among a person's case links (e.g. in the clients list): a PEP
 * confirmed in one case is a PEP whatever another case shows.
 */
export function worstScreeningStatus(statuses: readonly ScreeningStatus[]): ScreeningStatus {
  return statuses.reduce<ScreeningStatus>(
    (worst, s) => (SEVERITY.indexOf(s) > SEVERITY.indexOf(worst) ? s : worst),
    'NOT_SCREENED',
  );
}
