import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, ButtonGroup, Card, Col, Form, Nav, Row, Table } from 'react-bootstrap';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  findEntity,
  mergeLayers,
  SYSTEM_ENTITY_KEYS,
  withTaxFields,
  type EntityPatch,
  type EntityTaxSettings,
  type FieldDef,
  type LocalizedText,
} from '@erp/metadata';
import { useAuth } from '../auth/AuthContext';
import { useConfigActions, useEffectiveConfig, useLabel } from '../config/hooks';
import { LocalizedInput } from '../config/LocalizedInput';
import { ErrorAlert, Field } from '../components/ui';
import { FieldDialog } from './FieldDialog';
import { FormDesigner } from './FormDesigner';
import { ListDesigner } from './ListDesigner';
import { PACK_BADGE, useInherited } from './packBase';
import { useStudio } from './StudioContext';

const DOCUMENT_KINDS: NonNullable<EntityTaxSettings['document']>[] = [
  'invoice',
  'credit_note',
  'debit_note',
  'bill_of_supply',
  'receipt',
];
const SOURCES = [
  'sellerRegion',
  'buyerRegion',
  'buyerCountry',
  'buyerRegistered',
  'reverseCharge',
] as const;
const SOURCE_RE = /^[a-z][a-z0-9_]{1,39}(\.[a-z][a-z0-9_]{1,39})?$/;
const NUMERIC = (c: FieldDef) =>
  ['integer', 'decimal', 'currency'].includes(c.type) ||
  (c.type === 'formula' && c.resultType === 'number');

/**
 * "Calculate taxes" for an entity: its line items and where the tax inputs come from. A pack
 * may set part of it (an Industry Pack the lines, a Country Pack the regions); the company's
 * values are merged over them key by key.
 */
