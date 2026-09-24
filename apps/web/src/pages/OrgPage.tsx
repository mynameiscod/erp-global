import { useMemo, useState } from 'react';
import { Badge, Button, ButtonGroup, Card, Form, Modal } from 'react-bootstrap';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import type { OrgUnitDto } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import {
  applyFieldErrors,
  ErrorAlert,
  Field,
  Loading,
  PageHeader,
  StatusBadge,
} from '../components/ui';
import { CustomFields, customFieldErrors } from '../records/CustomFields';

interface TreeNode extends OrgUnitDto {
  children: TreeNode[];
}

function buildTree(units: OrgUnitDto[]): TreeNode[] {
  const byId = new Map<string, TreeNode>(units.map((u) => [u.id, { ...u, children: [] }]));
  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (list: TreeNode[]) => {
    list.sort((a, b) => a.name.localeCompare(b.name));
    list.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

type Dialog =
  | { kind: 'create'; parent: OrgUnitDto }
  | { kind: 'edit'; unit: OrgUnitDto }
  | { kind: 'move'; unit: OrgUnitDto }
  | null;

export function OrgPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [showInactive, setShowInactive] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [error, setError] = useState<unknown>(null);

  const units = useQuery({
    queryKey: ['org-units', showInactive],
    queryFn: () => api<OrgUnitDto[]>('/org/units', { query: { includeInactive: showInactive } }),
  });
  const types = useQuery({
    queryKey: ['org-unit-types'],
    queryFn: () => api<string[]>('/org/unit-types'),
  });
  const tree = useMemo(() => buildTree(units.data ?? []), [units.data]);
  const refresh = () => qc.invalidateQueries({ queryKey: ['org-units'] });

  const deactivate = useMutation({
    mutationFn: (u: OrgUnitDto) => api(`/org/units/${u.id}/deactivate`, { method: 'POST' }),
    onSuccess: refresh,
    onError: setError,
  });

  const toggle = (id: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderNode = (n: TreeNode) => (
    <li key={n.id} className="org-node">
      <div className="org-row d-flex align-items-center gap-2 rounded px-2 py-1">
        {n.children.length > 0 ? (
          <Button
            variant="link"
            size="sm"
            className="p-0 text-body"
            onClick={() => toggle(n.id)}
            aria-label="toggle"
          >
            <i
              className={`bi ${collapsed.has(n.id) ? 'bi-chevron-right flip-rtl' : 'bi-chevron-down'}`}
            />
          </Button>
        ) : (
          <span className="org-spacer" />
        )}
        <i className="bi bi-building text-primary" />
        <span className="fw-medium">{n.name}</span>
        <Badge bg="light" text="dark" className="border">
          {n.type}
        </Badge>
        {n.code && <span className="small text-body-secondary font-monospace">{n.code}</span>}
        {n.status !== 'active' && <StatusBadge status={n.status} />}
        {n.children.length > 0 && collapsed.has(n.id) && (
          <span className="small text-body-secondary">
            {t('org.children', { count: n.children.length })}
          </span>
        )}
        <ButtonGroup size="sm" className="ms-auto org-actions">
          {can('org.unit.create', n.path) && n.status === 'active' && (
            <Button
              variant="outline-primary"
              onClick={() => setDialog({ kind: 'create', parent: n })}
              title={t('org.addChild')}
            >
              <i className="bi bi-plus-lg" />
            </Button>
          )}
          {can('org.unit.update', n.path) && (
            <Button
              variant="outline-secondary"
              onClick={() => setDialog({ kind: 'edit', unit: n })}
              title={t('common.edit')}
            >
              <i className="bi bi-pencil" />
            </Button>
          )}
          {n.parentId && can('org.unit.move', n.path) && (
            <Button
              variant="outline-secondary"
              onClick={() => setDialog({ kind: 'move', unit: n })}
              title={t('org.move')}
            >
              <i className="bi bi-arrows-move" />
            </Button>
          )}
          {n.parentId && n.status === 'active' && can('org.unit.deactivate', n.path) && (
            <Button
              variant="outline-danger"
              title={t('org.deactivate')}
              onClick={() => window.confirm(t('common.confirm')) && deactivate.mutate(n)}
            >
              <i className="bi bi-slash-circle" />
            </Button>
          )}
        </ButtonGroup>
      </div>
      {n.children.length > 0 && !collapsed.has(n.id) && (
        <ul className="org-children">{n.children.map(renderNode)}</ul>
      )}
    </li>
  );

  return (
    <>
      <PageHeader
        title={t('org.title')}
        subtitle={t('org.subtitle')}
        actions={
          <Form.Check
            type="switch"
            id="inactive"
            label={t('org.showInactive')}
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
        }
      />
      <ErrorAlert error={error ?? units.error} onClose={() => setError(null)} />
      <Card className="shadow-sm border-0">
        <Card.Body>
          {units.isLoading ? (
            <Loading />
          ) : (
            <ul className="org-tree mb-0">{tree.map(renderNode)}</ul>
          )}
        </Card.Body>
      </Card>
      <datalist id="unit-types">
        {types.data?.map((ty) => (
          <option key={ty} value={ty} />
        ))}
      </datalist>
      {dialog?.kind === 'create' || dialog?.kind === 'edit' ? (
        <UnitDialog dialog={dialog} onClose={() => setDialog(null)} onSaved={refresh} />
      ) : null}
      {dialog?.kind === 'move' && (
        <MoveDialog
          unit={dialog.unit}
          units={units.data ?? []}
          onClose={() => setDialog(null)}
          onSaved={refresh}
        />
      )}
    </>
  );
}

interface UnitForm {
  name: string;
  code: string;
  type: string;
}

function UnitDialog({
  dialog,
  onClose,
  onSaved,
}: {
  dialog: { kind: 'create'; parent: OrgUnitDto } | { kind: 'edit'; unit: OrgUnitDto };
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<unknown>(null);
  const editing = dialog.kind === 'edit' ? dialog.unit : null;
  const [custom, setCustom] = useState<Record<string, unknown>>(editing?.custom ?? {});
  const [customErrors, setCustomErrors] = useState<Record<string, string>>({});
  const form = useForm<UnitForm>({
    defaultValues: {
      name: editing?.name ?? '',
      code: editing?.code ?? '',
      type: editing?.type ?? '',
    },
  });
  const submit = form.handleSubmit(async (v) => {
    setError(null);
    const body = { name: v.name, type: v.type, ...(v.code ? { code: v.code } : {}), custom };
    try {
      if (editing) await api(`/org/units/${editing.id}`, { method: 'PATCH', body });
      else
        await api('/org/units', {
          method: 'POST',
          body: { ...body, parentId: (dialog as { parent: OrgUnitDto }).parent.id },
        });
      onSaved();
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
          <Modal.Title className="h5">{editing ? t('org.editUnit') : t('org.addUnit')}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <ErrorAlert error={error} />
          {dialog.kind === 'create' && (
            <p className="small text-body-secondary">
              {t('org.parent')}: <strong>{dialog.parent.name}</strong>
            </p>
          )}
          <Field
            label={t('common.name')}
            controlId="name"
            error={form.formState.errors.name?.message}
          >
            <Form.Control {...form.register('name', { required: true })} autoFocus />
          </Field>
          <Field
            label={t('common.type')}
            controlId="type"
            error={form.formState.errors.type?.message}
            hint={t('org.typeHint')}
          >
            <Form.Control {...form.register('type', { required: true })} list="unit-types" />
          </Field>
          <Field
            label={`${t('common.code')} (${t('common.optional')})`}
            controlId="code"
            error={form.formState.errors.code?.message}
          >
            <Form.Control {...form.register('code')} className="font-monospace" />
          </Field>
          <CustomFields
            entityKey="org_unit"
            values={custom}
            errors={customErrors}
            onChange={setCustom}
            orgUnitId={editing ? editing.id : (dialog as { parent: OrgUnitDto }).parent.id}
          />
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {t('common.save')}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}

function MoveDialog({
  unit,
  units,
  onClose,
  onSaved,
}: {
  unit: OrgUnitDto;
  units: OrgUnitDto[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [target, setTarget] = useState('');
  const [error, setError] = useState<unknown>(null);
  const options = units.filter(
    (u) =>
      u.status === 'active' &&
      !u.path.startsWith(unit.path) &&
      u.id !== unit.parentId &&
      can('org.unit.move', u.path),
  );
  const move = useMutation({
    mutationFn: () =>
      api(`/org/units/${unit.id}/move`, { method: 'POST', body: { newParentId: target } }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: setError,
  });
  return (
    <Modal show onHide={onClose} centered>
      <Modal.Header closeButton>
        <Modal.Title className="h5">{t('org.moveUnit', { name: unit.name })}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <ErrorAlert error={error} />
        <Field label={t('org.newParent')} controlId="target">
          <Form.Select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="" />
            {options.map((u) => (
              <option key={u.id} value={u.id}>
                {'— '.repeat(u.depth)}
                {u.name} ({u.type})
              </option>
            ))}
          </Form.Select>
        </Field>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button disabled={!target || move.isPending} onClick={() => move.mutate()}>
          {t('org.move')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
