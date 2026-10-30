import { ComplianceStatus } from '@skydra/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { api } from '../../api';
import { Badge, Page } from '../../ui';
import type { CaseSummary } from './types';

export function CasesPage({ canCreate }: { canCreate: boolean }) {
  const { t } = useTranslation();
  const cases = useQuery({
    queryKey: ['cases'],
    queryFn: () => api<CaseSummary[]>('GET', '/cases'),
  });
  const [status, setStatus] = useState<ComplianceStatus | null>(null);
  const all = cases.data ?? [];
  const shown = status ? all.filter((c) => c.complianceStatus === status) : all;
  const count = (s: ComplianceStatus) => all.filter((c) => c.complianceStatus === s).length;

  return (
    <Page
      title={t('cases.title')}
      wide
      actions={
        canCreate && (
          <Link to="/cases/new" className="button-link primary">
            + {t('cases.create')}
          </Link>
        )
      }
    >
      {all.length > 0 && (
        <div className="filters" role="group" aria-label={t('cases.compliance')}>
          <button type="button" aria-pressed={status === null} onClick={() => setStatus(null)}>
            {t('cases.all', { count: all.length })}
          </button>
          {ComplianceStatus.options
            .filter((s) => count(s) > 0)
            .map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={status === s}
                onClick={() => setStatus(s)}
              >
                {t(`complianceStatuses.${s}`)} ({count(s)})
              </button>
            ))}
        </div>
      )}
      {all.length === 0 && cases.isSuccess && <p className="muted">{t('cases.none')}</p>}
      <ul className="list">
        {shown.map((c) => (
          <li key={c.id}>
            <Link to={`/cases/${c.id}`} className="card case-row">
              <strong>
                {c.reference} · {t(`transactionTypes.${c.transactionType}`)} ·{' '}
                {t(`propertyTypes.${c.propertyType}`)}
              </strong>
              <span className="badges">
                <Badge kind={c.complianceStatus}>
                  {t(`complianceStatuses.${c.complianceStatus}`)}
                </Badge>
                {c.riskLevel && (
                  <Badge kind={`risk-${c.riskLevel}`}>{t(`riskLevels.${c.riskLevel}`)}</Badge>
                )}
              </span>
              <span>{c.propertyAddress}</span>
              <span className="muted">{t(`stages.${c.stage}`)}</span>
              <span className="muted">
                {t(`amlApplicability.${c.amlApplicability}`)} ·{' '}
                {t('cases.partyCount', { count: c.partyCount })}
              </span>
              <span className="muted">{c.responsibleName}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Page>
  );
}
