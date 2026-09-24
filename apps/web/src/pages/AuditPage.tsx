import { useMemo, useState } from 'react';
import { Alert, Button, Form, Modal } from 'react-bootstrap';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import type { Page } from '@erp/contracts';
import { api } from '../api/client';
import type { AuditRecordDto, VerifyResult } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { DataGrid } from '../components/DataGrid';
import { ErrorAlert, PageHeader } from '../components/ui';
import { formatDateTime } from '../lib/format';

export function AuditPage() {
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const [type, setType] = useState('');
  const [selected, setSelected] = useState<AuditRecordDto | null>(null);

  const events = useQuery({
    queryKey: ['audit', type],
    queryFn: () =>
      api<Page<AuditRecordDto>>('/audit/events', {
        query: { pageSize: 200, type: type || undefined },
      }),
  });
  const verify = useMutation({ mutationFn: () => api<VerifyResult>('/audit/verify') });

  const columns = useMemo<ColDef<AuditRecordDto>[]>(
    () => [
      { field: 'seq', headerName: t('audit.seq'), maxWidth: 90, sort: 'desc' },
      {
        field: 'occurredAt',
        headerName: t('audit.when'),
        valueFormatter: (p) => formatDateTime(p.value, i18n.language),
        minWidth: 180,
      },
      {
        field: 'type',
        headerName: t('audit.event'),
        minWidth: 220,
        cellClass: 'font-monospace small',
      },
      {
        headerName: t('audit.actor'),
        valueGetter: (p) => (p.data ? `${p.data.actor.type}:${p.data.actor.id}` : ''),
        cellClass: 'font-monospace small',
      },
      { field: 'source', headerName: t('audit.source'), maxWidth: 170 },
      {
        headerName: t('audit.details'),
        sortable: false,
        filter: false,
        maxWidth: 110,
        cellRenderer: (p: ICellRendererParams<AuditRecordDto>) => (
          <Button
            size="sm"
            variant="outline-secondary"
            onClick={() => p.data && setSelected(p.data)}
          >
            <i className="bi bi-braces" />
          </Button>
        ),
      },
    ],
    [t, i18n.language],
  );

  const types = [...new Set(events.data?.items.map((e) => e.type) ?? [])].sort();

  return (
    <>
      <PageHeader
        title={t('audit.title')}
        subtitle={t('audit.subtitle')}
        actions={
          can('audit.chain.verify') && (
            <Button
              variant="outline-success"
              onClick={() => verify.mutate()}
              disabled={verify.isPending}
            >
              <i className="bi bi-patch-check me-1" />
              {t('audit.verify')}
            </Button>
          )
        }
      />
      {verify.data &&
        (verify.data.valid ? (
          <Alert variant="success">
            <i className="bi bi-shield-check me-2" />
            {t('audit.valid', { count: verify.data.records })}
          </Alert>
        ) : (
          <Alert variant="danger">
            <i className="bi bi-exclamation-octagon me-2" />
            {t('audit.invalid', {
              seq: verify.data.brokenAt?.seq,
              reason: verify.data.brokenAt?.reason,
            })}
          </Alert>
        ))}
      <ErrorAlert error={events.error ?? verify.error} />
      <Form.Select
        className="mb-3"
        style={{ maxWidth: 360 }}
        value={type}
        onChange={(e) => setType(e.target.value)}
        aria-label={t('audit.filterType')}
      >
        <option value="">{t('audit.filterType')}</option>
        {types.map((ty) => (
          <option key={ty}>{ty}</option>
        ))}
      </Form.Select>
      <DataGrid
        rows={events.data?.items}
        columns={columns}
        rowId={(e) => e.eventId}
        loading={events.isLoading}
      />
      {selected && (
        <Modal show onHide={() => setSelected(null)} size="lg" centered>
          <Modal.Header closeButton>
            <Modal.Title className="h6 font-monospace">
              #{selected.seq} {selected.type}
            </Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <pre className="bg-body-tertiary p-3 rounded small mb-0" dir="ltr">
              {JSON.stringify(selected, null, 2)}
            </pre>
          </Modal.Body>
        </Modal>
      )}
    </>
  );
}
