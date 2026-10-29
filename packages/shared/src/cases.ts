import { z } from 'zod';

export const TransactionType = z.enum(['SALE', 'RENT']);
export type TransactionType = z.infer<typeof TransactionType>;

export const PropertyType = z.enum([
  'APARTMENT',
  'HOUSE',
  'LAND',
  'OFFICE',
  'RETAIL',
  'INDUSTRIAL',
  'WAREHOUSE',
  'HOSPITALITY',
  'PARKING',
  'OTHER_COMMERCIAL',
  'OTHER',
]);
export type PropertyType = z.infer<typeof PropertyType>;

export const PaymentMethod = z.enum(['BANK_TRANSFER', 'CASH', 'MIXED', 'LOAN', 'OTHER']);
export type PaymentMethod = z.infer<typeof PaymentMethod>;

export const CaseStage = z.enum([
  'INITIAL_CONTACT',
  'DATA_COLLECTION',
  'CHECKS_IN_PROGRESS',
  'OFFER_ACCEPTED',
  'RESERVATION',
  'CONTRACT',
  'COMPLETED',
  'TERMINATED',
]);
export type CaseStage = z.infer<typeof CaseStage>;

export const AmlApplicability = z.enum([
  'APPLICABLE',
  'NOT_APPLICABLE_RENT_THRESHOLD',
  'MANUALLY_ACTIVATED',
]);
export type AmlApplicability = z.infer<typeof AmlApplicability>;

export const ComplianceStatus = z.enum([
  'NOT_STARTED',
  'IN_PROGRESS',
  'REVIEW_REQUIRED',
  'BLOCKED',
  'COMPLETED',
]);
export type ComplianceStatus = z.infer<typeof ComplianceStatus>;

export const PartyType = z.enum(['NATURAL', 'LEGAL']);
export type PartyType = z.infer<typeof PartyType>;

export const PartyRole = z.enum([
  'BUYER',
  'SELLER',
  'TENANT',
  'LANDLORD',
  'REPRESENTATIVE',
  'PAYER',
  /** Natural person who owns or controls a legal-entity party (added from registry data). */
  'BENEFICIAL_OWNER',
  'OTHER',
]);
export type PartyRole = z.infer<typeof PartyRole>;

export const CddScope = z.enum(['FULL', 'RELIANCE']);
export const CddStatus = z.enum(['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED']);

/** Monthly rent from which real-estate agents must apply AML procedures to lettings (EUR). */
export const RENT_AML_THRESHOLD_EUR = 10_000;

/**
 * Whether AML procedures apply to a transaction. Sales always; lettings from EUR 10 000 per month.
 * The database applies the same rule (migration 0006) and has the final word.
 */
export function amlApplicability(
  transactionType: TransactionType,
  monthlyRent: number | null | undefined,
): Exclude<AmlApplicability, 'MANUALLY_ACTIVATED'> {
  return transactionType === 'RENT' && (monthlyRent ?? 0) < RENT_AML_THRESHOLD_EUR
    ? 'NOT_APPLICABLE_RENT_THRESHOLD'
    : 'APPLICABLE';
}

const CountryCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/);

const Money = z.coerce.number().positive().max(1_000_000_000_000);

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullish();

/** Case data entered by a broker; derived columns (reference, regime, applicability) are not. */
export const CaseFields = z.object({
  transactionType: TransactionType,
  propertyType: PropertyType,
  propertyAddress: z.string().trim().min(1).max(500),
  transactionValue: Money.nullish(),
  monthlyRent: Money.nullish(),
  paymentMethod: PaymentMethod.nullish(),
  paymentMethodOther: optionalText(200),
});

export const CreateCaseInput = CaseFields.extend({
  /** Defaults to the creator. Assigning someone else needs the case.assign permission. */
  responsibleUserId: z.uuid().optional(),
}).superRefine(checkAmounts);
export type CreateCaseInput = z.input<typeof CreateCaseInput>;

