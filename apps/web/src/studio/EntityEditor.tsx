import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, ButtonGroup, Card, Col, Form, Nav, Row, Table } from 'react-bootstrap';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  findEntity,
  SYSTEM_ENTITY_KEYS,
  type EntityPatch,
  type FieldDef,
  type LocalizedText,
} from '@erp/metadata';
import { useAuth } from '../auth/AuthContext';
import { useConfigActions, useEffectiveConfig, useLabel } from '../config/hooks';
import { LocalizedInput } from '../config/LocalizedInput';
import { ErrorAlert, Field } from '../components/ui';
import { FieldDialog } from './FieldDialog';
import { FormDesigner } from './FormDesigner';
import { ListDesigner } from './ListDesigner';
import { useStudio } from './StudioContext';

export function EntityEditor() {
  const { key = '' } = useParams();
  const { t } = useTranslation();
  const label = useLabel();
  const { can } = useAuth();
  const { scope, layer, company } = useStudio();
  const { putItem } = useConfigActions();
  const [tab, setTab] = useState<'fields' | 'form' | 'list'>('fields');
  const [editing, setEditing] = useState<FieldDef | 'new' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const editable = can('config.manage');

  const isSystem = (SYSTEM_ENTITY_KEYS as readonly string[]).includes(key);
  const own: EntityPatch = layer.entities.find((e) => e.key === key) ?? { key, fields: [] };
  const base = scope === 'company' ? undefined : company.entities.find((e) => e.key === key);
  const published = useEffectiveConfig(scope === 'company' ? undefined : scope);
  const publishedFields = useMemo(() => {
    const e = published.data ? findEntity(published.data, key) : undefined;
    return new Set(e?.fields.map((f) => f.key));
  }, [published.data, key]);

  // Entity properties (company scope, custom entities only).
  const [props, setProps] = useState({
    label: own.label ?? {},
    pluralLabel: own.pluralLabel ?? {},
    titleField: own.titleField ?? '',
    orgScoped: own.orgScoped !== false,
  });
  useEffect(() => {
    setProps({
      label: own.label ?? {},
      pluralLabel: own.pluralLabel ?? {},
      titleField: own.titleField ?? '',
      orgScoped: own.orgScoped !== false,
    });
  }, [key, scope, layer]);

  const save = async (patch: EntityPatch) => {
    setError(null);
    try {
      await putItem.mutateAsync({ kind: 'entities', key, body: patch, scope });
      return true;
    } catch (e) {
      setError(e);
      return false;
    }
  };

  const saveField = async (f: FieldDef, originalKey?: string) => {
    const fields = own.fields.filter((x) => x.key !== (originalKey ?? f.key));
    const at = own.fields.findIndex((x) => x.key === (originalKey ?? f.key));
    fields.splice(at >= 0 ? at : fields.length, 0, f);
    return save({ ...own, fields });
  };

  const setArchived = (f: FieldDef, archived: boolean) =>
    void saveField({ ...f, archived: archived || undefined });
  const removeField = (f: FieldDef) =>
    void save({ ...own, fields: own.fields.filter((x) => x.key !== f.key) });

  const allFields = [
    ...(base?.fields ?? []).filter((f) => !own.fields.some((o) => o.key === f.key)),
    ...own.fields,
  ];
  const title = label(own.label ?? base?.label) || key;

  return (
    <>
      <div className="d-flex align-items-center gap-2 mb-3">
        <Link to="/studio/entities" className="btn btn-sm btn-outline-secondary">
          <i className="bi bi-arrow-left flip-rtl" />
        </Link>
        <h2 className="h5 mb-0">{title}</h2>
        <code className="small">{key}</code>
        {isSystem && <Badge bg="secondary">{t('studio.builtIn')}</Badge>}
      </div>
      {isSystem && <p className="small text-body-secondary">{t('studio.systemEntityHint')}</p>}
      <ErrorAlert error={error} onClose={() => setError(null)} />

      {scope === 'company' && !isSystem && (
        <Card className="shadow-sm border-0 mb-3">
          <Card.Body>
            <fieldset disabled={!editable}>
              <Row>
                <Col md={6}>
                  <Field label={t('studio.singular')} controlId="e-label">
                    <LocalizedInput
                      id="e-label"
                      value={props.label}
                      onChange={(v: LocalizedText) => setProps({ ...props, label: v })}
                    />
                  </Field>
                </Col>
                <Col md={6}>
                  <Field label={t('studio.plural')} controlId="e-plural">
                    <LocalizedInput
                      id="e-plural"
                      value={props.pluralLabel}
                      onChange={(v: LocalizedText) => setProps({ ...props, pluralLabel: v })}
                    />
                  </Field>
                </Col>
                <Col md={6}>
                  <Field label={t('studio.titleField')} controlId="e-title">
                    <Form.Select
                      value={props.titleField}
                      onChange={(e) => setProps({ ...props, titleField: e.target.value })}
                    >
                      <option value="" />
                      {own.fields
                        .filter(
                          (f) =>
                            ['text', 'email', 'phone', 'autonumber'].includes(f.type) &&
                            !f.archived,
                        )
                        .map((f) => (
                          <option key={f.key} value={f.key}>
                            {label(f.label)}
                          </option>
                        ))}
                    </Form.Select>
                  </Field>
                </Col>
                <Col md={6} className="d-flex align-items-center">
                  <Form.Check
                    type="switch"
                    id="e-org"
                    label={t('studio.orgScoped')}
                    checked={props.orgScoped}
                    onChange={(e) => setProps({ ...props, orgScoped: e.target.checked })}
                  />
                </Col>
              </Row>
              <div className="d-flex gap-2">
                <Button
                  size="sm"
                  onClick={() =>
                    void save({
                      ...own,
                      kind: 'custom',
                      ...props,
                      titleField: props.titleField || undefined,
                    })
                  }
                >
                  {t('common.save')}
                </Button>
                <Button
                  size="sm"
                  variant="outline-secondary"
                  onClick={() => void save({ ...own, archived: !own.archived || undefined })}
                >
                  {own.archived ? t('studio.restore') : t('studio.archive')}
                </Button>
              </div>
            </fieldset>
          </Card.Body>
        </Card>
      )}

      <Nav
        variant="pills"
        className="mb-3"
        activeKey={tab}
        onSelect={(k) => setTab((k as typeof tab) ?? 'fields')}
      >
        <Nav.Item>
          <Nav.Link eventKey="fields">{t('studio.fields')}</Nav.Link>
        </Nav.Item>
        {scope === 'company' && !isSystem && (
          <>
            <Nav.Item>
              <Nav.Link eventKey="form">{t('studio.form')}</Nav.Link>
            </Nav.Item>
            <Nav.Item>
              <Nav.Link eventKey="list">{t('studio.list')}</Nav.Link>
            </Nav.Item>
          </>
        )}
      </Nav>

      {tab === 'fields' && (
        <Card className="shadow-sm border-0">
          <Card.Body>
            {editable && (
              <Button size="sm" className="mb-3" onClick={() => setEditing('new')}>
                <i className="bi bi-plus-lg me-1" />
                {t('studio.addField')}
              </Button>
            )}
            <Table responsive hover size="sm" className="align-middle mb-0">
              <thead>
                <tr>
                  <th>{t('studio.label')}</th>
                  <th>{t('studio.fieldKey')}</th>
                  <th>{t('studio.fieldType')}</th>
                  <th />
                  <th className="text-end">{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {allFields.map((f) => {
                  const inherited = !own.fields.some((o) => o.key === f.key);
                  return (
                    <tr key={f.key} className={f.archived ? 'text-body-tertiary' : ''}>
                      <td>{label(f.label)}</td>
                      <td>
                        <code>{f.key}</code>
                      </td>
                      <td>{t(`fieldTypes.${f.type}`)}</td>
                      <td className="d-flex gap-1 flex-wrap">
                        {f.required && (
                          <Badge bg="danger-subtle" text="danger-emphasis">
                            {t('studio.required')}
                          </Badge>
                        )}
                        {f.unique && (
                          <Badge bg="info-subtle" text="info-emphasis">
                            {t('studio.unique')}
                          </Badge>
                        )}
                        {f.archived && <Badge bg="secondary">{t('studio.archived')}</Badge>}
                        {inherited && (
                          <Badge bg="light" text="dark" className="border">
                            {t('studio.company')}
                          </Badge>
                        )}
                      </td>
                      <td className="text-end">
                        {editable && !inherited && (
                          <ButtonGroup size="sm">
                            <Button
                              variant="outline-primary"
                              onClick={() => setEditing(f)}
                              title={t('common.edit')}
                            >
                              <i className="bi bi-pencil" />
                            </Button>
                            <Button
                              variant="outline-secondary"
                              onClick={() => setArchived(f, !f.archived)}
                              title={f.archived ? t('studio.restore') : t('studio.archive')}
                            >
                              <i
                                className={`bi ${f.archived ? 'bi-arrow-counterclockwise' : 'bi-archive'}`}
                              />
                            </Button>
                            {!publishedFields.has(f.key) && (
                              <Button
                                variant="outline-danger"
                                onClick={() =>
                                  window.confirm(t('common.confirm')) && removeField(f)
                                }
                                title={t('common.delete')}
                              >
                                <i className="bi bi-trash" />
                              </Button>
                            )}
                          </ButtonGroup>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </Card.Body>
        </Card>
      )}
      {tab === 'form' && <FormDesigner entityKey={key} fields={own.fields} />}
      {tab === 'list' && <ListDesigner entityKey={key} fields={own.fields} />}

      {editing && (
        <FieldDialog
          entityKey={key}
          isSystem={isSystem}
          field={editing === 'new' ? undefined : editing}
          published={editing !== 'new' && publishedFields.has(editing.key)}
          existingKeys={allFields.map((f) => f.key)}
          onClose={() => setEditing(null)}
          onSave={async (f, originalKey) => {
            if (await saveField(f, originalKey)) setEditing(null);
          }}
        />
      )}
    </>
  );
}
