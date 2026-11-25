import type { HealthResponse } from '@skydra/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, ApiError, type Me } from './api';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api<Me>('GET', '/auth/me');
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    retry: false,
  });
}

export function useRefreshMe() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: ['me'] });
}

/** Server status; `simulatedProviders` marks a demo environment. Public, fetched once. */
export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: () => api<HealthResponse>('GET', '/health'),
    staleTime: Infinity,
  });
}

/** Known business-rule refusals from the API (English, from the database) → LT texts. */
const RULES: [RegExp, string][] = [
  [/purpose, acting on own behalf/, 'cddAnswers'],
  [/identity has not been verified/, 'cddIdentity'],
  [/before moving to the contract/, 'contract'],
  [/document has expired/, 'documentExpired'],
  [/someone other than the responsible/, 'fourEyes'],
  [/approver permission/, 'approverOnly'],
  [/only the AML officer/, 'amlOfficerOnly'],
  [/already been (decided|resolved|reviewed)/, 'alreadyDecided'],
  [/approval request is already open/, 'approvalOpen'],
  [/does not need an approval/, 'noApprovalNeeded'],
  [/activate them first/, 'amlNotApplicable'],
  [/add the parties/, 'addParties'],
  [/already has this role/, 'duplicateRole'],
  [/not available yet/, 'providerUnavailable'],
  [/assign a case to another member/, 'assign'],
  [/assess the risk before/, 'assessRiskFirst'],
  [/confirmed sanctions/, 'sanctionsNoApproval'],
  [/enter the company code/, 'companyCode'],
  [/not found in the registries/, 'companyNotFound'],
  [/newer registry data/, 'newerOwnership'],
  [/added from registry data/, 'uboManual'],
  [/no discrepancy to resolve/, 'noDiscrepancy'],
  [/before exporting the case/, 'exportCompleted'],
  [/below the mandatory minimum/, 'riskMinimum'],
  [/lowering the calculated risk/, 'riskLowering'],
  [/needs a justification/, 'riskJustification'],
  [/reopen it to make changes/, 'caseLocked'],
  [/only a completed case is reopened|already reopened/, 'reopenOnly'],
  [/cannot be approved yet/, 'decisionNotReady'],
  [/approve with enhanced measures/, 'decisionEnhanced'],
  [/terminate instead/, 'decisionTerminate'],
  [/decline instead/, 'decisionDecline'],
  [/report the suspicious indicators/, 'decisionReportFirst'],
  [/closed by (an earlier decision|a decision)/, 'caseClosed'],
  [/already approved on its latest/, 'decisionAlready'],
  [/only PDF, JPEG/, 'documentType'],
  [/larger than 20 MB/, 'documentSize'],
  [/file storage is not configured/, 'storageUnavailable'],
  [/latest check of this party is complete/, 'manualNotNeeded'],
  [/search date cannot be in the future/, 'manualFutureDate'],
  [/not a document of this case/, 'manualEvidence'],
  [/logo must be a PNG or JPEG|logo is larger/, 'logoFile'],
  [/only an organization administrator/, 'profileAdminOnly'],
];

/** Translated message for an API error code. */
export function useErrorMessage() {
  const { t } = useTranslation();
  return (error: unknown) => {
    if (error instanceof ApiError) {
      if (error.code === 'forbidden' && error.detail) return error.detail;
      if (error.code === 'rule_violation' && error.detail) {
        const rule = RULES.find(([pattern]) => pattern.test(error.detail!));
        if (rule) return t(`rules.${rule[1]}`);
      }
      return t(`errors.${error.code}`, { defaultValue: t('errors.unknown') });
    }
    return t('errors.unknown');
  };
}

/** Brokers and managers work on cases (mirrors access/policy.ts; for navigation only). */
export function caseWorker(roles: string[]): boolean {
  return roles.includes('BROKER') || roles.includes('MANAGER');
}
