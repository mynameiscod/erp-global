import { useMemo, useState } from 'react';
import { Badge, Button, ButtonGroup, Card, Col, Form, InputGroup, Row } from 'react-bootstrap';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { recordPermission } from '@erp/contracts';
import {
  AGGREGATE_FNS,
  CHART_TYPES,
  DATE_BUCKETS,
  isDateType,
  isNumericType,
  RELATIVE_DATES,
  resolveReportPath,
  SYSTEM_COLUMNS,
  type AggregateFn,
  type EffectiveConfig,
  type FilterOp,
  type ReportAggregate,
  type ReportDef,
  type ReportFilter,
  type ReportGroup,
  type ReportResult,
} from '@erp/metadata';
import { api } from '../api/client';
import type { RoleDto } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { customEntities, useLabel } from '../config/hooks';
import { LocalizedInput } from '../config/LocalizedInput';
import { ErrorAlert, Field } from '../components/ui';
import { previewReport } from './api';
import { ReportChart } from './ReportChart';
import { ReportView } from './ReportView';

export interface PathOption {
  path: string;
  label: string;
  type: string;
}

/** Every column a report on `entity` can use: its fields, system columns, and linked records' fields (two hops). */
export function usePathOptions(
  cfg: EffectiveConfig | undefined,
  entity: string | undefined,
): PathOption[] {
  const label = useLabel();
  const { t } = useTranslation();
  return useMemo(() => {
    if (!cfg || !entity) return [];
    const out: PathOption[] = [];
    const visit = (key: string, prefix: string, labels: string[], depth: number) => {
      const e = cfg.entities.find((x) => x.key === key);
      if (!e) return;
      for (const s of SYSTEM_COLUMNS) {
        if (depth > 0 && s !== 'number') continue;
        const res = resolveReportPath(cfg.entities, entity, `${prefix}${s}`);
        if (typeof res !== 'string')
          out.push({
            path: `${prefix}${s}`,
            label: [...labels, t(`reports.system.${s}`)].join(' › '),
            type: res.type,
          });
      }
      for (const f of e.fields) {
        if (f.archived || f.type === 'table') continue;
        const path = `${prefix}${f.key}`;
        const res = resolveReportPath(cfg.entities, entity, path);
        if (typeof res !== 'string')
          out.push({ path, label: [...labels, label(f.label)].join(' › '), type: res.type });
        const target =
          f.type === 'lookup' ? cfg.entities.find((x) => x.key === f.target) : undefined;
        if (target?.kind === 'custom' && depth < 2)
          visit(target.key, `${path}.`, [...labels, label(f.label)], depth + 1);
      }
    };
    visit(entity, '', [], 0);
    return out;
  }, [cfg, entity, label, t]);
}

const OPS_FOR: Record<string, FilterOp[]> = {
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'empty', 'not_empty'],
  date: ['relative', 'eq', 'gte', 'lte', 'between', 'empty', 'not_empty'],
  text: ['eq', 'ne', 'contains', 'in', 'empty', 'not_empty'],
};
const opsFor = (type: string) =>
  isNumericType(type) ? OPS_FOR.number : isDateType(type) ? OPS_FOR.date : OPS_FOR.text;

type Mode = 'rows' | 'groups' | 'pivot';
const modeOf = (d: Partial<ReportDef>): Mode =>
  d.pivot ? 'pivot' : d.groupBy?.length ? 'groups' : 'rows';

function PathSelect({
  value,
  onChange,
  options,
  filter,
  id,
}: {
  value: string | undefined;
  onChange: (v: string) => void;
  options: PathOption[];
  filter?: (o: PathOption) => boolean;
  id?: string;
}) {
  const { t } = useTranslation();
  return (
    <Form.Select id={id} size="sm" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t('records.choose')}</option>
      {options.filter(filter ?? (() => true)).map((o) => (
        <option key={o.path} value={o.path}>
          {o.label}
        </option>
      ))}
    </Form.Select>
  );
}

