import { lazy, Suspense, type ComponentType } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from './auth/AuthContext';
import { AppLayout } from './components/AppLayout';
import { GuestOnly, RequireAuth, RequirePermission } from './components/guards';
import { Loading } from './components/ui';
import { LoginPage } from './pages/auth/LoginPage';
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

function Home() {
  const { isPlatform } = useAuth();
  return isPlatform ? <Navigate to="/platform/tenants" replace /> : <DashboardPage />;
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
          <Route path="account" element={<AccountPage />} />
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
