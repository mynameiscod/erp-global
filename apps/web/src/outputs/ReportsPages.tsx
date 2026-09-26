import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Dropdown,
  Form,
  InputGroup,
  Modal,
  Row,
  Table,
} from 'react-bootstrap';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  isDateType,
  isNumericType,
  pickText,
  resolveReportPath,
  type ReportDef,
  type ReportFilter,
  type ReportResult,
  type ReportRunParams,
} from '@erp/metadata';
import { api } from '../api/client';
import type { RoleDto } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { useEffectiveConfig, useLabel } from '../config/hooks';
import { ErrorAlert, Field, Loading, PageHeader } from '../components/ui';
import { UserSelect } from '../components/UserSelect';
import { formatDateTime } from '../lib/format';
import {
  personalId,
  runReport,
  useExports,
  useReport,
  useReportActions,
  useReports,
  useScheduleActions,
  useSchedules,
  type ReportEntry,
  type ScheduleDto,
  type ScheduleInput,
} from './api';
import { clean, ReportBuilder, usePathOptions } from './ReportBuilder';
import { ReportChart } from './ReportChart';
import { ReportView } from './ReportView';

/** Company formats for reports: locale and time zone from the effective configuration. */
export function useCellFormat() {
  const cfg = useEffectiveConfig();
  return useMemo(
    () => ({
      locale: cfg.data?.tenant.locale ?? 'en',
      timezone: cfg.data?.tenant.timezone ?? 'UTC',
    }),
    [cfg.data],
  );
}

/** Roles the person can share with: all roles for those who manage access, else their own. */
function useShareableRoles() {
  const { can } = useAuth();
  return useQuery({
    queryKey: ['share-roles', can('access.role.read')],
    queryFn: async () => {
      if (can('access.role.read'))
        return (await api<RoleDto[]>('/access/roles')).map((r) => ({ id: r.id, name: r.name }));
      const mine = await api<{ roleId: string; name: string }[]>('/access/me/roles');
      return [...new Map(mine.map((r) => [r.roleId, { id: r.roleId, name: r.name }])).values()];
    },
    staleTime: 60_000,
  });
}

function ShareDialog({
  current,
  onSave,
  onClose,
}: {
  current: string[];
  onSave: (roleIds: string[]) => Promise<unknown>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const roles = useShareableRoles();
  const [ids, setIds] = useState(current);
  const [error, setError] = useState<unknown>(null);
  return (
    <Modal show onHide={onClose} centered>
      <Modal.Header closeButton>
        <Modal.Title className="h5">{t('reports.share')}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <p className="small text-body-secondary">{t('reports.shareHelp')}</p>
        <ErrorAlert error={error} />
        {roles.data?.map((r) => (
          <Form.Check
            key={r.id}
            id={`share-${r.id}`}
            label={r.name}
            checked={ids.includes(r.id)}
            onChange={(e) =>
              setIds(e.target.checked ? [...ids, r.id] : ids.filter((x) => x !== r.id))
            }
          />
        ))}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button onClick={() => void onSave(ids).then(onClose, setError)}>{t('common.save')}</Button>
      </Modal.Footer>
    </Modal>
  );
}

// ---- list ----

export function ReportsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const cfg = useEffectiveConfig();
  const label = useLabel();
  const reports = useReports();
  const entityName = (key: string) =>
    label(cfg.data?.entities.find((e) => e.key === key)?.pluralLabel) || key;
  const groups: [string, ReportEntry[]][] = [
    ['reports.company', reports.data?.filter((r) => r.kind === 'company') ?? []],
    ['reports.mine', reports.data?.filter((r) => r.kind === 'mine') ?? []],
    ['reports.sharedWithMe', reports.data?.filter((r) => r.kind === 'shared') ?? []],
  ];
  return (
    <>
      <PageHeader
        title={t('reports.title')}
        subtitle={t('reports.subtitle')}
        actions={
          <>
            <Link className="btn btn-outline-secondary" to="/reports/exports">
              <i className="bi bi-download me-1" />
              {t('reports.exports')}
            </Link>
            {can('reports.export') && (
              <Link className="btn btn-outline-secondary" to="/reports/schedules">
                <i className="bi bi-calendar-week me-1" />
                {t('reports.schedules')}
              </Link>
            )}
            {can('reports.personal') && (
              <Link className="btn btn-primary" to="/reports/new">
                <i className="bi bi-plus-lg me-1" />
                {t('reports.new')}
              </Link>
            )}
          </>
        }
      />
      <ErrorAlert error={reports.error} />
      {reports.isLoading && <Loading />}
      {reports.data?.length === 0 && <p className="text-body-secondary">{t('reports.none')}</p>}
      {groups
        .filter(([, list]) => list.length)
        .map(([title, list]) => (
          <div key={title} className="mb-4">
            <h2 className="h6 text-uppercase text-body-secondary">{t(title)}</h2>
            <Row className="g-3">
              {list.map((r) => (
                <Col key={r.ref} sm={6} lg={4}>
                  <Card
                    as={Link}
                    to={`/reports/${encodeURIComponent(r.ref)}`}
                    className="h-100 shadow-sm border-0 text-decoration-none"
                  >
                    <Card.Body>
                      <div className="d-flex align-items-start gap-2">
                        <i
                          className={`bi bi-${r.def.chart ? 'bar-chart' : r.def.pivot ? 'grid-3x3' : r.def.groupBy?.length ? 'collection' : 'table'} fs-4 text-primary`}
                        />
                        <div>
                          <div className="fw-semibold">{r.label}</div>
                          <div className="small text-body-secondary">{entityName(r.entity)}</div>
                          {r.def.description && (
                            <div className="small mt-1">{label(r.def.description)}</div>
                          )}
                        </div>
                      </div>
                    </Card.Body>
                  </Card>
                </Col>
              ))}
            </Row>
          </div>
        ))}
    </>
  );
}

