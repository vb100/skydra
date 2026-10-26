/** Shapes returned by /api/cases (see apps/api/src/cases). */
export type CaseSummary = {
  id: string;
  reference: string;
  transactionType: 'SALE' | 'RENT';
  propertyType: string;
  propertyAddress: string;
  stage: string;
  amlApplicability: 'APPLICABLE' | 'NOT_APPLICABLE_RENT_THRESHOLD' | 'MANUALLY_ACTIVATED';
  complianceStatus: string;
  responsibleUserId: string;
  responsibleName: string;
  partyCount: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | null;
  updatedAt: string;
};

export type Party = {
  id: string;
  partyType: 'NATURAL' | 'LEGAL';
  displayName: string;
  birthDate: string | null;
  personalCodeMasked: string | null;
  citizenships: string[];
  companyCode: string | null;
  registrationCountry: string | null;
};

export type CaseParty = {
  id: string;
  role: string;
  isOurClient: boolean;
  representedByOtherBroker: boolean;
  cddScope: 'FULL' | 'RELIANCE';
  reliance: { entityName: string; entityCode?: string | null } | null;
  cddStatus: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';
  kyc: {
    purpose?: string | null;
    sourceOfFunds?: string | null;
    actsOnOwnBehalf?: boolean | null;
    pepSelfDeclared?: boolean | null;
  };
  party: Party;
};

export type CaseDetail = CaseSummary & {
  transactionValue: string | null;
  monthlyRent: string | null;
  paymentMethod: string | null;
  paymentMethodOther: string | null;
  offerAcceptedAt: string | null;
  amlActivationReason: string | null;
  legalRegime: 'PPTFPI' | 'AMLR';
  parties: CaseParty[];
};

export type ScreeningMatch = {
  id: string;
  name: string;
  score: string | null;
  categories: string[];
  details: Record<string, unknown>;
  reviewStatus: 'OPEN' | 'FALSE_POSITIVE' | 'TRUE_POSITIVE';
  reviewJustification: string | null;
  reviewedAt: string | null;
};

export type ScreeningCheck = {
  id: string;
  casePartyId: string;
  provider: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  matchCount: number | null;
  requestedAt: string;
  matches: ScreeningMatch[];
};

export type ChecklistEntry = { casePartyId: string | null; item: string; ok: boolean };

export type IdentityVerification = {
  id: string;
  casePartyId: string;
  method: 'REMOTE' | 'IN_PERSON';
  provider: string;
  status: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'FAILED';
  documentType: string | null;
  documentNumberMasked: string | null;
  requestedAt: string;
};

export type Approval = {
  id: string;
  reason: string;
  status: 'OPEN' | 'APPROVED' | 'REJECTED';
  requestedByName: string;
  decidedByName: string | null;
  decisionJustification: string | null;
};

export type Escalation = {
  id: string;
  reason: string;
  status: 'OPEN' | 'CLEARED' | 'REPORTED';
  requestedByName: string;
  resolvedByName: string | null;
  resolutionNotes: string | null;
};

/** What the signed-in member may do beyond working on cases (mirrors access/policy.ts). */
export type CaseAbilities = { canAssign: boolean; canApprove: boolean; isAmlOfficer: boolean };

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export type RiskFactor = {
  code: string;
  group: string;
  level: RiskLevel;
  mandatory: boolean;
  matched: boolean;
};

export type RiskAssessment = {
  id: string;
  ruleSetCode: string;
  ruleSetVersion: string;
  calculatedLevel: RiskLevel;
  finalLevel: RiskLevel;
  justification: string | null;
  factors: RiskFactor[];
  nextReviewOn: string;
  assessedByName: string;
  assessedAt: string;
};

export type RiskOverview = {
  ruleSet: { code: string; version: string; isDemo: boolean };
  preview: {
    calculatedLevel: RiskLevel;
    mandatoryLevel: RiskLevel | null;
    escalatedByMediumCount: boolean;
    factors: RiskFactor[];
  };
  current: RiskAssessment | null;
  stale: boolean;
  history: RiskAssessment[];
};
