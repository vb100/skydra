import { z } from 'zod';

export const DocumentType = z.enum(['ID_CARD', 'PASSPORT', 'RESIDENCE_PERMIT', 'OTHER']);
export type DocumentType = z.infer<typeof DocumentType>;

/** Identity checked face to face by the broker against an identity document. */
export const InPersonVerificationInput = z.object({
  casePartyId: z.uuid(),
  documentType: DocumentType,
  documentNumber: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9 -]{4,30}$/),
  documentCountry: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/),
  documentExpiresOn: z.iso.date().nullish(),
});
export type InPersonVerificationInput = z.input<typeof InPersonVerificationInput>;

export const RemoteVerificationInput = z.object({ casePartyId: z.uuid() });

/** MOCK provider only: what the simulated remote session ends with. */
export const SimulateVerificationInput = z.object({ outcome: z.enum(['VERIFIED', 'REJECTED']) });

const Reasoned = (min = 10) => z.string().trim().min(min).max(4000);

export const RequestApprovalInput = z.object({ reason: Reasoned() });
export const DecideApprovalInput = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  justification: Reasoned(),
});
export const EscalateInput = z.object({ reason: Reasoned() });
export const ResolveEscalationInput = z.object({
  resolution: z.enum(['CLEARED', 'REPORTED']),
  notes: Reasoned(),
});

/** Items of a case checklist (app.case_checklist), in the order a broker works through them. */
export const ChecklistItem = z.enum([
  'PARTIES_ADDED',
  'SCREENED',
  'MATCHES_REVIEWED',
  'IDENTITY_VERIFIED',
  'CDD_COMPLETED',
  'RISK_ASSESSED',
  'NO_CONFIRMED_SANCTIONS',
  'EDD_APPROVED',
  'APPROVAL_NOT_REJECTED',
  'NO_OPEN_ESCALATION',
]);
export type ChecklistItem = z.infer<typeof ChecklistItem>;
