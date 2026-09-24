import type { ReactNode } from 'react';
import { Alert } from 'react-bootstrap';
import { Navigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Permission } from '@erp/contracts';
import { useAuth } from '../auth/AuthContext';
import { Loading } from './ui';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <Loading />;
  if (status === 'anonymous')
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

/** Hides a page (UX only). The API enforces the same permission on every request. */
export function RequirePermission({ perm, children }: { perm: Permission; children: ReactNode }) {
  const { can } = useAuth();
  const { t } = useTranslation();
  if (!can(perm)) return <Alert variant="warning">{t('errors.forbidden')}</Alert>;
  return <>{children}</>;
}

export function GuestOnly({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (status === 'loading') return <Loading />;
  if (status === 'authenticated') return <Navigate to="/" replace />;
  return <>{children}</>;
}