function GroupEditor({
  group,
  onChange,
  options,
  onRemove,
}: {
  group: ReportGroup;
  onChange: (g: ReportGroup) => void;
  options: PathOption[];
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  const type = options.find((o) => o.path === group.path)?.type ?? '';
  return (
    <InputGroup size="sm" className="mb-2">
      <PathSelect
        value={group.path}
        options={options}
        filter={(o) =>
          !['longtext', 'file', 'image', 'lookup_many', 'multiselect'].includes(o.type)
        }
        onChange={(path) => onChange({ path })}
      />
      {isDateType(type) && (
        <Form.Select
          size="sm"
          style={{ maxWidth: 160 }}
          value={group.bucket ?? ''}
          onChange={(e) =>
            onChange({ ...group, bucket: (e.target.value || undefined) as ReportGroup['bucket'] })
          }
        >
          <option value="">{t('reports.exactValue')}</option>
          {DATE_BUCKETS.map((b) => (
            <option key={b} value={b}>
              {t(`reports.bucket.${b}`)}
            </option>
          ))}
        </Form.Select>
      )}
      {onRemove && (
        <Button variant="outline-danger" onClick={onRemove} aria-label={t('common.delete')}>
          <i className="bi bi-x" />
        </Button>
      )}
    </InputGroup>
  );
}

function AggregateEditor({
  agg,
  onChange,
  options,
  onRemove,
}: {
  agg: ReportAggregate;
  onChange: (a: ReportAggregate) => void;
  options: PathOption[];
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  const needsNumber = agg.fn === 'sum' || agg.fn === 'avg';
  const needsOrdered = agg.fn === 'min' || agg.fn === 'max';
  return (
    <InputGroup size="sm" className="mb-2">
      <Form.Select
        size="sm"
        style={{ maxWidth: 170 }}
        value={agg.fn}
        onChange={(e) => {
          const fn = e.target.value as AggregateFn;
          onChange(fn === 'count' ? { fn } : { ...agg, fn });
        }}
      >
        {AGGREGATE_FNS.map((f) => (
          <option key={f} value={f}>
            {t(`reports.fn.${f}`)}
          </option>
        ))}
      </Form.Select>
      {agg.fn !== 'count' && (
        <PathSelect
          value={agg.path}
          options={options}
          filter={(o) =>
            needsNumber
              ? isNumericType(o.type)
              : needsOrdered
                ? isNumericType(o.type) || isDateType(o.type)
                : true
          }
          onChange={(path) => onChange({ ...agg, path })}
        />
      )}
      {onRemove && (
        <Button variant="outline-danger" onClick={onRemove} aria-label={t('common.delete')}>
          <i className="bi bi-x" />
        </Button>
      )}
    </InputGroup>
  );
}

function FilterEditor({
  filter,
  onChange,
  options,
  cfg,
  entity,
  index,
  onRemove,
}: {
  filter: ReportFilter;
  onChange: (f: ReportFilter) => void;
  options: PathOption[];
  cfg: EffectiveConfig;
  entity: string;
  index: number;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const label = useLabel();
  const type = options.find((o) => o.path === filter.path)?.type ?? 'text';
  const resolved = filter.path ? resolveReportPath(cfg.entities, entity, filter.path) : undefined;
  const field = typeof resolved === 'object' ? resolved.field : undefined;
  const picklist = field?.picklist
    ? cfg.picklists.find((p) => p.key === field.picklist)
    : undefined;
  const valueInput = (v: unknown, set: (x: string) => void, key: string) =>
    picklist ? (
      <Form.Select
        key={key}
        size="sm"
        value={String(v ?? '')}
        onChange={(e) => set(e.target.value)}
      >
        <option value="">{t('records.choose')}</option>
        {picklist.options.map((o) => (
          <option key={o.value} value={o.value}>
            {label(o.label)}
          </option>
        ))}
      </Form.Select>
    ) : (
      <Form.Control
        key={key}
        size="sm"
        type={isDateType(type) ? 'date' : isNumericType(type) ? 'number' : 'text'}
        value={String(v ?? '')}
        onChange={(e) => set(e.target.value)}
      />
    );
  const values = Array.isArray(filter.value) ? filter.value : [filter.value ?? ''];
  return (
    <Card body className="mb-2 p-0 border-light-subtle">
      <Row className="g-2 align-items-center">
        <Col md={4}>
          <PathSelect
            value={filter.path}
            options={options}
            onChange={(path) => onChange({ path, op: 'eq' })}
          />
        </Col>
        <Col md={3}>
          <Form.Select
            size="sm"
            value={filter.op}
            onChange={(e) => {
              const op = e.target.value as FilterOp;
              onChange({
                ...filter,
                op,
                value: op === 'between' ? ['', ''] : op === 'in' ? [] : undefined,
                relative: op === 'relative' ? { period: 'this_month' } : undefined,
              });
            }}
          >
            {opsFor(type).map((o) => (
              <option key={o} value={o}>
                {t(`reports.op.${o}`)}
              </option>
            ))}
          </Form.Select>
        </Col>
        <Col md={4}>
          {filter.op === 'relative' ? (
            <InputGroup size="sm">
              <Form.Select
                size="sm"
                value={filter.relative?.period ?? 'this_month'}
                onChange={(e) =>
                  onChange({
                    ...filter,
                    relative: {
                      period: e.target.value as (typeof RELATIVE_DATES)[number],
                      n: filter.relative?.n,
                    },
                  })
                }
              >
                {RELATIVE_DATES.map((p) => (
                  <option key={p} value={p}>
                    {t(`reports.period.${p}`)}
                  </option>
                ))}
              </Form.Select>
              {filter.relative?.period.endsWith('n_days') && (
                <Form.Control
                  type="number"
                  min={1}
                  style={{ maxWidth: 80 }}
                  value={filter.relative?.n ?? 7}
                  onChange={(e) =>
                    onChange({
                      ...filter,
                      relative: { ...filter.relative!, n: Number(e.target.value) || 1 },
                    })
                  }
                />
              )}
            </InputGroup>
          ) : filter.op === 'between' ? (
            <InputGroup size="sm">
              {valueInput(
                values[0],
                (x) => onChange({ ...filter, value: [x, values[1] ?? ''] }),
                'a',
              )}
              {valueInput(
                values[1],
                (x) => onChange({ ...filter, value: [values[0] ?? '', x] }),
                'b',
              )}
            </InputGroup>
          ) : filter.op === 'in' ? (
            <Form.Control
              size="sm"
              placeholder={t('reports.commaSeparated')}
              value={values.join(', ')}
              onChange={(e) =>
                onChange({ ...filter, value: e.target.value.split(/\s*,\s*/).filter(Boolean) })
              }
            />
          ) : filter.op === 'empty' || filter.op === 'not_empty' ? null : (
            valueInput(one(filter.value), (x) => onChange({ ...filter, value: x }), 'v')
          )}
        </Col>
        <Col md={1} className="text-end">
          <Button
            size="sm"
            variant="outline-danger"
            onClick={onRemove}
            aria-label={t('common.delete')}
          >
            <i className="bi bi-x" />
          </Button>
        </Col>
        <Col xs={12}>
          <Form.Check
            type="switch"
            id={`rb-prompt-${index}`}
            label={t('reports.prompt')}
            checked={!!filter.prompt}
            onChange={(e) => onChange({ ...filter, prompt: e.target.checked || undefined })}
          />
        </Col>
      </Row>
    </Card>
  );
}

const one = (v: ReportFilter['value']) => (Array.isArray(v) ? v[0] : v);

/** Values typed in the builder arrive as text; numbers go to the server as numbers. */
function cleanFilters(filters: ReportFilter[], options: PathOption[]): ReportFilter[] {
  return filters
    .filter((f) => f.path)
    .map((f) => {
      const type = options.find((o) => o.path === f.path)?.type ?? 'text';
      const conv = (v: unknown) =>
        v === '' ? null : isNumericType(type) && v !== null ? Number(v) : v;
      const value = Array.isArray(f.value)
        ? f.value.map(conv)
        : f.value === undefined
          ? undefined
          : conv(f.value);
      return { ...f, value: value as ReportFilter['value'] };
    });
}

/** Builds a report definition. Used for company reports (Studio) and personal reports. */
export function ReportBuilder({
  value,
  onChange,
  cfg,
  company,
  format,
}: {
  value: Partial<ReportDef>;
  onChange: (d: Partial<ReportDef>) => void;
  cfg: EffectiveConfig;
  /** Company reports can be limited to roles. */
  company?: boolean;
  format: { locale: string; timezone: string };
}) {
  const { t } = useTranslation();
  const label = useLabel();
  const { can } = useAuth();
  const d = value;
  const set = (patch: Partial<ReportDef>) => onChange({ ...d, ...patch });
  const options = usePathOptions(cfg, d.entity);
  const mode = modeOf(d);
  const [preview, setPreview] = useState<ReportResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: () => api<RoleDto[]>('/access/roles'),
    enabled: !!company && can('access.role.read'),
  });
  const entities = customEntities(cfg).filter((e) => can(recordPermission(e.key, 'read')));

  const setMode = (m: Mode) => {
    if (m === 'rows')
      set({ groupBy: undefined, pivot: undefined, aggregates: undefined, chart: undefined });
    if (m === 'groups')
      set({
        pivot: undefined,
        groupBy: d.groupBy?.length ? d.groupBy : [{ path: '' }],
        aggregates: d.aggregates?.length ? d.aggregates : [{ fn: 'count' }],
      });
    if (m === 'pivot')
      set({
        groupBy: undefined,
        pivot: d.pivot ?? {
          rows: [{ path: 'orgUnitId' }],
          column: { path: 'createdAt', bucket: 'month' },
          values: [{ fn: 'count' }],
        },
      });
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await previewReport({ ...clean(d, options), key: 'preview' }, { pageSize: 50 }));
    } catch (e) {
      setError(e);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  const list = <T,>(
    items: T[] | undefined,
    render: (item: T, i: number, setItem: (x: T) => void, remove: () => void) => React.ReactNode,
    key: keyof ReportDef,
  ) =>
    (items ?? []).map((item, i) =>
      render(
        item,
        i,
        (x) => set({ [key]: (items ?? []).map((y, j) => (j === i ? x : y)) } as Partial<ReportDef>),
        () => set({ [key]: (items ?? []).filter((_, j) => j !== i) } as Partial<ReportDef>),
      ),
    );

  return (
    <div>
      <Row>
        <Col md={6}>
          <Field label={t('reports.name')} controlId="rb-label">
            <LocalizedInput id="rb-label" value={d.label} onChange={(v) => set({ label: v })} />
          </Field>
        </Col>
        <Col md={6}>
          <Field label={t('reports.entity')} controlId="rb-entity">
            <Form.Select
              value={d.entity ?? ''}
              onChange={(e) =>
                onChange({
                  label: d.label,
                  key: d.key,
                  entity: e.target.value,
                  columns: [],
                  filters: [],
                })
              }
            >
              <option value="">{t('records.choose')}</option>
              {entities.map((e) => (
                <option key={e.key} value={e.key}>
                  {label(e.pluralLabel)}
                </option>
              ))}
            </Form.Select>
          </Field>
        </Col>
      </Row>

      {d.entity && (
        <>
          <ButtonGroup size="sm" className="mb-3">
            {(['rows', 'groups', 'pivot'] as Mode[]).map((m) => (
              <Button
                key={m}
                variant={mode === m ? 'primary' : 'outline-primary'}
                onClick={() => setMode(m)}
              >
                <i
                  className={`bi bi-${m === 'rows' ? 'list-ul' : m === 'groups' ? 'collection' : 'grid-3x3'} me-1`}
                />
                {t(`reports.mode.${m}`)}
              </Button>
            ))}
          </ButtonGroup>

          <Row>
            <Col lg={6}>
              {mode === 'rows' && (
                <Card body className="mb-3">
                  <div className="fw-semibold mb-2">{t('reports.columns')}</div>
                  {list(
                    d.columns,
                    (c, i, setItem, remove) => (
                      <InputGroup size="sm" className="mb-2" key={i}>
                        <PathSelect
                          value={c.path}
                          options={options}
                          onChange={(path) => setItem({ path })}
                        />
                        <Button
                          variant="outline-danger"
                          onClick={remove}
                          aria-label={t('common.delete')}
                        >
                          <i className="bi bi-x" />
                        </Button>
                      </InputGroup>
                    ),
                    'columns',
                  )}
                  <Button
                    size="sm"
                    variant="outline-primary"
                    onClick={() => set({ columns: [...(d.columns ?? []), { path: '' }] })}
                  >
                    <i className="bi bi-plus" /> {t('reports.addColumn')}
                  </Button>
                  <hr />
                  <div className="fw-semibold mb-2">{t('reports.sort')}</div>
                  {list(
                    d.sort,
                    (s, i, setItem, remove) => (
                      <InputGroup size="sm" className="mb-2" key={i}>
                        <PathSelect
                          value={s.path}
                          options={options}
                          onChange={(path) => setItem({ ...s, path })}
                        />
                        <Form.Select
                          size="sm"
                          style={{ maxWidth: 130 }}
                          value={s.dir}
                          onChange={(e) => setItem({ ...s, dir: e.target.value as 'asc' | 'desc' })}
                        >
                          <option value="asc">{t('reports.asc')}</option>
                          <option value="desc">{t('reports.desc')}</option>
                        </Form.Select>
                        <Button
                          variant="outline-danger"
                          onClick={remove}
                          aria-label={t('common.delete')}
                        >
                          <i className="bi bi-x" />
                        </Button>
                      </InputGroup>
                    ),
                    'sort',
                  )}
                  {(d.sort?.length ?? 0) < 3 && (
                    <Button
                      size="sm"
                      variant="outline-primary"
                      onClick={() => set({ sort: [...(d.sort ?? []), { path: '', dir: 'asc' }] })}
                    >
                      <i className="bi bi-plus" /> {t('reports.addSort')}
                    </Button>
                  )}
                </Card>
              )}
              {mode === 'groups' && (
                <Card body className="mb-3">
                  <div className="fw-semibold mb-2">{t('reports.groupBy')}</div>
                  {list(
                    d.groupBy,
                    (g, i, setItem, remove) => (
                      <GroupEditor
                        key={i}
                        group={g}
                        options={options}
                        onChange={setItem}
                        onRemove={(d.groupBy?.length ?? 0) > 1 ? remove : undefined}
                      />
                    ),
                    'groupBy',
                  )}
                  {(d.groupBy?.length ?? 0) < 3 && (
                    <Button
                      size="sm"
                      variant="outline-primary"
                      onClick={() => set({ groupBy: [...(d.groupBy ?? []), { path: '' }] })}
                    >
                      <i className="bi bi-plus" /> {t('reports.addGroup')}
                    </Button>
                  )}
                  <hr />
                  <div className="fw-semibold mb-2">{t('reports.totals')}</div>
                  {list(
                    d.aggregates,
                    (a, i, setItem, remove) => (
                      <AggregateEditor
                        key={i}
                        agg={a}
                        options={options}
                        onChange={setItem}
                        onRemove={(d.aggregates?.length ?? 0) > 1 ? remove : undefined}
                      />
                    ),
                    'aggregates',
                  )}
                  <Button
                    size="sm"
                    variant="outline-primary"
                    onClick={() => set({ aggregates: [...(d.aggregates ?? []), { fn: 'sum' }] })}
                  >
                    <i className="bi bi-plus" /> {t('reports.addTotal')}
                  </Button>
                </Card>
              )}
              {mode === 'pivot' && d.pivot && (
                <Card body className="mb-3">
                  <div className="fw-semibold mb-2">{t('reports.pivotRows')}</div>
                  {d.pivot.rows.map((g, i) => (
                    <GroupEditor
                      key={i}
                      group={g}
                      options={options}
                      onChange={(x) =>
                        set({
                          pivot: {
                            ...d.pivot!,
                            rows: d.pivot!.rows.map((y, j) => (j === i ? x : y)),
                          },
                        })
                      }
                      onRemove={
                        d.pivot!.rows.length > 1
                          ? () =>
                              set({
                                pivot: {
                                  ...d.pivot!,
                                  rows: d.pivot!.rows.filter((_, j) => j !== i),
                                },
                              })
                          : undefined
                      }
                    />
                  ))}
                  {d.pivot.rows.length < 2 && (
                    <Button
                      size="sm"
                      variant="outline-primary"
                      className="mb-2"
                      onClick={() =>
                        set({ pivot: { ...d.pivot!, rows: [...d.pivot!.rows, { path: '' }] } })
                      }
                    >
                      <i className="bi bi-plus" /> {t('reports.addGroup')}
                    </Button>
                  )}
                  <div className="fw-semibold mb-2">{t('reports.pivotColumns')}</div>
                  <GroupEditor
                    group={d.pivot.column}
                    options={options}
                    onChange={(column) => set({ pivot: { ...d.pivot!, column } })}
                  />
                  <div className="fw-semibold mb-2">{t('reports.totals')}</div>
                  {d.pivot.values.map((a, i) => (
                    <AggregateEditor
                      key={i}
                      agg={a}
                      options={options}
                      onChange={(x) =>
                        set({
                          pivot: {
                            ...d.pivot!,
                            values: d.pivot!.values.map((y, j) => (j === i ? x : y)),
                          },
                        })
                      }
                      onRemove={
                        d.pivot!.values.length > 1
                          ? () =>
                              set({
                                pivot: {
                                  ...d.pivot!,
                                  values: d.pivot!.values.filter((_, j) => j !== i),
                                },
                              })
                          : undefined
                      }
                    />
                  ))}
                  {d.pivot.values.length < 3 && (
                    <Button
                      size="sm"
                      variant="outline-primary"
                      onClick={() =>
                        set({ pivot: { ...d.pivot!, values: [...d.pivot!.values, { fn: 'sum' }] } })
                      }
                    >
                      <i className="bi bi-plus" /> {t('reports.addTotal')}
                    </Button>
                  )}
                </Card>
              )}
              {mode !== 'rows' && (
                <Field label={t('reports.chart')} controlId="rb-chart">
                  <Form.Select
                    size="sm"
                    value={d.chart?.type ?? ''}
                    onChange={(e) =>
                      set({
                        chart: e.target.value
                          ? { type: e.target.value as (typeof CHART_TYPES)[number] }
                          : undefined,
                      })
                    }
                  >
                    <option value="">{t('reports.noChart')}</option>
                    {CHART_TYPES.map((c) => (
                      <option key={c} value={c}>
                        {t(`reports.chartType.${c}`)}
                      </option>
                    ))}
                  </Form.Select>
                </Field>
              )}
            </Col>
            <Col lg={6}>
              <Card body className="mb-3">
                <div className="fw-semibold mb-2">{t('reports.filters')}</div>
                {list(
                  d.filters,
                  (f, i, setItem, remove) => (
                    <FilterEditor
                      key={i}
                      index={i}
                      filter={f}
                      options={options}
                      cfg={cfg}
                      entity={d.entity!}
                      onChange={setItem}
                      onRemove={remove}
                    />
                  ),
                  'filters',
                )}
                <Button
                  size="sm"
                  variant="outline-primary"
                  onClick={() => set({ filters: [...(d.filters ?? []), { path: '', op: 'eq' }] })}
                >
                  <i className="bi bi-plus" /> {t('reports.addFilter')}
                </Button>
              </Card>
              <Field
                label={t('reports.dateField')}
                controlId="rb-date"
                hint={t('reports.dateFieldHint')}
              >
                <PathSelect
                  id="rb-date"
                  value={d.dateField}
                  options={options}
                  filter={(o) => isDateType(o.type)}
                  onChange={(v) => set({ dateField: v || undefined })}
                />
              </Field>
              {company && (
                <Field
                  label={t('reports.roles')}
                  controlId="rb-roles"
                  hint={t('reports.rolesHint')}
                >
                  <div className="d-flex flex-wrap gap-2">
                    {roles.data?.map((r) => (
                      <Form.Check
                        key={r.id}
                        id={`rb-role-${r.id}`}
                        label={r.name}
                        checked={d.roleIds?.includes(r.id) ?? false}
                        onChange={(e) =>
                          set({
                            roleIds: e.target.checked
                              ? [...(d.roleIds ?? []), r.id]
                              : (d.roleIds ?? []).filter((x) => x !== r.id),
                          })
                        }
                      />
                    ))}
                  </div>
                </Field>
              )}
            </Col>
          </Row>

          <div className="d-flex align-items-center gap-2 mb-2">
            <Button
              size="sm"
              variant="outline-secondary"
              onClick={() => void run()}
              disabled={busy}
            >
              <i className="bi bi-play me-1" />
              {t('reports.preview')}
            </Button>
            {preview && (
              <Badge bg="light" text="dark">
                {t('reports.previewNote')}
              </Badge>
            )}
          </div>
          <ErrorAlert error={error} />
          {preview && (
            <Card body>
              {d.chart && preview.kind !== 'rows' && (
                <ReportChart result={preview} type={d.chart.type} format={format} height={260} />
              )}
              <ReportView result={preview} format={format} height={300} />
            </Card>
          )}
        </>
      )}
    </div>
  );
}

/** Drops half-filled rows so the definition validates. */
export function clean(d: Partial<ReportDef>, options: PathOption[]): Partial<ReportDef> {
  return {
    ...d,
    columns: (d.columns ?? []).filter((c) => c.path),
    filters: cleanFilters(d.filters ?? [], options),
    sort: d.sort?.filter((s) => s.path).length ? d.sort.filter((s) => s.path) : undefined,
    groupBy: d.groupBy?.filter((g) => g.path).length ? d.groupBy.filter((g) => g.path) : undefined,
    aggregates: d.aggregates?.length ? d.aggregates : undefined,
    roleIds: d.roleIds?.length ? d.roleIds : undefined,
  };
}
