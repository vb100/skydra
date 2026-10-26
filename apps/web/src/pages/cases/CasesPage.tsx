import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { api } from '../../api';
import { Page } from '../../ui';
import type { CaseSummary } from './types';

export function CasesPage({ canCreate }: { canCreate: boolean }) {
  const { t } = useTranslation();
  const cases = useQuery({
    queryKey: ['cases'],
    queryFn: () => api<CaseSummary[]>('GET', '/cases'),
  });

  return (
    <Page title={t('cases.title')}>
      <nav className="actions">
        <Link to="/">{t('common.back')}</Link>
        {canCreate && <Link to="/cases/new">{t('cases.create')}</Link>}
      </nav>
      {cases.data?.length === 0 && <p className="muted">{t('cases.none')}</p>}
      <ul className="list">
        {cases.data?.map((c) => (
          <li key={c.id}>
            <Link to={`/cases/${c.id}`} className="card">
              <strong>
                {c.reference} · {t(`transactionTypes.${c.transactionType}`)}
              </strong>
              <span>{c.propertyAddress}</span>
              <span className="muted">
                {t(`stages.${c.stage}`)} · {t('cases.aml')}:{' '}
                {t(`amlApplicability.${c.amlApplicability}`)} ·{' '}
                {t('cases.partyCount', { count: c.partyCount })}
              </span>
              <span className="muted">
                {t('cases.responsible')}: {c.responsibleName}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Page>
  );
}
