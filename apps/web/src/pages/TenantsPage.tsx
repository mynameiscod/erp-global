import { useMemo, useState } from 'react';
import { Button, Form, InputGroup } from 'react-bootstrap';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import type { Page } from '@erp/contracts';
import { api } from '../api/client';
import type { TenantDto } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { DataGrid } from '../components/DataGrid';
import { ErrorAlert, PageHeader, StatusBadge } from '../components/ui';
import { formatDateTime } from '../lib/format';

/** Super Admin view of every company on the platform. */
export function TenantsPage() {
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [filter, setFilter] = useState('');
  const tenants = useQuery({
    queryKey: ['platform-tenants'],
    queryFn: () => api<Page<TenantDto>>('/platform/tenants', { query: { pageSize: 200 } }),
  });
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'suspended' }) =>
      api(`/platform/tenants/${id}/status`, { method: 'PATCH', body: { status } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform-tenants'] }),
  });

  const columns = useMemo<ColDef<TenantDto>[]>(
    () => [
      { field: 'name', headerName: t('common.name'), minWidth: 180 },
      { field: 'slug', headerName: t('tenants.slug'), cellClass: 'font-monospace' },
      { field: 'countryCode', headerName: t('common.country'), maxWidth: 110 },
      { field: 'industryCode', headerName: t('common.industry') },
      {
        field: 'placement',
        headerName: t('tenants.placement'),
        valueFormatter: (p) => t(`settings.${p.value}`),
      },
      {
        field: 'status',
        headerName: t('common.status'),
        maxWidth: 140,
        cellRenderer: (p: ICellRendererParams<TenantDto>) =>
          p.data && <StatusBadge status={p.data.status} />,
      },
      {
        field: 'createdAt',
        headerName: t('tenants.created'),
        valueFormatter: (p) => formatDateTime(p.value, i18n.language),
      },
      {
        headerName: t('common.actions'),
        sortable: false,
        filter: false,
        minWidth: 140,
        cellRenderer: (p: ICellRendererParams<TenantDto>) => {
          const d = p.data;
          if (!d || !can('platform.tenant.manage') || !['active', 'suspended'].includes(d.status))
            return null;
          const next = d.status === 'active' ? 'suspended' : 'active';
          return (
            <Button
              size="sm"
              variant={next === 'suspended' ? 'outline-warning' : 'outline-success'}
              onClick={() =>
                window.confirm(t('common.confirm')) && setStatus.mutate({ id: d.id, status: next })
              }
            >
              {next === 'suspended' ? t('tenants.suspend') : t('tenants.activate')}
            </Button>
          );
        },
      },
    ],
    [t, i18n.language, can, setStatus],
  );

  return (
    <>
      <PageHeader title={t('tenants.title')} />
      <ErrorAlert error={tenants.error ?? setStatus.error} />
      <InputGroup className="mb-3" style={{ maxWidth: 360 }}>
        <InputGroup.Text>
          <i className="bi bi-search" />
        </InputGroup.Text>
        <Form.Control
          placeholder={t('common.search')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </InputGroup>
      <DataGrid
        rows={tenants.data?.items}
        columns={columns}
        rowId={(x) => x.id}
        loading={tenants.isLoading}
        quickFilter={filter}
      />
    </>
  );
}
