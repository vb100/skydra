import type { ReactNode } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, useNavigate } from 'react-router';
import { api, type Me, type Membership } from './api';
import { Icon } from './icons';
import { useHealth, useRefreshMe } from './session';
import { ThemeToggle } from './theme';
import { Avatar } from './pages/cases/PartyCard';

/**
 * Top bar for signed-in pages: organization, navigation, the user and sign-out. On phones the
 * navigation and account actions fold into a menu under the bar.
 */
export function AppShell(props: {
  me: Me;
  active: Membership | undefined;
  canSeeCases: boolean;
  canSeeDashboard: boolean;
  canSeeMembers: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const refreshMe = useRefreshMe();
  const health = useHealth();
  const [open, setOpen] = useState(false);
  const { me, active } = props;
  const close = () => setOpen(false);

  async function logout() {
    await api('POST', '/auth/logout');
    await refreshMe();
    navigate('/login');
  }

  return (
    <div className="shell">
      <header className="topbar" onKeyDown={(e) => e.key === 'Escape' && close()}>
        <div className="topbar-inner">
          <NavLink to="/" className="topbar-brand" onClick={close}>
            {t('app.name')}
          </NavLink>
          {active && <span className="topbar-org">{active.organizationName}</span>}
          {health.data?.simulatedProviders && <span className="badge badge-demo">DEMO</span>}
          <button
            type="button"
            className="ghost menu-toggle"
            aria-expanded={open}
            aria-controls="topbar-menu"
            aria-label={open ? t('shell.closeMenu') : t('shell.openMenu')}
            onClick={() => setOpen(!open)}
          >
            <Icon name={open ? 'close' : 'menu'} size={22} />
          </button>
          <div id="topbar-menu" className={`topbar-menu ${open ? 'open' : ''}`}>
            <nav className="topbar-nav" aria-label={t('shell.navigation')}>
              {props.canSeeCases && (
                <NavLink to="/" end onClick={close}>
                  {t('work.link')}
                </NavLink>
              )}
              {props.canSeeCases && (
                <NavLink to="/cases" onClick={close}>
                  {t('cases.link')}
                </NavLink>
              )}
              {props.canSeeDashboard && (
                <NavLink to="/dashboard" onClick={close}>
                  {t('dashboard.link')}
                </NavLink>
              )}
              {props.canSeeMembers && (
                <NavLink to="/members" onClick={close}>
                  {t('members.link')}
                </NavLink>
              )}
              {me.isPlatformAdmin && (
                <NavLink to="/platform" onClick={close}>
                  {t('home.platform')}
                </NavLink>
              )}
            </nav>
            <div className="topbar-account">
              <span className="topbar-user">
                <Avatar name={me.user.fullName} legal={false} />
                <span className="topbar-user-text">
                  <span>{me.user.fullName}</span>
                  {me.memberships.length > 1 && (
                    <Link to="/select-organization" onClick={close}>
                      {t('organizations.change')}
                    </Link>
                  )}
                </span>
              </span>
              <ThemeToggle />
              <button type="button" className="small" onClick={() => void logout()}>
                {t('common.logout')}
              </button>
            </div>
          </div>
        </div>
      </header>
      {props.children}
    </div>
  );
}
