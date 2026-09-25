import { useState } from 'react';
import { Badge, Button, Card, Col, Form, Modal, Row, Table } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import { KEY_RE, RULE_EFFECTS, type RuleDef, type RuleEffect } from '@erp/metadata';
import { useAuth } from '../auth/AuthContext';
import { customEntities, useConfigActions, useEffectiveConfig, useLabel } from '../config/hooks';
import { LocalizedInput } from '../config/LocalizedInput';
import { ErrorAlert, Field } from '../components/ui';
import { ConditionInput, formulaProblem } from './AutomationShared';
import { useStudio } from './StudioContext';

function RuleDialog({ rule, onClose }: { rule?: RuleDef; onClose: () => void }) {
  const { t } = useTranslation();
  const label = useLabel();
  const { scope } = useStudio();
  const { putItem } = useConfigActions();
  const cfg = useEffectiveConfig(undefined, 'draft');
  const entities = customEntities(cfg.data);
  const [r, setR] = useState<RuleDef>(
    rule ?? { key: '', entity: entities[0]?.key ?? '', on: 'save', effect: 'block' },
  );
  const entity = entities.find((e) => e.key === r.entity);
  const needsField = r.effect !== 'block';
  const ok =
    KEY_RE.test(r.key) &&
    !!entity &&
    (!needsField || !!r.field) &&
    (r.effect !== 'block' || Object.values(r.message ?? {}).some(Boolean)) &&
    (r.effect !== 'set' || (!!r.value && !formulaProblem(r.value, entity))) &&
    !formulaProblem(r.condition, entity);

  return (
    <Modal show onHide={onClose} centered size="lg">
      <Modal.Header closeButton>
        <Modal.Title className="h5">{rule ? rule.key : t('rules.new')}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <ErrorAlert error={putItem.error} />
        <Row>
          <Col md={6}>
            <Field label={t('rules.entity')} controlId="r-entity">
              <Form.Select
                value={r.entity}
                disabled={!!rule}
                onChange={(e) => setR({ ...r, entity: e.target.value, field: undefined })}
              >
                {entities.map((e) => (
                  <option key={e.key} value={e.key}>
                    {label(e.label)}
                  </option>
                ))}
              </Form.Select>
            </Field>
          </Col>
          <Col md={6}>
            <Field label={t('studio.key')} controlId="r-key" hint={t('studio.keyHint')}>
              <Form.Control
                dir="ltr"
                className="font-monospace"
                value={r.key}
                disabled={!!rule}
                onChange={(e) => setR({ ...r, key: e.target.value.toLowerCase() })}
              />
            </Field>
          </Col>
          <Col md={4}>
            <Field label={t('rules.when')} controlId="r-on">
              <Form.Select
                value={r.on}
                onChange={(e) => setR({ ...r, on: e.target.value as RuleDef['on'] })}
              >
                {(['save', 'create', 'update'] as const).map((o) => (
                  <option key={o} value={o}>
                    {t(`rules.on.${o}`)}
                  </option>
                ))}
              </Form.Select>
            </Field>
          </Col>
          <Col md={4}>
            <Field label={t('rules.then')} controlId="r-effect">
              <Form.Select
                value={r.effect}
                onChange={(e) => setR({ ...r, effect: e.target.value as RuleEffect })}
              >
                {RULE_EFFECTS.map((o) => (
                  <option key={o} value={o}>
                    {t(`rules.effect.${o}`)}
                  </option>
                ))}
              </Form.Select>
            </Field>
          </Col>
          <Col md={4}>
            {needsField && (
              <Field label={t('rules.field')} controlId="r-field">
                <Form.Select
                  value={r.field ?? ''}
                  onChange={(e) => setR({ ...r, field: e.target.value || undefined })}
                >
                  <option value="">{t('records.choose')}</option>
                  {entity?.fields
                    .filter((f) => !f.archived)
                    .map((f) => (
                      <option key={f.key} value={f.key}>
                        {label(f.label)}
                      </option>
                    ))}
                </Form.Select>
              </Field>
            )}
          </Col>
          <Col md={12}>
            <Field label={t('rules.condition')} controlId="r-cond" hint={t('rules.conditionHelp')}>
              <ConditionInput
                id="r-cond"
                value={r.condition}
                entity={entity}
                onChange={(condition) => setR({ ...r, condition })}
              />
            </Field>
          </Col>
          {r.effect === 'set' && (
            <Col md={12}>
              <Field label={t('rules.value')} controlId="r-value" hint={t('rules.valueHelp')}>
                <ConditionInput
                  id="r-value"
                  value={r.value}
                  entity={entity}
                  placeholder='IF(amount > 1000, "big", "small")'
                  onChange={(value) => setR({ ...r, value })}
                />
              </Field>
            </Col>
          )}
          {r.effect === 'block' && (
            <Col md={12}>
              <Field label={t('rules.message')} controlId="r-msg">
                <LocalizedInput
                  id="r-msg"
                  value={r.message}
                  onChange={(message) => setR({ ...r, message })}
                />
              </Field>
            </Col>
          )}
          <Col md={12}>
            <Form.Check
              id="r-active"
              type="switch"
              label={t('workflow.active')}
              checked={r.active !== false}
              onChange={(e) => setR({ ...r, active: e.target.checked ? undefined : false })}
            />
          </Col>
        </Row>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button
          disabled={!ok || putItem.isPending}
          onClick={() =>
            void putItem.mutateAsync({ kind: 'rules', key: r.key, body: r, scope }).then(onClose)
          }
        >
          {t('common.save')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

export function RulesTab() {
  const { t } = useTranslation();
  const label = useLabel();
  const { can } = useAuth();
  const { layer, scope } = useStudio();
  const { deleteItem } = useConfigActions();
  const cfg = useEffectiveConfig(undefined, 'draft');
  const entities = customEntities(cfg.data);
  const [editing, setEditing] = useState<RuleDef | 'new' | null>(null);
  return (
    <Card className="shadow-sm border-0">
      <Card.Body>
        <p className="small text-body-secondary">{t('rules.intro')}</p>
        <ErrorAlert error={deleteItem.error} />
        {can('config.manage') && (
          <Button
            size="sm"
            className="mb-3"
            disabled={!entities.length}
            onClick={() => setEditing('new')}
          >
            <i className="bi bi-plus-lg me-1" />
            {t('rules.new')}
          </Button>
        )}
        {layer.rules.length === 0 ? (
          <p className="text-body-secondary mb-0">{t('studio.empty')}</p>
        ) : (
          <Table hover size="sm" className="align-middle mb-0">
            <tbody>
              {layer.rules.map((r) => (
                <tr key={r.key} className={r.active === false ? 'text-body-secondary' : ''}>
                  <td className="font-monospace small" dir="ltr">
                    {r.key}
                  </td>
                  <td>{label(entities.find((e) => e.key === r.entity)?.label) || r.entity}</td>
                  <td>
                    <Badge bg="secondary-subtle" text="secondary-emphasis">
                      {t(`rules.effect.${r.effect}`)}
                    </Badge>{' '}
                    {r.field && <code>{r.field}</code>}
                  </td>
                  <td
                    className="font-monospace small text-truncate"
                    style={{ maxWidth: 260 }}
                    dir="ltr"
                  >
                    {r.condition || t('rules.always')}
                  </td>
                  <td className="text-end text-nowrap">
                    <Button
                      size="sm"
                      variant="outline-primary"
                      className="me-1"
                      onClick={() => setEditing(r)}
                    >
                      <i className="bi bi-pencil" />
                    </Button>
                    {can('config.manage') && (
                      <Button
                        size="sm"
                        variant="outline-danger"
                        onClick={() =>
                          window.confirm(t('common.confirm')) &&
                          deleteItem.mutate({ kind: 'rules', key: r.key, scope })
                        }
                      >
                        <i className="bi bi-trash" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card.Body>
      {editing && (
        <RuleDialog
          rule={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}