function TaxSettingsCard({
  entity,
  inherited,
  own,
  roles,
  editable,
  onSave,
}: {
  /** The entity as the draft defines it at this scope (all layers merged). */
  entity: EntityPatch;
  inherited: Partial<EntityTaxSettings> | undefined;
  own: Partial<EntityTaxSettings> | undefined;
  roles: string[];
  editable: boolean;
  onSave: (tax: Partial<EntityTaxSettings> | undefined) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const label = useLabel();
  const { layer } = useStudio();
  const { below } = useInherited();
  const [open, setOpen] = useState(!!(inherited ?? own));
  const [tax, setTax] = useState<Partial<EntityTaxSettings>>(own ?? {});
  const [saved, setSaved] = useState(false);
  useEffect(() => setTax(own ?? {}), [own]);
  const eff: Partial<EntityTaxSettings> = { ...inherited, ...tax };
  const on = !!inherited || Object.keys(tax).length > 0;
  const set = (patch: Partial<EntityTaxSettings>) => {
    setSaved(false);
    setTax((p) => {
      const next = { ...p, ...patch };
      for (const k of Object.keys(next) as (keyof EntityTaxSettings)[])
        if (next[k] === undefined || next[k] === '') delete next[k];
      return next;
    });
  };

  const tables = entity.fields.filter((f) => f.type === 'table' && !f.archived);
  const columns = tables.find((f) => f.key === eff.lines)?.columns ?? [];
  // Suggestions for the sources: fields, linked records' fields and the org unit's fields.
  const entities = useMemo(
    () => new Map(mergeLayers([below, layer]).entities.map((e) => [e.key, e])),
    [below, layer],
  );
  const suggestions = useMemo(() => {
    const out: string[] = [];
    for (const f of entity.fields) {
      if (f.type === 'table') continue;
      out.push(f.key);
      if (f.type === 'lookup' && f.target)
        for (const tf of entities.get(f.target)?.fields ?? [])
          if (tf.type !== 'table') out.push(`${f.key}.${tf.key}`);
    }
    for (const uf of entities.get('org_unit')?.fields ?? []) out.push(`unit.${uf.key}`);
    return out;
  }, [entity.fields, entities]);
  const sourcesOk = SOURCES.every((k) => !tax[k] || SOURCE_RE.test(tax[k]!));
  const valid = !on || (!!eff.lines && !!eff.amount && sourcesOk);

  const colSelect = (k: 'amount' | 'category' | 'code', filter: (c: FieldDef) => boolean) => (
    <Form.Select
      value={tax[k] ?? ''}
      onChange={(e) => set({ [k]: e.target.value || undefined })}
      isInvalid={k === 'amount' && on && !eff.amount}
    >
      <option value="">
        {inherited?.[k] ? t('studio.taxes.inherit', { value: inherited[k] }) : t('common.none')}
      </option>
      {columns.filter(filter).map((c) => (
        <option key={c.key} value={c.key}>
          {label(c.label) || c.key}
        </option>
      ))}
    </Form.Select>
  );

  return (
    <Card className="shadow-sm border-0 mb-3">
      <Card.Header
        as="button"
        type="button"
        className="bg-body d-flex align-items-center gap-2 border-0 text-start"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <i className={`bi bi-chevron-${open ? 'down' : 'right'} flip-rtl`} />
        <i className="bi bi-percent" />
        <span className="fw-semibold">{t('studio.entityTax.title')}</span>
        {on ? (
          <Badge bg="success-subtle" text="success-emphasis">
            {t('studio.entityTax.on')}
          </Badge>
        ) : (
          <Badge bg="light" text="dark" className="border">
            {t('studio.entityTax.off')}
          </Badge>
        )}
        {roles.map((r) => (
          <Badge key={r} {...PACK_BADGE} className="font-monospace">
            {r}
          </Badge>
        ))}
      </Card.Header>
      {open && (
        <Card.Body>
          <p className="small text-body-secondary">{t('studio.entityTax.intro')}</p>
          {roles.length > 0 && (
            <p className="small">
              <span className="me-2">{t('studio.entityTax.roles')}:</span>
              {roles.map((r) => (
                <Badge key={r} {...PACK_BADGE} className="me-1 font-monospace">
                  {r}
                </Badge>
              ))}
              <span className="d-block text-body-secondary">{t('studio.entityTax.rolesHelp')}</span>
            </p>
          )}
          {saved && <p className="text-success small">{t('common.saved')}</p>}
          <fieldset disabled={!editable}>
            {!inherited && (
              <Form.Check
                type="switch"
                id="tax-on"
                className="mb-3"
                label={t('studio.entityTax.enable')}
                checked={on}
                onChange={(e) => {
                  setSaved(false);
                  setTax(e.target.checked ? { lines: tables[0]?.key } : {});
                }}
              />
            )}
            {on && (
              <>
                {!tables.length && (
                  <p className="text-danger small">{t('studio.entityTax.noTable')}</p>
                )}
                <Row>
                  <Col md={4}>
                    <Field label={t('studio.entityTax.lines')} controlId="tax-lines">
                      <Form.Select
                        value={tax.lines ?? ''}
                        isInvalid={!eff.lines}
                        onChange={(e) => set({ lines: e.target.value || undefined })}
                      >
                        <option value="">
                          {inherited?.lines
                            ? t('studio.taxes.inherit', { value: inherited.lines })
                            : t('records.choose')}
                        </option>
                        {tables.map((f) => (
                          <option key={f.key} value={f.key}>
                            {label(f.label) || f.key}
                          </option>
                        ))}
                      </Form.Select>
                    </Field>
                  </Col>
                  <Col md={4}>
                    <Field label={t('studio.entityTax.amount')} controlId="tax-amount">
                      {colSelect('amount', NUMERIC)}
                    </Field>
                  </Col>
                  <Col md={4}>
                    <Field
                      label={t('studio.entityTax.category')}
                      controlId="tax-category"
                      hint={t('studio.entityTax.categoryHelp')}
                    >
                      {colSelect('category', (c) => c.type === 'select' || c.type === 'text')}
                    </Field>
                  </Col>
                  <Col md={4}>
                    <Field
                      label={t('studio.entityTax.code')}
                      controlId="tax-code"
                      hint={t('studio.entityTax.codeHelp')}
                    >
                      {colSelect('code', (c) => c.type !== 'formula')}
                    </Field>
                  </Col>
                  <Col md={4}>
                    <Field label={t('studio.entityTax.document')} controlId="tax-doc">
                      <Form.Select
                        value={tax.document ?? ''}
                        onChange={(e) =>
                          set({
                            document: (e.target.value ||
                              undefined) as EntityTaxSettings['document'],
                          })
                        }
                      >
                        <option value="">
                          {inherited?.document
                            ? t('studio.taxes.inherit', {
                                value: t(`studio.entityTax.documents.${inherited.document}`),
                              })
                            : t('common.none')}
                        </option>
                        {DOCUMENT_KINDS.map((d) => (
                          <option key={d} value={d}>
                            {t(`studio.entityTax.documents.${d}`)}
                          </option>
                        ))}
                      </Form.Select>
                    </Field>
                  </Col>
                  <Col md={4} className="d-flex align-items-center">
                    <Form.Check
                      type="switch"
                      id="tax-inclusive"
                      label={t('studio.entityTax.inclusive')}
                      checked={!!eff.inclusive}
                      onChange={(e) => set({ inclusive: e.target.checked })}
                    />
                  </Col>
                </Row>
                <h3 className="h6 mt-2">{t('studio.entityTax.sources')}</h3>
                <p className="small text-body-secondary">{t('studio.entityTax.sourcesHelp')}</p>
                <datalist id="tax-sources">
                  {suggestions.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
                <Row>
                  {SOURCES.map((k) => (
                    <Col md={4} key={k}>
                      <Field label={t(`studio.entityTax.${k}`)} controlId={`tax-${k}`}>
                        <Form.Control
                          list="tax-sources"
                          dir="ltr"
                          className="font-monospace"
                          placeholder={inherited?.[k] ?? ''}
                          value={tax[k] ?? ''}
                          isInvalid={!!tax[k] && !SOURCE_RE.test(tax[k]!)}
                          onChange={(e) => set({ [k]: e.target.value.trim() || undefined })}
                        />
                      </Field>
                    </Col>
                  ))}
                </Row>
                <p className="small text-body-secondary">{t('studio.entityTax.adds')}</p>
              </>
            )}
            <Button
              size="sm"
              disabled={!valid}
              onClick={() =>
                void onSave(Object.keys(tax).length ? tax : undefined).then(
                  (ok) => ok && setSaved(true),
                )
              }
            >
              {t('common.save')}
            </Button>
          </fieldset>
        </Card.Body>
      )}
    </Card>
  );
}

export function EntityEditor() {
  const { key = '' } = useParams();
  const { t } = useTranslation();
  const label = useLabel();
  const { can } = useAuth();
  const { scope, layer } = useStudio();
  const { packs, below } = useInherited();
  const { putItem } = useConfigActions();
  const [tab, setTab] = useState<'fields' | 'form' | 'list'>('fields');
  const [editing, setEditing] = useState<{ field?: FieldDef; readOnly?: boolean } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const editable = can('config.manage');

  const isSystem = (SYSTEM_ENTITY_KEYS as readonly string[]).includes(key);
  const own: EntityPatch = layer.entities.find((e) => e.key === key) ?? { key, fields: [] };
  // What this layer builds on: the packs, and for a branch override the company too.
  const base = below.entities.find((e) => e.key === key);
  const packEntity = packs.entities.find((e) => e.key === key);
  const packFields = new Set(packEntity?.fields.map((f) => f.key));
  const merged = useMemo(
    () => mergeLayers([below, layer]).entities.find((e) => e.key === key),
    [below, layer, key],
  );
  const published = useEffectiveConfig(scope === 'company' ? undefined : scope);
  const publishedFields = useMemo(() => {
    const e = published.data ? findEntity(published.data, key) : undefined;
    return new Set(e?.fields.map((f) => f.key));
  }, [published.data, key]);

  // Entity properties (company scope, custom entities only).
  const propsOf = () => ({
    label: own.label ?? base?.label ?? {},
    pluralLabel: own.pluralLabel ?? base?.pluralLabel ?? {},
    titleField: own.titleField ?? base?.titleField ?? '',
    orgScoped: (own.orgScoped ?? base?.orgScoped) !== false,
  });
  const [props, setProps] = useState(propsOf);
  useEffect(() => setProps(propsOf()), [key, scope, layer, base]);

  const save = async (patch: EntityPatch) => {
    setError(null);
    try {
      await putItem.mutateAsync({ kind: 'entities', key, body: patch, scope });
      return true;
    } catch (e) {
      setError(e);
      return false;
    }
  };

  const saveField = async (f: FieldDef, originalKey?: string) => {
    const fields = own.fields.filter((x) => x.key !== (originalKey ?? f.key));
    const at = own.fields.findIndex((x) => x.key === (originalKey ?? f.key));
    fields.splice(at >= 0 ? at : fields.length, 0, f);
    return save({ ...own, fields });
  };

  const setArchived = (f: FieldDef, archived: boolean) =>
    void saveField({ ...f, archived: archived || undefined });
  const removeField = (f: FieldDef) =>
    void save({ ...own, fields: own.fields.filter((x) => x.key !== f.key) });

  const allFields = [
    ...(base?.fields ?? []).filter((f) => !own.fields.some((o) => o.key === f.key)),
    ...own.fields,
  ];
  // Fields the tax engine adds (read-only here).
  const taxFields = useMemo(() => {
    if (!merged?.tax?.lines) return [];
    const withTax = withTaxFields({
      fields: merged.fields,
      tax: merged.tax as EntityTaxSettings,
    });
    return withTax.fields.filter((f) => f.calculated === 'tax');
  }, [merged]);
  const title = label(own.label ?? base?.label) || key;
  const roles = merged?.roles ?? [];

  return (
    <>
      <div className="d-flex align-items-center gap-2 mb-3 flex-wrap">
        <Link to="/studio/entities" className="btn btn-sm btn-outline-secondary">
          <i className="bi bi-arrow-left flip-rtl" />
        </Link>
        <h2 className="h5 mb-0">{title}</h2>
        <code className="small">{key}</code>
        {isSystem && <Badge bg="secondary">{t('studio.builtIn')}</Badge>}
        {packEntity && <Badge {...PACK_BADGE}>{t('studio.taxes.fromPack')}</Badge>}
        {roles.map((r) => (
          <Badge key={r} bg="light" text="dark" className="border font-monospace">
            {r}
          </Badge>
        ))}
      </div>
      {isSystem && <p className="small text-body-secondary">{t('studio.systemEntityHint')}</p>}
      <ErrorAlert error={error} onClose={() => setError(null)} />

      {scope === 'company' && !isSystem && (
        <Card className="shadow-sm border-0 mb-3">
          <Card.Body>
            <fieldset disabled={!editable}>
              <Row>
                <Col md={6}>
                  <Field label={t('studio.singular')} controlId="e-label">
                    <LocalizedInput
                      id="e-label"
                      value={props.label}
                      onChange={(v: LocalizedText) => setProps({ ...props, label: v })}
                    />
                  </Field>
                </Col>
                <Col md={6}>
                  <Field label={t('studio.plural')} controlId="e-plural">
                    <LocalizedInput
                      id="e-plural"
                      value={props.pluralLabel}
                      onChange={(v: LocalizedText) => setProps({ ...props, pluralLabel: v })}
                    />
                  </Field>
                </Col>
                <Col md={6}>
                  <Field label={t('studio.titleField')} controlId="e-title">
                    <Form.Select
                      value={props.titleField}
                      onChange={(e) => setProps({ ...props, titleField: e.target.value })}
                    >
                      <option value="" />
                      {allFields
                        .filter(
                          (f) =>
                            ['text', 'email', 'phone', 'autonumber'].includes(f.type) &&
                            !f.archived,
                        )
                        .map((f) => (
                          <option key={f.key} value={f.key}>
                            {label(f.label)}
                          </option>
                        ))}
                    </Form.Select>
                  </Field>
                </Col>
                <Col md={6} className="d-flex align-items-center">
                  <Form.Check
                    type="switch"
                    id="e-org"
                    label={t('studio.orgScoped')}
                    checked={props.orgScoped}
                    onChange={(e) => setProps({ ...props, orgScoped: e.target.checked })}
                  />
                </Col>
              </Row>
              <div className="d-flex gap-2">
                <Button
                  size="sm"
                  onClick={() =>
                    void save({
                      ...own,
                      kind: 'custom',
                      ...props,
                      titleField: props.titleField || undefined,
                    })
                  }
                >
                  {t('common.save')}
                </Button>
                <Button
                  size="sm"
                  variant="outline-secondary"
                  onClick={() => void save({ ...own, archived: !own.archived || undefined })}
                >
                  {own.archived ? t('studio.restore') : t('studio.archive')}
                </Button>
              </div>
            </fieldset>
          </Card.Body>
        </Card>
      )}

      {scope === 'company' && !isSystem && merged && (
        <TaxSettingsCard
          entity={merged}
          inherited={base?.tax}
          own={own.tax}
          roles={roles}
          editable={editable}
          onSave={(tax) => save({ ...own, tax: tax as EntityTaxSettings | undefined })}
        />
      )}

      <Nav
        variant="pills"
        className="mb-3"
        activeKey={tab}
        onSelect={(k) => setTab((k as typeof tab) ?? 'fields')}
      >
        <Nav.Item>
          <Nav.Link eventKey="fields">{t('studio.fields')}</Nav.Link>
        </Nav.Item>
        {scope === 'company' && !isSystem && (
          <>
            <Nav.Item>
              <Nav.Link eventKey="form">{t('studio.form')}</Nav.Link>
            </Nav.Item>
            <Nav.Item>
              <Nav.Link eventKey="list">{t('studio.list')}</Nav.Link>
            </Nav.Item>
          </>
        )}
      </Nav>

      {tab === 'fields' && (
        <Card className="shadow-sm border-0">
          <Card.Body>
            {editable && (
              <Button size="sm" className="mb-3" onClick={() => setEditing({})}>
                <i className="bi bi-plus-lg me-1" />
                {t('studio.addField')}
              </Button>
            )}
            <Table responsive hover size="sm" className="align-middle mb-0">
              <thead>
                <tr>
                  <th>{t('studio.label')}</th>
                  <th>{t('studio.fieldKey')}</th>
                  <th>{t('studio.fieldType')}</th>
                  <th />
                  <th className="text-end">{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {allFields.map((f) => {
                  const inherited = !own.fields.some((o) => o.key === f.key);
                  const fromPack = packFields.has(f.key);
                  // A company copy of a pack's field: removing it brings the pack's back.
                  const overridesPack = !inherited && fromPack;
                  // Pack fields can be changed here (saved as the company's copy); a branch
                  // override does not change the company's own fields.
                  const canEdit = editable && (!inherited || (fromPack && scope === 'company'));
                  return (
                    <tr key={f.key} className={f.archived ? 'text-body-tertiary' : ''}>
                      <td>{label(f.label)}</td>
                      <td>
                        <code>{f.key}</code>
                      </td>
                      <td>{t(`fieldTypes.${f.type}`)}</td>
                      <td className="d-flex gap-1 flex-wrap">
                        {f.required && (
                          <Badge bg="danger-subtle" text="danger-emphasis">
                            {t('studio.required')}
                          </Badge>
                        )}
                        {f.unique && (
                          <Badge bg="info-subtle" text="info-emphasis">
                            {t('studio.unique')}
                          </Badge>
                        )}
                        {f.locked && (
                          <Badge bg="dark-subtle" text="dark-emphasis">
                            <i className="bi bi-lock me-1" />
                            {t('studio.field.locked')}
                          </Badge>
                        )}
                        {f.identifier && (
                          <Badge bg="light" text="dark" className="border font-monospace">
                            {f.identifier}
                          </Badge>
                        )}
                        {f.archived && <Badge bg="secondary">{t('studio.archived')}</Badge>}
                        {inherited && fromPack && (
                          <Badge {...PACK_BADGE}>{t('studio.taxes.fromPack')}</Badge>
                        )}
                        {overridesPack && (
                          <Badge bg="warning-subtle" text="warning-emphasis">
                            {t('studio.taxes.changed')}
                          </Badge>
                        )}
                        {inherited && !fromPack && (
                          <Badge bg="light" text="dark" className="border">
                            {t('studio.company')}
                          </Badge>
                        )}
                      </td>
                      <td className="text-end">
                        {canEdit && (
                          <ButtonGroup size="sm">
                            <Button
                              variant="outline-primary"
                              onClick={() => setEditing({ field: f })}
                              title={t('common.edit')}
                            >
                              <i className="bi bi-pencil" />
                            </Button>
                            {!f.locked && (
                              <Button
                                variant="outline-secondary"
                                onClick={() => setArchived(f, !f.archived)}
                                title={f.archived ? t('studio.restore') : t('studio.archive')}
                              >
                                <i
                                  className={`bi ${f.archived ? 'bi-arrow-counterclockwise' : 'bi-archive'}`}
                                />
                              </Button>
                            )}
                            {overridesPack ? (
                              <Button
                                variant="outline-danger"
                                onClick={() =>
                                  window.confirm(t('common.confirm')) && removeField(f)
                                }
                                title={t('studio.taxes.revert')}
                              >
                                <i className="bi bi-arrow-counterclockwise" />
                              </Button>
                            ) : (
                              !inherited &&
                              !publishedFields.has(f.key) && (
                                <Button
                                  variant="outline-danger"
                                  onClick={() =>
                                    window.confirm(t('common.confirm')) && removeField(f)
                                  }
                                  title={t('common.delete')}
                                >
                                  <i className="bi bi-trash" />
                                </Button>
                              )
                            )}
                          </ButtonGroup>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {taxFields.map((f) => (
                  <tr key={`tax-${f.key}`} className="text-body-secondary">
                    <td>{label(f.label)}</td>
                    <td>
                      <code>{f.key}</code>
                    </td>
                    <td>{t(`fieldTypes.${f.type}`)}</td>
                    <td>
                      <Badge bg="success-subtle" text="success-emphasis">
                        <i className="bi bi-calculator me-1" />
                        {t('studio.field.taxCalculated')}
                      </Badge>
                    </td>
                    <td className="text-end">
                      <Button
                        size="sm"
                        variant="outline-secondary"
                        title={t('studio.field.view')}
                        onClick={() => setEditing({ field: f, readOnly: true })}
                      >
                        <i className="bi bi-eye" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card.Body>
        </Card>
      )}
      {tab === 'form' && <FormDesigner entityKey={key} fields={allFields} />}
      {tab === 'list' && <ListDesigner entityKey={key} fields={allFields} />}

      {editing && (
        <FieldDialog
          entityKey={key}
          isSystem={isSystem}
          field={editing.field}
          readOnly={editing.readOnly}
          published={
            !!editing.field &&
            (publishedFields.has(editing.field.key) || packFields.has(editing.field.key))
          }
          existingKeys={allFields.map((f) => f.key)}
          siblings={merged?.fields ?? allFields}
          onClose={() => setEditing(null)}
          onSave={async (f, originalKey) => {
            if (await saveField(f, originalKey)) setEditing(null);
          }}
        />
      )}
    </>
  );
}
