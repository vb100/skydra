import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { api } from '../api';
import { useMe, useRefreshMe } from '../session';
import { Page } from '../ui';

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
  return (
    <Page title={t('organizations.title')}>
      {memberships.length === 0 && <p>{t('organizations.empty')}</p>}
      <ul className="list">
        {memberships.map((m) => (
          <li key={m.organizationId}>
            <button type="button" className="card" onClick={() => void choose(m.organizationId)}>
              <strong>{m.organizationName}</strong>
              <span className="muted">{t(`plans.${m.planCode}`)}</span>
            </button>
          </li>
        ))}
      </ul>
    </Page>
  );
}
