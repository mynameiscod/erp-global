import { useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  ButtonGroup,
  Card,
  Col,
  Dropdown,
  Form,
  InputGroup,
  ListGroup,
  Row,
  Table,
} from 'react-bootstrap';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  CHART_TYPES,
  resolveRelative,
  WIDGET_TYPES,
  type DashboardDef,
  type DashboardWidget,
  type ReportResult,
  type WidgetType,
} from '@erp/metadata';
import { api } from '../api/client';
import type { NotificationDto, OrgUnitDto, Page, RoleDto } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { useEffectiveConfig, useLabel } from '../config/hooks';
import { LocalizedInput } from '../config/LocalizedInput';
import { ErrorAlert, Field, Loading, PageHeader } from '../components/ui';
import { formatDateTime } from '../lib/format';
import { DashboardPage } from '../pages/DashboardPage';
import { useApprovalCount } from '../workflow/hooks';
import {
  personalId,
  refreshDashboard,
  useDashboardActions,
  useDashboardData,
  useDashboards,
  useReports,
  type DashboardEntry,
  type DashboardFilters,
  type WidgetData,
} from './api';
import { ReportChart } from './ReportChart';
import { formatCell, isNumeric, type CellFormat } from './ReportView';
import { useCellFormat } from './ReportsPages';

// ---- widgets ----

