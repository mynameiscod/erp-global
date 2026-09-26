import { useMemo, useState } from 'react';
import { Alert, Button, Card, Col, Form, InputGroup, Modal, Row } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import {
  compileFormula,
  FIELD_TYPES,
  FormulaError,
  KEY_RE,
  mergeLayers,
  TABLE_COLUMN_TYPES,
  type EntityPatch,
  type FieldDef,
  type FieldType,
  type LocalizedText,
} from '@erp/metadata';
import { useLabel } from '../config/hooks';
import { LocalizedInput } from '../config/LocalizedInput';
import { Field } from '../components/ui';
import { useInherited } from './packBase';
import { useStudio } from './StudioContext';

/** Same rule as the server: which type changes keep existing data valid. */
const COMPATIBLE: Partial<Record<FieldType, FieldType[]>> = {
  text: ['longtext', 'email', 'phone', 'url'],
  email: ['text', 'longtext'],
  phone: ['text', 'longtext'],
  url: ['text', 'longtext'],
  integer: ['decimal'],
  lookup: ['lookup_many'],
  select: ['multiselect'],
  image: ['file'],
};
const NOT_ON_SYSTEM = new Set<FieldType>([
  'lookup',
  'lookup_many',
  'file',
  'image',
  'autonumber',
  'table',
]);

const num = (v: string) => (v === '' ? undefined : Number(v));

/** Types a value can be copied into from a linked record (`defaultFrom`). */
const NO_DEFAULT_FROM = new Set<FieldType>(['formula', 'autonumber', 'table', 'file', 'image']);

/**
 * `lookup.field` choices: for each lookup among `siblings` (the entity's fields, or the
 * other columns of a line), the fields of the entity it links to.
 */
function DefaultFromSelect({
  id,
  value,
  onChange,
  siblings,
  entities,
  size,
}: {
  id: string;
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  siblings: FieldDef[];
  entities: Map<string, EntityPatch>;
  size?: 'sm';
}) {
  const { t } = useTranslation();
  const label = useLabel();
  const lookups = siblings.filter((f) => f.type === 'lookup' && f.target);
  if (!lookups.length && !value) return null;
  return (
    <Form.Select
      id={id}
      size={size}
      value={value ?? ''}
      title={t('studio.field.defaultFrom')}
      onChange={(e) => onChange(e.target.value || undefined)}
    >
      <option value="">
        {size ? t('studio.field.defaultFrom') : t('studio.field.defaultFromNone')}
      </option>
      {value && !lookups.some((l) => value.startsWith(`${l.key}.`)) && (
        <option value={value}>{value}</option>
      )}
      {lookups.map((l) => (
        <optgroup key={l.key} label={label(l.label) || l.key}>
          {(entities.get(l.target!)?.fields ?? [])
            .filter((tf) => tf.type !== 'table' && !tf.archived)
            .map((tf) => (
              <option key={tf.key} value={`${l.key}.${tf.key}`}>
                {label(l.label) || l.key} → {label(tf.label) || tf.key}
              </option>
            ))}
        </optgroup>
      ))}
    </Form.Select>
  );
}