export const UpdateCaseInput = CaseFields.extend({
  stage: CaseStage,
  offerAcceptedAt: z.iso.datetime({ offset: true }).nullish(),
  responsibleUserId: z.uuid(),
})
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');
export type UpdateCaseInput = z.input<typeof UpdateCaseInput>;

function checkAmounts(
  v: {
    transactionType: TransactionType;
    transactionValue?: number | null;
    monthlyRent?: number | null;
    paymentMethod?: string | null;
    paymentMethodOther?: string | null;
  },
  ctx: z.RefinementCtx,
) {
  if (v.transactionType === 'SALE' && v.transactionValue == null)
    ctx.addIssue({ code: 'custom', path: ['transactionValue'], message: 'required for a sale' });
  if (v.transactionType === 'RENT' && v.monthlyRent == null)
    ctx.addIssue({ code: 'custom', path: ['monthlyRent'], message: 'required for a letting' });
  if (v.paymentMethod === 'OTHER' && !v.paymentMethodOther)
    ctx.addIssue({ code: 'custom', path: ['paymentMethodOther'], message: 'describe the method' });
}

export const ActivateAmlInput = z.object({ reason: z.string().trim().min(10).max(2000) });

export const NaturalPartyInput = z.object({
  partyType: z.literal('NATURAL'),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  birthDate: z.iso.date().nullish(),
  /** Stored encrypted; foreign codes accepted as entered (letters and digits). */
  personalCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{4,30}$/)
    .nullish(),
  citizenships: z.array(CountryCode).max(5).default([]),
  residenceCountry: CountryCode.nullish(),
});

export const LegalPartyInput = z.object({
  partyType: z.literal('LEGAL'),
  companyName: z.string().trim().min(1).max(300),
  companyCode: z.string().trim().min(1).max(50).nullish(),
  legalForm: optionalText(100),
  registrationCountry: CountryCode,
  registeredAddress: optionalText(500),
});

export const PartyInput = z.discriminatedUnion('partyType', [NaturalPartyInput, LegalPartyInput]);
export type PartyInput = z.input<typeof PartyInput>;

/**
 * Transaction-specific KYC answers for a party (version 1). Kept per case, because purpose and
 * source of funds belong to a transaction, not to the person.
 */
export const KycAnswers = z.object({
  version: z.literal(1).default(1),
  purpose: optionalText(1000),
  sourceOfFunds: optionalText(1000),
  actsOnOwnBehalf: z.boolean().nullish(),
  /** The party's own statement; screening results are recorded separately. */
  pepSelfDeclared: z.boolean().nullish(),
  notes: optionalText(2000),
});
export type KycAnswers = z.infer<typeof KycAnswers>;

/** Documented reliance on CDD performed by another obliged entity (e.g. the other side's broker). */
export const Reliance = z.object({
  entityName: z.string().trim().min(1).max(300),
  entityCode: optionalText(50),
  notes: optionalText(2000),
});

export const AddCasePartyInput = z
  .object({
    /** An existing party of the organization, or a new one. */
    partyId: z.uuid().optional(),
    party: PartyInput.optional(),
    role: PartyRole,
    isOurClient: z.boolean(),
    representedByOtherBroker: z.boolean().default(false),
    cddScope: CddScope.default('FULL'),
    reliance: Reliance.nullish(),
    kyc: KycAnswers.default({ version: 1 }),
  })
  .refine((v) => (v.partyId === undefined) !== (v.party === undefined), {
    message: 'give either partyId or party',
  })
  .refine((v) => v.cddScope !== 'RELIANCE' || v.reliance, {
    path: ['reliance'],
    message: 'describe the reliance',
  });
export type AddCasePartyInput = z.input<typeof AddCasePartyInput>;

export const UpdateCasePartyInput = z
  .object({
    isOurClient: z.boolean(),
    representedByOtherBroker: z.boolean(),
    cddScope: CddScope,
    reliance: Reliance.nullable(),
    cddStatus: CddStatus,
    kyc: KycAnswers,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');
export type UpdateCasePartyInput = z.input<typeof UpdateCasePartyInput>;
