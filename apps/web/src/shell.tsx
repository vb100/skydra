import type { HealthResponse } from '@skydra/shared';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, useNavigate } from 'react-router';
import { api, type Me, type Membership } from './api';
import { useRefreshMe } from './session';

/** Top bar for signed-in pages: organization, navigation, the user and sign-out. */
export function AppShell(props: {
  me: Me;
  active: Membership | undefined;
  canSeeCases: boolean;
  canSeeMembers: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const refreshMe = useRefreshMe();
  const { me, active } = props;
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => api<HealthResponse>('GET', '/health'),
    staleTime: Infinity,
  });

  async function logout() {
    await api('POST', '/auth/logout');
    await refreshMe();
    navigate('/login');
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-inner">
          <NavLink to="/" className="topbar-brand">
            {t('app.name')}
          </NavLink>
          {active && <span className="topbar-org">{active.organizationName}</span>}
          {health.data?.simulatedProviders && <span className="badge badge-demo">DEMO</span>}
          <nav className="topbar-nav">
            {props.canSeeCases && <NavLink to="/cases">{t('cases.link')}</NavLink>}
            {props.canSeeMembers && <NavLink to="/members">{t('members.link')}</NavLink>}
            {me.isPlatformAdmin && <NavLink to="/platform">{t('home.platform')}</NavLink>}
          </nav>
          <span className="topbar-user">{me.user.fullName}</span>
          <button type="button" className="secondary small" onClick={() => void logout()}>
            {t('common.logout')}
          </button>
        </div>
      </header>
      {props.children}
    </div>
  );
}
