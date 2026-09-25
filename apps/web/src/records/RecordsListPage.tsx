import { useEffect, useMemo, useState } from 'react';
import { Button, Form, InputGroup } from 'react-bootstrap';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ColDef, ValueFormatterParams } from 'ag-grid-community';
import { recordPermission, type Page } from '@erp/contracts';
import {
  activeFields,
  findEntity,
  workflowFor,
  type EntityDef,
  type FieldDef,
} from '@erp/metadata';
import { api } from '../api/client';
import type { OrgUnitDto } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { useEffectiveConfig, useLabel } from '../config/hooks';
import { DataGrid } from '../components/DataGrid';
import { ErrorAlert, Loading, PageHeader } from '../components/ui';
import { formatDateTime } from '../lib/format';
import { displayValue } from './display';

export interface RecordDto {
  id: string;
  entity: string;
  number: string | null;
  /** Workflow state; null when the entity has no workflow. */
  status?: string | null;
  data: Record<string, unknown>;
  orgUnitId: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

/** Titles for every linked record in the rows, fetched in one go per target. */
function useLinkedTitles(entity: EntityDef | undefined, rows: RecordDto[] | undefined) {
  const wanted = useMemo(() => {
    const byTarget = new Map<string, Set<string>>();
    for (const f of entity?.fields ?? []) {
      if ((f.type !== 'lookup' && f.type !== 'lookup_many') || !f.target) continue;
      for (const r of rows ?? []) {
        const v = r.data[f.key];
        for (const id of Array.isArray(v) ? v : v ? [v] : []) {
          if (!byTarget.has(f.target)) byTarget.set(f.target, new Set());
          byTarget.get(f.target)!.add(String(id));
        }
      }
    }
    return [...byTarget].map(([target, ids]) => [target, [...ids].sort()] as const);
  }, [entity, rows]);

  return useQuery({
    queryKey: ['linked-titles', JSON.stringify(wanted)],
    enabled: wanted.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const titles = new Map<string, string>();
      for (const [target, ids] of wanted) {
        if (target === 'org_unit') {
          for (const u of await api<OrgUnitDto[]>('/org/units')) titles.set(u.id, u.name);
        } else if (target === 'user') {
          const users = await api<Page<{ id: string; name: string }>>('/identity/users', {
            query: { pageSize: 200 },
          });
          for (const u of users.items) titles.set(u.id, u.name);
        } else {
          for (let i = 0; i < ids.length; i += 100) {
            const res = await api<{ id: string; title: string }[]>(`/records/${target}/lookup`, {
              query: { ids: ids.slice(i, i + 100).join(',') },
            });
            for (const r of res) titles.set(r.id, r.title);
          }
        }
      }
      return titles;
    },
  });
}