// ---- one report ----

function PromptInputs({
  report,
  values,
  onChange,
}: {
  report: ReportDef;
  values: Record<string, Partial<ReportFilter>>;
  onChange: (v: Record<string, Partial<ReportFilter>>) => void;
}) {
  const { t } = useTranslation();
  const label = useLabel();
  const cfg = useEffectiveConfig();
  if (!cfg.data) return null;
  const prompts = report.filters.map((f, i) => ({ f, i })).filter(({ f }) => f.prompt);
  if (!prompts.length) return null;
  return (
    <Row className="g-2 mb-3">
      {prompts.map(({ f, i }) => {
        const res = resolveReportPath(cfg.data!.entities, report.entity, f.path, report.lines);
        const type = typeof res === 'string' ? 'text' : res.type;
        const field = typeof res === 'string' ? undefined : res.field;
        const list = field?.picklist
          ? cfg.data!.picklists.find((p) => p.key === field.picklist)
          : undefined;
        const current = values[String(i)]?.value ?? f.value;
        const set = (value: unknown) =>
          onChange({
            ...values,
            [String(i)]: { value: value === '' ? undefined : (value as ReportFilter['value']) },
          });
        const name = f.label
          ? label(f.label)
          : typeof res === 'string'
            ? f.path
            : label(res.labels[res.labels.length - 1]);
        const one = Array.isArray(current) ? current[0] : current;
        return (
          <Col key={i} sm={6} md={3}>
            <Form.Label className="small mb-1" htmlFor={`prompt-${i}`}>
              {name}
            </Form.Label>
            {list ? (
              <Form.Select
                id={`prompt-${i}`}
                size="sm"
                value={String(one ?? '')}
                onChange={(e) => set(e.target.value)}
              >
                <option value="">{t('reports.any')}</option>
                {list.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {label(o.label)}
                  </option>
                ))}
              </Form.Select>
            ) : f.op === 'between' ? (
              <InputGroup size="sm">
                {[0, 1].map((k) => (
                  <Form.Control
                    key={k}
                    type={isDateType(type) ? 'date' : 'text'}
                    value={String((Array.isArray(current) ? current[k] : '') ?? '')}
                    onChange={(e) => {
                      const both = Array.isArray(current) ? [...current] : ['', ''];
                      both[k] = e.target.value;
                      set(both);
                    }}
                  />
                ))}
              </InputGroup>
            ) : (
              <Form.Control
                id={`prompt-${i}`}
                size="sm"
                type={isDateType(type) ? 'date' : isNumericType(type) ? 'number' : 'text'}
                value={String(one ?? '')}
                placeholder={t('reports.any')}
                onChange={(e) =>
                  set(
                    isNumericType(type) && e.target.value ? Number(e.target.value) : e.target.value,
                  )
                }
              />
            )}
          </Col>
        );
      })}
    </Row>
  );
}

