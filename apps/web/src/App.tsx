import { type ReactNode, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { api } from './api';
import { ActivatePage } from './pages/ActivatePage';
import { CaseDetailPage } from './pages/cases/CaseDetailPage';
import { CasesPage } from './pages/cases/CasesPage';
import { NewCasePage } from './pages/cases/NewCasePage';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { MembersPage } from './pages/MembersPage';
import { PlatformPage } from './pages/PlatformPage';
import { SecondFactorPage } from './pages/SecondFactorPage';
import { SelectOrganizationPage } from './pages/SelectOrganizationPage';
import { caseWorker, useMe, useRefreshMe } from './session';
import { Page } from './ui';

/** Routes for a signed-in user; decides where to go when no organization is chosen yet. */
function SignedIn() {
  const me = useMe();
  const refreshMe = useRefreshMe();
  const data = me.data;
  const single =
    data && !data.activeOrganizationId && data.memberships.length === 1
      ? data.memberships[0]
      : undefined;

  // A user with exactly one organization does not need to choose.
  useEffect(() => {
    if (single)
      void api('POST', '/auth/organization', { organizationId: single.organizationId }).then(
        refreshMe,
      );
  }, [single, refreshMe]);

  if (!data || single) return <Loading />;
  const needsChoice = !data.activeOrganizationId && data.memberships.length > 1;
  const active = data.memberships.find((m) => m.organizationId === data.activeOrganizationId);
  // Mirrors access/policy.ts for navigation only; the API decides.
  const canCreateCases = !!active && caseWorker(active.roles);
  const canSeeCases =
    canCreateCases ||
    !!active?.permissions.some((p) => ['CASE_VIEW_ALL', 'APPROVER', 'AML_OFFICER'].includes(p));
  const abilities = {
    canAssign: !!active?.roles.includes('MANAGER') && active.planCode !== 'INDIVIDUAL',
    canApprove: !!active?.permissions.includes('APPROVER'),
    isAmlOfficer: !!active?.permissions.includes('AML_OFFICER'),
  };
  const cases = (element: ReactNode) => (canSeeCases ? element : <Navigate to="/" />);
  return (
    <Routes>
      <Route path="/select-organization" element={<SelectOrganizationPage />} />
      <Route path="/cases" element={cases(<CasesPage canCreate={canCreateCases} />)} />
      <Route
        path="/cases/new"
        element={canCreateCases ? <NewCasePage /> : <Navigate to="/cases" />}
      />
      <Route path="/cases/:id" element={cases(<CaseDetailPage abilities={abilities} />)} />
      <Route
        path="/members"
        element={
          active && (active.roles.includes('ORG_ADMIN') || active.roles.includes('MANAGER')) ? (
            <MembersPage canManage={active.roles.includes('ORG_ADMIN')} />
          ) : (
            <Navigate to="/" />
          )
        }
      />
      <Route
        path="/platform"
        element={data.isPlatformAdmin ? <PlatformPage /> : <Navigate to="/" />}
      />
      <Route
        path="*"
        element={
          needsChoice ? (
            <Navigate to="/select-organization" />
          ) : !data.activeOrganizationId && data.isPlatformAdmin ? (
            <Navigate to="/platform" />
          ) : (
            <HomePage me={data} />
          )
        }
      />
    </Routes>
  );
}

function Loading() {
  const { t } = useTranslation();
  return <Page title={t('common.loading')}>{null}</Page>;
}

export function App() {
  const me = useMe();
  if (me.isPending) return <Loading />;
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/activate" element={<ActivatePage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/login/second-factor" element={<SecondFactorPage />} />
        <Route path="*" element={me.data ? <SignedIn /> : <Navigate to="/login" />} />
      </Routes>
    </BrowserRouter>
  );
}
