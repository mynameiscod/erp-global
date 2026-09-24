import { useState } from 'react';
import { Button, Card, Col, Form, Modal, Row, Table } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import { KEY_RE, type PicklistDef, type PicklistOption } from '@erp/metadata';
import { useAuth } from '../auth/AuthContext';
import { useConfigActions, useLabel } from '../config/hooks';
import { LocalizedInput } from '../config/LocalizedInput';
import { ErrorAlert, Field } from '../components/ui';
import { useStudio } from './StudioContext';

function PicklistDialog({ list, onClose }: { list?: PicklistDef; onClose: () => void }) {
  const { t } = useTranslation();
  const { scope } = useStudio();
  const { putItem } = useConfigActions();
  const [p, setP] = useState<PicklistDef>(
    list ?? { key: '', label: {}, options: [{ value: '', label: {} }] },
  );
  const setOption = (i: number, patch: Partial<PicklistOption>) =>
    setP((prev) => ({
      ...prev,
      options: prev.options.map((o, j) => (j === i ? { ...o, ...patch } : o)),
    }));
  const valid =
    KEY_RE.test(p.key) &&
    p.options.length > 0 &&
    p.options.every((o) => o.value.trim() && Object.values(o.label).some(Boolean));

  const save = async () => {
    await putItem.mutateAsync({ kind: 'picklists', key: p.key, body: p, scope });
    onClose();
  };

  return (
    <Modal show onHide={onClose} centered size="xl" scrollable>
      <Modal.Header closeButton>
        <Modal.Title className="h5">{list ? list.key : t('studio.newPicklist')}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <ErrorAlert error={putItem.error} />
        <Row>
          <Col md={6}>
            <Field label={t('studio.label')} controlId="pl-label">
              <LocalizedInput
                id="pl-label"
                value={p.label}
                onChange={(v) => setP({ ...p, label: v })}
              />
            </Field>
          </Col>
          <Col md={6}>
            <Field label={t('studio.key')} controlId="pl-key" hint={t('studio.keyHint')}>
              <Form.Control
                value={p.key}
                disabled={!!list}
                onChange={(e) => setP({ ...p, key: e.target.value.toLowerCase() })}
                className="font-monospace"
                dir="ltr"
              />
            </Field>
          </Col>
        </Row>
        <h3 className="h6">{t('studio.options')}</h3>
        <Table size="sm" className="align-middle">
          <thead>
            <tr>
              <th style={{ width: 160 }}>{t('studio.value')}</th>
              <th>{t('studio.label')}</th>
              <th style={{ width: 70 }}>{t('studio.color')}</th>
              <th style={{ width: 70 }}>{t('studio.active')}</th>
              <th style={{ width: 50 }} />
            </tr>
          </thead>
          <tbody>
            {p.options.map((o, i) => (
              <tr key={i}>
                <td>
                  <Form.Control
                    size="sm"
                    value={o.value}
                    onChange={(e) => setOption(i, { value: e.target.value })}
                    className="font-monospace"
                    dir="ltr"
                  />
                </td>
                <td>
                  <LocalizedInput
                    id={`pl-o-${i}`}
                    value={o.label}
                    onChange={(v) => setOption(i, { label: v })}
                  />
                </td>
                <td>
                  <Form.Control
                    type="color"
                    size="sm"
                    value={o.color ?? '#6c757d'}
                    onChange={(e) => setOption(i, { color: e.target.value })}
                  />
                </td>
                <td>
                  <Form.Check
                    type="switch"
                    id={`pl-a-${i}`}
                    checked={o.active !== false}
                    onChange={(e) => setOption(i, { active: e.target.checked ? undefined : false })}
                  />
                </td>
                <td>
                  <Button
                    size="sm"
                    variant="outline-danger"
                    disabled={p.options.length === 1}
                    onClick={() => setP({ ...p, options: p.options.filter((_, j) => j !== i) })}
                  >
                    <i className="bi bi-x" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
        <Button
          size="sm"
          variant="outline-primary"
          onClick={() => setP({ ...p, options: [...p.options, { value: '', label: {} }] })}
        >
          <i className="bi bi-plus me-1" />
          {t('studio.addOption')}
        </Button>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button disabled={!valid || putItem.isPending} onClick={() => void save()}>
          {t('common.save')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

export function PicklistsTab() {
  const { t } = useTranslation();
  const label = useLabel();
  const { can } = useAuth();
  const { layer, scope } = useStudio();
  const { deleteItem } = useConfigActions();
  const [editing, setEditing] = useState<PicklistDef | 'new' | null>(null);
  return (
    <Card className="shadow-sm border-0">
      <Card.Body>
        <ErrorAlert error={deleteItem.error} />
        {can('config.manage') && (
          <Button size="sm" className="mb-3" onClick={() => setEditing('new')}>
            <i className="bi bi-plus-lg me-1" />
            {t('studio.newPicklist')}
          </Button>
        )}
        {layer.picklists.length === 0 ? (
          <p className="text-body-secondary mb-0">{t('studio.empty')}</p>
        ) : (
          <Table hover size="sm" className="align-middle mb-0">
            <tbody>
              {layer.picklists.map((p) => (
                <tr key={p.key}>
                  <td className="fw-medium">{label(p.label)}</td>
                  <td>
                    <code>{p.key}</code>
                  </td>
                  <td className="small text-body-secondary">
                    {p.options.map((o) => label(o.label)).join(', ')}
                  </td>
                  <td className="text-end text-nowrap">
                    <Button
                      size="sm"
                      variant="outline-primary"
                      className="me-1"
                      onClick={() => setEditing(p)}
                    >
                      <i className="bi bi-pencil" />
                    </Button>
                    {can('config.manage') && (
                      <Button
                        size="sm"
                        variant="outline-danger"
                        onClick={() =>
                          window.confirm(t('common.confirm')) &&
                          deleteItem.mutate({ kind: 'picklists', key: p.key, scope })
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
        <PicklistDialog
          list={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}
