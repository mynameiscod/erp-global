import { useState } from 'react';
import { Button, Dropdown, Nav, Offcanvas } from 'react-bootstrap';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { recordPermission, type Permission } from '@erp/contracts';
import { api } from '../api/client';
import type { TenantDto } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { customEntities, useEffectiveConfig, useLabel } from '../config/hooks';
import { LanguageSwitcher } from './LanguageSwitcher';

interface NavItem {
  to: string;
  icon: string;
  label: string;
  perm?: Permission;
  platform?: boolean;
}

export function useCurrentTenant() {
  const { isPlatform, status } = useAuth();
  return useQuery({
    queryKey: ['tenant', 'current'],
    queryFn: () => api<TenantDto>('/tenants/current'),
    enabled: status === 'authenticated' && !isPlatform,
    staleTime: 60_000,
  });
}

function SideNav({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  const { can, isPlatform } = useAuth();
  const cfg = useEffectiveConfig();
  const label = useLabel();
  const items: NavItem[] = isPlatform
    ? [
        {
          to: '/platform/tenants',
          icon: 'buildings',
          label: t('nav.tenants'),
          perm: 'platform.tenant.read',
          platform: true,
        },
      ]
    : [
        { to: '/', icon: 'speedometer2', label: t('nav.dashboard') },
        { to: '/org', icon: 'diagram-3', label: t('nav.organization'), perm: 'org.unit.read' },
        { to: '/users', icon: 'people', label: t('nav.users'), perm: 'identity.user.read' },
        { to: '/roles', icon: 'shield-lock', label: t('nav.roles'), perm: 'access.role.read' },
        { to: '/audit', icon: 'journal-check', label: t('nav.audit'), perm: 'audit.event.read' },
        { to: '/settings', icon: 'gear', label: t('nav.settings'), perm: 'tenant.settings.read' },
        { to: '/studio', icon: 'sliders2', label: t('nav.studio'), perm: 'config.read' },
      ];
  // Custom entities appear in the menu as soon as they are published.
  const modules: NavItem[] = customEntities(cfg.data)
    .filter((e) => can(recordPermission(e.key, 'read')))
    .map((e) => ({
      to: `/r/${e.key}`,
      icon: e.icon ?? 'box',
      label: label(e.pluralLabel) || e.key,
    }));
  const link = (i: NavItem) => (
    <Nav.Link
      as={NavLink}
      to={i.to}
      end={i.to === '/'}
      key={i.to}
      onClick={onNavigate}
      className="rounded px-3 py-2 d-flex align-items-center gap-2"
    >
      <i className={`bi bi-${i.icon}`} />
      {i.label}
    </Nav.Link>
  );
  return (
    <Nav className="flex-column gap-1">
      {items.filter((i) => !i.perm || can(i.perm)).map(link)}
      {modules.length > 0 && (
        <>
          <div className="small text-uppercase text-body-secondary px-3 pt-3 pb-1">
            {t('nav.modules')}
          </div>
          {modules.map(link)}
        </>
      )}
    </Nav>
  );
}

export function AppLayout() {
  const { t } = useTranslation();
  const { user, logout, isPlatform } = useAuth();
  const tenant = useCurrentTenant();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const brand = (
    <div className="d-flex align-items-center gap-2 px-3 py-3">
      <img src="/favicon.svg" alt="" width={28} height={28} />
      <div className="lh-sm">
        <div className="fw-semibold text-truncate" style={{ maxWidth: 170 }}>
          {isPlatform ? t('nav.platform') : (tenant.data?.name ?? t('app.name'))}
        </div>
        <div className="small text-body-secondary">{t('app.name')}</div>
      </div>
    </div>
  );

  return (
    <div className="app-shell">
      <aside className="app-sidebar d-none d-lg-flex flex-column border-end bg-body-tertiary">
        {brand}
        <div className="px-2">
          <SideNav />
        </div>
      </aside>
      <Offcanvas show={open} onHide={() => setOpen(false)} placement="start">
        <Offcanvas.Header closeButton>{brand}</Offcanvas.Header>
        <Offcanvas.Body>
          <SideNav onNavigate={() => setOpen(false)} />
        </Offcanvas.Body>
      </Offcanvas>

      <div className="app-main">
        <header className="d-flex align-items-center gap-2 border-bottom px-3 py-2 bg-body">
          <Button
            variant="link"
            className="d-lg-none text-body p-1"
            onClick={() => setOpen(true)}
            aria-label="Menu"
          >
            <i className="bi bi-list fs-4" />
          </Button>
          <div className="ms-auto d-flex align-items-center gap-2">
            <LanguageSwitcher />
            <Dropdown align="end">
              <Dropdown.Toggle
                variant="light"
                size="sm"
                className="d-flex align-items-center gap-2"
              >
                <i className="bi bi-person-circle" />
                <span className="d-none d-sm-inline">{user?.name}</span>
              </Dropdown.Toggle>
              <Dropdown.Menu>
                <Dropdown.ItemText className="small text-body-secondary">
                  {user?.email}
                </Dropdown.ItemText>
                <Dropdown.Divider />
                <Dropdown.Item onClick={() => navigate('/account')}>
                  <i className="bi bi-person-gear me-2" />
                  {t('nav.security')}
                </Dropdown.Item>
                <Dropdown.Item onClick={() => void logout().then(() => navigate('/login'))}>
                  <i className="bi bi-box-arrow-right me-2" />
                  {t('nav.logout')}
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown>
          </div>
        </header>
        <main className="p-3 p-md-4">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
