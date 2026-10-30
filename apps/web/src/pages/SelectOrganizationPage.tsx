import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { api } from '../api';
import { useMe, useRefreshMe } from '../session';
import { Page } from '../ui';
import { Avatar } from './cases/PartyCard';

export function SelectOrganizationPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const me = useMe();
  const refreshMe = useRefreshMe();

  async function choose(organizationId: string) {
    await api('POST', '/auth/organization', { organizationId });
    await refreshMe();
    navigate('/');
  }

  const memberships = me.data?.memberships ?? [];
  const activeId = me.data?.activeOrganizationId;
  return (
    <Page title={t('organizations.title')}>
      {memberships.length === 0 ? (
        <p>{t('organizations.empty')}</p>
      ) : (
        memberships.length > 1 && <p className="page-lead">{t('organizations.lead')}</p>
      )}
      <ul className="list">
        {memberships.map((m) => (
          <li key={m.organizationId}>
            <button
              type="button"
              className="card org-choice"
              onClick={() => void choose(m.organizationId)}
              aria-current={m.organizationId === activeId ? 'true' : undefined}
            >
              <Avatar name={m.organizationName} legal />
              <span className="org-choice-text">
                <strong>{m.organizationName}</strong>
                <span className="muted">
                  {t(`plans.${m.planCode}`)} · {m.roles.map((r) => t(`roles.${r}`)).join(', ')}
                </span>
              </span>
              {m.organizationId === activeId && (
                <span className="badge badge-completed">{t('organizations.current')}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </Page>
  );
}
