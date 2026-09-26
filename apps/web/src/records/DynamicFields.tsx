import { Fragment, type ReactNode } from 'react';
import { Col, Form, Row } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import {
  activeFields,
  isCalculated,
  TAX_RECORD_FIELDS,
  type EffectiveConfig,
  type EntityDef,
  type FormSection,
} from '@erp/metadata';
import { useLabel } from '../config/hooks';
import { FieldInput } from './FieldInput';

export type Values = Record<string, unknown>;

/** Key of the section that collects fields the form layout does not place. */
export const MORE_SECTION = '__more';

/** Record fields the tax engine fills; the form shows them in the tax summary instead. */
export function taxRecordKeys(entity: EntityDef): Set<string> {
  if (!entity.tax) return new Set();
  return new Set(
    entity.fields
      .filter(
        (f) => f.calculated === 'tax' && (TAX_RECORD_FIELDS as readonly string[]).includes(f.key),
      )
      .map((f) => f.key),
  );
}

/**
 * Sections to render: the configured form layout, or one section with every active field.
 * Fields the layout does not place (e.g. added later by a Country Pack) are shown in a last
 * section, so no field is ever unreachable.
 */
export function sectionsFor(entity: EntityDef, cfg: EffectiveConfig): FormSection[] {
  const tax = taxRecordKeys(entity);
  const active = activeFields(entity).filter((f) => !tax.has(f.key));
  const layout = cfg.forms.find((f) => f.entity === entity.key);
  if (!layout)
    return [{ key: 'main', label: entity.label, columns: 2, fields: active.map((f) => f.key) }];
  const activeKeys = new Set(active.map((f) => f.key));
  const sections = layout.sections.map((s) => ({
    ...s,
    fields: s.fields.filter((k) => activeKeys.has(k)),
  }));
  const placed = new Set(sections.flatMap((s) => s.fields));
  const missing = active.filter((f) => !placed.has(f.key)).map((f) => f.key);
  if (missing.length)
    sections.push({ key: MORE_SECTION, label: entity.label, columns: 2, fields: missing });
  return sections.filter((s) => s.fields.length);
}

/** Values the client may send: no calculated (formula, auto-number, tax) or archived fields. */
export function editableValues(entity: EntityDef, values: Values): Values {
  const editable = new Set(
    entity.fields.filter((f) => !f.archived && !isCalculated(f)).map((f) => f.key),
  );
  return Object.fromEntries(Object.entries(values).filter(([k]) => editable.has(k)));
}

export function DynamicFields({
  entity,
  cfg,
  currency,
  values,
  errors,
  onChange,
  idPrefix = 'f',
  showSectionTitles = true,
  hidden,
  readOnly,
  required,
  renderAfter,
}: {
  entity: EntityDef;
  cfg: EffectiveConfig;
  currency: string;
  values: Values;
  errors: Record<string, string>;
  onChange: (key: string, value: unknown) => void;
  idPrefix?: string;
  showSectionTitles?: boolean;
  /** From business rules and workflow locks. */
  hidden?: Set<string>;
  readOnly?: Set<string>;
  required?: Set<string>;
  /** Extra content shown right after a field (e.g. the tax summary after the line items). */
  renderAfter?: (key: string) => ReactNode;
}) {
  const { t } = useTranslation();
  const label = useLabel();
  const fields = new Map(entity.fields.map((f) => [f.key, f]));
  return (
    <>
      {sectionsFor(entity, cfg)
        .map((s) => ({ ...s, fields: s.fields.filter((k) => !hidden?.has(k)) }))
        .filter((s) => s.fields.length)
        .map((s) => (
          <fieldset key={s.key} className="mb-3">
            {showSectionTitles && (
              <legend className="h6 text-body-secondary border-bottom pb-1">
                {s.key === MORE_SECTION ? t('records.moreDetails') : label(s.label)}
              </legend>
            )}
            <Row>
              {s.fields.map((key) => {
                const f = fields.get(key)!;
                const id = `${idPrefix}-${key}`;
                const after = renderAfter?.(key);
                return (
                  <Fragment key={key}>
                    <Col md={f.type === 'table' ? 12 : 12 / s.columns}>
                      <Form.Group className="mb-3" controlId={id}>
                        <Form.Label>
                          {label(f.label)}
                          {(f.required || required?.has(key)) && (
                            <span className="text-danger ms-1">*</span>
                          )}
                          {readOnly?.has(key) && (
                            <i className="bi bi-lock ms-1 text-body-secondary small" />
                          )}
                        </Form.Label>
                        <fieldset disabled={readOnly?.has(key)}>
                          <FieldInput
                            field={f}
                            id={id}
                            cfg={cfg}
                            currency={currency}
                            value={values[key]}
                            invalid={!!errors[key]}
                            onChange={(v) => onChange(key, v)}
                          />
                        </fieldset>
                        {errors[key] ? (
                          <Form.Control.Feedback type="invalid" className="d-block">
                            {errors[key]}
                          </Form.Control.Feedback>
                        ) : (
                          f.help && <Form.Text muted>{label(f.help)}</Form.Text>
                        )}
                      </Form.Group>
                    </Col>
                    {after && <Col xs={12}>{after}</Col>}
                  </Fragment>
                );
              })}
            </Row>
          </fieldset>
        ))}
    </>
  );
}