export function FieldDialog({
  entityKey,
  isSystem,
  field,
  published,
  readOnly,
  existingKeys,
  siblings,
  onClose,
  onSave,
}: {
  entityKey: string;
  isSystem: boolean;
  field?: FieldDef;
  published: boolean;
  /** A field the tax engine fills: shown, not edited. */
  readOnly?: boolean;
  existingKeys: string[];
  /** The entity's fields (all layers), for "Default from". */
  siblings?: FieldDef[];
  onClose: () => void;
  onSave: (f: FieldDef, originalKey?: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const label = useLabel();
  const { layer } = useStudio();
  const { below } = useInherited();
  const [f, setF] = useState<FieldDef>(field ?? { key: '', type: 'text', label: {} });
  const set = (patch: Partial<FieldDef>) => setF((prev) => ({ ...prev, ...patch }));
  const [saving, setSaving] = useState(false);
  const locked = !!field?.locked;
  const calculated = !!readOnly || field?.calculated === 'tax';

  // What this field can refer to: entities, option lists, series and identifier types visible
  // at this scope in the draft (platform, packs, the company and the override).
  const merged = useMemo(() => mergeLayers([below, layer]), [below, layer]);
  const entityMap = useMemo(
    () => new Map(merged.entities.map((e) => [e.key, e])),
    [merged.entities],
  );

  const types = FIELD_TYPES.filter((ty) => {
    if (locked && field) return ty === field.type;
    if (isSystem && NOT_ON_SYSTEM.has(ty)) return false;
    if (published && field) return ty === field.type || COMPATIBLE[field.type]?.includes(ty);
    return true;
  });
  const keyTaken = !field && existingKeys.includes(f.key);
  const keyOk = KEY_RE.test(f.key) && !keyTaken;
  const formulaError = useMemo(() => {
    if (f.type !== 'formula' || !f.formula) return undefined;
    try {
      // Table columns (`lines.amount`) count by their table field.
      const deps = compileFormula(f.formula).fields.filter(
        (d) => !existingKeys.includes(d.split('.')[0]),
      );
      return deps.length ? `Unknown field: ${deps.join(', ')}` : undefined;
    } catch (e) {
      return e instanceof FormulaError ? e.message : 'Invalid formula';
    }
  }, [f.type, f.formula, existingKeys]);

  const submit = async () => {
    setSaving(true);
    // Drop settings that do not belong to the chosen type.
    const clean: FieldDef = { key: f.key, type: f.type, label: f.label };
    for (const k of [
      'help',
      'required',
      'unique',
      'searchable',
      'archived',
      'default',
      'locked',
      'defaultFrom',
    ] as const)
      if (f[k] !== undefined && f[k] !== false)
        (clean as unknown as Record<string, unknown>)[k] = f[k];
    const keep = (...ks: (keyof FieldDef)[]) =>
      ks.forEach(
        (k) =>
          f[k] !== undefined &&
          f[k] !== '' &&
          ((clean as unknown as Record<string, unknown>)[k] = f[k]),
      );
    if (['text', 'longtext'].includes(f.type)) keep('minLength', 'maxLength', 'pattern');
    if (f.type === 'text') keep('identifier');
    if (NO_DEFAULT_FROM.has(f.type)) delete clean.defaultFrom;
    if (['integer', 'decimal', 'currency', 'percent'].includes(f.type)) keep('min', 'max');
    if (['decimal', 'currency', 'percent'].includes(f.type)) keep('scale');
    if (f.type === 'currency') keep('currency');
    if (['select', 'multiselect'].includes(f.type)) keep('picklist');
    if (['lookup', 'lookup_many'].includes(f.type)) keep('target');
    if (f.type === 'formula') keep('formula', 'resultType');
    if (f.type === 'autonumber') keep('numbering');
    if (['file', 'image'].includes(f.type)) keep('accept', 'maxSizeMb');
    if (f.type === 'table') keep('columns', 'maxRows');
    await onSave(clean, field?.key);
    setSaving(false);
  };

  const n = (k: 'min' | 'max' | 'scale' | 'maxLength' | 'minLength' | 'maxSizeMb' | 'maxRows') => (
    <Field label={t(`studio.${k === 'maxSizeMb' ? 'maxSize' : k}`)} controlId={`fd-${k}`}>
      <Form.Control
        type="number"
        value={f[k] ?? ''}
        onChange={(e) => set({ [k]: num(e.target.value) })}
        dir="ltr"
      />
    </Field>
  );

  return (
    <Modal show onHide={onClose} centered size="lg" scrollable>
      <Modal.Header closeButton>
        <Modal.Title className="h5">
          {field ? t('studio.editField') : t('studio.addField')}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {calculated && (
          <Alert variant="info" className="small">
            <i className="bi bi-calculator me-1" />
            {t('studio.field.taxCalculatedHelp')}
          </Alert>
        )}
        {locked && !calculated && (
          <Alert variant="warning" className="small">
            <i className="bi bi-lock me-1" />
            {t('studio.field.lockedHelp')}
          </Alert>
        )}
        <fieldset disabled={calculated}>
          <Row>
            <Col md={6}>
              <Field label={t('studio.label')} controlId="fd-label">
                <LocalizedInput
                  id="fd-label"
                  value={f.label}
                  onChange={(v: LocalizedText) => {
                    const auto = !field && (!f.key || f.key === slug(label(f.label)));
                    set({
                      label: v,
                      ...(auto ? { key: slug(v.en ?? Object.values(v)[0] ?? '') } : {}),
                    });
                  }}
                />
              </Field>
            </Col>
            <Col md={6}>
              <Field
                label={t('studio.fieldKey')}
                controlId="fd-key"
                hint={t('studio.keyHint')}
                error={f.key && !keyOk ? (keyTaken ? '✗' : t('studio.keyHint')) : undefined}
              >
                <Form.Control
                  value={f.key}
                  disabled={published}
                  onChange={(e) => set({ key: e.target.value.toLowerCase() })}
                  className="font-monospace"
                  dir="ltr"
                />
              </Field>
            </Col>
            <Col md={6}>
              <Field label={t('studio.fieldType')} controlId="fd-type">
                <Form.Select
                  value={f.type}
                  disabled={locked}
                  onChange={(e) => set({ type: e.target.value as FieldType })}
                >
                  {types.map((ty) => (
                    <option key={ty} value={ty}>
                      {t(`fieldTypes.${ty}`)}
                    </option>
                  ))}
                </Form.Select>
              </Field>
            </Col>
            <Col md={6} className="d-flex flex-wrap align-items-center gap-3 pt-md-3">
              {!['formula', 'autonumber'].includes(f.type) && (
                <Form.Check
                  type="switch"
                  id="fd-req"
                  label={t('studio.required')}
                  checked={!!f.required}
                  onChange={(e) => set({ required: e.target.checked })}
                />
              )}
              {!isSystem &&
                [
                  'text',
                  'email',
                  'phone',
                  'integer',
                  'decimal',
                  'date',
                  'select',
                  'lookup',
                  'url',
                ].includes(f.type) && (
                  <Form.Check
                    type="switch"
                    id="fd-unique"
                    label={t('studio.unique')}
                    checked={!!f.unique}
                    onChange={(e) => set({ unique: e.target.checked })}
                  />
                )}
              {['text', 'email', 'phone', 'longtext'].includes(f.type) && (
                <Form.Check
                  type="switch"
                  id="fd-search"
                  label={t('studio.searchable')}
                  checked={!!f.searchable}
                  onChange={(e) => set({ searchable: e.target.checked })}
                />
              )}
            </Col>
          </Row>

          <Row>
            {['text', 'longtext'].includes(f.type) && (
              <>
                <Col md={4}>{n('maxLength')}</Col>
                <Col md={8}>
                  <Field label={t('studio.pattern')} controlId="fd-pattern">
                    <Form.Control
                      value={f.pattern ?? ''}
                      onChange={(e) => set({ pattern: e.target.value || undefined })}
                      className="font-monospace"
                      dir="ltr"
                    />
                  </Field>
                </Col>
              </>
            )}
            {f.type === 'text' && (
              <Col md={6}>
                <Field
                  label={t('studio.field.identifier')}
                  controlId="fd-identifier"
                  hint={t('studio.field.identifierHelp')}
                >
                  <Form.Select
                    value={f.identifier ?? ''}
                    disabled={locked && !!field?.identifier}
                    onChange={(e) => set({ identifier: e.target.value || undefined })}
                  >
                    <option value="">{t('common.none')}</option>
                    {f.identifier &&
                      !merged.identifierTypes.some((i) => i.key === f.identifier) && (
                        <option value={f.identifier}>{f.identifier}</option>
                      )}
                    {merged.identifierTypes.map((i) => (
                      <option key={i.key} value={i.key}>
                        {label(i.label) || i.key}
                        {i.example ? ` — ${i.example}` : ''}
                      </option>
                    ))}
                  </Form.Select>
                </Field>
              </Col>
            )}
            {['integer', 'decimal', 'currency', 'percent'].includes(f.type) && (
              <>
                <Col md={4}>{n('min')}</Col>
                <Col md={4}>{n('max')}</Col>
                {f.type !== 'integer' && <Col md={4}>{n('scale')}</Col>}
              </>
            )}
            {f.type === 'currency' && (
              <Col md={4}>
                <Field
                  label={t('studio.currency')}
                  controlId="fd-cur"
                  hint={t('studio.currencyHint')}
                >
                  <Form.Control
                    value={f.currency ?? ''}
                    maxLength={3}
                    onChange={(e) => set({ currency: e.target.value.toUpperCase() || undefined })}
                    dir="ltr"
                  />
                </Field>
              </Col>
            )}
            {['select', 'multiselect'].includes(f.type) && (
              <Col md={6}>
                <Field label={t('studio.picklist')} controlId="fd-pick">
                  <Form.Select
                    value={f.picklist ?? ''}
                    onChange={(e) => set({ picklist: e.target.value || undefined })}
                  >
                    <option value="">{t('records.choose')}</option>
                    {merged.picklists.map((p) => (
                      <option key={p.key} value={p.key}>
                        {label(p.label)}
                      </option>
                    ))}
                  </Form.Select>
                </Field>
              </Col>
            )}
            {['lookup', 'lookup_many'].includes(f.type) && (
              <Col md={6}>
                <Field label={t('studio.target')} controlId="fd-target">
                  <Form.Select
                    value={f.target ?? ''}
                    onChange={(e) => set({ target: e.target.value || undefined })}
                  >
                    <option value="">{t('records.choose')}</option>
                    {merged.entities
                      .filter((e) => !e.archived && e.key !== entityKey)
                      .map((e) => (
                        <option key={e.key} value={e.key}>
                          {label(e.label) || e.key}
                        </option>
                      ))}
                  </Form.Select>
                </Field>
              </Col>
            )}
            {f.type === 'formula' && (
              <>
                <Col md={8}>
                  <Field
                    label={t('studio.formula')}
                    controlId="fd-formula"
                    hint={t('studio.formulaHelp')}
                    error={formulaError}
                  >
                    <Form.Control
                      value={f.formula ?? ''}
                      onChange={(e) => set({ formula: e.target.value })}
                      className="font-monospace"
                      dir="ltr"
                    />
                  </Field>
                </Col>
                <Col md={4}>
                  <Field label={t('studio.resultType')} controlId="fd-rt">
                    <Form.Select
                      value={f.resultType ?? ''}
                      onChange={(e) =>
                        set({ resultType: (e.target.value || undefined) as FieldDef['resultType'] })
                      }
                    >
                      <option value="" />
                      <option value="number">{t('fieldTypes.decimal')}</option>
                      <option value="text">{t('fieldTypes.text')}</option>
                      <option value="date">{t('fieldTypes.date')}</option>
                      <option value="boolean">{t('fieldTypes.boolean')}</option>
                    </Form.Select>
                  </Field>
                </Col>
                {existingKeys.length > 0 && (
                  <Col xs={12}>
                    <Alert variant="light" className="small py-2">
                      {existingKeys.map((k) => (
                        <code key={k} className="me-2">
                          {k}
                        </code>
                      ))}
                    </Alert>
                  </Col>
                )}
              </>
            )}
            {f.type === 'autonumber' && (
              <Col md={6}>
                <Field label={t('studio.numberingSeries')} controlId="fd-num">
                  <Form.Select
                    value={f.numbering ?? ''}
                    onChange={(e) => set({ numbering: e.target.value || undefined })}
                  >
                    <option value="">{t('records.choose')}</option>
                    {merged.numbering.map((s) => (
                      <option key={s.key} value={s.key}>
                        {label(s.label)} — {s.pattern}
                      </option>
                    ))}
                  </Form.Select>
                </Field>
              </Col>
            )}
            {['file', 'image'].includes(f.type) && (
              <>
                <Col md={4}>{n('maxSizeMb')}</Col>
                {f.type === 'file' && (
                  <Col md={8}>
                    <Field
                      label={t('studio.accept')}
                      controlId="fd-accept"
                      hint={t('studio.acceptHint')}
                    >
                      <Form.Control
                        value={f.accept?.join(', ') ?? ''}
                        dir="ltr"
                        onChange={(e) =>
                          set({
                            accept: e.target.value
                              .split(',')
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }
                      />
                    </Field>
                  </Col>
                )}
              </>
            )}
            {f.type === 'table' && (
              <Col xs={12}>
                <ColumnsEditor
                  columns={f.columns ?? []}
                  onChange={(columns) => set({ columns })}
                  picklists={merged.picklists}
                  entities={merged.entities.filter((e) => !e.archived && e.key !== entityKey)}
                  entityMap={entityMap}
                  published={published}
                />
                <Col md={4}>{n('maxRows')}</Col>
              </Col>
            )}
            {!NO_DEFAULT_FROM.has(f.type) &&
              (siblings ?? []).some((s) => s.type === 'lookup' && s.target && s.key !== f.key) && (
                <Col md={6}>
                  <Field
                    label={t('studio.field.defaultFrom')}
                    controlId="fd-default-from"
                    hint={t('studio.field.defaultFromHelp')}
                  >
                    <DefaultFromSelect
                      id="fd-default-from"
                      value={f.defaultFrom}
                      onChange={(defaultFrom) => set({ defaultFrom })}
                      siblings={(siblings ?? []).filter((s) => s.key !== f.key)}
                      entities={entityMap}
                    />
                  </Field>
                </Col>
              )}
            <Col xs={12}>
              <Field label={`${t('studio.help')} (${t('common.optional')})`} controlId="fd-help">
                <LocalizedInput
                  id="fd-help"
                  value={f.help}
                  onChange={(v) => set({ help: Object.keys(v).length ? v : undefined })}
                />
              </Field>
            </Col>
          </Row>
        </fieldset>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          {calculated ? t('common.close') : t('common.cancel')}
        </Button>
        {!calculated && (
          <Button
            onClick={() => void submit()}
            disabled={
              saving ||
              !keyOk ||
              !Object.values(f.label).some(Boolean) ||
              !!formulaError ||
              (f.type === 'table' && !(f.columns ?? []).length)
            }
          >
            {t('common.save')}
          </Button>
        )}
      </Modal.Footer>
    </Modal>
  );
}

function slug(s: string): string {
  const k = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return /^[a-z]/.test(k) ? k : k ? `f_${k}`.slice(0, 40) : '';
}

/** Columns of a table field (line items): each a simple field of its own. */
function ColumnsEditor({
  columns,
  onChange,
  picklists,
  entities,
  entityMap,
  published,
}: {
  columns: FieldDef[];
  onChange: (c: FieldDef[]) => void;
  picklists: { key: string; label: LocalizedText }[];
  entities: { key: string; label?: LocalizedText }[];
  entityMap: Map<string, EntityPatch>;
  published: boolean;
}) {
  const { t } = useTranslation();
  const label = useLabel();
  const setCol = (i: number, patch: Partial<FieldDef>) =>
    onChange(columns.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const keys = columns.map((c) => c.key);
  return (
    <Card body className="mb-3">
      <div className="fw-semibold mb-1">{t('studio.columns')}</div>
      <p className="small text-body-secondary">{t('studio.columnsHelp')}</p>
      {columns.map((c, i) => (
        <Row key={i} className="g-2 mb-2 align-items-start border-bottom pb-2">
          <Col md={3}>
            <LocalizedInput
              id={`col-label-${i}`}
              value={c.label}
              onChange={(v) =>
                setCol(i, {
                  label: v,
                  ...(!c.key || c.key === slug(label(c.label))
                    ? { key: slug(v.en ?? Object.values(v)[0] ?? '') }
                    : {}),
                })
              }
            />
          </Col>
          <Col md={2}>
            <Form.Control
              size="sm"
              className="font-monospace"
              dir="ltr"
              placeholder={t('studio.fieldKey')}
              value={c.key}
              isInvalid={!!c.key && (!KEY_RE.test(c.key) || keys.indexOf(c.key) !== i)}
              onChange={(e) => setCol(i, { key: e.target.value.toLowerCase() })}
            />
          </Col>
          <Col md={2}>
            <Form.Select
              size="sm"
              value={c.type}
              onChange={(e) => setCol(i, { type: e.target.value as FieldType })}
            >
              {TABLE_COLUMN_TYPES.map((ty) => (
                <option key={ty} value={ty}>
                  {t(`fieldTypes.${ty}`)}
                </option>
              ))}
            </Form.Select>
          </Col>
          <Col md={4}>
            {c.type === 'select' && (
              <Form.Select
                size="sm"
                value={c.picklist ?? ''}
                onChange={(e) => setCol(i, { picklist: e.target.value || undefined })}
              >
                <option value="">{t('studio.picklist')}</option>
                {picklists.map((p) => (
                  <option key={p.key} value={p.key}>
                    {label(p.label)}
                  </option>
                ))}
              </Form.Select>
            )}
            {c.type === 'lookup' && (
              <Form.Select
                size="sm"
                value={c.target ?? ''}
                onChange={(e) => setCol(i, { target: e.target.value || undefined })}
              >
                <option value="">{t('studio.target')}</option>
                {entities.map((e) => (
                  <option key={e.key} value={e.key}>
                    {label(e.label) || e.key}
                  </option>
                ))}
              </Form.Select>
            )}
            {c.type === 'formula' && (
              <InputGroup size="sm">
                <Form.Control
                  dir="ltr"
                  className="font-monospace"
                  placeholder="qty * rate"
                  value={c.formula ?? ''}
                  onChange={(e) =>
                    setCol(i, { formula: e.target.value, resultType: c.resultType ?? 'number' })
                  }
                />
                <Form.Select
                  style={{ maxWidth: 110 }}
                  value={c.resultType ?? 'number'}
                  onChange={(e) =>
                    setCol(i, { resultType: e.target.value as FieldDef['resultType'] })
                  }
                >
                  <option value="number">{t('fieldTypes.decimal')}</option>
                  <option value="text">{t('fieldTypes.text')}</option>
                </Form.Select>
              </InputGroup>
            )}
            {c.type === 'currency' && (
              <Form.Control
                size="sm"
                dir="ltr"
                maxLength={3}
                placeholder={t('studio.currencyHint')}
                value={c.currency ?? ''}
                onChange={(e) => setCol(i, { currency: e.target.value.toUpperCase() || undefined })}
              />
            )}
            {!NO_DEFAULT_FROM.has(c.type) && (
              <DefaultFromSelect
                id={`col-df-${i}`}
                size="sm"
                value={c.defaultFrom}
                onChange={(defaultFrom) => setCol(i, { defaultFrom })}
                siblings={columns.filter((_, j) => j !== i)}
                entities={entityMap}
              />
            )}
            {c.type !== 'formula' && (
              <Form.Check
                type="switch"
                id={`col-req-${i}`}
                label={t('studio.required')}
                checked={!!c.required}
                onChange={(e) => setCol(i, { required: e.target.checked || undefined })}
              />
            )}
          </Col>
          <Col md={1} className="text-end">
            {!published && (
              <Button
                size="sm"
                variant="outline-danger"
                onClick={() => onChange(columns.filter((_, j) => j !== i))}
                aria-label={t('common.delete')}
              >
                <i className="bi bi-x" />
              </Button>
            )}
          </Col>
        </Row>
      ))}
      <Button
        size="sm"
        variant="outline-primary"
        onClick={() => onChange([...columns, { key: '', type: 'text', label: {} }])}
      >
        <i className="bi bi-plus me-1" />
        {t('studio.addColumn')}
      </Button>
    </Card>
  );
}
