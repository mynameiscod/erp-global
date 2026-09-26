import { useEffect, useState } from 'react';
import { Alert, Button, ButtonGroup, Card, Col, Form, ListGroup, Row } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import { SYSTEM_COLUMNS, type FieldDef, type ListView } from '@erp/metadata';
import { useAuth } from '../auth/AuthContext';
import { useConfigActions, useLabel } from '../config/hooks';
import { ErrorAlert, Field } from '../components/ui';
import { useInherited } from './packBase';
import { useStudio } from './StudioContext';

/** Choose and order the columns of an entity's list, and its default sort. */
export function ListDesigner({ entityKey, fields }: { entityKey: string; fields: FieldDef[] }) {
  const { t } = useTranslation();
  const label = useLabel();
  const { can } = useAuth();
  const { layer, scope } = useStudio();
  const { below } = useInherited();
  const { putItem } = useConfigActions();
  const active = fields.filter((f) => !f.archived);
  const initial = (): ListView =>
    layer.listViews.find((v) => v.entity === entityKey) ??
    below.listViews.find((v) => v.entity === entityKey) ?? {
      entity: entityKey,
      columns: ['number', ...active.slice(0, 5).map((f) => f.key)],
      sort: { field: 'createdAt', dir: 'desc' },
    };
  const [view, setView] = useState<ListView>(initial);
  const [saved, setSaved] = useState(false);
  useEffect(() => setView(initial()), [layer, entityKey]);

  const systemNames: Record<string, string> = {
    number: '#',
    createdAt: t('tenants.created'),
    updatedAt: t('audit.when'),
    createdBy: t('audit.actor'),
    updatedBy: t('audit.actor'),
    orgUnitId: t('records.orgUnit'),
  };
  const all = [...SYSTEM_COLUMNS, ...active.map((f) => f.key)];
  const nameOf = (k: string) =>
    systemNames[k] ?? (label(active.find((f) => f.key === k)?.label) || k);
  const update = (patch: Partial<ListView>) => {
    setSaved(false);
    setView((v) => ({ ...v, ...patch }));
  };
  const toggle = (k: string, on: boolean) =>
    update({ columns: on ? [...view.columns, k] : view.columns.filter((c) => c !== k) });
  const shift = (i: number, d: -1 | 1) => {
    const cols = [...view.columns];
    [cols[i], cols[i + d]] = [cols[i + d], cols[i]];
    update({ columns: cols });
  };

  return (
    <Card className="shadow-sm border-0">
      <Card.Body>
        <ErrorAlert error={putItem.error} />
        {saved && <Alert variant="success">{t('common.saved')}</Alert>}
        <Row className="g-4">
          <Col md={6}>
            <h3 className="h6">{t('studio.listColumns')}</h3>
            <ListGroup>
              {view.columns.map((k, i) => (
                <ListGroup.Item key={k} className="d-flex align-items-center gap-2">
                  <span className="flex-grow-1">{nameOf(k)}</span>
                  <ButtonGroup size="sm">
                    <Button
                      variant="outline-secondary"
                      disabled={i === 0}
                      onClick={() => shift(i, -1)}
                      aria-label="up"
                    >
                      <i className="bi bi-arrow-up" />
                    </Button>
                    <Button
                      variant="outline-secondary"
                      disabled={i === view.columns.length - 1}
                      onClick={() => shift(i, 1)}
                      aria-label="down"
                    >
                      <i className="bi bi-arrow-down" />
                    </Button>
                    <Button
                      variant="outline-danger"
                      disabled={view.columns.length === 1}
                      onClick={() => toggle(k, false)}
                      aria-label="remove"
                    >
                      <i className="bi bi-x" />
                    </Button>
                  </ButtonGroup>
                </ListGroup.Item>
              ))}
            </ListGroup>
            <div className="mt-2 d-flex flex-wrap gap-2">
              {all
                .filter((k) => !view.columns.includes(k))
                .map((k) => (
                  <Button
                    key={k}
                    size="sm"
                    variant="outline-primary"
                    onClick={() => toggle(k, true)}
                  >
                    <i className="bi bi-plus me-1" />
                    {nameOf(k)}
                  </Button>
                ))}
            </div>
          </Col>
          <Col md={6}>
            <Field label={t('studio.sortBy')} controlId="lv-sort">
              <Form.Select
                value={view.sort?.field ?? ''}
                onChange={(e) =>
                  update({
                    sort: e.target.value
                      ? { field: e.target.value, dir: view.sort?.dir ?? 'asc' }
                      : undefined,
                  })
                }
              >
                <option value="" />
                {all.map((k) => (
                  <option key={k} value={k}>
                    {nameOf(k)}
                  </option>
                ))}
              </Form.Select>
            </Field>
            {view.sort && (
              <Form.Group className="mb-3">
                <Form.Check
                  inline
                  type="radio"
                  id="lv-asc"
                  label={t('studio.ascending')}
                  checked={view.sort.dir === 'asc'}
                  onChange={() => update({ sort: { ...view.sort!, dir: 'asc' } })}
                />
                <Form.Check
                  inline
                  type="radio"
                  id="lv-desc"
                  label={t('studio.descending')}
                  checked={view.sort.dir === 'desc'}
                  onChange={() => update({ sort: { ...view.sort!, dir: 'desc' } })}
                />
              </Form.Group>
            )}
          </Col>
        </Row>
        {can('config.manage') && (
          <Button
            className="mt-3"
            disabled={putItem.isPending}
            onClick={() =>
              void putItem
                .mutateAsync({ kind: 'list-views', key: entityKey, body: view, scope })
                .then(() => setSaved(true))
            }
          >
            {t('studio.saveLayout')}
          </Button>
        )}
      </Card.Body>
    </Card>
  );
}
