import { Alert, Card, Col, ListGroup, Row } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { INDUSTRIES, type Page } from '@erp/contracts';
import { api } from '../api/client';
import type { OrgUnitDto, RoleDto, UserDto } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { useCurrentTenant } from '../components/AppLayout';
import { PageHeader } from '../components/ui';
import type { PackDto } from './PacksPage';
import { formatCurrency, formatDate, formatNumber } from '../lib/format';

function Stat({
  icon,
  label,
  value,
  to,
}: {
  icon: string;
  label: string;
  value?: number;
  to: string;
}) {
  return (
    <Card as={Link} to={to} className="text-decoration-none h-100 shadow-sm border-0">
      <Card.Body className="d-flex align-items-center gap-3">
        <div className="stat-icon rounded-3 bg-primary-subtle text-primary d-flex align-items-center justify-content-center">
          <i className={`bi bi-${icon} fs-4`} />
        </div>
        <div>
          <div className="fs-3 fw-semibold lh-1">{value ?? '—'}</div>
          <div className="text-body-secondary small">{label}</div>
        </div>
      </Card.Body>
    </Card>
  );
}

export function DashboardPage() {
  const { t, i18n } = useTranslation();
  const { user, can, mfaSetupRequired } = useAuth();
  const tenant = useCurrentTenant().data;
  const units = useQuery({
    queryKey: ['org-units', false],
    queryFn: () => api<OrgUnitDto[]>('/org/units'),
    enabled: can('org.unit.read'),
  });
  const users = useQuery({
    queryKey: ['users', 'count'],
    queryFn: () => api<Page<UserDto>>('/identity/users', { query: { pageSize: 1 } }),
    enabled: can('identity.user.read'),
  });
  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: () => api<RoleDto[]>('/access/roles'),
    enabled: can('access.role.read'),
  });

  const packs = useQuery({
    queryKey: ['packs'],
    queryFn: () => api<PackDto[]>('/packs'),
    enabled: can('packs.manage'),
  });

  const countryName = tenant
    ? (new Intl.DisplayNames([i18n.language], { type: 'region' }).of(tenant.countryCode) ??
      tenant.countryCode)
    : '';
  const industry =
    INDUSTRIES.find((x) => x.code === tenant?.industryCode)?.name ?? tenant?.industryCode;
  const now = new Date();

  const steps = [
    { done: (units.data?.length ?? 0) > 1, label: t('dashboard.stepOrg'), to: '/org' },
    {
      done: (roles.data?.filter((r) => !r.system).length ?? 0) > 0,
      label: t('dashboard.stepRoles'),
      to: '/roles',
    },
    { done: (users.data?.total ?? 0) > 1, label: t('dashboard.stepUsers'), to: '/users' },
    { done: !!user?.mfaEnabled, label: t('dashboard.stepMfa'), to: '/account' },
    ...(can('packs.manage')
      ? [
          {
            done: !!packs.data?.some((p) => p.published),
            label: t('packs.setupStep'),
            to: '/packs',
          },
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title={t('dashboard.welcome', { name: user?.name })}
        subtitle={
          tenant
            ? t('dashboard.company', { company: tenant.name, country: countryName, industry })
            : undefined
        }
      />
      {mfaSetupRequired && (
        <Alert variant="warning">
          <i className="bi bi-shield-exclamation me-2" />
          <Link to="/account">{t('dashboard.mfaRequired')}</Link>
        </Alert>
      )}
      <Row className="g-3 mb-4">
        <Col sm={4}>
          <Stat
            icon="diagram-3"
            label={t('dashboard.units')}
            value={units.data?.length}
            to="/org"
          />
        </Col>
        <Col sm={4}>
          <Stat icon="people" label={t('dashboard.users')} value={users.data?.total} to="/users" />
        </Col>
        <Col sm={4}>
          <Stat
            icon="shield-lock"
            label={t('dashboard.roles')}
            value={roles.data?.length}
            to="/roles"
          />
        </Col>
      </Row>
      <Row className="g-3">
        <Col lg={6}>
          <Card className="shadow-sm border-0 h-100">
            <Card.Header className="bg-body fw-semibold">{t('dashboard.setup')}</Card.Header>
            <ListGroup variant="flush">
              {steps.map((s) => (
                <ListGroup.Item
                  key={s.to}
                  action
                  as={Link}
                  to={s.to}
                  className="d-flex align-items-center gap-2"
                >
                  <i
                    className={`bi ${s.done ? 'bi-check-circle-fill text-success' : 'bi-circle text-body-tertiary'}`}
                  />
                  <span
                    className={s.done ? 'text-body-secondary text-decoration-line-through' : ''}
                  >
                    {s.label}
                  </span>
                </ListGroup.Item>
              ))}
            </ListGroup>
          </Card>
        </Col>
        {tenant && (
          <Col lg={6}>
            <Card className="shadow-sm border-0 h-100">
              <Card.Header className="bg-body fw-semibold">{t('dashboard.formats')}</Card.Header>
              <Card.Body>
                <p className="small text-body-secondary">{t('dashboard.formatsHelp')}</p>
                <dl className="row mb-0">
                  <dt className="col-4">{t('dashboard.date')}</dt>
                  <dd className="col-8">{formatDate(now, tenant.locale, tenant.timezone)}</dd>
                  <dt className="col-4">{t('dashboard.number')}</dt>
                  <dd className="col-8">{formatNumber(1234567.891, tenant.locale)}</dd>
                  <dt className="col-4">{t('dashboard.money')}</dt>
                  <dd className="col-8">
                    {formatCurrency(1234567.5, tenant.currency, tenant.locale)}
                  </dd>
                  <dt className="col-4">{t('common.timezone')}</dt>
                  <dd className="col-8 mb-0">{tenant.timezone}</dd>
                </dl>
              </Card.Body>
            </Card>
          </Col>
        )}
      </Row>
    </>
  );
}
