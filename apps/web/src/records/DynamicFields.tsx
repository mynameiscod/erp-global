import { Col, Form, Row } from 'react-bootstrap';
import {
  activeFields,
  COMPUTED_TYPES,
  type EffectiveConfig,
  type EntityDef,
  type FormSection,
} from '@erp/metadata';
import { useLabel } from '../config/hooks';
import { FieldInput } from './FieldInput';

export type Values = Record<string, unknown>;

/** Sections to render: the configured form layout, or one section with every active field. */
export function sectionsFor(entity: EntityDef, cfg: EffectiveConfig): FormSection[] {
  const active = activeFields(entity);
  const layout = cfg.forms.find((f) => f.entity === entity.key);
  if (!layout)
    return [{ key: 'main', label: entity.label, columns: 2, fields: active.map((f) => f.key) }];
  const activeKeys = new Set(active.map((f) => f.key));
  const sections = layout.sections.map((s) => ({
    ...s,
    fields: s.fields.filter((k) => activeKeys.has(k)),
  }));
  // Required fields must always be reachable, even if the layout forgot them.
  const placed = new Set(sections.flatMap((s) => s.fields));
  const missing = active.filter((f) => f.required && !placed.has(f.key)).map((f) => f.key);
  if (missing.length)
    sections.push({ key: 'more', label: entity.label, columns: 2, fields: missing });
  return sections.filter((s) => s.fields.length);
}

/** Values the client may send: no calculated or archived fields. */
export function editableValues(entity: EntityDef, values: Values): Values {
  const editable = new Set(
    entity.fields.filter((f) => !f.archived && !COMPUTED_TYPES.has(f.type)).map((f) => f.key),
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
}) {
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
                {label(s.label)}
              </legend>
            )}
            <Row>
              {s.fields.map((key) => {
                const f = fields.get(key)!;
                const id = `${idPrefix}-${key}`;
                return (
                  <Col md={f.type === 'table' ? 12 : 12 / s.columns} key={key}>
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
                );
              })}
            </Row>
          </fieldset>
        ))}
    </>
  );
}
