import { lazy, Suspense, type ComponentType } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from './auth/AuthContext';
import { AppLayout } from './components/AppLayout';
import { GuestOnly, RequireAuth, RequirePermission } from './components/guards';
import { Loading } from './components/ui';
import { LoginPage } from './pages/auth/LoginPage';
import { SsoCompletePage } from './pages/auth/SsoCompletePage';
import {
  AcceptInvitePage,
  ForgotPasswordPage,
  ResetPasswordPage,
} from './pages/auth/PasswordPages';

/** Pages load on demand so the sign-in screen stays small; AG Grid only loads with the grids. */
function page<K extends string>(loader: () => Promise<Record<K, ComponentType>>, name: K) {
  return lazy(() => loader().then((m) => ({ default: m[name] })));
}
const SignupPage = page(() => import('./pages/auth/SignupPage'), 'SignupPage');
const DashboardPage = page(() => import('./pages/DashboardPage'), 'DashboardPage');
const OrgPage = page(() => import('./pages/OrgPage'), 'OrgPage');
const UsersPage = page(() => import('./pages/UsersPage'), 'UsersPage');
const RolesPage = page(() => import('./pages/RolesPage'), 'RolesPage');
const AuditPage = page(() => import('./pages/AuditPage'), 'AuditPage');
const SettingsPage = page(() => import('./pages/SettingsPage'), 'SettingsPage');
const AccountPage = page(() => import('./pages/AccountPage'), 'AccountPage');
const TenantsPage = page(() => import('./pages/TenantsPage'), 'TenantsPage');
const PacksPage = page(() => import('./pages/PacksPage'), 'PacksPage');
const StudioPage = page(() => import('./studio/StudioPage'), 'StudioPage');
const ApprovalsPage = page(() => import('./pages/ApprovalsPage'), 'ApprovalsPage');
const NotificationsPage = page(() => import('./pages/NotificationsPage'), 'NotificationsPage');
const RecordsListPage = page(() => import('./records/RecordsListPage'), 'RecordsListPage');
const RecordFormPage = page(() => import('./records/RecordFormPage'), 'RecordFormPage');
const HomePage = page(() => import('./outputs/Dashboards'), 'HomePage');
const MyDashboardEditor = page(() => import('./outputs/Dashboards'), 'MyDashboardEditor');
const ReportsPage = page(() => import('./outputs/ReportsPages'), 'ReportsPage');
const ReportPage = page(() => import('./outputs/ReportsPages'), 'ReportPage');
const MyReportEditor = page(() => import('./outputs/ReportsPages'), 'MyReportEditor');
const ExportsPage = page(() => import('./outputs/ReportsPages'), 'ExportsPage');
const SchedulesPage = page(() => import('./outputs/ReportsPages'), 'SchedulesPage');

/** Home: the role's dashboard when there is one, else the setup page. */
function Home() {
  const { isPlatform } = useAuth();
  return isPlatform ? <Navigate to="/platform/tenants" replace /> : <HomePage />;
}

function NotFound() {
  const { t } = useTranslation();
  return <p className="p-4 text-body-secondary">{t('errors.notFound')}</p>;
}

export function App() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route
          path="/login"
          element={
            <GuestOnly>
              <LoginPage />
            </GuestOnly>
          }
        />
        <Route
          path="/signup"
          element={
            <GuestOnly>
              <SignupPage />
            </GuestOnly>
          }
        />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/accept-invite" element={<AcceptInvitePage />} />
        <Route path="/sso/complete" element={<SsoCompletePage />} />
        <Route
          element={
            <RequireAuth>
              <AppLayout />
            </RequireAuth>
          }
        >
          <Route index element={<Home />} />
          <Route
            path="org"
            element={
              <RequirePermission perm="org.unit.read">
                <OrgPage />
              </RequirePermission>
            }
          />
          <Route
            path="users"
            element={
              <RequirePermission perm="identity.user.read">
                <UsersPage />
              </RequirePermission>
            }
          />
          <Route
            path="roles"
            element={
              <RequirePermission perm="access.role.read">
                <RolesPage />
              </RequirePermission>
            }
          />
          <Route
            path="audit"
            element={
              <RequirePermission perm="audit.event.read">
                <AuditPage />
              </RequirePermission>
            }
          />
          <Route
            path="settings"
            element={
              <RequirePermission perm="tenant.settings.read">
                <SettingsPage />
              </RequirePermission>
            }
          />
          <Route
            path="packs"
            element={
              <RequirePermission perm="packs.manage">
                <PacksPage />
              </RequirePermission>
            }
          />
          <Route path="account" element={<AccountPage />} />
          <Route path="approvals" element={<ApprovalsPage />} />
          <Route path="notifications" element={<NotificationsPage />} />
          <Route
            path="studio/*"
            element={
              <RequirePermission perm="config.read">
                <StudioPage />
              </RequirePermission>
            }
          />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="reports/new" element={<MyReportEditor />} />
          <Route path="reports/exports" element={<ExportsPage />} />
          <Route path="reports/schedules" element={<SchedulesPage />} />
          <Route path="reports/my/:id/edit" element={<MyReportEditor />} />
          <Route path="reports/:ref" element={<ReportPage />} />
          <Route path="dashboards/new" element={<MyDashboardEditor />} />
          <Route path="dashboards/my/:id/edit" element={<MyDashboardEditor />} />
          <Route path="dashboards/:ref" element={<HomePage />} />
          <Route path="setup" element={<DashboardPage />} />
          <Route path="r/:entity" element={<RecordsListPage />} />
          <Route path="r/:entity/new" element={<RecordFormPage />} />
          <Route path="r/:entity/:id" element={<RecordFormPage />} />
          <Route
            path="platform/tenants"
            element={
              <RequirePermission perm="platform.tenant.read">
                <TenantsPage />
              </RequirePermission>
            }
          />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
