import { useState } from 'react';
import { Badge, Button, Card, Col, Form, InputGroup, Modal, Row, Table } from 'react-bootstrap';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  BUILTIN_TEMPLATES,
  CHANNELS,
  KEY_RE,
  workflowFor,
  type AutomationAction,
  type AutomationDef,
  type AutomationTrigger,
  type Channel,
} from '@erp/metadata';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { customEntities, useConfigActions, useEffectiveConfig, useLabel } from '../config/hooks';
import { LocalizedInput } from '../config/LocalizedInput';
import { ErrorAlert, Field, Loading } from '../components/ui';
import { formatDateTime } from '../lib/format';
import {
  AssignmentsEditor,
  ChecklistInput,
  ConditionInput,
  formulaProblem,
  PeopleEditor,
} from './AutomationShared';
import { useStudio } from './StudioContext';

const TRIGGERS: AutomationTrigger['type'][] = [
  'created',
  'updated',
  'field_changed',
  'status_changed',
  'deleted',
  'schedule',
];
const ACTIONS: AutomationAction['type'][] = [
  'notify',
  'update',
  'create',
  'webhook',
  'workflow_action',
  'document',
];
const RECIPIENTS = ['creator', 'manager', 'field', 'role', 'users'] as const;

function blankAction(type: AutomationAction['type'], entity: string): AutomationAction {
  switch (type) {
    case 'notify':
      return {
        type,
        template: 'approval.approved',
        recipients: [{ type: 'creator' }],
        channels: ['inapp', 'email'],
      };
    case 'update':
      return { type, set: [] };
    case 'create':
      return { type, entity, orgUnit: 'same', set: [] };
    case 'webhook':
      return { type, url: 'https://' };
    case 'workflow_action':
      return { type, action: '' };
    case 'document':
      return { type };
  }
}

