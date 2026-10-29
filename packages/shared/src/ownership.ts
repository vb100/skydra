import { z } from 'zod';

/** How a person qualifies as a beneficial owner. */
export const UboBasis = z.enum(['OWNERSHIP', 'CONTROL', 'SENIOR_MANAGING_OFFICIAL']);
export type UboBasis = z.infer<typeof UboBasis>;

/**
 * How a UBO discrepancy or an incomplete ownership chain was resolved. A comment alone is not
 * enough (client answer): the broker states what was done and what evidence supports it.
 */
export const DiscrepancyResolution = z.enum([
  'CLARIFIED_WITH_CLIENT',
  'CLIENT_DOCUMENTS_ACCEPTED',
  'REPORTED_TO_REGISTRY',
]);
export type DiscrepancyResolution = z.infer<typeof DiscrepancyResolution>;

export const ResolveOwnershipInput = z.object({
  resolution: DiscrepancyResolution,
  /** What was found and why the identified UBOs are correct. */
  notes: z.string().trim().min(20).max(4000),
  /** Document, letter or registry report the resolution relies on. */
  evidence: z.string().trim().min(3).max(500),
});
export type ResolveOwnershipInput = z.input<typeof ResolveOwnershipInput>;