export function RecordsListPage() {
  const { entity: key = '' } = useParams();
  const { t, i18n } = useTranslation();
  const label = useLabel();
  const { can } = useAuth();
  const navigate = useNavigate();
  const cfg = useEffectiveConfig();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const h = setTimeout(() => setSearch(q), 300);
    return () => clearTimeout(h);
  }, [q]);

  const entity = cfg.data ? findEntity(cfg.data, key) : undefined;
  const view = cfg.data?.listViews.find((v) => v.entity === key);
  const workflow = cfg.data ? workflowFor(cfg.data, key) : undefined;
  const [status, setStatus] = useState('');
  const rows = useQuery({
    queryKey: ['records', key, search, view?.sort?.field, view?.sort?.dir, status],
    enabled: !!entity,
    queryFn: () =>
      api<Page<RecordDto>>(`/records/${key}`, {
        query: {
          pageSize: 200,
          q: search || undefined,
          status: status || undefined,
          sort: view?.sort ? `${view.sort.field}:${view.sort.dir}` : undefined,
        },
      }),
  });
  const titles = useLinkedTitles(entity, rows.data?.items);
  const units = useQuery({
    queryKey: ['org-units', false],
    queryFn: () => api<OrgUnitDto[]>('/org/units'),
  });
  const unitName = useMemo(() => new Map(units.data?.map((u) => [u.id, u.name])), [units.data]);

  const columns = useMemo<ColDef<RecordDto>[]>(() => {
    if (!entity || !cfg.data) return [];
    const fields = new Map(entity.fields.map((f) => [f.key, f]));
    const keys =
      view?.columns ??
      [
        'number',
        ...(workflow ? ['status'] : []),
        ...(entity.titleField ? [entity.titleField] : []),
        ...activeFields(entity).map((f) => f.key),
      ]
        .filter((k, i, a) => a.indexOf(k) === i)
        .slice(0, 7);
    const ctx = { cfg: cfg.data, locale: cfg.data.tenant.locale, label, titles: titles.data };
    const system: Record<string, ColDef<RecordDto>> = {
      number: { headerName: '#', valueGetter: (p) => p.data?.number ?? '', maxWidth: 190 },
      createdAt: {
        headerName: t('tenants.created'),
        valueGetter: (p) => p.data?.createdAt,
        valueFormatter: (p: ValueFormatterParams<RecordDto>) =>
          formatDateTime(p.value, i18n.language),
      },
      updatedAt: {
        headerName: t('audit.when'),
        valueGetter: (p) => p.data?.updatedAt,
        valueFormatter: (p: ValueFormatterParams<RecordDto>) =>
          formatDateTime(p.value, i18n.language),
      },
      orgUnitId: {
        headerName: t('records.orgUnit'),
        valueGetter: (p) => unitName.get(p.data?.orgUnitId ?? '') ?? '',
      },
      status: {
        headerName: t('workflow.status'),
        valueGetter: (p) => p.data?.status ?? '',
        cellRenderer: (p: { data?: RecordDto }) => {
          const st = workflow?.states.find((x) => x.key === p.data?.status);
          return st ? (
            <span className="badge" style={{ background: st.color ?? '#6c757d' }}>
              {label(st.label)}
            </span>
          ) : null;
        },
      },
      createdBy: { headerName: t('audit.actor'), valueGetter: (p) => p.data?.createdBy },
      updatedBy: { headerName: t('audit.actor'), valueGetter: (p) => p.data?.updatedBy },
    };
    return keys
      .map((k): ColDef<RecordDto> | undefined => {
        if (system[k]) return system[k];
        const f: FieldDef | undefined = fields.get(k);
        if (!f || f.archived) return undefined;
        const numeric = ['integer', 'decimal', 'currency', 'percent'].includes(f.type);
        return {
          headerName: label(f.label),
          valueGetter: (p) => p.data?.data[k],
          valueFormatter: (p: ValueFormatterParams<RecordDto>) => displayValue(f, p.value, ctx),
          comparator: numeric
            ? (a: unknown, b: unknown) => {
                const n = (v: unknown) => Number((v as { amount?: string })?.amount ?? v ?? 0);
                return n(a) - n(b);
              }
            : undefined,
          type: numeric ? 'rightAligned' : undefined,
        };
      })
      .filter((c): c is ColDef<RecordDto> => !!c);
  }, [entity, cfg.data, view, label, titles.data, t, i18n.language, unitName, workflow]);

  if (cfg.isLoading) return <Loading />;
  if (!entity || entity.kind !== 'custom')
    return <p className="p-4 text-body-secondary">{t('errors.notFound')}</p>;

  return (
    <>
      <PageHeader
        title={label(entity.pluralLabel)}
        actions={
          can(recordPermission(key, 'create')) && (
            <Link className="btn btn-primary" to={`/r/${key}/new`}>
              <i className="bi bi-plus-lg me-1" />
              {t('records.new', { name: label(entity.label) })}
            </Link>
          )
        }
      />
      <ErrorAlert error={rows.error} />
      <div className="d-flex flex-wrap gap-2 mb-3">
        <InputGroup style={{ maxWidth: 360 }}>
          <InputGroup.Text>
            <i className="bi bi-search" />
          </InputGroup.Text>
          <Form.Control
            placeholder={t('common.search')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </InputGroup>
        {workflow && (
          <Form.Select
            style={{ maxWidth: 220 }}
            aria-label={t('workflow.status')}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">{t('workflow.anyStatus')}</option>
            {workflow.states.map((st) => (
              <option key={st.key} value={st.key}>
                {label(st.label)}
              </option>
            ))}
          </Form.Select>
        )}
      </div>
      {rows.data?.total === 0 && !search ? (
        <p className="text-body-secondary">{t('records.empty')}</p>
      ) : (
        <div>
          <DataGrid<RecordDto>
            rows={rows.data?.items}
            columns={[
              ...columns,
              {
                headerName: '',
                sortable: false,
                filter: false,
                maxWidth: 80,
                cellRenderer: (p: { data?: RecordDto }) =>
                  p.data && (
                    <Button
                      size="sm"
                      variant="outline-primary"
                      onClick={() => navigate(`/r/${key}/${p.data!.id}`)}
                    >
                      <i className="bi bi-pencil" />
                    </Button>
                  ),
              },
            ]}
            rowId={(r) => r.id}
            loading={rows.isLoading}
          />
        </div>
      )}
    </>
  );
}
