import { useState } from 'react';
import { Accordion, Badge, Button, Card, Col, Form, Modal, Row, Table } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import {
  KEY_RE,
  type ApprovalLevel,
  type EntityDef,
  type WorkflowAction,
  type WorkflowDef,
  type WorkflowState,
} from '@erp/metadata';
import { useAuth } from '../auth/AuthContext';
import { customEntities, useConfigActions, useEffectiveConfig, useLabel } from '../config/hooks';
import { LocalizedInput } from '../config/LocalizedInput';
import { ErrorAlert } from '../components/ui';
import {
  ChecklistInput,
  ConditionInput,
  formulaProblem,
  PeopleEditor,
  useRoles,
} from './AutomationShared';
import { useStudio } from './StudioContext';

const APPROVER_KINDS = ['unit_head', 'manager', 'role', 'users', 'field'] as const;

/** A sensible starting point: Draft → Pending → Approved / Rejected, one approval level. */
function starter(entity: string): WorkflowDef {
  return {
    entity,
    initialState: 'draft',
    states: [
      { key: 'draft', label: { en: 'Draft', hi: 'ड्राफ्ट', ar: 'مسودة' }, color: '#6c757d' },
      {
        key: 'pending',
        label: { en: 'Pending approval', hi: 'स्वीकृति लंबित', ar: 'بانتظار الموافقة' },
        color: '#fd7e14',
        locked: true,
      },
      {
        key: 'approved',
        label: { en: 'Approved', hi: 'स्वीकृत', ar: 'تمت الموافقة' },
        color: '#198754',
        locked: true,
      },
      { key: 'rejected', label: { en: 'Rejected', hi: 'अस्वीकृत', ar: 'مرفوض' }, color: '#dc3545' },
    ],
    actions: [
      {
        key: 'submit',
        label: { en: 'Submit for approval', hi: 'स्वीकृति के लिए भेजें', ar: 'إرسال للموافقة' },
        from: ['draft', 'rejected'],
        to: 'pending',
        requesterOnly: true,
        approval: {
          approvedState: 'approved',
          rejectedState: 'rejected',
          levels: [
            {
              key: 'head',
              label: { en: 'Unit head' },
              approvers: [{ type: 'unit_head' }],
              mode: 'any',
              remindAfterHours: 24,
              escalateAfterHours: 48,
            },
          ],
        },
      },
      {
        key: 'withdraw',
        label: { en: 'Withdraw', hi: 'वापस लें', ar: 'سحب' },
        from: ['pending'],
        to: 'draft',
        requesterOnly: true,
      },
    ],
  };
}

