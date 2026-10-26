import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { api, type Me } from '../api';
import { useRefreshMe } from '../session';
import { Page } from '../ui';

export function HomePage({ me }: { me: Me }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const refreshMe = useRefreshMe();
  const active = me.memberships.find((m) => m.organizationId === me.activeOrganizationId);

  async function logout() {
    await api('POST', '/auth/logout');
    await refreshMe();
    navigate('/login');
  }

  return (
    <Page title={t('home.title')}>
      <p>{t('home.signedInAs', { name: me.user.fullName, email: me.user.email })}</p>
      {active && (
        <section className="card static">
          <p className="muted">{t('organizations.active')}</p>
          <h2>{active.organizationName}</h2>
          <p>
            {t('home.plan')}: {t(`plans.${active.planCode}`)}
          </p>
          <p>
            {t('home.roles')}: {active.roles.map((r) => t(`roles.${r}`)).join(', ')}
          </p>
          {active.permissions.length > 0 && (
            <p>
              {t('home.permissions')}:{' '}
              {active.permissions.map((p) => t(`permissions.${p}`)).join(', ')}
            </p>
          )}
          <p className="muted">{t('home.nextSteps')}</p>
        </section>
      )}
      <nav className="stack">
        {me.memberships.length > 1 && (
          <Link to="/select-organization">{t('organizations.change')}</Link>
        )}
        {me.isPlatformAdmin && <Link to="/platform">{t('home.platform')}</Link>}
        <button type="button" className="secondary" onClick={() => void logout()}>
          {t('common.logout')}
        </button>
      </nav>
    </Page>
  );
}
