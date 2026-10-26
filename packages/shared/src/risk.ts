import { z } from 'zod';

export const RiskLevel = z.enum(['LOW', 'MEDIUM', 'HIGH']);
export type RiskLevel = z.infer<typeof RiskLevel>;

/** Factor groups named by the client: PEP, sanctions, customer / ownership, geography, payment. */
export const RiskGroup = z.enum(['PEP', 'SANCTIONS', 'CUSTOMER', 'GEOGRAPHY', 'PAYMENT']);
export type RiskGroup = z.infer<typeof RiskGroup>;

export const AssessRiskInput = z
  .object({
    /** Defaults to the calculated level. */
    finalLevel: RiskLevel.optional(),
    justification: z.string().trim().max(4000).optional(),
  })
  .default({});
export type AssessRiskInput = z.input<typeof AssessRiskInput>;
