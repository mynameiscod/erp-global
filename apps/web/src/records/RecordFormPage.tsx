import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Form } from 'react-bootstrap';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { recordPermission } from '@erp/contracts';
import {
  applyFieldRules,
  findEntity,
  lockedFields,
  rulesFor,
  validateRecord,
  workflowFor,
  type RecordData,
} from '@erp/metadata';
import { api, ApiError } from '../api/client';
import type { OrgUnitDto } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { useEffectiveConfig, useLabel } from '../config/hooks';
import { ErrorAlert, Loading, PageHeader } from '../components/ui';
import { defaultFills } from './defaults';
import { DynamicFields, editableValues, type Values } from './DynamicFields';
import { PrintMenu } from './PrintMenu';
import type { RecordDto } from './RecordsListPage';
import { TaxPanel } from './TaxPanel';
import { browserTaxContext, previewTaxes, taxSources, unitChain } from './taxPreview';
import { WorkflowPanel } from './WorkflowPanel';

const ID_RE = /^[a-f0-9]{24}$/;

/** One record by id; shares the cache with the record form. */
const recordQuery = (entity: string, id: string) => ({
  queryKey: ['record', entity, id],
  queryFn: () => api<RecordDto>(`/records/${entity}/${id}`),
  staleTime: 30_000,
});

/** The signed-in user's role names and keys, for HAS_ROLE() in form rules. */
function useMyRoles() {
  return useQuery({
    queryKey: ['me', 'roles'],
    queryFn: () => api<{ name: string; key: string | null }[]>('/access/me/roles'),
    staleTime: 60_000,
  });
}

