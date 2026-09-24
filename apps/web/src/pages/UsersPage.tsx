import { useMemo, useState } from 'react';
import { Alert, Button, Col, Form, InputGroup, ListGroup, Modal, Row } from 'react-bootstrap';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import { z } from 'zod';
import { inviteUserSchema, UI_LANGUAGES, type Page } from '@erp/contracts';
import { api } from '../api/client';
import type { AssignmentDto, OrgUnitDto, RoleDto, UserDto } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { DataGrid } from '../components/DataGrid';
import { applyFieldErrors, ErrorAlert, Field, PageHeader, StatusBadge } from '../components/ui';
import { formatDateTime } from '../lib/format';
import { CustomFields, customFieldErrors } from '../records/CustomFields';

export function UsersPage() {
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const [filter, setFilter] = useState('');
  const [inviting, setInviting] = useState(false);
  const [selected, setSelected] = useState<UserDto | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api<Page<UserDto>>('/identity/users', { query: { pageSize: 200 } }),
  });

  const columns = useMemo<ColDef<UserDto>[]>(
    () => [
      { field: 'name', headerName: t('common.name'), minWidth: 160 },
      { field: 'email', headerName: t('common.email'), minWidth: 200 },
      {
        field: 'status',
        headerName: t('common.status'),
        maxWidth: 140,
        cellRenderer: (p: ICellRendererParams<UserDto>) =>
          p.data && <StatusBadge status={p.data.status} />,
      },
      {
        field: 'mfaEnabled',
        headerName: t('users.mfa'),
        maxWidth: 90,
        cellRenderer: (p: ICellRendererParams<UserDto>) =>
          p.value ? (
            <i className="bi bi-shield-check text-success" />
          ) : (
            <i className="bi bi-dash text-body-tertiary" />
          ),
      },
      {
        field: 'lastLoginAt',
        headerName: t('users.lastLogin'),
        valueFormatter: (p) => formatDateTime(p.value, i18n.language),
      },
      {
        headerName: t('common.actions'),
        sortable: false,
        filter: false,
        maxWidth: 130,
        cellRenderer: (p: ICellRendererParams<UserDto>) => (
          <Button size="sm" variant="outline-primary" onClick={() => p.data && setSelected(p.data)}>
            {t('common.edit')}
          </Button>
        ),
      },
    ],
    [t, i18n.language],
  );

  return (
    <>
      <PageHeader
        title={t('users.title')}
        actions={
          can('identity.user.invite') && (
            <Button onClick={() => setInviting(true)}>
              <i className="bi bi-person-plus me-1" />
              {t('users.invite')}
            </Button>
          )
        }
      />
      {notice && (
        <Alert variant="success" dismissible onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}
      <ErrorAlert error={users.error} />
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
        rows={users.data?.items}
        columns={columns}
        rowId={(u) => u.id}
        loading={users.isLoading}
        quickFilter={filter}
      />
      {inviting && (
        <InviteDialog
          onClose={() => setInviting(false)}
          onInvited={(email) => setNotice(t('users.inviteSent', { email }))}
        />
      )}
      {selected && <UserDialog user={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

function InviteDialog({
  onClose,
  onInvited,
}: {
  onClose: () => void;
  onInvited: (email: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [custom, setCustom] = useState<Record<string, unknown>>({});
  const [customErrors, setCustomErrors] = useState<Record<string, string>>({});
  const form = useForm<z.input<typeof inviteUserSchema>>({
    resolver: zodResolver(inviteUserSchema),
    defaultValues: { name: '', email: '', language: i18n.language },
  });
  const submit = form.handleSubmit(async (v) => {
    setError(null);
    setCustomErrors({});
    try {
      const u = await api<UserDto>('/identity/users/invite', {
        method: 'POST',
        body: { ...v, custom },
      });
      await qc.invalidateQueries({ queryKey: ['users'] });
      onInvited(u.email);
      onClose();
    } catch (e) {
      const ce = customFieldErrors(e);
      setCustomErrors(ce);
      if (!applyFieldErrors(e, form.setError as never) && !Object.keys(ce).length) setError(e);
    }
  });
  return (
    <Modal show onHide={onClose} centered>
      <Form onSubmit={submit} noValidate>
        <Modal.Header closeButton>
          <Modal.Title className="h5">{t('users.invite')}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <ErrorAlert error={error} />
          <Field
            label={t('common.name')}
            controlId="name"
            error={form.formState.errors.name?.message}
          >
            <Form.Control {...form.register('name')} autoFocus />
          </Field>
          <Field
            label={t('common.email')}
            controlId="email"
            error={form.formState.errors.email?.message}
          >
            <Form.Control type="email" {...form.register('email')} dir="ltr" />
          </Field>
          <Field label={t('common.language')} controlId="language">
            <Form.Select {...form.register('language')}>
              {UI_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </Form.Select>
          </Field>
          <CustomFields
            entityKey="user"
            values={custom}
            errors={customErrors}
            onChange={setCustom}
          />
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {t('users.invite')}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}

function UserDialog({ user, onClose }: { user: UserDto; onClose: () => void }) {
  const { t } = useTranslation();
  const { can, user: me } = useAuth();
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [roleId, setRoleId] = useState('');
  const [unitId, setUnitId] = useState('');

  const canAssign = can('access.assignment.manage');
  const assignments = useQuery({
    queryKey: ['assignments', user.id],
    queryFn: () => api<AssignmentDto[]>('/access/assignments', { query: { userId: user.id } }),
    enabled: can('access.assignment.read'),
  });
  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: () => api<RoleDto[]>('/access/roles'),
    enabled: canAssign,
  });
  const units = useQuery({
    queryKey: ['org-units', false],
    queryFn: () => api<OrgUnitDto[]>('/org/units'),
    enabled: canAssign,
  });
  const unitName = (id: string) => units.data?.find((u) => u.id === id)?.name ?? id;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['assignments', user.id] });
    void qc.invalidateQueries({ queryKey: ['users'] });
    void qc.invalidateQueries({ queryKey: ['roles'] });
  };
  const onError = (e: unknown) => setError(e);
  const assign = useMutation({
    mutationFn: () =>
      api('/access/assignments', {
        method: 'POST',
        body: { userId: user.id, roleId, orgUnitId: unitId },
      }),
    onSuccess: () => {
      setRoleId('');
      refresh();
    },
    onError,
  });
  const unassign = useMutation({
    mutationFn: (id: string) => api(`/access/assignments/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError,
  });
  const setStatus = useMutation({
    mutationFn: (action: 'deactivate' | 'reactivate' | 'resend-invite') =>
      api(`/identity/users/${user.id}/${action}`, { method: 'POST' }),
    onSuccess: () => {
      refresh();
      onClose();
    },
    onError,
  });

  return (
    <Modal show onHide={onClose} centered size="lg">
      <Modal.Header closeButton>
        <Modal.Title className="h5">
          {user.name} <StatusBadge status={user.status} />
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <ErrorAlert error={error} onClose={() => setError(null)} />
        <p className="text-body-secondary" dir="ltr">
          {user.email}
        </p>
        {can('identity.user.manage') && <UserCustomFields user={user} />}
        <h2 className="h6">{t('users.assignments')}</h2>
        <ListGroup className="mb-3">
          {assignments.data?.length === 0 && (
            <ListGroup.Item className="text-body-secondary">
              {t('users.noAssignments')}
            </ListGroup.Item>
          )}
          {assignments.data?.map((a) => (
            <ListGroup.Item key={a.id} className="d-flex align-items-center gap-2">
              <i className="bi bi-shield-lock text-primary" />
              <strong>{a.roleName}</strong>
              <span className="text-body-secondary">@ {unitName(a.orgUnitId)}</span>
              {can('access.assignment.manage', a.orgUnitPath) && (
                <Button
                  size="sm"
                  variant="outline-danger"
                  className="ms-auto"
                  onClick={() => unassign.mutate(a.id)}
                >
                  {t('users.remove')}
                </Button>
              )}
            </ListGroup.Item>
          ))}
        </ListGroup>
        {canAssign && user.status !== 'deactivated' && (
          <Row className="g-2 align-items-end">
            <Col sm={5}>
              <Form.Label>{t('users.role')}</Form.Label>
              <Form.Select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
                <option value="" />
                {roles.data?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Form.Select>
            </Col>
            <Col sm={5}>
              <Form.Label>{t('users.orgUnit')}</Form.Label>
              <Form.Select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
                <option value="" />
                {units.data
                  ?.filter((u) => can('access.assignment.manage', u.path))
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {'— '.repeat(u.depth)}
                      {u.name}
                    </option>
                  ))}
              </Form.Select>
            </Col>
            <Col sm={2}>
              <Button
                className="w-100"
                disabled={!roleId || !unitId || assign.isPending}
                onClick={() => assign.mutate()}
              >
                {t('users.assignRole')}
              </Button>
            </Col>
          </Row>
        )}
      </Modal.Body>
      <Modal.Footer className="justify-content-between">
        <div className="d-flex gap-2">
          {user.status === 'invited' && can('identity.user.invite') && (
            <Button variant="outline-primary" onClick={() => setStatus.mutate('resend-invite')}>
              {t('users.resend')}
            </Button>
          )}
          {user.id !== me?.id && can('identity.user.manage') && user.status !== 'deactivated' && (
            <Button
              variant="outline-danger"
              onClick={() => window.confirm(t('common.confirm')) && setStatus.mutate('deactivate')}
            >
              {t('users.deactivate')}
            </Button>
          )}
          {can('identity.user.manage') && user.status === 'deactivated' && (
            <Button variant="outline-success" onClick={() => setStatus.mutate('reactivate')}>
              {t('users.reactivate')}
            </Button>
          )}
        </div>
        <Button variant="secondary" onClick={onClose}>
          {t('common.close')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

function UserCustomFields({ user }: { user: UserDto }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [values, setValues] = useState<Record<string, unknown>>(user.custom ?? {});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const save = async () => {
    setErrors({});
    setError(null);
    setSaved(false);
    try {
      await api<UserDto>(`/identity/users/${user.id}`, {
        method: 'PATCH',
        body: { custom: values },
      });
      await qc.invalidateQueries({ queryKey: ['users'] });
      setSaved(true);
    } catch (e) {
      const ce = customFieldErrors(e);
      setErrors(ce);
      if (!Object.keys(ce).length) setError(e);
    }
  };
  return (
    <div className="mb-3">
      <ErrorAlert error={error} />
      {saved && <Alert variant="success">{t('common.saved')}</Alert>}
      <CustomFields entityKey="user" values={values} errors={errors} onChange={setValues} />
      {Object.keys(user.custom ?? {}).length > 0 || Object.keys(values).length > 0 ? (
        <Button size="sm" onClick={() => void save()}>
          {t('common.save')}
        </Button>
      ) : null}
    </div>
  );
}
