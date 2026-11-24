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
