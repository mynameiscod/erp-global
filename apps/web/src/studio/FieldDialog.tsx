import { useMemo, useState } from 'react';
import { Alert, Button, Col, Form, Modal, Row } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import {
  compileFormula,
  FIELD_TYPES,
  FormulaError,
  KEY_RE,
  mergeLayers,
  platformBaseLayer,
  type FieldDef,
  type FieldType,
  type LocalizedText,
} from '@erp/metadata';
import { useLabel } from '../config/hooks';
import { LocalizedInput } from '../config/LocalizedInput';
import { Field } from '../components/ui';
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
const NOT_ON_SYSTEM = new Set<FieldType>(['lookup', 'lookup_many', 'file', 'image', 'autonumber']);

const num = (v: string) => (v === '' ? undefined : Number(v));

export function FieldDialog({
  entityKey,
  isSystem,
  field,
  published,
  existingKeys,
  onClose,
  onSave,
}: {
  entityKey: string;
  isSystem: boolean;
  field?: FieldDef;
  published: boolean;
  existingKeys: string[];
  onClose: () => void;
  onSave: (f: FieldDef, originalKey?: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const label = useLabel();
  const { layer, company, scope } = useStudio();
  const [f, setF] = useState<FieldDef>(field ?? { key: '', type: 'text', label: {} });
  const set = (patch: Partial<FieldDef>) => setF((prev) => ({ ...prev, ...patch }));
  const [saving, setSaving] = useState(false);

  // What this field can refer to: entities, option lists and series visible at this scope in the draft.
  const merged = useMemo(
    () =>
      mergeLayers(
        scope === 'company' ? [platformBaseLayer(), layer] : [platformBaseLayer(), company, layer],
      ),
    [layer, company, scope],
  );

  const types = FIELD_TYPES.filter((ty) => {
    if (isSystem && NOT_ON_SYSTEM.has(ty)) return false;
    if (published && field) return ty === field.type || COMPATIBLE[field.type]?.includes(ty);
    return true;
  });
  const keyTaken = !field && existingKeys.includes(f.key);
  const keyOk = KEY_RE.test(f.key) && !keyTaken;
  const formulaError = useMemo(() => {
    if (f.type !== 'formula' || !f.formula) return undefined;
    try {
      const deps = compileFormula(f.formula).fields.filter((d) => !existingKeys.includes(d));
      return deps.length ? `Unknown field: ${deps.join(', ')}` : undefined;
    } catch (e) {
      return e instanceof FormulaError ? e.message : 'Invalid formula';
    }
  }, [f.type, f.formula, existingKeys]);

  const submit = async () => {
    setSaving(true);
    // Drop settings that do not belong to the chosen type.
    const clean: FieldDef = { key: f.key, type: f.type, label: f.label };
    for (const k of ['help', 'required', 'unique', 'searchable', 'archived', 'default'] as const)
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
    if (['integer', 'decimal', 'currency', 'percent'].includes(f.type)) keep('min', 'max');
    if (['decimal', 'currency', 'percent'].includes(f.type)) keep('scale');
    if (f.type === 'currency') keep('currency');
    if (['select', 'multiselect'].includes(f.type)) keep('picklist');
    if (['lookup', 'lookup_many'].includes(f.type)) keep('target');
    if (f.type === 'formula') keep('formula', 'resultType');
    if (f.type === 'autonumber') keep('numbering');
    if (['file', 'image'].includes(f.type)) keep('accept', 'maxSizeMb');
    await onSave(clean, field?.key);
    setSaving(false);
  };

  const n = (k: 'min' | 'max' | 'scale' | 'maxLength' | 'minLength' | 'maxSizeMb') => (
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
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button
          onClick={() => void submit()}
          disabled={saving || !keyOk || !Object.values(f.label).some(Boolean) || !!formulaError}
        >
          {t('common.save')}
        </Button>
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
