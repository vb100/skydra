import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { formatDateTime } from '../../format';
import type { CaseHistoryEntry } from './types';

/** Value labels for the few details the history returns (levels, roles, decisions…). */
const VALUE_GROUPS = [
  'riskLevels',
  'partyRoles',
  'complianceStatuses',
  'approvals.statuses',
  'escalations.resolutions',
  'screening.reviewStatuses',
  'identity.statuses',
  'identity.documentTypes',
];

/** The case's audit trail as a timeline, newest first. */
export function HistoryPanel({ caseId }: { caseId: string }) {
  const { t, i18n } = useTranslation();
  const history = useQuery({
    queryKey: ['history', caseId],
    queryFn: () => api<CaseHistoryEntry[]>('GET', `/cases/${caseId}/history`),
  });
  const value = (v: string | number | boolean) => {
    if (typeof v !== 'string') return String(v);
    const group = VALUE_GROUPS.find((g) => i18n.exists(`${g}.${v}`));
    return group ? t(`${group}.${v}`) : v;
  };

  if (history.data?.length === 0) return <p className="muted">{t('history.empty')}</p>;
  return (
    <ol className="timeline">
      {history.data?.map((h) => (
        <li key={h.seq}>
          <span className="timeline-time">{formatDateTime(h.occurredAt)}</span>
          <span className="timeline-what">
            {t(`auditActions.${h.action}`, { defaultValue: h.action })}
            {Object.entries(h.details).map(([k, v]) => (
              <span key={k} className="muted">
                {' · '}
                {t(`history.details.${k}`, { defaultValue: k })}: {value(v)}
              </span>
            ))}
          </span>
          <span className="muted">{h.actorName ?? t('history.system')}</span>
        </li>
      ))}
    </ol>
  );
}
