import { z } from 'zod';

/** What a potential match was found in. Mirrors the provider's datasets (Ondato: SAN, PEP, RCA, AM…). */
export const MatchCategory = z.enum([
  'SANCTIONS',
  'PEP',
  'PEP_ASSOCIATE',
  'ADVERSE_MEDIA',
  'OTHER_LIST',
]);
export type MatchCategory = z.infer<typeof MatchCategory>;

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
