import type { ScreeningStatus } from '@skydra/shared';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { api } from '../api';
import { formatDate } from '../format';
import { Page } from '../ui';
import { Avatar, ScreeningBadge } from './cases/PartyCard';

export type ClientListItem = {
  id: string;
  partyType: 'NATURAL' | 'LEGAL';
  displayName: string;
  code: string | null;
  countries: string[];
  roles: string[];
  isOurClient: boolean;
  cases: number;
  openCases: number;
  lastActivityAt: string | null;
  screening: ScreeningStatus;
};

/** Lower case without diacritics, so "zirmunu" finds "Žirmūnų". */
const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

/**
 * The simple clients list (client answer Q7): every person and company of the member's visible
 * cases, once each, with their roles, cases and the most serious screening status.
 */
export function ClientsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const clients = useQuery({
    queryKey: ['clients'],
    queryFn: () => api<ClientListItem[]>('GET', '/clients'),
  });
  const [query, setQuery] = useState('');
  const [type, setType] = useState<'NATURAL' | 'LEGAL' | null>(null);

  const all = useMemo(() => clients.data ?? [], [clients.data]);
  const shown = useMemo(() => {
    const q = fold(query.trim());
    return all.filter(
      (c) =>
        (!type || c.partyType === type) &&
        (!q || fold(`${c.displayName} ${c.code ?? ''}`).includes(q)),
    );
  }, [all, query, type]);
  const count = (k: 'NATURAL' | 'LEGAL') => all.filter((c) => c.partyType === k).length;
  const roles = (c: ClientListItem) => c.roles.map((r) => t(`partyRoles.${r}`)).join(', ');
  const casesText = (c: ClientListItem) =>
    t('clients.casesValue', { open: c.openCases, total: c.cases });

  return (
    <Page title={t('clients.title')} wide>
      <p className="muted page-lead">{t('clients.subtitle')}</p>
      <div className="list-toolbar">
        <input
          type="search"
          className="search"
          placeholder={t('clients.search')}
          aria-label={t('clients.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {all.length > 0 && (
          <div className="filters" role="group" aria-label={t('clients.title')}>
            <button type="button" aria-pressed={type === null} onClick={() => setType(null)}>
              {t('clients.all', { count: all.length })}
            </button>
            {(['NATURAL', 'LEGAL'] as const)
              .filter((k) => count(k) > 0)
              .map((k) => (
                <button key={k} type="button" aria-pressed={type === k} onClick={() => setType(k)}>
                  {t(k === 'NATURAL' ? 'clients.natural' : 'clients.legal', { count: count(k) })}
                </button>
              ))}
          </div>
        )}
      </div>

      {clients.isSuccess && all.length === 0 && <p className="muted">{t('clients.none')}</p>}
      {all.length > 0 && shown.length === 0 && <p className="muted">{t('clients.noResults')}</p>}

      {shown.length > 0 && (
        <>
          <div className="card static table-card">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('clients.name')}</th>
                  <th>{t('clients.code')}</th>
                  <th>{t('clients.roles')}</th>
                  <th>{t('clients.cases')}</th>
                  <th>{t('clients.screening')}</th>
                  <th>{t('clients.lastActivity')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.id} onClick={() => navigate(`/clients/${c.id}`)}>
                    <td>
                      <span className="person">
                        <Avatar name={c.displayName} legal={c.partyType === 'LEGAL'} />
                        <Link to={`/clients/${c.id}`} onClick={(e) => e.stopPropagation()}>
                          <strong>{c.displayName}</strong>
                        </Link>
                      </span>
                      <span className="muted">
                        {t(`parties.${c.partyType}`)}
                        {c.isOurClient && ` · ${t('clients.ourClient')}`}
                      </span>
                    </td>
                    <td className="num">{c.code ?? '–'}</td>
                    <td>{roles(c)}</td>
                    <td>{casesText(c)}</td>
                    <td>
                      <ScreeningBadge status={c.screening} />
                    </td>
                    <td className="num muted">{formatDate(c.lastActivityAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Narrow screens: the same rows as cards. */}
          <ul className="list case-cards">
            {shown.map((c) => (
              <li key={c.id}>
                <Link to={`/clients/${c.id}`} className="card case-row">
                  <strong>{c.displayName}</strong>
                  <span className="badges">
                    <ScreeningBadge status={c.screening} />
                  </span>
                  <span>
                    {t(`parties.${c.partyType}`)}
                    {c.code && ` · ${c.code}`}
                  </span>
                  <span className="muted">
                    {roles(c)} · {casesText(c)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {shown.length !== all.length && (
            <p className="muted">
              {t('clients.count', { shown: shown.length, total: all.length })}
            </p>
          )}
        </>
      )}
    </Page>
  );
}