/** Create or edit one record. The form follows the configuration that applies at the record's org unit. */
export function RecordFormPage() {
  const { entity: key = '', id } = useParams();
  const isNew = !id || id === 'new';
  const { t } = useTranslation();
  const label = useLabel();
  const { can, user } = useAuth();
  const myRoles = useMyRoles();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const record = useQuery({
    queryKey: ['record', key, id],
    enabled: !isNew,
    queryFn: () => api<RecordDto>(`/records/${key}/${id}`),
  });
  const units = useQuery({
    queryKey: ['org-units', false],
    queryFn: () => api<OrgUnitDto[]>('/org/units'),
  });

  const [orgUnitId, setOrgUnitId] = useState<string>('');
  const [values, setValues] = useState<Values>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  /** The form has changes not yet saved; tax figures are then the browser's preview. */
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (record.data) {
      setValues(record.data.data);
      setOrgUnitId(record.data.orgUnitId ?? '');
      setDirty(false);
    }
  }, [record.data]);

  const companyCfg = useEffectiveConfig();
  const orgScoped = companyCfg.data ? findEntity(companyCfg.data, key)?.orgScoped !== false : true;
  const allowedUnits = useMemo(
    () =>
      (units.data ?? []).filter(
        (u) =>
          u.status === 'active' && can(recordPermission(key, isNew ? 'create' : 'update'), u.path),
      ),
    [units.data, can, key, isNew],
  );
  useEffect(() => {
    if (isNew && orgScoped && !orgUnitId && allowedUnits.length === 1)
      setOrgUnitId(allowedUnits[0].id);
  }, [isNew, orgScoped, orgUnitId, allowedUnits]);

  // Fields can differ per org unit (branch overrides), so load the config for the chosen unit.
  const cfg = useEffectiveConfig(orgScoped && orgUnitId ? orgUnitId : undefined);
  const entity = cfg.data ? findEntity(cfg.data, key) : undefined;

  // Business rules and workflow locks, evaluated live as the user types. The server applies
  // the same rules on save, so this is for guidance only.
  const workflow = cfg.data ? workflowFor(cfg.data, key) : undefined;
  const status = isNew ? (workflow?.initialState ?? null) : (record.data?.status ?? null);
  const formState = useMemo(() => {
    if (!entity || !cfg.data) return undefined;
    const rules = rulesFor(cfg.data, key, isNew ? 'create' : 'update');
    const path = units.data?.find((u) => u.id === orgUnitId)?.path ?? '';
    const codes = path
      .split('/')
      .filter(Boolean)
      .map((uid) => units.data?.find((u) => u.id === uid)?.code ?? '')
      .filter(Boolean);
    const env = {
      old: isNew ? undefined : record.data?.data,
      user: {
        id: user?.id ?? '',
        roles: (myRoles.data ?? []).flatMap((r) => [r.name, r.key ?? '']).filter(Boolean),
      },
      unitCodes: codes,
      status,
    };
    const { data, effects } = applyFieldRules(entity, rules, values, env);
    const setByRule = new Set(
      rules
        .filter((r) => r.effect === 'set' && r.field && data[r.field] !== values[r.field])
        .map((r) => r.field!),
    );
    const locked = isNew ? new Set<string>() : lockedFields(workflow, status, entity);
    return {
      shown: { ...values, ...Object.fromEntries([...setByRule].map((k) => [k, data[k]])) },
      hidden: effects.hidden,
      required: effects.required,
      readOnly: new Set([...effects.readonly, ...setByRule, ...locked]),
      locked: locked.size > 0,
    };
  }, [
    entity,
    cfg.data,
    key,
    isNew,
    units.data,
    orgUnitId,
    record.data,
    user,
    myRoles.data,
    status,
    values,
    workflow,
  ]);

  // Linked records the tax inputs read (e.g. the customer's state), for the live preview.
  const taxLinks = useMemo(
    () =>
      taxSources(entity)
        .map((src) => src.split('.'))
        .filter(([first, second]) => second !== undefined && first !== 'unit')
        .map(([first]) => entity?.fields.find((f) => f.key === first))
        .filter(
          (f, i, a) =>
            f?.type === 'lookup' &&
            !!f.target &&
            f.target !== 'user' &&
            f.target !== 'org_unit' &&
            a.indexOf(f) === i,
        )
        .map((f) => ({ key: f!.key, target: f!.target!, id: values[f!.key] }))
        .filter((l): l is { key: string; target: string; id: string } =>
          typeof l.id === 'string' ? ID_RE.test(l.id) : false,
        ),
    [entity, values],
  );
  const taxLinked = useQueries({
    queries: taxLinks.map((l) => recordQuery(l.target, l.id)),
  });
  const taxPreview = useMemo(() => {
    const shown = formState?.shown ?? values;
    if (!entity?.tax || !cfg.data) return { values: shown, unresolved: false };
    const linked = new Map<string, RecordData | null | undefined>(
      taxLinks.map((l, i) => [l.key, taxLinked[i]?.data?.data]),
    );
    const { ctx, unresolved } = browserTaxContext(
      entity,
      shown,
      unitChain(units.data, orgUnitId),
      linked,
      cfg.data.tenant.countryCode,
    );
    // Saved figures come from the server and are authoritative; preview only while editing.
    if (!dirty) return { values: shown, unresolved };
    return { values: previewTaxes(entity, shown, cfg.data.taxes, ctx), unresolved };
  }, [formState, values, entity, cfg.data, taxLinks, taxLinked, units.data, orgUnitId, dirty]);

  if (cfg.isLoading || (!isNew && record.isLoading)) return <Loading />;
  if (!entity || !cfg.data)
    return (
      <ErrorAlert error={record.error ?? new ApiError(404, 'NOT_FOUND', t('errors.notFound'))} />
    );
  const effective = cfg.data;

  const unitPath = units.data?.find((u) => u.id === orgUnitId)?.path;
  const canWrite = can(
    recordPermission(key, isNew ? 'create' : 'update'),
    orgScoped ? unitPath : undefined,
  );
  const canDelete =
    !isNew &&
    !formState?.locked &&
    can(recordPermission(key, 'delete'), orgScoped ? unitPath : undefined);

  const change = (k: string, v: unknown) => {
    setDirty(true);
    setValues((prev) => ({ ...prev, [k]: v }));
    // Fields with `defaultFrom` take the chosen record's value right away (the server
    // does the same on save).
    for (const fill of defaultFills(
      entity,
      values,
      { ...values, [k]: v },
      effective.tenant.currency,
    )) {
      qc.fetchQuery(recordQuery(fill.target, fill.id))
        .then((linked) => setValues((prev) => fill.apply(linked.data, prev)))
        .catch(() => undefined);
    }
  };

  const save = async () => {
    setError(null);
    setSaved(false);
    const payload = editableValues(entity, values);
    const local = validateRecord(
      entity,
      payload,
      { cfg: effective, companyCurrency: effective.tenant.currency },
      isNew ? undefined : record.data?.data,
    );
    const localErrors = Object.fromEntries(local.issues.map((i) => [i.field, i.message]));
    if (orgScoped && !orgUnitId) localErrors.orgUnitId = t('records.choose');
    setErrors(localErrors);
    if (Object.keys(localErrors).length) return;
    setSaving(true);
    try {
      const res = isNew
        ? await api<RecordDto>(`/records/${key}`, {
            method: 'POST',
            body: { orgUnitId: orgUnitId || undefined, data: payload },
          })
        : await api<RecordDto>(`/records/${key}/${id}`, {
            method: 'PATCH',
            body: { orgUnitId: orgUnitId || undefined, data: payload },
          });
      await qc.invalidateQueries({ queryKey: ['records', key] });
      qc.setQueryData(['record', key, res.id], res);
      if (isNew) navigate(`/r/${key}/${res.id}`, { replace: true });
      else setValues(res.data);
      setDirty(false);
      setSaved(true);
    } catch (e) {
      if (e instanceof ApiError && Object.keys(e.fieldErrors()).length) setErrors(e.fieldErrors());
      else setError(e);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(t('records.deleteConfirm'))) return;
    try {
      await api(`/records/${key}/${id}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['records', key] });
      navigate(`/r/${key}`);
    } catch (e) {
      setError(e);
    }
  };

  const title = isNew
    ? t('records.new', { name: label(entity.label) })
    : t('records.edit', {
        name: String(
          record.data?.data[entity.titleField ?? ''] ?? record.data?.number ?? label(entity.label),
        ),
      });

  return (
    <>
      <PageHeader
        title={title}
        subtitle={record.data?.number ?? undefined}
        actions={
          <>
            {!isNew && id && (
              <PrintMenu
                entity={key}
                ids={[id]}
                templates={effective.printTemplates.filter(
                  (p) => p.entity === key && p.active !== false,
                )}
              />
            )}
            <Button variant="outline-secondary" onClick={() => navigate(`/r/${key}`)}>
              <i className="bi bi-arrow-left me-1 flip-rtl" />
              {label(entity.pluralLabel)}
            </Button>
          </>
        }
      />
      {saved && <Alert variant="success">{t('records.saved')}</Alert>}
      <ErrorAlert error={error} onClose={() => setError(null)} />
      {errors._record && <Alert variant="danger">{errors._record}</Alert>}
      {!isNew && id && <WorkflowPanel entity={key} id={id} />}
      <Card className="shadow-sm border-0">
        <Card.Body>
          <Form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            {orgScoped && (
              <Form.Group className="mb-3" controlId="orgUnitId" style={{ maxWidth: 420 }}>
                <Form.Label>
                  {t('records.orgUnit')} <span className="text-danger">*</span>
                </Form.Label>
                <Form.Select
                  value={orgUnitId}
                  disabled={formState?.locked}
                  isInvalid={!!errors.orgUnitId}
                  onChange={(e) => setOrgUnitId(e.target.value)}
                >
                  <option value="">{t('records.choose')}</option>
                  {allowedUnits.map((u) => (
                    <option key={u.id} value={u.id}>
                      {'— '.repeat(u.depth)}
                      {u.name}
                    </option>
                  ))}
                </Form.Select>
              </Form.Group>
            )}
            <fieldset disabled={!canWrite || saving}>
              <DynamicFields
                entity={entity}
                cfg={effective}
                currency={effective.tenant.currency}
                values={taxPreview.values}
                errors={errors}
                hidden={formState?.hidden}
                readOnly={formState?.readOnly}
                required={formState?.required}
                onChange={change}
                renderAfter={(k) =>
                  entity.tax && k === entity.tax.lines ? (
                    <TaxPanel
                      cfg={effective}
                      values={taxPreview.values}
                      currency={effective.tenant.currency}
                      preview={dirty}
                      unresolved={taxPreview.unresolved}
                    />
                  ) : null
                }
              />
            </fieldset>
            <div className="d-flex justify-content-between">
              <div>
                {canDelete && (
                  <Button variant="outline-danger" onClick={() => void remove()}>
                    {t('common.delete')}
                  </Button>
                )}
              </div>
              {canWrite && (
                <Button type="submit" disabled={saving}>
                  {t('common.save')}
                </Button>
              )}
            </div>
          </Form>
        </Card.Body>
      </Card>
    </>
  );
}