function AutomationDialog({
  automation,
  onClose,
}: {
  automation?: AutomationDef;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const label = useLabel();
  const { scope, layer } = useStudio();
  const { putItem } = useConfigActions();
  const cfg = useEffectiveConfig(undefined, 'draft');
  const entities = customEntities(cfg.data);
  const [a, setA] = useState<AutomationDef>(
    automation ?? {
      key: '',
      entity: entities[0]?.key ?? '',
      label: {},
      trigger: { type: 'created' },
      actions: [],
    },
  );
  const entity = entities.find((e) => e.key === a.entity);
  const wf = cfg.data ? workflowFor(cfg.data, a.entity) : undefined;
  const templates = [
    ...BUILTIN_TEMPLATES.map((m) => m.key),
    ...(cfg.data?.templates ?? layer.templates).map((m) => m.key),
  ].filter((k, i, all) => all.indexOf(k) === i);
  const setAction = (i: number, next: AutomationAction) =>
    setA({ ...a, actions: a.actions.map((x, n) => (n === i ? next : x)) });
  const trig = a.trigger;
  const ok =
    KEY_RE.test(a.key) &&
    !!entity &&
    Object.values(a.label).some(Boolean) &&
    a.actions.length > 0 &&
    !formulaProblem(a.condition, entity) &&
    (trig.type !== 'schedule' || trig.every !== 'day' || !!trig.at);

  return (
    <Modal show onHide={onClose} size="xl" scrollable>
      <Modal.Header closeButton>
        <Modal.Title className="h5">
          {automation ? label(automation.label) : t('automation.new')}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <ErrorAlert error={putItem.error} />
        <Row>
          <Col md={4}>
            <Field label={t('rules.entity')} controlId="au-entity">
              <Form.Select
                value={a.entity}
                disabled={!!automation}
                onChange={(e) => setA({ ...a, entity: e.target.value })}
              >
                {entities.map((e) => (
                  <option key={e.key} value={e.key}>
                    {label(e.label)}
                  </option>
                ))}
              </Form.Select>
            </Field>
          </Col>
          <Col md={4}>
            <Field label={t('studio.key')} controlId="au-key" hint={t('studio.keyHint')}>
              <Form.Control
                dir="ltr"
                className="font-monospace"
                value={a.key}
                disabled={!!automation}
                onChange={(e) => setA({ ...a, key: e.target.value.toLowerCase() })}
              />
            </Field>
          </Col>
          <Col md={4}>
            <Field label={t('studio.label')} controlId="au-label">
              <LocalizedInput
                id="au-label"
                value={a.label}
                onChange={(l) => setA({ ...a, label: l })}
              />
            </Field>
          </Col>
        </Row>

        <h3 className="h6 mt-2">{t('automation.when')}</h3>
        <Row className="g-2 mb-3">
          <Col md={4}>
            <Form.Select
              value={trig.type}
              onChange={(e) => {
                const type = e.target.value as AutomationTrigger['type'];
                const next: AutomationTrigger =
                  type === 'field_changed'
                    ? { type, field: entity?.fields[0]?.key ?? '' }
                    : type === 'status_changed'
                      ? { type }
                      : type === 'schedule'
                        ? { type, every: 'day', at: '09:00' }
                        : { type };
                setA({ ...a, trigger: next });
              }}
            >
              {TRIGGERS.map((k) => (
                <option key={k} value={k}>
                  {t(`automation.trigger.${k}`)}
                </option>
              ))}
            </Form.Select>
          </Col>
          <Col md={8}>
            {trig.type === 'field_changed' && (
              <Form.Select
                value={trig.field}
                onChange={(e) => setA({ ...a, trigger: { ...trig, field: e.target.value } })}
              >
                {entity?.fields.map((f) => (
                  <option key={f.key} value={f.key}>
                    {label(f.label)}
                  </option>
                ))}
              </Form.Select>
            )}
            {trig.type === 'status_changed' && (
              <Form.Select
                value={trig.to ?? ''}
                onChange={(e) =>
                  setA({
                    ...a,
                    trigger: { type: 'status_changed', to: e.target.value || undefined },
                  })
                }
              >
                <option value="">{t('automation.anyState')}</option>
                {wf?.states.map((s) => (
                  <option key={s.key} value={s.key}>
                    {label(s.label)}
                  </option>
                ))}
              </Form.Select>
            )}
            {trig.type === 'schedule' && (
              <InputGroup>
                <Form.Select
                  value={trig.every}
                  onChange={(e) =>
                    setA({
                      ...a,
                      trigger: { ...trig, every: e.target.value as 'day' | 'hour' | '15min' },
                    })
                  }
                >
                  <option value="day">{t('automation.everyDay')}</option>
                  <option value="hour">{t('automation.everyHour')}</option>
                  <option value="15min">{t('automation.every15')}</option>
                </Form.Select>
                {trig.every === 'day' && (
                  <Form.Control
                    type="time"
                    value={trig.at ?? ''}
                    onChange={(e) => setA({ ...a, trigger: { ...trig, at: e.target.value } })}
                  />
                )}
              </InputGroup>
            )}
          </Col>
          <Col md={12}>
            <Form.Label className="small">{t('automation.onlyIf')}</Form.Label>
            <ConditionInput
              id="au-cond"
              value={a.condition}
              entity={entity}
              onChange={(condition) => setA({ ...a, condition })}
            />
          </Col>
        </Row>

        <h3 className="h6">{t('automation.then')}</h3>
        {a.actions.map((act, i) => (
          <Card key={i} className="mb-2 border">
            <Card.Body className="p-2">
              <div className="d-flex align-items-center gap-2 mb-2">
                <Badge bg="primary-subtle" text="primary-emphasis">
                  {i + 1}
                </Badge>
                <Form.Select
                  size="sm"
                  style={{ maxWidth: 260 }}
                  value={act.type}
                  onChange={(e) =>
                    setAction(i, blankAction(e.target.value as AutomationAction['type'], a.entity))
                  }
                >
                  {ACTIONS.map((k) => (
                    <option key={k} value={k}>
                      {t(`automation.action.${k}`)}
                    </option>
                  ))}
                </Form.Select>
                <Button
                  size="sm"
                  variant="link"
                  className="ms-auto text-danger"
                  onClick={() => setA({ ...a, actions: a.actions.filter((_, n) => n !== i) })}
                >
                  {t('common.delete')}
                </Button>
              </div>
              {act.type === 'notify' && (
                <Row className="g-2">
                  <Col md={4}>
                    <Form.Label className="small">{t('automation.template')}</Form.Label>
                    <Form.Select
                      size="sm"
                      value={act.template}
                      onChange={(e) => setAction(i, { ...act, template: e.target.value })}
                    >
                      {templates.map((k) => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                    </Form.Select>
                  </Col>
                  <Col md={8}>
                    <Form.Label className="small">{t('automation.channels')}</Form.Label>
                    <ChecklistInput<Channel>
                      id={`au-ch-${i}`}
                      options={[...CHANNELS]}
                      value={act.channels}
                      labelOf={(c) => t(`automation.channel.${c}`)}
                      onChange={(channels) => setAction(i, { ...act, channels })}
                    />
                  </Col>
                  <Col md={12}>
                    <Form.Label className="small">{t('automation.recipients')}</Form.Label>
                    <PeopleEditor
                      value={act.recipients}
                      entity={entity}
                      kinds={[...RECIPIENTS]}
                      onChange={(r) =>
                        setAction(i, { ...act, recipients: r as typeof act.recipients })
                      }
                    />
                  </Col>
                </Row>
              )}
              {act.type === 'update' && (
                <AssignmentsEditor
                  value={act.set}
                  target={entity}
                  source={entity}
                  onChange={(set) => setAction(i, { ...act, set })}
                />
              )}
              {act.type === 'create' && (
                <>
                  <Row className="g-2 mb-2">
                    <Col md={6}>
                      <Form.Select
                        size="sm"
                        value={act.entity}
                        onChange={(e) => setAction(i, { ...act, entity: e.target.value, set: [] })}
                      >
                        {entities.map((e) => (
                          <option key={e.key} value={e.key}>
                            {label(e.label)}
                          </option>
                        ))}
                      </Form.Select>
                    </Col>
                    <Col md={6}>
                      <Form.Select
                        size="sm"
                        value={act.orgUnit ?? 'same'}
                        onChange={(e) =>
                          setAction(i, { ...act, orgUnit: e.target.value as 'same' | 'none' })
                        }
                      >
                        <option value="same">{t('automation.sameUnit')}</option>
                        <option value="none">{t('automation.noUnit')}</option>
                      </Form.Select>
                    </Col>
                  </Row>
                  <AssignmentsEditor
                    value={act.set}
                    target={entities.find((e) => e.key === act.entity)}
                    source={entity}
                    onChange={(set) => setAction(i, { ...act, set })}
                  />
                </>
              )}
              {act.type === 'webhook' && (
                <>
                  <Form.Control
                    size="sm"
                    dir="ltr"
                    className="font-monospace"
                    value={act.url}
                    onChange={(e) => setAction(i, { ...act, url: e.target.value })}
                  />
                  <Form.Text muted>{t('automation.webhookHelp')}</Form.Text>
                </>
              )}
              {act.type === 'document' && (
                <Row className="g-2">
                  <Col md={6}>
                    <Form.Label className="small">{t('automation.printTemplate')}</Form.Label>
                    <Form.Select
                      size="sm"
                      value={act.template ?? ''}
                      onChange={(e) =>
                        setAction(i, { ...act, template: e.target.value || undefined })
                      }
                    >
                      <option value="">{t('automation.firstTemplate')}</option>
                      {(cfg.data?.printTemplates ?? [])
                        .filter((p) => p.entity === a.entity)
                        .map((p) => (
                          <option key={p.key} value={p.key}>
                            {label(p.label)}
                          </option>
                        ))}
                    </Form.Select>
                  </Col>
                  <Col md={6}>
                    <Form.Label className="small">{t('automation.attachTo')}</Form.Label>
                    <Form.Select
                      size="sm"
                      value={act.attachField ?? ''}
                      onChange={(e) =>
                        setAction(i, { ...act, attachField: e.target.value || undefined })
                      }
                    >
                      <option value="">{t('common.none')}</option>
                      {entity?.fields
                        .filter((f) => f.type === 'file')
                        .map((f) => (
                          <option key={f.key} value={f.key}>
                            {label(f.label)}
                          </option>
                        ))}
                    </Form.Select>
                  </Col>
                  <Col md={6}>
                    <Form.Label className="small">{t('automation.emailFields')}</Form.Label>
                    <ChecklistInput<string>
                      id={`au-ef-${i}`}
                      options={(entity?.fields ?? [])
                        .filter((f) => f.type === 'email')
                        .map((f) => f.key)}
                      value={act.emailFields ?? []}
                      labelOf={(k) => label(entity?.fields.find((f) => f.key === k)?.label)}
                      onChange={(emailFields) =>
                        setAction(i, {
                          ...act,
                          emailFields: emailFields.length ? emailFields : undefined,
                        })
                      }
                    />
                  </Col>
                  <Col md={6}>
                    <Form.Label className="small">{t('automation.emailTo')}</Form.Label>
                    <Form.Control
                      size="sm"
                      dir="ltr"
                      placeholder="accounts@example.com"
                      value={(act.emailTo ?? []).join(', ')}
                      onChange={(e) => {
                        const list = e.target.value.split(/[\s,;]+/).filter(Boolean);
                        setAction(i, { ...act, emailTo: list.length ? list : undefined });
                      }}
                    />
                  </Col>
                  <Col md={12}>
                    <Form.Text muted>{t('automation.documentHelp')}</Form.Text>
                  </Col>
                </Row>
              )}
              {act.type === 'workflow_action' && (
                <Form.Select
                  size="sm"
                  value={act.action}
                  onChange={(e) => setAction(i, { ...act, action: e.target.value })}
                >
                  <option value="">{t('records.choose')}</option>
                  {wf?.actions.map((x) => (
                    <option key={x.key} value={x.key}>
                      {label(x.label)}
                    </option>
                  ))}
                </Form.Select>
              )}
            </Card.Body>
          </Card>
        ))}
        <Button
          size="sm"
          variant="outline-primary"
          onClick={() => setA({ ...a, actions: [...a.actions, blankAction('notify', a.entity)] })}
        >
          <i className="bi bi-plus-lg me-1" />
          {t('automation.addAction')}
        </Button>
        <Form.Check
          id="au-active"
          type="switch"
          className="mt-3"
          label={t('workflow.active')}
          checked={a.active !== false}
          onChange={(e) => setA({ ...a, active: e.target.checked ? undefined : false })}
        />
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button
          disabled={!ok || putItem.isPending}
          onClick={() =>
            void putItem
              .mutateAsync({ kind: 'automations', key: a.key, body: a, scope })
              .then(onClose)
          }
        >
          {t('common.save')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

interface RunDto {
  id: string;
  automation: string;
  entity: string;
  recordId: string;
  trigger: string;
  status: 'running' | 'ok' | 'failed' | 'skipped';
  steps: { type: string; ok: boolean; info?: string }[];
  error: string | null;
  attempts: number;
  createdAt: string;
}

const RUN_VARIANT: Record<RunDto['status'], string> = {
  ok: 'success',
  failed: 'danger',
  skipped: 'secondary',
  running: 'info',
};

/** Recent runs: what each automation did, failures first-class, and a button to run again. */
function RunsCard() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const runs = useQuery({
    queryKey: ['automation-runs', status],
    queryFn: () =>
      api<{ items: RunDto[] }>('/workflow/automation-runs', {
        query: { status: status || undefined, pageSize: 50 },
      }),
  });
  const secret = useQuery({
    queryKey: ['webhook-secret'],
    queryFn: () => api<{ secret: string }>('/workflow/webhook-secret'),
  });
  const [show, setShow] = useState(false);
  const retry = useMutation({
    mutationFn: (id: string) => api(`/workflow/automation-runs/${id}/retry`, { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['automation-runs'] }),
  });
  return (
    <Card className="shadow-sm border-0 mt-3">
      <Card.Body>
        <div className="d-flex align-items-center gap-2 mb-2">
          <h2 className="h6 mb-0">{t('automation.runs')}</h2>
          <Form.Select
            size="sm"
            style={{ maxWidth: 180 }}
            className="ms-auto"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">{t('automation.allRuns')}</option>
            {(['failed', 'ok', 'skipped'] as const).map((s) => (
              <option key={s} value={s}>
                {t(`automation.status.${s}`)}
              </option>
            ))}
          </Form.Select>
        </div>
        <ErrorAlert error={retry.error} />
        {runs.isLoading ? (
          <Loading />
        ) : !runs.data?.items.length ? (
          <p className="text-body-secondary small mb-0">{t('automation.noRuns')}</p>
        ) : (
          <Table size="sm" className="align-middle small mb-0">
            <tbody>
              {runs.data.items.map((r) => (
                <tr key={r.id}>
                  <td className="text-nowrap">{formatDateTime(r.createdAt, i18n.language)}</td>
                  <td className="font-monospace" dir="ltr">
                    {r.automation}
                  </td>
                  <td>
                    <a href={`/r/${r.entity}/${r.recordId}`}>{r.entity}</a>
                  </td>
                  <td>
                    <Badge bg={RUN_VARIANT[r.status]}>{t(`automation.status.${r.status}`)}</Badge>
                  </td>
                  <td className="text-truncate" style={{ maxWidth: 320 }} title={r.error ?? ''}>
                    {r.error ??
                      r.steps
                        .map((s) => s.info)
                        .filter(Boolean)
                        .join(' · ')}
                  </td>
                  <td className="text-end">
                    {r.status === 'failed' && (
                      <Button
                        size="sm"
                        variant="outline-primary"
                        disabled={retry.isPending}
                        onClick={() => retry.mutate(r.id)}
                      >
                        {t('automation.retry')}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <div className="mt-3 small">
          <span className="text-body-secondary me-2">{t('automation.webhookSecret')}</span>
          {secret.data && (
            <>
              <code dir="ltr">{show ? secret.data.secret : '••••••••••••'}</code>
              <Button size="sm" variant="link" onClick={() => setShow(!show)}>
                {show ? t('automation.hide') : t('automation.show')}
              </Button>
            </>
          )}
        </div>
      </Card.Body>
    </Card>
  );
}

export function AutomationsTab() {
  const { t } = useTranslation();
  const label = useLabel();
  const { can } = useAuth();
  const { layer, scope } = useStudio();
  const { deleteItem } = useConfigActions();
  const cfg = useEffectiveConfig(undefined, 'draft');
  const entities = customEntities(cfg.data);
  const [editing, setEditing] = useState<AutomationDef | 'new' | null>(null);
  return (
    <>
      <Card className="shadow-sm border-0">
        <Card.Body>
          <p className="small text-body-secondary">{t('automation.intro')}</p>
          <ErrorAlert error={deleteItem.error} />
          {can('config.manage') && (
            <Button
              size="sm"
              className="mb-3"
              disabled={!entities.length}
              onClick={() => setEditing('new')}
            >
              <i className="bi bi-plus-lg me-1" />
              {t('automation.new')}
            </Button>
          )}
          {layer.automations.length === 0 ? (
            <p className="text-body-secondary mb-0">{t('studio.empty')}</p>
          ) : (
            <Table hover size="sm" className="align-middle mb-0">
              <tbody>
                {layer.automations.map((a) => (
                  <tr key={a.key} className={a.active === false ? 'text-body-secondary' : ''}>
                    <td className="fw-medium">{label(a.label)}</td>
                    <td>{label(entities.find((e) => e.key === a.entity)?.label) || a.entity}</td>
                    <td className="small">{t(`automation.trigger.${a.trigger.type}`)}</td>
                    <td className="small">
                      {a.actions.map((x, i) => (
                        <Badge
                          key={i}
                          bg="secondary-subtle"
                          text="secondary-emphasis"
                          className="me-1"
                        >
                          {t(`automation.action.${x.type}`)}
                        </Badge>
                      ))}
                    </td>
                    <td className="text-end text-nowrap">
                      <Button
                        size="sm"
                        variant="outline-primary"
                        className="me-1"
                        onClick={() => setEditing(a)}
                      >
                        <i className="bi bi-pencil" />
                      </Button>
                      {can('config.manage') && (
                        <Button
                          size="sm"
                          variant="outline-danger"
                          onClick={() =>
                            window.confirm(t('common.confirm')) &&
                            deleteItem.mutate({ kind: 'automations', key: a.key, scope })
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
          <AutomationDialog
            automation={editing === 'new' ? undefined : editing}
            onClose={() => setEditing(null)}
          />
        )}
      </Card>
      {can('workflow.automation.manage') && <RunsCard />}
    </>
  );
}
