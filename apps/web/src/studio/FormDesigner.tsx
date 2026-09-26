import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Col, Form, Row } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import type { FieldDef, FormSection } from '@erp/metadata';
import { useAuth } from '../auth/AuthContext';
import { useConfigActions, useLabel } from '../config/hooks';
import { LocalizedInput } from '../config/LocalizedInput';
import { ErrorAlert } from '../components/ui';
import { useInherited } from './packBase';
import { useStudio } from './StudioContext';

const UNPLACED = '__unplaced__';

/**
 * Arrange fields into sections by dragging them. Fields left out of every
 * section are hidden on the form (required fields are always shown).
 */
export function FormDesigner({ entityKey, fields }: { entityKey: string; fields: FieldDef[] }) {
  const { t } = useTranslation();
  const label = useLabel();
  const { can } = useAuth();
  const { layer, scope } = useStudio();
  const { below } = useInherited();
  const { putItem } = useConfigActions();
  const active = fields.filter((f) => !f.archived);
  const initial = (): FormSection[] =>
    (
      layer.forms.find((f) => f.entity === entityKey) ??
      below.forms.find((f) => f.entity === entityKey)
    )?.sections ?? [
      {
        key: 'main',
        label: { en: 'Details', hi: 'विवरण', ar: 'التفاصيل' },
        columns: 2,
        fields: active.map((f) => f.key),
      },
    ];
  const [sections, setSections] = useState<FormSection[]>(initial);
  const [dragging, setDragging] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => setSections(initial()), [layer, entityKey]);

  const placed = new Set(sections.flatMap((s) => s.fields));
  const unplaced = active.filter((f) => !placed.has(f.key)).map((f) => f.key);
  const byKey = new Map(fields.map((f) => [f.key, f]));

  const move = (field: string, to: string, before?: string) => {
    setSaved(false);
    setSections((prev) => {
      const next = prev.map((s) => ({ ...s, fields: s.fields.filter((k) => k !== field) }));
      if (to === UNPLACED) return next;
      const target = next.find((s) => s.key === to)!;
      const i = before ? target.fields.indexOf(before) : -1;
      if (i >= 0) target.fields.splice(i, 0, field);
      else target.fields.push(field);
      return next;
    });
  };

  const chip = (key: string) => {
    const f = byKey.get(key);
    return (
      <Badge
        key={key}
        bg="light"
        text="dark"
        className="border p-2 me-1 mb-1 user-select-none"
        style={{ cursor: 'grab' }}
        draggable
        onDragStart={(e) => {
          setDragging(key);
          e.dataTransfer.setData('text/plain', key);
        }}
        onDragEnd={() => setDragging(null)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const field = e.dataTransfer.getData('text/plain');
          const section = sections.find((s) => s.fields.includes(key));
          if (field && field !== key) move(field, section?.key ?? UNPLACED, key);
        }}
      >
        <i className="bi bi-grip-vertical me-1 text-body-tertiary" />
        {label(f?.label) || key}
        {f?.required && <span className="text-danger ms-1">*</span>}
      </Badge>
    );
  };

  const dropZone = (sectionKey: string) => ({
    onDragOver: (e: React.DragEvent) => e.preventDefault(),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const field = e.dataTransfer.getData('text/plain');
      if (field) move(field, sectionKey);
    },
  });

  const save = async () => {
    await putItem.mutateAsync({
      kind: 'forms',
      key: entityKey,
      body: { entity: entityKey, sections },
      scope,
    });
    setSaved(true);
  };

  return (
    <Card className="shadow-sm border-0">
      <Card.Body>
        <p className="small text-body-secondary">
          <i className="bi bi-arrows-move me-1" />
          {t('studio.dragHint')}
        </p>
        <ErrorAlert error={putItem.error} />
        {saved && <Alert variant="success">{t('common.saved')}</Alert>}
        {sections.map((s, i) => (
          <Card key={s.key} className={`mb-3 ${dragging ? 'border-primary border-2' : ''}`}>
            <Card.Header className="d-flex flex-wrap gap-2 align-items-start bg-body-tertiary">
              <div className="flex-grow-1" style={{ minWidth: 220 }}>
                <LocalizedInput
                  id={`sec-${s.key}`}
                  value={s.label}
                  onChange={(v) =>
                    setSections((prev) => prev.map((x, j) => (j === i ? { ...x, label: v } : x)))
                  }
                />
              </div>
              <Form.Select
                size="sm"
                style={{ width: 130 }}
                value={s.columns}
                aria-label={t('studio.columns')}
                onChange={(e) =>
                  setSections((prev) =>
                    prev.map((x, j) =>
                      j === i ? { ...x, columns: Number(e.target.value) as 1 | 2 | 3 } : x,
                    ),
                  )
                }
              >
                {[1, 2, 3].map((c) => (
                  <option key={c} value={c}>
                    {c} × {t('studio.columns')}
                  </option>
                ))}
              </Form.Select>
              <Button
                size="sm"
                variant="outline-danger"
                disabled={sections.length === 1}
                onClick={() => setSections((prev) => prev.filter((_, j) => j !== i))}
              >
                <i className="bi bi-trash" />
              </Button>
            </Card.Header>
            <Card.Body {...dropZone(s.key)} style={{ minHeight: 64 }}>
              <Row>
                <Col>{s.fields.map(chip)}</Col>
              </Row>
            </Card.Body>
          </Card>
        ))}
        <Card className="mb-3 border-dashed" {...dropZone(UNPLACED)}>
          <Card.Header className="small text-body-secondary">{t('studio.notOnForm')}</Card.Header>
          <Card.Body style={{ minHeight: 56 }}>{unplaced.map(chip)}</Card.Body>
        </Card>
        {can('config.manage') && (
          <div className="d-flex gap-2">
            <Button
              variant="outline-primary"
              onClick={() =>
                setSections((prev) => [
                  ...prev,
                  {
                    key: `section_${prev.length + 1}`,
                    label: { en: `Section ${prev.length + 1}` },
                    columns: 2,
                    fields: [],
                  },
                ])
              }
            >
              <i className="bi bi-plus-lg me-1" />
              {t('studio.addSection')}
            </Button>
            <Button onClick={() => void save()} disabled={putItem.isPending}>
              {t('studio.saveLayout')}
            </Button>
          </div>
        )}
      </Card.Body>
    </Card>
  );
}