function KpiWidget({
  data,
  format,
}: {
  data: Extract<WidgetData, { kind: 'kpi' }>;
  format: CellFormat;
}) {
  const { t } = useTranslation();
  const value = Number(data.value ?? 0);
  const prev = data.previous === undefined ? undefined : Number(data.previous ?? 0);
  const change =
    prev === undefined
      ? undefined
      : prev === 0
        ? value === 0
          ? 0
          : undefined
        : ((value - prev) / Math.abs(prev)) * 100;
  return (
    <div>
      <div className="kpi-value">{formatCell(data.column, data.value ?? 0, format) || '0'}</div>
      {prev !== undefined && (
        <div className={`small ${value >= prev ? 'text-success' : 'text-danger'}`}>
          <i className={`bi bi-caret-${value >= prev ? 'up' : 'down'}-fill me-1`} />
          {change === undefined ? (
            t('dashboards.fromZero')
          ) : (
            <>
              {`${Math.abs(change).toFixed(1)}%`}{' '}
              <span className="text-body-secondary">
                {t('dashboards.vsPrevious', {
                  value: formatCell(data.column, prev, format) || '0',
                })}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ListWidget({ result, format }: { result: ReportResult; format: CellFormat }) {
  if (result.kind === 'rows') {
    return (
      <Table size="sm" className="mb-0 small">
        <thead>
          <tr>
            {result.columns.map((c) => (
              <th key={c.key} className={isNumeric(c) ? 'text-end' : ''}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((r, i) => (
            <tr key={i}>
              {result.columns.map((c) => (
                <td key={c.key} className={isNumeric(c) ? 'text-end' : ''}>
                  {formatCell(c, r[c.key], format)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </Table>
    );
  }
  if (result.kind === 'groups') {
    const groups = result.columns.filter((c) => c.key.startsWith('g'));
    const values = result.columns.filter((c) => c.key.startsWith('a'));
    return (
      <Table size="sm" className="mb-0 small">
        <tbody>
          {result.rows.map((r, i) => (
            <tr key={i}>
              <td>{groups.map((g) => r.labels[g.key] || '—').join(' · ')}</td>
              {values.map((c) => (
                <td key={c.key} className="text-end">
                  {formatCell(c, r.values[c.key], format)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </Table>
    );
  }
  return null;
}

function ApprovalsWidget() {
  const { t } = useTranslation();
  const count = useApprovalCount();
  return (
    <Link to="/approvals" className="text-decoration-none d-flex align-items-center gap-3">
      <span className="kpi-value">{count.data?.pending ?? '—'}</span>
      <span className="text-body-secondary">{t('dashboards.waitingForYou')}</span>
    </Link>
  );
}

function NotificationsWidget() {
  const { i18n } = useTranslation();
  const navigate = useNavigate();
  const list = useQuery({
    queryKey: ['notifications', 'widget'],
    queryFn: () => api<Page<NotificationDto>>('/notifications', { query: { pageSize: 5 } }),
  });
  return (
    <ListGroup variant="flush" className="small">
      {list.data?.items.map((n) => (
        <ListGroup.Item
          key={n.id}
          action
          onClick={() => n.link && navigate(n.link)}
          className={n.read ? '' : 'fw-semibold'}
        >
          {n.title}
          <div className="text-body-secondary">{formatDateTime(n.createdAt, i18n.language)}</div>
        </ListGroup.Item>
      ))}
    </ListGroup>
  );
}

function WidgetBody({
  widget,
  data,
  chartType,
  format,
  onOpenReport,
}: {
  widget: DashboardWidget;
  data: WidgetData | undefined;
  chartType?: string;
  format: CellFormat;
  onOpenReport: () => void;
}) {
  const label = useLabel();
  const { t } = useTranslation();
  switch (widget.type) {
    case 'approvals':
      return <ApprovalsWidget />;
    case 'notifications':
      return <NotificationsWidget />;
    case 'text':
      return <div style={{ whiteSpace: 'pre-wrap' }}>{label(widget.text)}</div>;
    case 'links':
      return (
        <div className="d-flex flex-wrap gap-2">
          {widget.links?.map((l) => (
            <Link key={l.href} to={l.href} className="btn btn-sm btn-outline-primary">
              {label(l.label)}
            </Link>
          ))}
        </div>
      );
  }
  if (!data) return <div className="text-body-secondary small">{t('common.loading')}</div>;
  if (data.kind === 'error') return <div className="text-danger small">{data.message}</div>;
  if (data.kind === 'kpi') return <KpiWidget data={data} format={format} />;
  if (widget.type === 'chart') {
    return (
      <ReportChart
        result={data.result}
        type={(widget.chart?.type ?? chartType ?? 'bar') as (typeof CHART_TYPES)[number]}
        format={format}
        height={Math.max(120, widget.h * 72 + (widget.h - 1) * 16 - 70)}
        onDrill={onOpenReport}
      />
    );
  }
  return <ListWidget result={data.result} format={format} />;
}

// ---- dashboard ----

const iso = (d: Date) => d.toISOString().slice(0, 10);

function FiltersBar({
  def,
  value,
  onChange,
}: {
  def: DashboardDef;
  value: DashboardFilters;
  onChange: (f: DashboardFilters) => void;
}) {
  const { t } = useTranslation();
  const cfg = useEffectiveConfig();
  const units = useQuery({
    queryKey: ['org-units', false],
    queryFn: () => api<OrgUnitDto[]>('/org/units'),
    enabled: !!def.filters?.orgUnit,
  });
  if (!def.filters?.dateRange && !def.filters?.orgUnit) return null;
  const preset = (period: 'this_month' | 'last_month' | 'this_quarter' | 'this_fiscal_year') => {
    const r = resolveRelative(period, {
      timezone: cfg.data?.tenant.timezone ?? 'UTC',
      fyStartMonth: cfg.data?.settings.fiscalYearStartMonth ?? 1,
    });
    const to = new Date(`${r.to}T00:00:00Z`);
    onChange({
      ...value,
      dateRange: { from: r.from, to: iso(new Date(to.getTime() - 86_400_000)) },
    });
  };
  return (
    <div className="d-flex flex-wrap align-items-center gap-2 mb-3">
      {def.filters?.dateRange && (
        <>
          <InputGroup size="sm" style={{ maxWidth: 330 }}>
            <InputGroup.Text>
              <i className="bi bi-calendar-range" />
            </InputGroup.Text>
            <Form.Control
              type="date"
              aria-label={t('dashboards.from')}
              value={value.dateRange?.from ?? ''}
              onChange={(e) =>
                onChange({
                  ...value,
                  dateRange: e.target.value
                    ? { from: e.target.value, to: value.dateRange?.to ?? e.target.value }
                    : undefined,
                })
              }
            />
            <Form.Control
              type="date"
              aria-label={t('dashboards.to')}
              value={value.dateRange?.to ?? ''}
              onChange={(e) =>
                onChange({
                  ...value,
                  dateRange: e.target.value
                    ? { from: value.dateRange?.from ?? e.target.value, to: e.target.value }
                    : undefined,
                })
              }
            />
          </InputGroup>
          <ButtonGroup size="sm">
            {(['this_month', 'last_month', 'this_quarter', 'this_fiscal_year'] as const).map(
              (p) => (
                <Button key={p} variant="outline-secondary" onClick={() => preset(p)}>
                  {t(`reports.period.${p}`)}
                </Button>
              ),
            )}
            {value.dateRange && (
              <Button
                variant="outline-secondary"
                onClick={() => onChange({ ...value, dateRange: undefined })}
                aria-label={t('dashboards.clear')}
              >
                <i className="bi bi-x" />
              </Button>
            )}
          </ButtonGroup>
        </>
      )}
      {def.filters?.orgUnit && (
        <Form.Select
          size="sm"
          style={{ maxWidth: 240 }}
          value={value.orgUnitId ?? ''}
          onChange={(e) => onChange({ ...value, orgUnitId: e.target.value || undefined })}
        >
          <option value="">{t('dashboards.allUnits')}</option>
          {units.data?.map((u) => (
            <option key={u.id} value={u.id}>
              {'— '.repeat(u.depth)}
              {u.name}
            </option>
          ))}
        </Form.Select>
      )}
    </div>
  );
}

export function DashboardView({ entry }: { entry: DashboardEntry }) {
  const { t, i18n } = useTranslation();
  const label = useLabel();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const format = useCellFormat();
  const reports = useReports();
  const [filters, setFilters] = useState<DashboardFilters>({});
  const data = useDashboardData(entry.ref, filters);
  const [refreshing, setRefreshing] = useState(false);
  const chartTypes = useMemo(
    () => new Map(reports.data?.map((r) => [r.ref, r.def.chart?.type])),
    [reports.data],
  );
  const refresh = async () => {
    setRefreshing(true);
    try {
      qc.setQueryData(
        ['dashboards', entry.ref, 'data', filters],
        await refreshDashboard(entry.ref, filters),
      );
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <>
      <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
        <FiltersBar def={entry.def} value={filters} onChange={setFilters} />
        <div className="ms-auto small text-body-secondary d-flex align-items-center gap-2">
          {data.data &&
            t('dashboards.updated', { time: formatDateTime(data.data.loadedAt, i18n.language) })}
          <Button
            size="sm"
            variant="outline-secondary"
            onClick={() => void refresh()}
            disabled={refreshing}
          >
            <i className="bi bi-arrow-clockwise" /> {t('dashboards.refresh')}
          </Button>
        </div>
      </div>
      <ErrorAlert error={data.error} />
      <div className="dash-grid">
        {entry.def.widgets.map((w) => (
          <Card
            key={w.id}
            className="dash-widget shadow-sm border-0"
            style={{ gridColumn: `${w.x + 1} / span ${w.w}`, gridRow: `${w.y + 1} / span ${w.h}` }}
          >
            <Card.Header className="bg-body d-flex align-items-center py-2">
              <span className="fw-semibold small text-truncate">
                {label(w.title) ||
                  reports.data?.find((r) => r.ref === w.report)?.label ||
                  t(`dashboards.widget.${w.type}`)}
              </span>
              {w.report && (
                <Button
                  size="sm"
                  variant="link"
                  className="ms-auto p-0"
                  aria-label={t('dashboards.openReport')}
                  onClick={() => navigate(`/reports/${encodeURIComponent(w.report!)}`)}
                >
                  <i className="bi bi-box-arrow-up-right" />
                </Button>
              )}
            </Card.Header>
            <Card.Body className="py-2">
              <WidgetBody
                widget={w}
                data={data.data?.data[w.id]}
                chartType={w.report ? chartTypes.get(w.report) : undefined}
                format={format}
                onOpenReport={() =>
                  w.report && navigate(`/reports/${encodeURIComponent(w.report)}`)
                }
              />
            </Card.Body>
          </Card>
        ))}
      </div>
    </>
  );
}

/** Home: the dashboard for the person's role, or the setup page when there is none. */
export function HomePage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const { ref: routeRef } = useParams();
  const dashboards = useDashboards();
  const { remove } = useDashboardActions();
  if (dashboards.isLoading) return <Loading />;
  const list = dashboards.data ?? [];
  const current = routeRef ? list.find((d) => d.ref === routeRef) : list.find((d) => d.home);
  if (!current)
    return routeRef ? (
      <ErrorAlert error={dashboards.error ?? new Error('not found')} />
    ) : (
      <DashboardPage />
    );
  const id = personalId(current.ref);
  return (
    <>
      <PageHeader
        title={current.label}
        actions={
          <>
            {list.length > 1 && (
              <Dropdown>
                <Dropdown.Toggle variant="outline-secondary">
                  <i className="bi bi-grid-1x2 me-1" />
                  {t('dashboards.switch')}
                </Dropdown.Toggle>
                <Dropdown.Menu>
                  {list.map((d) => (
                    <Dropdown.Item
                      key={d.ref}
                      onClick={() =>
                        navigate(d.home ? '/' : `/dashboards/${encodeURIComponent(d.ref)}`)
                      }
                    >
                      {d.label}{' '}
                      {d.kind !== 'company' && (
                        <Badge bg="light" text="dark">
                          {t(`reports.kind.${d.kind}`)}
                        </Badge>
                      )}
                    </Dropdown.Item>
                  ))}
                </Dropdown.Menu>
              </Dropdown>
            )}
            {can('reports.personal') && (
              <Button variant="outline-primary" onClick={() => navigate('/dashboards/new')}>
                <i className="bi bi-plus-lg me-1" />
                {t('dashboards.new')}
              </Button>
            )}
            {current.kind === 'mine' && id && (
              <Dropdown>
                <Dropdown.Toggle variant="outline-secondary">
                  <i className="bi bi-three-dots" />
                </Dropdown.Toggle>
                <Dropdown.Menu>
                  <Dropdown.Item onClick={() => navigate(`/dashboards/my/${id}/edit`)}>
                    {t('common.edit')}
                  </Dropdown.Item>
                  <Dropdown.Item
                    className="text-danger"
                    onClick={() =>
                      window.confirm(t('common.confirm')) &&
                      void remove.mutateAsync(id).then(() => navigate('/'))
                    }
                  >
                    {t('common.delete')}
                  </Dropdown.Item>
                </Dropdown.Menu>
              </Dropdown>
            )}
          </>
        }
      />
      <DashboardView entry={current} />
    </>
  );
}

// ---- builder ----

const WIDTHS = [3, 4, 6, 8, 12];

/** Lays widgets out in order, left to right, wrapping to a new row when full. */
export function layout(widgets: DashboardWidget[]): DashboardWidget[] {
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  return widgets.map((w) => {
    if (x + w.w > 12) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    const placed = { ...w, x, y };
    x += w.w;
    rowHeight = Math.max(rowHeight, w.h);
    return placed;
  });
}

const DEFAULT_SIZE: Record<WidgetType, [number, number]> = {
  kpi: [3, 2],
  chart: [6, 4],
  list: [6, 4],
  approvals: [3, 2],
  notifications: [3, 4],
  text: [6, 2],
  links: [6, 2],
};

/** Edits a dashboard: widgets in order, with their size. Used in the Studio and for personal dashboards. */
export function DashboardBuilder({
  value,
  onChange,
  reportOptions,
  company,
}: {
  value: Partial<DashboardDef>;
  onChange: (d: Partial<DashboardDef>) => void;
  reportOptions: { ref: string; label: string }[];
  company?: boolean;
}) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const d = value;
  const widgets = d.widgets ?? [];
  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: () => api<RoleDto[]>('/access/roles'),
    enabled: !!company && can('access.role.read'),
  });
  const setWidgets = (list: DashboardWidget[]) => onChange({ ...d, widgets: layout(list) });
  const setW = (i: number, patch: Partial<DashboardWidget>) =>
    setWidgets(widgets.map((w, j) => (j === i ? { ...w, ...patch } : w)));
  const move = (i: number, by: number) => {
    const list = [...widgets];
    const [w] = list.splice(i, 1);
    list.splice(Math.max(0, Math.min(list.length, i + by)), 0, w);
    setWidgets(list);
  };
  const add = (type: WidgetType) => {
    const [w, h] = DEFAULT_SIZE[type];
    setWidgets([...widgets, { id: `w${Date.now().toString(36)}`, type, x: 0, y: 0, w, h }]);
  };
  return (
    <div>
      <Row>
        <Col md={6}>
          <Field label={t('dashboards.name')} controlId="db-label">
            <LocalizedInput
              id="db-label"
              value={d.label}
              onChange={(label) => onChange({ ...d, label })}
            />
          </Field>
        </Col>
        <Col md={6} className="pt-md-4">
          <Form.Check
            inline
            type="switch"
            id="db-f-date"
            label={t('dashboards.dateFilter')}
            checked={!!d.filters?.dateRange}
            onChange={(e) =>
              onChange({
                ...d,
                filters: { ...d.filters, dateRange: e.target.checked || undefined },
              })
            }
          />
          <Form.Check
            inline
            type="switch"
            id="db-f-unit"
            label={t('dashboards.unitFilter')}
            checked={!!d.filters?.orgUnit}
            onChange={(e) =>
              onChange({ ...d, filters: { ...d.filters, orgUnit: e.target.checked || undefined } })
            }
          />
          {company && (
            <Form.Check
              inline
              type="switch"
              id="db-home"
              label={t('dashboards.home')}
              checked={!!d.home}
              onChange={(e) => onChange({ ...d, home: e.target.checked || undefined })}
            />
          )}
        </Col>
        {company && (
          <Col md={12}>
            <Field
              label={t('dashboards.roles')}
              controlId="db-roles"
              hint={t('dashboards.rolesHint')}
            >
              <div className="d-flex flex-wrap gap-3">
                {roles.data?.map((r) => (
                  <Form.Check
                    key={r.id}
                    id={`db-role-${r.id}`}
                    label={r.name}
                    checked={d.roleIds?.includes(r.id) ?? false}
                    onChange={(e) =>
                      onChange({
                        ...d,
                        roleIds: e.target.checked
                          ? [...(d.roleIds ?? []), r.id]
                          : (d.roleIds ?? []).filter((x) => x !== r.id),
                      })
                    }
                  />
                ))}
              </div>
            </Field>
          </Col>
        )}
      </Row>
      <div className="fw-semibold mb-2">{t('dashboards.widgets')}</div>
      {widgets.map((w, i) => (
        <Card body key={w.id} className="mb-2 print-block">
          <Row className="g-2 align-items-end">
            <Col md={2}>
              <Badge bg="primary-subtle" text="primary-emphasis">
                {t(`dashboards.widget.${w.type}`)}
              </Badge>
            </Col>
            <Col md={3}>
              <Form.Label className="small mb-0">{t('dashboards.title')}</Form.Label>
              <LocalizedInput
                id={`w-title-${i}`}
                value={w.title}
                onChange={(title) =>
                  setW(i, { title: Object.keys(title).length ? title : undefined })
                }
              />
            </Col>
            {['kpi', 'chart', 'list'].includes(w.type) && (
              <Col md={3}>
                <Form.Label className="small mb-0">{t('reports.report')}</Form.Label>
                <Form.Select
                  size="sm"
                  value={w.report ?? ''}
                  onChange={(e) => setW(i, { report: e.target.value || undefined })}
                >
                  <option value="">{t('records.choose')}</option>
                  {reportOptions.map((r) => (
                    <option key={r.ref} value={r.ref}>
                      {r.label}
                    </option>
                  ))}
                </Form.Select>
              </Col>
            )}
            <Col md={1}>
              <Form.Label className="small mb-0">{t('dashboards.width')}</Form.Label>
              <Form.Select
                size="sm"
                value={w.w}
                onChange={(e) => setW(i, { w: Number(e.target.value) })}
              >
                {WIDTHS.map((n) => (
                  <option key={n} value={n}>
                    {n}/12
                  </option>
                ))}
              </Form.Select>
            </Col>
            <Col md={1}>
              <Form.Label className="small mb-0">{t('dashboards.height')}</Form.Label>
              <Form.Select
                size="sm"
                value={w.h}
                onChange={(e) => setW(i, { h: Number(e.target.value) })}
              >
                {[1, 2, 3, 4, 5, 6, 8].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Form.Select>
            </Col>
            <Col md={2} className="text-end text-nowrap">
              <Button
                size="sm"
                variant="outline-secondary"
                className="me-1"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                aria-label={t('dashboards.up')}
              >
                <i className="bi bi-arrow-up" />
              </Button>
              <Button
                size="sm"
                variant="outline-secondary"
                className="me-1"
                onClick={() => move(i, 1)}
                disabled={i === widgets.length - 1}
                aria-label={t('dashboards.down')}
              >
                <i className="bi bi-arrow-down" />
              </Button>
              <Button
                size="sm"
                variant="outline-danger"
                onClick={() => setWidgets(widgets.filter((_, j) => j !== i))}
                aria-label={t('common.delete')}
              >
                <i className="bi bi-x" />
              </Button>
            </Col>
            {w.type === 'kpi' && (
              <Col md={12}>
                <Form.Check
                  type="switch"
                  id={`w-cmp-${i}`}
                  label={t('dashboards.compare')}
                  checked={!!w.kpi?.compare}
                  onChange={(e) =>
                    setW(i, { kpi: { ...w.kpi, compare: e.target.checked || undefined } })
                  }
                />
              </Col>
            )}
            {w.type === 'chart' && (
              <Col md={4}>
                <Form.Select
                  size="sm"
                  value={w.chart?.type ?? ''}
                  onChange={(e) =>
                    setW(i, {
                      chart: e.target.value
                        ? { type: e.target.value as (typeof CHART_TYPES)[number] }
                        : undefined,
                    })
                  }
                >
                  <option value="">{t('dashboards.reportChart')}</option>
                  {CHART_TYPES.map((c) => (
                    <option key={c} value={c}>
                      {t(`reports.chartType.${c}`)}
                    </option>
                  ))}
                </Form.Select>
              </Col>
            )}
            {w.type === 'list' && (
              <Col md={3}>
                <InputGroup size="sm">
                  <InputGroup.Text>{t('dashboards.rows')}</InputGroup.Text>
                  <Form.Control
                    type="number"
                    min={1}
                    max={50}
                    value={w.limit ?? 10}
                    onChange={(e) => setW(i, { limit: Number(e.target.value) || 10 })}
                  />
                </InputGroup>
              </Col>
            )}
            {w.type === 'text' && (
              <Col md={12}>
                <LocalizedInput
                  id={`w-text-${i}`}
                  value={w.text}
                  onChange={(text) => setW(i, { text })}
                />
              </Col>
            )}
            {w.type === 'links' && (
              <Col md={12}>
                <Form.Control
                  as="textarea"
                  rows={3}
                  size="sm"
                  dir="ltr"
                  placeholder={t('dashboards.linksHint')}
                  value={(w.links ?? [])
                    .map((l) => `${l.label.en ?? Object.values(l.label)[0] ?? ''} | ${l.href}`)
                    .join('\n')}
                  onChange={(e) =>
                    setW(i, {
                      links: e.target.value
                        .split('\n')
                        .map((line) => line.split('|').map((s) => s.trim()))
                        .filter(([name, href]) => name && href)
                        .map(([name, href]) => ({ label: { en: name }, href })),
                    })
                  }
                />
              </Col>
            )}
          </Row>
        </Card>
      ))}
      <Dropdown className="mt-2">
        <Dropdown.Toggle size="sm" variant="outline-primary">
          <i className="bi bi-plus me-1" />
          {t('dashboards.addWidget')}
        </Dropdown.Toggle>
        <Dropdown.Menu>
          {WIDGET_TYPES.map((w) => (
            <Dropdown.Item key={w} onClick={() => add(w)}>
              {t(`dashboards.widget.${w}`)}
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown>
    </div>
  );
}

/** A personal dashboard: new, or editing one's own. */
export function MyDashboardEditor() {
  const { id } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const reports = useReports();
  const dashboards = useDashboards();
  const { save } = useDashboardActions();
  const [def, setDef] = useState<Partial<DashboardDef>>({ label: {}, widgets: [] });
  const existing = dashboards.data?.find((d) => d.ref === `my:${id}`);
  useEffect(() => {
    if (existing) setDef(existing.def);
  }, [existing]);
  if (reports.isLoading || (id && dashboards.isLoading)) return <Loading />;
  const ok = Object.values(def.label ?? {}).some(Boolean) && (def.widgets?.length ?? 0) > 0;
  return (
    <>
      <PageHeader
        title={id ? t('dashboards.edit') : t('dashboards.new')}
        actions={
          <>
            <Button variant="outline-secondary" onClick={() => navigate(-1)}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={!ok || save.isPending}
              onClick={() => {
                const { key: _key, roleIds: _r, home: _h, ...body } = def;
                void save
                  .mutateAsync({ id, def: body })
                  .then((d) => navigate(`/dashboards/${encodeURIComponent(d.ref)}`));
              }}
            >
              {t('common.save')}
            </Button>
          </>
        }
      />
      <ErrorAlert error={save.error} />
      <Card className="shadow-sm border-0">
        <Card.Body>
          <DashboardBuilder
            value={def}
            onChange={setDef}
            reportOptions={(reports.data ?? []).map((r) => ({ ref: r.ref, label: r.label }))}
          />
        </Card.Body>
      </Card>
    </>
  );
}
