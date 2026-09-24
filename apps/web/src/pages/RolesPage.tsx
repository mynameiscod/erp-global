import { useMemo, useState } from 'react';
import { Badge, Button, Card, Col, Form, Modal, Row } from 'react-bootstrap';
import { useForm } from 'react-hook-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import type { PermissionKey } from '@erp/contracts';
import { api } from '../api/client';
import type { PermissionDefDto, RoleDto } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { DataGrid } from '../components/DataGrid';
import { applyFieldErrors, ErrorAlert, Field, PageHeader } from '../components/ui';

export function RolesPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [editing, setEditing] = useState<RoleDto | 'new' | null>(null);
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api<RoleDto[]>('/access/roles') });
  const catalog = useQuery({
    queryKey: ['permissions'],
    queryFn: () => api<PermissionDefDto[]>('/access/permissions'),
    staleTime: Infinity,
  });

  const columns = useMemo<ColDef<RoleDto>[]>(
    () => [
      {
        field: 'name',
        headerName: t('common.name'),
        cellRenderer: (p: ICellRendererParams<RoleDto>) =>
          p.data && (
            <span>
              {p.data.name} {p.data.system && <Badge bg="secondary">{t('roles.system')}</Badge>}
            </span>
          ),
      },
      { field: 'description', headerName: t('roles.description'), flex: 2 },
      {
        headerName: t('roles.permissions'),
        valueGetter: (p) => p.data?.permissions.length,
        valueFormatter: (p) => t('roles.count', { count: p.value }),
        maxWidth: 170,
      },
      { field: 'assignmentCount', headerName: t('roles.assigned'), maxWidth: 130 },
      {
        headerName: t('common.actions'),
        sortable: false,
        filter: false,
        maxWidth: 130,
        cellRenderer: (p: ICellRendererParams<RoleDto>) =>
          p.data && (
            <Button size="sm" variant="outline-primary" onClick={() => setEditing(p.data!)}>
              {p.data.system || !can('access.role.manage') ? (
                <i className="bi bi-eye" />
              ) : (
                t('common.edit')
              )}
            </Button>
          ),
      },
    ],
    [t, can],
  );

  return (
    <>
      <PageHeader
        title={t('roles.title')}
        subtitle={t('roles.subtitle')}
        actions={
          can('access.role.manage') && (
            <Button onClick={() => setEditing('new')}>
              <i className="bi bi-plus-lg me-1" />
              {t('roles.create')}
            </Button>
          )
        }
      />
      <ErrorAlert error={roles.error} />
      <DataGrid
        rows={roles.data}
        columns={columns}
        rowId={(r) => r.id}
        loading={roles.isLoading}
        height={440}
      />
      {editing && catalog.data && (
        <RoleDialog
          role={editing === 'new' ? null : editing}
          catalog={catalog.data}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

interface RoleForm {
  name: string;
  description: string;
  permissions: PermissionKey[];
}

function RoleDialog({
  role,
  catalog,
  onClose,
}: {
  role: RoleDto | null;
  catalog: PermissionDefDto[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const readOnly = !!role?.system || !can('access.role.manage');
  const form = useForm<RoleForm>({
    defaultValues: {
      name: role?.name ?? '',
      description: role?.description ?? '',
      permissions: role?.permissions ?? [],
    },
  });
  const selected = new Set(form.watch('permissions'));
  const byModule = useMemo(() => {
    const m = new Map<string, PermissionDefDto[]>();
    for (const p of catalog) m.set(p.module, [...(m.get(p.module) ?? []), p]);
    return [...m.entries()];
  }, [catalog]);

  const toggleModule = (perms: PermissionDefDto[], on: boolean) => {
    const next = new Set(selected);
    for (const p of perms) {
      // You can only grant what you hold; the API enforces this too.
      if (on && can(p.key)) next.add(p.key);
      else if (!on) next.delete(p.key);
    }
    form.setValue('permissions', [...next]);
  };

  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      const body = {
        name: v.name,
        description: v.description || undefined,
        permissions: v.permissions,
      };
      if (role) await api(`/access/roles/${role.id}`, { method: 'PATCH', body });
      else await api('/access/roles', { method: 'POST', body });
      await qc.invalidateQueries({ queryKey: ['roles'] });
      onClose();
    } catch (e) {
      if (!applyFieldErrors(e, form.setError as never)) setError(e);
    }
  });

  const remove = async () => {
    if (!role || !window.confirm(t('common.confirm'))) return;
    try {
      await api(`/access/roles/${role.id}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['roles'] });
      onClose();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <Modal show onHide={onClose} centered size="lg" scrollable>
      <Form onSubmit={submit} noValidate>
        <Modal.Header closeButton>
          <Modal.Title className="h5">{role ? role.name : t('roles.create')}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <ErrorAlert error={error} onClose={() => setError(null)} />
          <Row>
            <Col md={5}>
              <Field
                label={t('common.name')}
                controlId="name"
                error={form.formState.errors.name?.message}
              >
                <Form.Control {...form.register('name', { required: true })} disabled={readOnly} />
              </Field>
            </Col>
            <Col md={7}>
              <Field label={t('roles.description')} controlId="description">
                <Form.Control {...form.register('description')} disabled={readOnly} />
              </Field>
            </Col>
          </Row>
          <h2 className="h6">{t('roles.permissions')}</h2>
          <Row className="g-3">
            {byModule.map(([module, perms]) => {
              const allOn = perms.every((p) => selected.has(p.key));
              return (
                <Col md={6} key={module}>
                  <Card className="h-100">
                    <Card.Header className="d-flex align-items-center bg-body-tertiary">
                      <Form.Check
                        type="checkbox"
                        id={`mod-${module}`}
                        label={<span className="text-capitalize fw-semibold">{module}</span>}
                        checked={allOn}
                        disabled={readOnly}
                        onChange={(e) => toggleModule(perms, e.target.checked)}
                      />
                    </Card.Header>
                    <Card.Body className="py-2">
                      {perms.map((p) => (
                        <Form.Check
                          key={p.key}
                          type="checkbox"
                          id={p.key}
                          value={p.key}
                          disabled={readOnly || (!can(p.key) && !selected.has(p.key))}
                          label={
                            <span>
                              {p.description} <code className="small">{p.key}</code>
                            </span>
                          }
                          {...form.register('permissions')}
                        />
                      ))}
                    </Card.Body>
                  </Card>
                </Col>
              );
            })}
          </Row>
        </Modal.Body>
        <Modal.Footer className="justify-content-between">
          <div>
            {role && !readOnly && (
              <Button variant="outline-danger" onClick={() => void remove()}>
                {t('common.delete')}
              </Button>
            )}
          </div>
          <div className="d-flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              {readOnly ? t('common.close') : t('common.cancel')}
            </Button>
            {!readOnly && (
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {t('common.save')}
              </Button>
            )}
          </div>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
