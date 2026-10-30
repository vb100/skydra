import { ComplianceStatus } from '@skydra/shared';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { formatDate } from '../../format';
import { Badge, Page } from '../../ui';
import { TAB_OF_ITEM } from './NextStepCard';
import { Avatar } from './PartyCard';
import type { CaseListItem } from './types';
import { caseLink, useCases } from './useCases';

type SortKey = 'reference' | 'client' | 'status' | 'risk' | 'updated';
const RISK_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
const STATUS_ORDER = ['BLOCKED', 'REVIEW_REQUIRED', 'IN_PROGRESS', 'NOT_STARTED', 'COMPLETED'];

/** Lower case without diacritics, so "zirmunu" finds "Žirmūnų". */
const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

const compare: Record<SortKey, (a: CaseListItem, b: CaseListItem) => number> = {
  reference: (a, b) => a.reference.localeCompare(b.reference),
  client: (a, b) => (a.clientName ?? '').localeCompare(b.clientName ?? '', 'lt'),
  status: (a, b) =>
    STATUS_ORDER.indexOf(a.complianceStatus) - STATUS_ORDER.indexOf(b.complianceStatus),
  risk: (a, b) =>
    (a.riskLevel ? RISK_ORDER[a.riskLevel] : 3) - (b.riskLevel ? RISK_ORDER[b.riskLevel] : 3),
  updated: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
};

export function CasesPage({ canCreate }: { canCreate: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const cases = useCases();
  const [status, setStatus] = useState<ComplianceStatus | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'updated', desc: true });

  const all = useMemo(() => cases.data ?? [], [cases.data]);
  const shown = useMemo(() => {
    const q = fold(query.trim());
    const rows = all.filter(
      (c) =>
        (!status || c.complianceStatus === status) &&
        (!q || [c.reference, c.propertyAddress, ...c.partyNames].some((v) => fold(v).includes(q))),
    );
    const sorted = [...rows].sort(compare[sort.key]);
    return sort.desc ? sorted.reverse() : sorted;
  }, [all, status, query, sort]);
  const count = (s: ComplianceStatus) => all.filter((c) => c.complianceStatus === s).length;

  const nextText = (c: CaseListItem) =>
    c.amlApplicability === 'NOT_APPLICABLE_RENT_THRESHOLD'
      ? t('casesTable.notApplicable')
      : c.next
        ? `${t(`checklist.todo.${c.next.item}`)}${c.next.partyName ? ` · ${c.next.partyName}` : ''}`
        : c.complianceStatus === 'COMPLETED'
          ? t('casesTable.completed')
          : '';
  const linkOf = (c: CaseListItem) => caseLink(c.id, c.next ? TAB_OF_ITEM[c.next.item] : undefined);

  const header = (key: SortKey, label: string) => (
    <th aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <button
        type="button"
        className="sort"
        onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key === 'updated' }))}
        aria-label={t('casesTable.sortBy', { column: label })}
      >
        {label}
        <span aria-hidden="true">{sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : ''}</span>
      </button>
    </th>
  );

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
      <div className="list-toolbar">
        <input
          type="search"
          className="search"
          placeholder={t('casesTable.search')}
          aria-label={t('casesTable.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
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
      </div>

      {all.length === 0 && cases.isSuccess && <p className="muted">{t('cases.none')}</p>}
      {all.length > 0 && shown.length === 0 && <p className="muted">{t('casesTable.noResults')}</p>}

      {shown.length > 0 && (
        <>
          <div className="card static table-card">
            <table className="data-table">
              <thead>
                <tr>
                  {header('reference', t('casesTable.reference'))}
                  {header('client', t('casesTable.client'))}
                  <th>{t('casesTable.property')}</th>
                  <th>{t('casesTable.next')}</th>
                  {header('status', t('casesTable.status'))}
                  {header('risk', t('casesTable.risk'))}
                  <th>{t('casesTable.responsible')}</th>
                  {header('updated', t('casesTable.updated'))}
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.id} onClick={() => navigate(linkOf(c))}>
                    <td>
                      <Link to={linkOf(c)} className="ref" onClick={(e) => e.stopPropagation()}>
                        {c.reference}
                      </Link>
                      <span className="muted">{t(`transactionTypes.${c.transactionType}`)}</span>
                    </td>
                    <td>
                      <strong>{c.clientName ?? '–'}</strong>
                      {c.partyNames.length > 1 && (
                        <span className="muted">+{c.partyNames.length - 1}</span>
                      )}
                    </td>
                    <td>
                      <span>{c.propertyAddress}</span>
                      <span className="muted">{t(`propertyTypes.${c.propertyType}`)}</span>
                    </td>
                    <td
                      className={`next-cell ${c.complianceStatus === 'BLOCKED' ? 'blocked' : ''}`}
                    >
                      {nextText(c)}
                    </td>
                    <td>
                      <Badge kind={c.complianceStatus}>
                        {t(`complianceStatuses.${c.complianceStatus}`)}
                      </Badge>
                    </td>
                    <td>
                      {c.riskLevel && (
                        <Badge kind={`risk-${c.riskLevel}`}>{t(`riskLevels.${c.riskLevel}`)}</Badge>
                      )}
                    </td>
                    <td>
                      <span className="person">
                        <Avatar name={c.responsibleName} legal={false} />
                        {c.responsibleName}
                      </span>
                    </td>
                    <td className="num muted">{formatDate(c.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Narrow screens: the same rows as cards. */}
          <ul className="list case-cards">
            {shown.map((c) => (
              <li key={c.id}>
                <Link to={linkOf(c)} className="card case-row">
                  <strong>
                    {c.reference} · {c.clientName ?? t(`transactionTypes.${c.transactionType}`)}
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
                  <span className="muted">{nextText(c)}</span>
                </Link>
              </li>
            ))}
          </ul>
          {shown.length !== all.length && (
            <p className="muted">
              {t('casesTable.count', { shown: shown.length, total: all.length })}
            </p>
          )}
        </>
      )}
    </Page>
  );
}