function LevelEditor({
  level,
  onChange,
  onRemove,
  entity,
  idp,
}: {
  level: ApprovalLevel;
  onChange: (l: ApprovalLevel) => void;
  onRemove: () => void;
  entity: EntityDef | undefined;
  idp: string;
}) {
  const { t } = useTranslation();
  const num = (v: string) => (v === '' ? undefined : Number(v));
  return (
    <Card className="mb-2 border">
      <Card.Body className="p-2">
        <Row className="g-2">
          <Col md={3}>
            <Form.Label className="small">{t('studio.key')}</Form.Label>
            <Form.Control
              size="sm"
              dir="ltr"
              className="font-monospace"
              value={level.key}
              onChange={(e) => onChange({ ...level, key: e.target.value.toLowerCase() })}
            />
          </Col>
          <Col md={5}>
            <Form.Label className="small">{t('studio.label')}</Form.Label>
            <LocalizedInput
              id={`${idp}-label`}
              value={level.label}
              onChange={(label) => onChange({ ...level, label })}
            />
          </Col>
          <Col md={4}>
            <Form.Label className="small">{t('workflow.mode')}</Form.Label>
            <Form.Select
              size="sm"
              value={level.mode}
              onChange={(e) => onChange({ ...level, mode: e.target.value as 'all' | 'any' })}
            >
              <option value="any">{t('workflow.modeAny')}</option>
              <option value="all">{t('workflow.modeAll')}</option>
            </Form.Select>
          </Col>
          <Col md={12}>
            <Form.Label className="small">{t('workflow.levelCondition')}</Form.Label>
            <ConditionInput
              id={`${idp}-cond`}
              value={level.condition}
              entity={entity}
              placeholder="amount > 50000"
              onChange={(condition) => onChange({ ...level, condition })}
            />
          </Col>
          <Col md={12}>
            <Form.Label className="small">{t('workflow.approvers')}</Form.Label>
            <PeopleEditor
              value={level.approvers}
              entity={entity}
              kinds={[...APPROVER_KINDS]}
              onChange={(approvers) =>
                onChange({ ...level, approvers: approvers as ApprovalLevel['approvers'] })
              }
            />
          </Col>
          <Col md={3}>
            <Form.Label className="small">{t('workflow.remindAfter')}</Form.Label>
            <Form.Control
              size="sm"
              type="number"
              min={0}
              value={level.remindAfterHours ?? ''}
              onChange={(e) => onChange({ ...level, remindAfterHours: num(e.target.value) })}
            />
          </Col>
          <Col md={3}>
            <Form.Label className="small">{t('workflow.escalateAfter')}</Form.Label>
            <Form.Control
              size="sm"
              type="number"
              min={0}
              value={level.escalateAfterHours ?? ''}
              onChange={(e) => onChange({ ...level, escalateAfterHours: num(e.target.value) })}
            />
          </Col>
          <Col md={6}>
            <Form.Label className="small">{t('workflow.escalateTo')}</Form.Label>
            <PeopleEditor
              value={level.escalateTo ?? []}
              entity={entity}
              kinds={[...APPROVER_KINDS]}
              onChange={(v) => onChange({ ...level, escalateTo: v as ApprovalLevel['approvers'] })}
            />
            <Form.Text muted>{t('workflow.escalateToHelp')}</Form.Text>
          </Col>
        </Row>
        <div className="text-end">
          <Button size="sm" variant="link" className="text-danger" onClick={onRemove}>
            {t('common.delete')}
          </Button>
        </div>
      </Card.Body>
    </Card>
  );
}

