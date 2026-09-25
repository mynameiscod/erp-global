import { useState } from 'react';
import { Badge, Button, Card, Col, Form, InputGroup, Modal, Row, Table } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import { UI_LANGUAGES } from '@erp/contracts';
import { BUILTIN_TEMPLATES, type MessageTemplate } from '@erp/metadata';
import { useAuth } from '../auth/AuthContext';
import { useConfigActions, useLabel } from '../config/hooks';
import { LocalizedInput } from '../config/LocalizedInput';
import { ErrorAlert, Field } from '../components/ui';
import { useStudio } from './StudioContext';

const TEMPLATE_KEY = /^[a-z][a-z0-9_.]{1,59}$/;

function TemplateDialog({
  template,
  onClose,
}: {
  template?: MessageTemplate;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { scope } = useStudio();
  const { putItem } = useConfigActions();
  const [m, setM] = useState<MessageTemplate>(
    template ?? { key: '', label: {}, title: {}, body: {} },
  );
  const ok =
    TEMPLATE_KEY.test(m.key) &&
    Object.values(m.label).some(Boolean) &&
    Object.values(m.title).some(Boolean) &&
    Object.values(m.body).some((v) => v.trim());
  return (
    <Modal show onHide={onClose} centered size="lg" scrollable>
      <Modal.Header closeButton>
        <Modal.Title className="h5">{template ? template.key : t('templates.new')}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <ErrorAlert error={putItem.error} />
        <p className="small text-body-secondary">{t('templates.placeholders')}</p>
        <Row>
          <Col md={6}>
            <Field label={t('studio.key')} controlId="t-key" hint={t('templates.keyHint')}>
              <Form.Control
                dir="ltr"
                className="font-monospace"
                value={m.key}
                disabled={!!template}
                onChange={(e) => setM({ ...m, key: e.target.value.toLowerCase() })}
              />
            </Field>
          </Col>
          <Col md={6}>
            <Field label={t('studio.label')} controlId="t-label">
              <LocalizedInput
                id="t-label"
                value={m.label}
                onChange={(label) => setM({ ...m, label })}
              />
            </Field>
          </Col>
          <Col md={12}>
            <Field label={t('templates.title')} controlId="t-title">
              <LocalizedInput
                id="t-title"
                value={m.title}
                onChange={(title) => setM({ ...m, title })}
              />
            </Field>
          </Col>
          <Col md={12}>
            <Form.Label>{t('templates.body')}</Form.Label>
            {UI_LANGUAGES.map((l) => (
              <InputGroup key={l.code} className="mb-1" size="sm">
                <InputGroup.Text style={{ minWidth: 48 }} className="justify-content-center">
                  {l.code.toUpperCase()}
                </InputGroup.Text>
                <Form.Control
                  as="textarea"
                  rows={2}
                  dir={l.dir}
                  lang={l.code}
                  value={m.body[l.code] ?? ''}
                  onChange={(e) => {
                    const body = { ...m.body };
                    if (e.target.value) body[l.code] = e.target.value;
                    else delete body[l.code];
                    setM({ ...m, body });
                  }}
                />
              </InputGroup>
            ))}
          </Col>
          <Col md={12} className="mt-3">
            <Form.Check
              id="t-wa"
              type="switch"
              label={t('templates.whatsapp')}
              checked={!!m.whatsapp}
              onChange={(e) =>
                setM({
                  ...m,
                  whatsapp: e.target.checked
                    ? { template: '', params: ['record.title'] }
                    : undefined,
                })
              }
            />
            <Form.Text muted className="d-block mb-2">
              {t('templates.whatsappHelp')}
            </Form.Text>
            {m.whatsapp && (
              <Row>
                <Col md={6}>
                  <Field label={t('templates.whatsappName')} controlId="t-wa-name">
                    <Form.Control
                      dir="ltr"
                      className="font-monospace"
                      value={m.whatsapp.template}
                      onChange={(e) =>
                        setM({
                          ...m,
                          whatsapp: { ...m.whatsapp!, template: e.target.value.toLowerCase() },
                        })
                      }
                    />
                  </Field>
                </Col>
                <Col md={6}>
                  <Field
                    label={t('templates.whatsappParams')}
                    controlId="t-wa-params"
                    hint="record.title, record.amount, link"
                  >
                    <Form.Control
                      dir="ltr"
                      className="font-monospace"
                      value={m.whatsapp.params.join(', ')}
                      onChange={(e) =>
                        setM({
                          ...m,
                          whatsapp: {
                            ...m.whatsapp!,
                            params: e.target.value.split(/\s*,\s*/).filter(Boolean),
                          },
                        })
                      }
                    />
                  </Field>
                </Col>
              </Row>
            )}
          </Col>
        </Row>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button
          disabled={
            !ok || (!!m.whatsapp && !/^[a-z0-9_]+$/.test(m.whatsapp.template)) || putItem.isPending
          }
          onClick={() =>
            void putItem
              .mutateAsync({ kind: 'templates', key: m.key, body: m, scope })
              .then(onClose)
          }
        >
          {t('common.save')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

export function TemplatesTab() {
  const { t } = useTranslation();
  const label = useLabel();
  const { can } = useAuth();
  const { layer, scope } = useStudio();
  const { deleteItem } = useConfigActions();
  const [editing, setEditing] = useState<MessageTemplate | 'new' | null>(null);
  const own = new Set(layer.templates.map((m) => m.key));
  const rows = [...layer.templates, ...BUILTIN_TEMPLATES.filter((b) => !own.has(b.key))];
  return (
    <Card className="shadow-sm border-0">
      <Card.Body>
        <p className="small text-body-secondary">{t('templates.intro')}</p>
        <ErrorAlert error={deleteItem.error} />
        {can('config.manage') && (
          <Button size="sm" className="mb-3" onClick={() => setEditing('new')}>
            <i className="bi bi-plus-lg me-1" />
            {t('templates.new')}
          </Button>
        )}
        <Table hover size="sm" className="align-middle mb-0">
          <tbody>
            {rows.map((m) => {
              const builtin = !own.has(m.key);
              return (
                <tr key={m.key}>
                  <td className="font-monospace small" dir="ltr">
                    {m.key}
                  </td>
                  <td>
                    {label(m.label)}{' '}
                    {builtin && (
                      <Badge bg="light" text="dark">
                        {t('templates.builtin')}
                      </Badge>
                    )}
                    {m.whatsapp && (
                      <i className="bi bi-whatsapp text-success ms-1" title="WhatsApp" />
                    )}
                  </td>
                  <td className="small text-body-secondary text-truncate" style={{ maxWidth: 320 }}>
                    {label(m.title)}
                  </td>
                  <td className="text-end text-nowrap">
                    {can('config.manage') && (
                      <Button
                        size="sm"
                        variant="outline-primary"
                        className="me-1"
                        title={builtin ? t('templates.customize') : undefined}
                        onClick={() => setEditing(m)}
                      >
                        <i className={`bi ${builtin ? 'bi-pencil-square' : 'bi-pencil'}`} />
                      </Button>
                    )}
                    {!builtin && can('config.manage') && (
                      <Button
                        size="sm"
                        variant="outline-danger"
                        onClick={() =>
                          window.confirm(t('common.confirm')) &&
                          deleteItem.mutate({ kind: 'templates', key: m.key, scope })
                        }
                      >
                        <i className="bi bi-trash" />
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card.Body>
      {editing && (
        <TemplateDialog
          // Customizing a built-in starts from its text and keeps its key.
          template={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}