/** The records behind a number: opened by clicking a group, a pivot cell or a chart bar. */
function DrillModal({
  entry,
  params,
  onClose,
}: {
  entry: ReportEntry;
  params: ReportRunParams;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const format = useCellFormat();
  const res = useQuery({
    queryKey: ['reports', entry.ref, 'drill', params],
    queryFn: () => runReport(entry.ref, { ...params, records: true, pageSize: 500 }),
  });
  return (
    <Modal show onHide={onClose} size="xl" centered scrollable>
      <Modal.Header closeButton>
        <Modal.Title className="h5">{t('reports.recordsBehind')}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <ErrorAlert error={res.error} />
        {res.isLoading && <Loading />}
        {res.data && (
          <ReportView
            result={res.data}
            format={format}
            height={420}
            onOpenRecord={(id) => navigate(`/r/${entry.entity}/${id}`)}
          />
        )}
      </Modal.Body>
    </Modal>
  );
}

export function ReportPage() {
  const { ref = '' } = useParams();
  const { t } = useTranslation();
  const { can, user } = useAuth();
  const navigate = useNavigate();
  const format = useCellFormat();
  const entry = useReport(ref);
  const actions = useReportActions();
  const [prompts, setPrompts] = useState<Record<string, Partial<ReportFilter>>>({});
  const [params, setParams] = useState<ReportRunParams>({});
  const [drill, setDrill] = useState<ReportRunParams | null>(null);
  const [sharing, setSharing] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [exported, setExported] = useState(false);
  const result = useQuery({
    queryKey: ['reports', ref, 'run', params],
    enabled: !!entry.data,
    queryFn: () => runReport(ref, { ...params, pageSize: 500 }),
  });

  if (entry.isLoading) return <Loading />;
  if (!entry.data) return <ErrorAlert error={entry.error} />;
  const e = entry.data;
  const id = personalId(e.ref);

  const onDrill = (keys: Record<string, unknown>) => {
    const groups = e.def.pivot ? [...e.def.pivot.rows, e.def.pivot.column] : (e.def.groupBy ?? []);
    const d = groups
      .map((g, i) => ({
        path: g.path,
        bucket: g.bucket,
        value: keys[`g${i}`] as string | number | boolean | null,
      }))
      .filter((_, i) => `g${i}` in keys);
    setDrill({ ...params, drill: d });
  };
  const exportAs = (format: 'xlsx' | 'csv' | 'pdf') =>
    void actions.exportReport
      .mutateAsync({ ref: e.ref, format, params })
      .then(() => setExported(true));

  return (
    <>
      <PageHeader
        title={e.label}
        subtitle={
          e.def.description ? pickText(e.def.description, user?.language ?? 'en') : undefined
        }
        actions={
          <>
            <Button variant="outline-secondary" onClick={() => navigate('/reports')}>
              <i className="bi bi-arrow-left me-1 flip-rtl" />
              {t('reports.title')}
            </Button>
            {can('reports.export') && (
              <Dropdown>
                <Dropdown.Toggle variant="outline-primary">
                  <i className="bi bi-download me-1" />
                  {t('reports.export')}
                </Dropdown.Toggle>
                <Dropdown.Menu>
                  <Dropdown.Item onClick={() => exportAs('xlsx')}>Excel (.xlsx)</Dropdown.Item>
                  <Dropdown.Item onClick={() => exportAs('csv')}>CSV</Dropdown.Item>
                  <Dropdown.Item onClick={() => exportAs('pdf')}>PDF</Dropdown.Item>
                  <Dropdown.Divider />
                  <Dropdown.Item onClick={() => setScheduling(true)}>
                    <i className="bi bi-calendar-week me-1" />
                    {t('reports.schedule')}
                  </Dropdown.Item>
                </Dropdown.Menu>
              </Dropdown>
            )}
            {e.kind === 'mine' && (
              <Dropdown>
                <Dropdown.Toggle variant="outline-secondary">
                  <i className="bi bi-three-dots" />
                </Dropdown.Toggle>
                <Dropdown.Menu>
                  <Dropdown.Item onClick={() => navigate(`/reports/my/${id}/edit`)}>
                    {t('common.edit')}
                  </Dropdown.Item>
                  {can('reports.share') && (
                    <Dropdown.Item onClick={() => setSharing(true)}>
                      {t('reports.share')}
                    </Dropdown.Item>
                  )}
                  <Dropdown.Item
                    className="text-danger"
                    onClick={() =>
                      window.confirm(t('common.confirm')) &&
                      void actions.remove.mutateAsync(id!).then(() => navigate('/reports'))
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
      {exported && (
        <Alert variant="info" dismissible onClose={() => setExported(false)}>
          {t('reports.exportStarted')} <Link to="/reports/exports">{t('reports.exports')}</Link>
        </Alert>
      )}
      <ErrorAlert error={actions.exportReport.error} />
      <PromptInputs report={e.def} values={prompts} onChange={setPrompts} />
      {e.def.filters.some((f) => f.prompt) && (
        <Button
          size="sm"
          className="mb-3"
          onClick={() => setParams({ ...params, filters: prompts })}
        >
          <i className="bi bi-play me-1" />
          {t('reports.run')}
        </Button>
      )}
      <ErrorAlert error={result.error} />
      {result.isLoading && <Loading />}
      {result.data && (
        <ReportBody entry={e} result={result.data} format={format} onDrill={onDrill} />
      )}
      {drill && <DrillModal entry={e} params={drill} onClose={() => setDrill(null)} />}
      {sharing && id && (
        <ShareDialog
          current={e.sharedRoleIds}
          onSave={(roleIds) => actions.share.mutateAsync({ id, roleIds })}
          onClose={() => setSharing(false)}
        />
      )}
      {scheduling && <ScheduleDialog fixedRef={e.ref} onClose={() => setScheduling(false)} />}
    </>
  );
}

function ReportBody({
  entry,
  result,
  format,
  onDrill,
}: {
  entry: ReportEntry;
  result: ReportResult;
  format: { locale: string; timezone: string };
  onDrill: (keys: Record<string, unknown>) => void;
}) {
  const navigate = useNavigate();
  return (
    <Card className="shadow-sm border-0">
      <Card.Body>
        {entry.def.chart && result.kind !== 'rows' && (
          <div className="mb-3">
            <ReportChart
              result={result}
              type={entry.def.chart.type}
              format={format}
              onDrill={onDrill}
            />
          </div>
        )}
        <ReportView
          result={result}
          format={format}
          onDrill={onDrill}
          onOpenRecord={(id) => navigate(`/r/${entry.entity}/${id}`)}
        />
      </Card.Body>
    </Card>
  );
}

// ---- personal report editor ----

export function MyReportEditor() {
  const { id } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const cfg = useEffectiveConfig();
  const format = useCellFormat();
  const existing = useReport(id ? `my:${id}` : undefined);
  const { save } = useReportActions();
  const [def, setDef] = useState<Partial<ReportDef>>({ label: {}, columns: [], filters: [] });
  useEffect(() => {
    if (existing.data) setDef(existing.data.def);
  }, [existing.data]);
  const options = usePathOptions(cfg.data, def.entity, def.lines);
  if (!cfg.data || (id && existing.isLoading)) return <Loading />;
  const ok = !!def.entity && Object.values(def.label ?? {}).some(Boolean);
  return (
    <>
      <PageHeader
        title={id ? t('reports.edit') : t('reports.new')}
        actions={
          <>
            <Button variant="outline-secondary" onClick={() => navigate(-1)}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={!ok || save.isPending}
              onClick={() => {
                const { key: _key, roleIds: _roles, ...body } = clean(def, options);
                void save
                  .mutateAsync({ id, def: body })
                  .then((r) => navigate(`/reports/${encodeURIComponent(r.ref)}`));
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
          <ReportBuilder value={def} onChange={setDef} cfg={cfg.data} format={format} />
        </Card.Body>
      </Card>
    </>
  );
}

// ---- exports ----

export function ExportsPage() {
  const { t, i18n } = useTranslation();
  const exports = useExports();
  const [error, setError] = useState<unknown>(null);
  const download = async (fileId: string) => {
    try {
      const f = await api<{ url: string }>(`/files/${fileId}`);
      window.location.assign(f.url);
    } catch (e) {
      setError(e);
    }
  };
  return (
    <>
      <PageHeader title={t('reports.exports')} subtitle={t('reports.exportsHelp')} />
      <ErrorAlert error={exports.error ?? error} />
      {exports.isLoading && <Loading />}
      {exports.data?.length === 0 && (
        <p className="text-body-secondary">{t('reports.noExports')}</p>
      )}
      {!!exports.data?.length && (
        <Card className="shadow-sm border-0">
          <Table hover responsive className="align-middle mb-0">
            <thead>
              <tr>
                <th>{t('reports.report')}</th>
                <th>{t('reports.format')}</th>
                <th>{t('common.status')}</th>
                <th className="text-end">{t('reports.rows')}</th>
                <th>{t('audit.when')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {exports.data.map((j) => (
                <tr key={j.id}>
                  <td>{j.title}</td>
                  <td className="text-uppercase small">{j.format}</td>
                  <td>
                    <Badge
                      bg={
                        j.status === 'done' ? 'success' : j.status === 'failed' ? 'danger' : 'info'
                      }
                    >
                      {t(`reports.jobStatus.${j.status}`)}
                    </Badge>
                    {j.error && <div className="small text-danger">{j.error}</div>}
                  </td>
                  <td className="text-end">{j.rows ?? ''}</td>
                  <td className="small">{formatDateTime(j.createdAt, i18n.language)}</td>
                  <td className="text-end">
                    {j.fileId && (
                      <Button
                        size="sm"
                        variant="outline-primary"
                        onClick={() => void download(j.fileId!)}
                      >
                        <i className="bi bi-download me-1" />
                        {t('reports.download')}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}

// ---- schedules ----

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

export function ScheduleDialog({
  schedule,
  fixedRef,
  onClose,
}: {
  schedule?: ScheduleDto;
  fixedRef?: string;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const reports = useReports();
  const roles = useShareableRoles();
  const { save } = useScheduleActions();
  const [s, setS] = useState<ScheduleInput>(() => ({
    ref: schedule?.ref ?? fixedRef ?? '',
    frequency: schedule?.frequency ?? 'weekly',
    at: schedule?.at ?? '08:00',
    weekday: schedule?.weekday ?? 1,
    monthDay: schedule?.monthDay ?? 1,
    formats: schedule?.formats ?? ['xlsx'],
    recipients: schedule?.recipients ?? { userIds: [], roleIds: [] },
    params: {},
    skipEmpty: schedule?.skipEmpty ?? false,
    subject: schedule?.subject ?? undefined,
    active: schedule?.active ?? true,
  }));
  const [addUser, setAddUser] = useState<string | null>(null);
  const dayName = (d: number) =>
    new Intl.DateTimeFormat(i18n.language, { weekday: 'long', timeZone: 'UTC' }).format(
      new Date(Date.UTC(2024, 0, d)),
    );
  const ok =
    s.ref && s.formats.length && s.recipients.userIds.length + s.recipients.roleIds.length > 0;
  const body = (): ScheduleInput => ({
    ...s,
    weekday: s.frequency === 'weekly' ? s.weekday : undefined,
    monthDay: s.frequency === 'monthly' ? s.monthDay : undefined,
    subject: s.subject || undefined,
  });
  return (
    <Modal show onHide={onClose} centered size="lg">
      <Modal.Header closeButton>
        <Modal.Title className="h5">
          {schedule ? t('reports.editSchedule') : t('reports.schedule')}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <p className="small text-body-secondary">{t('reports.scheduleHelp')}</p>
        <ErrorAlert error={save.error} />
        <Row>
          {!fixedRef && (
            <Col md={12}>
              <Field label={t('reports.report')} controlId="sc-ref">
                <Form.Select value={s.ref} onChange={(e) => setS({ ...s, ref: e.target.value })}>
                  <option value="">{t('records.choose')}</option>
                  {reports.data?.map((r) => (
                    <option key={r.ref} value={r.ref}>
                      {r.label}
                    </option>
                  ))}
                </Form.Select>
              </Field>
            </Col>
          )}
          <Col md={4}>
            <Field label={t('reports.frequency')} controlId="sc-freq">
              <Form.Select
                value={s.frequency}
                onChange={(e) =>
                  setS({ ...s, frequency: e.target.value as ScheduleInput['frequency'] })
                }
              >
                {(['daily', 'weekly', 'monthly'] as const).map((f) => (
                  <option key={f} value={f}>
                    {t(`reports.freq.${f}`)}
                  </option>
                ))}
              </Form.Select>
            </Field>
          </Col>
          <Col md={4}>
            {s.frequency === 'weekly' && (
              <Field label={t('reports.weekday')} controlId="sc-wd">
                <Form.Select
                  value={s.weekday}
                  onChange={(e) => setS({ ...s, weekday: Number(e.target.value) })}
                >
                  {WEEKDAYS.map((d) => (
                    <option key={d} value={d}>
                      {dayName(d)}
                    </option>
                  ))}
                </Form.Select>
              </Field>
            )}
            {s.frequency === 'monthly' && (
              <Field label={t('reports.monthDay')} controlId="sc-md">
                <Form.Control
                  type="number"
                  min={1}
                  max={28}
                  value={s.monthDay}
                  onChange={(e) => setS({ ...s, monthDay: Number(e.target.value) })}
                />
              </Field>
            )}
          </Col>
          <Col md={4}>
            <Field label={t('reports.at')} controlId="sc-at" hint={t('reports.atHint')}>
              <Form.Control
                type="time"
                value={s.at}
                onChange={(e) => setS({ ...s, at: e.target.value })}
              />
            </Field>
          </Col>
          <Col md={12}>
            <Form.Label>{t('reports.format')}</Form.Label>
            <div className="mb-3">
              {(['xlsx', 'pdf', 'csv'] as const).map((f) => (
                <Form.Check
                  inline
                  key={f}
                  id={`sc-f-${f}`}
                  label={f.toUpperCase()}
                  checked={s.formats.includes(f)}
                  onChange={(e) =>
                    setS({
                      ...s,
                      formats: e.target.checked
                        ? [...s.formats, f]
                        : s.formats.filter((x) => x !== f),
                    })
                  }
                />
              ))}
            </div>
          </Col>
          <Col md={6}>
            <Form.Label>{t('reports.toRoles')}</Form.Label>
            <div className="mb-3">
              {roles.data?.map((r) => (
                <Form.Check
                  key={r.id}
                  id={`sc-r-${r.id}`}
                  label={r.name}
                  checked={s.recipients.roleIds.includes(r.id)}
                  onChange={(e) =>
                    setS({
                      ...s,
                      recipients: {
                        ...s.recipients,
                        roleIds: e.target.checked
                          ? [...s.recipients.roleIds, r.id]
                          : s.recipients.roleIds.filter((x) => x !== r.id),
                      },
                    })
                  }
                />
              ))}
            </div>
          </Col>
          <Col md={6}>
            <Form.Label htmlFor="sc-user">{t('reports.toPeople')}</Form.Label>
            <InputGroup size="sm" className="mb-2">
              <UserSelect id="sc-user" value={addUser} onChange={setAddUser} />
              <Button
                variant="outline-primary"
                disabled={!addUser}
                onClick={() => {
                  setS({
                    ...s,
                    recipients: {
                      ...s.recipients,
                      userIds: [...new Set([...s.recipients.userIds, addUser!])],
                    },
                  });
                  setAddUser(null);
                }}
              >
                <i className="bi bi-plus" />
              </Button>
            </InputGroup>
            <div className="small text-body-secondary mb-3">
              {t('reports.peopleCount', { count: s.recipients.userIds.length })}
            </div>
          </Col>
          <Col md={8}>
            <Field
              label={`${t('reports.subject')} (${t('common.optional')})`}
              controlId="sc-subject"
            >
              <Form.Control
                value={s.subject ?? ''}
                onChange={(e) => setS({ ...s, subject: e.target.value })}
              />
            </Field>
          </Col>
          <Col md={4} className="pt-md-4">
            <Form.Check
              type="switch"
              id="sc-skip"
              label={t('reports.skipEmpty')}
              checked={s.skipEmpty}
              onChange={(e) => setS({ ...s, skipEmpty: e.target.checked })}
            />
            <Form.Check
              type="switch"
              id="sc-active"
              label={t('reports.active')}
              checked={s.active}
              onChange={(e) => setS({ ...s, active: e.target.checked })}
            />
          </Col>
        </Row>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button
          disabled={!ok || save.isPending}
          onClick={() => void save.mutateAsync({ id: schedule?.id, body: body() }).then(onClose)}
        >
          {t('common.save')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

export function SchedulesPage() {
  const { t, i18n } = useTranslation();
  const schedules = useSchedules();
  const { remove } = useScheduleActions();
  const [editing, setEditing] = useState<ScheduleDto | 'new' | null>(null);
  return (
    <>
      <PageHeader
        title={t('reports.schedules')}
        subtitle={t('reports.scheduleHelp')}
        actions={
          <Button onClick={() => setEditing('new')}>
            <i className="bi bi-plus-lg me-1" />
            {t('reports.schedule')}
          </Button>
        }
      />
      <ErrorAlert error={schedules.error ?? remove.error} />
      {schedules.isLoading && <Loading />}
      {schedules.data?.length === 0 && (
        <p className="text-body-secondary">{t('reports.noSchedules')}</p>
      )}
      {!!schedules.data?.length && (
        <Card className="shadow-sm border-0">
          <Table hover responsive className="align-middle mb-0">
            <thead>
              <tr>
                <th>{t('reports.report')}</th>
                <th>{t('reports.frequency')}</th>
                <th>{t('reports.nextRun')}</th>
                <th>{t('reports.lastRun')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {schedules.data.map((s) => (
                <tr key={s.id} className={s.active ? '' : 'text-body-secondary'}>
                  <td>
                    {s.label}{' '}
                    <span className="small text-uppercase text-body-secondary">
                      {s.formats.join(', ')}
                    </span>
                  </td>
                  <td>
                    {t(`reports.freq.${s.frequency}`)} · {s.at}
                  </td>
                  <td className="small">
                    {s.active ? formatDateTime(s.nextRunAt, i18n.language) : t('reports.paused')}
                  </td>
                  <td className="small">
                    {s.lastRunAt ? formatDateTime(s.lastRunAt, i18n.language) : '—'}
                    {s.lastResult && <div className="text-body-secondary">{s.lastResult}</div>}
                  </td>
                  <td className="text-end text-nowrap">
                    <Button
                      size="sm"
                      variant="outline-primary"
                      className="me-1"
                      onClick={() => setEditing(s)}
                    >
                      <i className="bi bi-pencil" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline-danger"
                      onClick={() => window.confirm(t('common.confirm')) && remove.mutate(s.id)}
                    >
                      <i className="bi bi-trash" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      {editing && (
        <ScheduleDialog
          schedule={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