function ActionEditor({
  action,
  onChange,
  states,
  entity,
  idp,
}: {
  action: WorkflowAction;
  onChange: (a: WorkflowAction) => void;
  states: WorkflowState[];
  entity: EntityDef | undefined;
  idp: string;
}) {
  const { t } = useTranslation();
  const label = useLabel();
  const roles = useRoles();
  const stateKeys = states.map((s) => s.key);
  return (
    <Row className="g-2">
      <Col md={3}>
        <Form.Label className="small">{t('studio.key')}</Form.Label>
        <Form.Control
          size="sm"
          dir="ltr"
          className="font-monospace"
          value={action.key}
          onChange={(e) => onChange({ ...action, key: e.target.value.toLowerCase() })}
        />
      </Col>
      <Col md={5}>
        <Form.Label className="small">{t('workflow.buttonLabel')}</Form.Label>
        <LocalizedInput
          id={`${idp}-label`}
          value={action.label}
          onChange={(l) => onChange({ ...action, label: l })}
        />
      </Col>
      <Col md={4}>
        <Form.Label className="small">{t('workflow.to')}</Form.Label>
        <Form.Select
          size="sm"
          value={action.to}
          onChange={(e) => onChange({ ...action, to: e.target.value })}
        >
          {states.map((s) => (
            <option key={s.key} value={s.key}>
              {label(s.label)}
            </option>
          ))}
        </Form.Select>
      </Col>
      <Col md={12}>
        <Form.Label className="small">{t('workflow.from')}</Form.Label>
        <ChecklistInput
          id={`${idp}-from`}
          options={stateKeys}
          value={action.from}
          labelOf={(k) => label(states.find((s) => s.key === k)?.label)}
          onChange={(from) => onChange({ ...action, from })}
        />
      </Col>
      <Col md={6}>
        <Form.Label className="small">{t('workflow.whoCan')}</Form.Label>
        <Form.Select
          size="sm"
          multiple
          value={action.roleIds ?? []}
          onChange={(e) =>
            onChange({ ...action, roleIds: [...e.target.selectedOptions].map((o) => o.value) })
          }
        >
          {roles.data?.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Form.Select>
        <Form.Text muted>{t('workflow.whoCanHelp')}</Form.Text>
      </Col>
      <Col md={6} className="pt-md-4">
        <Form.Check
          id={`${idp}-req`}
          type="switch"
          label={t('workflow.requesterOnly')}
          checked={!!action.requesterOnly}
          onChange={(e) => onChange({ ...action, requesterOnly: e.target.checked || undefined })}
        />
        <Form.Check
          id={`${idp}-comment`}
          type="switch"
          label={t('workflow.commentRequired')}
          checked={!!action.commentRequired}
          onChange={(e) => onChange({ ...action, commentRequired: e.target.checked || undefined })}
        />
        <Form.Check
          id={`${idp}-approval`}
          type="switch"
          label={t('workflow.needsApproval')}
          checked={!!action.approval}
          onChange={(e) =>
            onChange({
              ...action,
              approval: e.target.checked
                ? {
                    approvedState: stateKeys.find((k) => k !== action.to) ?? action.to,
                    rejectedState: action.from[0] ?? action.to,
                    levels: [],
                  }
                : undefined,
            })
          }
        />
      </Col>
      <Col md={12}>
        <Form.Label className="small">{t('workflow.actionCondition')}</Form.Label>
        <ConditionInput
          id={`${idp}-cond`}
          value={action.condition}
          entity={entity}
          onChange={(condition) => onChange({ ...action, condition })}
        />
      </Col>
      {action.approval && (
        <Col md={12}>
          <div className="bg-body-tertiary rounded p-2">
            <Row className="g-2 mb-2">
              <Col md={6}>
                <Form.Label className="small">{t('workflow.approvedState')}</Form.Label>
                <Form.Select
                  size="sm"
                  value={action.approval.approvedState}
                  onChange={(e) =>
                    onChange({
                      ...action,
                      approval: { ...action.approval!, approvedState: e.target.value },
                    })
                  }
                >
                  {states.map((s) => (
                    <option key={s.key} value={s.key}>
                      {label(s.label)}
                    </option>
                  ))}
                </Form.Select>
              </Col>
              <Col md={6}>
                <Form.Label className="small">{t('workflow.rejectedState')}</Form.Label>
                <Form.Select
                  size="sm"
                  value={action.approval.rejectedState}
                  onChange={(e) =>
                    onChange({
                      ...action,
                      approval: { ...action.approval!, rejectedState: e.target.value },
                    })
                  }
                >
                  {states.map((s) => (
                    <option key={s.key} value={s.key}>
                      {label(s.label)}
                    </option>
                  ))}
                </Form.Select>
              </Col>
            </Row>
            <div className="small fw-semibold mb-1">{t('workflow.levels')}</div>
            {action.approval.levels.map((l, i) => (
              <LevelEditor
                key={i}
                idp={`${idp}-l${i}`}
                level={l}
                entity={entity}
                onChange={(lv) =>
                  onChange({
                    ...action,
                    approval: {
                      ...action.approval!,
                      levels: action.approval!.levels.map((x, n) => (n === i ? lv : x)),
                    },
                  })
                }
                onRemove={() =>
                  onChange({
                    ...action,
                    approval: {
                      ...action.approval!,
                      levels: action.approval!.levels.filter((_, n) => n !== i),
                    },
                  })
                }
              />
            ))}
            <Button
              size="sm"
              variant="outline-primary"
              onClick={() =>
                onChange({
                  ...action,
                  approval: {
                    ...action.approval!,
                    levels: [
                      ...action.approval!.levels,
                      {
                        key: `level${action.approval!.levels.length + 1}`,
                        label: { en: `Level ${action.approval!.levels.length + 1}` },
                        approvers: [{ type: 'unit_head' }],
                        mode: 'any',
                      },
                    ],
                  },
                })
              }
            >
              <i className="bi bi-plus-lg me-1" />
              {t('workflow.addLevel')}
            </Button>
          </div>
        </Col>
      )}
    </Row>
  );
}

function WorkflowDialog({ initial, onClose }: { initial: WorkflowDef; onClose: () => void }) {
  const { t } = useTranslation();
  const label = useLabel();
  const { scope } = useStudio();
  const { putItem } = useConfigActions();
  const cfg = useEffectiveConfig(undefined, 'draft');
  const entity = cfg.data?.entities.find((e) => e.key === initial.entity);
  const [w, setW] = useState<WorkflowDef>(initial);
  const setState = (i: number, patch: Partial<WorkflowState>) =>
    setW({ ...w, states: w.states.map((s, n) => (n === i ? { ...s, ...patch } : s)) });
  const keysOk =
    w.states.every((s) => KEY_RE.test(s.key)) &&
    w.actions.every(
      (a) => KEY_RE.test(a.key) && (a.approval?.levels ?? []).every((l) => KEY_RE.test(l.key)),
    );
  const formulasOk = w.actions.every(
    (a) =>
      !formulaProblem(a.condition, entity) &&
      (a.approval?.levels ?? []).every((l) => !formulaProblem(l.condition, entity)),
  );

  return (
    <Modal show onHide={onClose} size="xl" scrollable>
      <Modal.Header closeButton>
        <Modal.Title className="h5">
          {t('workflow.title')}: {label(entity?.label) || w.entity}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <ErrorAlert error={putItem.error} />
        <h3 className="h6">{t('workflow.states')}</h3>
        <Table size="sm" className="align-middle">
          <thead>
            <tr className="small text-body-secondary">
              <th>{t('studio.key')}</th>
              <th>{t('studio.label')}</th>
              <th>{t('workflow.color')}</th>
              <th>{t('workflow.locked')}</th>
              <th>{t('workflow.editableWhenLocked')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {w.states.map((s, i) => (
              <tr key={i}>
                <td style={{ width: 130 }}>
                  <Form.Control
                    size="sm"
                    dir="ltr"
                    className="font-monospace"
                    value={s.key}
                    onChange={(e) => setState(i, { key: e.target.value.toLowerCase() })}
                  />
                </td>
                <td>
                  <LocalizedInput
                    id={`st-${i}`}
                    value={s.label}
                    onChange={(l) => setState(i, { label: l })}
                  />
                </td>
                <td style={{ width: 70 }}>
                  <Form.Control
                    size="sm"
                    type="color"
                    value={s.color ?? '#6c757d'}
                    onChange={(e) => setState(i, { color: e.target.value })}
                  />
                </td>
                <td>
                  <Form.Check
                    id={`st-lock-${i}`}
                    type="switch"
                    checked={!!s.locked}
                    onChange={(e) => setState(i, { locked: e.target.checked || undefined })}
                  />
                </td>
                <td style={{ minWidth: 180 }}>
                  {s.locked && (
                    <Form.Select
                      size="sm"
                      multiple
                      value={s.editableFields ?? []}
                      onChange={(e) =>
                        setState(i, {
                          editableFields: [...e.target.selectedOptions].map((o) => o.value),
                        })
                      }
                    >
                      {entity?.fields.map((f) => (
                        <option key={f.key} value={f.key}>
                          {label(f.label)}
                        </option>
                      ))}
                    </Form.Select>
                  )}
                </td>
                <td>
                  <Button
                    size="sm"
                    variant="outline-danger"
                    disabled={w.states.length <= 2}
                    onClick={() => setW({ ...w, states: w.states.filter((_, n) => n !== i) })}
                  >
                    <i className="bi bi-trash" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
        <div className="d-flex gap-3 align-items-center mb-4">
          <Button
            size="sm"
            variant="outline-primary"
            onClick={() =>
              setW({
                ...w,
                states: [
                  ...w.states,
                  { key: `state${w.states.length + 1}`, label: { en: 'New state' } },
                ],
              })
            }
          >
            <i className="bi bi-plus-lg me-1" />
            {t('workflow.addState')}
          </Button>
          <Form.Label className="mb-0 small">{t('workflow.initialState')}</Form.Label>
          <Form.Select
            size="sm"
            style={{ maxWidth: 220 }}
            value={w.initialState}
            onChange={(e) => setW({ ...w, initialState: e.target.value })}
          >
            {w.states.map((s) => (
              <option key={s.key} value={s.key}>
                {label(s.label)}
              </option>
            ))}
          </Form.Select>
          <Form.Check
            id="wf-active"
            type="switch"
            className="ms-auto"
            label={t('workflow.active')}
            checked={w.active !== false}
            onChange={(e) => setW({ ...w, active: e.target.checked ? undefined : false })}
          />
        </div>

        <h3 className="h6">{t('workflow.actions')}</h3>
        <Accordion alwaysOpen>
          {w.actions.map((a, i) => (
            <Accordion.Item eventKey={String(i)} key={i}>
              <Accordion.Header>
                <span className="fw-medium me-2">{label(a.label) || a.key}</span>
                {a.approval && (
                  <Badge bg="warning-subtle" text="warning-emphasis">
                    {t('workflow.levelsCount', { count: a.approval.levels.length })}
                  </Badge>
                )}
              </Accordion.Header>
              <Accordion.Body>
                <ActionEditor
                  idp={`a${i}`}
                  action={a}
                  states={w.states}
                  entity={entity}
                  onChange={(na) =>
                    setW({ ...w, actions: w.actions.map((x, n) => (n === i ? na : x)) })
                  }
                />
                <div className="text-end mt-2">
                  <Button
                    size="sm"
                    variant="link"
                    className="text-danger"
                    disabled={w.actions.length <= 1}
                    onClick={() => setW({ ...w, actions: w.actions.filter((_, n) => n !== i) })}
                  >
                    {t('workflow.removeAction')}
                  </Button>
                </div>
              </Accordion.Body>
            </Accordion.Item>
          ))}
        </Accordion>
        <Button
          size="sm"
          variant="outline-primary"
          className="mt-2"
          onClick={() =>
            setW({
              ...w,
              actions: [
                ...w.actions,
                {
                  key: `action${w.actions.length + 1}`,
                  label: { en: 'New action' },
                  from: [w.initialState],
                  to: w.states[1]?.key ?? w.initialState,
                },
              ],
            })
          }
        >
          <i className="bi bi-plus-lg me-1" />
          {t('workflow.addAction')}
        </Button>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button
          disabled={!keysOk || !formulasOk || putItem.isPending}
          onClick={() =>
            void putItem
              .mutateAsync({ kind: 'workflows', key: w.entity, body: w, scope })
              .then(onClose)
          }
        >
          {t('common.save')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

export function WorkflowsTab() {
  const { t } = useTranslation();
  const label = useLabel();
  const { can } = useAuth();
  const { layer, scope } = useStudio();
  const { deleteItem } = useConfigActions();
  const cfg = useEffectiveConfig(undefined, 'draft');
  const entities = customEntities(cfg.data);
  const [editing, setEditing] = useState<WorkflowDef | null>(null);
  const [pick, setPick] = useState('');
  const without = entities.filter((e) => !layer.workflows.some((w) => w.entity === e.key));

  return (
    <Card className="shadow-sm border-0">
      <Card.Body>
        <p className="small text-body-secondary">{t('workflow.intro')}</p>
        <ErrorAlert error={deleteItem.error} />
        {can('config.manage') && without.length > 0 && (
          <div className="d-flex gap-2 mb-3" style={{ maxWidth: 480 }}>
            <Form.Select size="sm" value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">{t('workflow.chooseEntity')}</option>
              {without.map((e) => (
                <option key={e.key} value={e.key}>
                  {label(e.label)}
                </option>
              ))}
            </Form.Select>
            <Button
              size="sm"
              className="text-nowrap"
              disabled={!pick}
              onClick={() => setEditing(starter(pick))}
            >
              <i className="bi bi-plus-lg me-1" />
              {t('workflow.add')}
            </Button>
          </div>
        )}
        {layer.workflows.length === 0 ? (
          <p className="text-body-secondary mb-0">{t('studio.empty')}</p>
        ) : (
          <Table hover size="sm" className="align-middle mb-0">
            <tbody>
              {layer.workflows.map((w) => (
                <tr key={w.entity}>
                  <td className="fw-medium">
                    {label(entities.find((e) => e.key === w.entity)?.label) || w.entity}
                  </td>
                  <td>
                    {w.states.map((s) => (
                      <Badge
                        key={s.key}
                        className="me-1"
                        style={{ background: s.color ?? '#6c757d' }}
                      >
                        {label(s.label)}
                      </Badge>
                    ))}
                  </td>
                  <td className="small text-body-secondary">
                    {w.active === false
                      ? t('workflow.inactive')
                      : t('workflow.actionsCount', { count: w.actions.length })}
                  </td>
                  <td className="text-end text-nowrap">
                    <Button
                      size="sm"
                      variant="outline-primary"
                      className="me-1"
                      onClick={() => setEditing(w)}
                    >
                      <i className="bi bi-pencil" />
                    </Button>
                    {can('config.manage') && (
                      <Button
                        size="sm"
                        variant="outline-danger"
                        onClick={() =>
                          window.confirm(t('common.confirm')) &&
                          deleteItem.mutate({ kind: 'workflows', key: w.entity, scope })
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
      {editing && <WorkflowDialog initial={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}
