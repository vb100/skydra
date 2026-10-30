import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { Me } from '../api';
import { caseWorker } from '../session';
import { Page } from '../ui';

export function HomePage({ me }: { me: Me }) {
  const { t } = useTranslation();
  const active = me.memberships.find((m) => m.organizationId === me.activeOrganizationId);

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
        </section>
      )}
      <nav className="stack">
        {active &&
          (caseWorker(active.roles) ||
            active.permissions.some((p) =>
              ['CASE_VIEW_ALL', 'APPROVER', 'AML_OFFICER'].includes(p),
            )) && <Link to="/cases">{t('cases.link')}</Link>}
        {me.memberships.length > 1 && (
          <Link to="/select-organization">{t('organizations.change')}</Link>
        )}
        {active && (active.roles.includes('ORG_ADMIN') || active.roles.includes('MANAGER')) && (
          <Link to="/members">{t('members.link')}</Link>
        )}
        {me.isPlatformAdmin && <Link to="/platform">{t('home.platform')}</Link>}
      </nav>
    </Page>
  );
}
