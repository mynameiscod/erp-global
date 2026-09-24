import { useState } from 'react';
import { Badge, Button, Card, Col, Form, Modal, Row } from 'react-bootstrap';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { KEY_RE, SYSTEM_ENTITY_KEYS, type EntityPatch, type LocalizedText } from '@erp/metadata';
import { useAuth } from '../auth/AuthContext';
import { useConfigActions, useLabel } from '../config/hooks';
import { LocalizedInput } from '../config/LocalizedInput';
import { ErrorAlert, Field } from '../components/ui';
import { useStudio } from './StudioContext';

const ICONS = [
  'box',
  'mortarboard',
  'person-badge',
  'truck',
  'house-door',
  'heart-pulse',
  'cart',
  'briefcase',
  'building',
  'journal-text',
  'calendar-event',
  'tools',
];

function NewEntityDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { putItem } = useConfigActions();
  const [key, setKey] = useState('');
  const [label, setLabel] = useState<LocalizedText>({});
  const [plural, setPlural] = useState<LocalizedText>({});
  const [icon, setIcon] = useState('box');
  const [orgScoped, setOrgScoped] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const keyOk = KEY_RE.test(key) && !(SYSTEM_ENTITY_KEYS as readonly string[]).includes(key);

  const create = async () => {
    setError(null);
    try {
      const entity: EntityPatch = {
        key,
        kind: 'custom',
        label,
        pluralLabel: Object.keys(plural).length ? plural : label,
        icon,
        orgScoped,
        fields: [
          {
            key: 'name',
            type: 'text',
            label: { en: 'Name', hi: 'नाम', ar: 'الاسم' },
            required: true,
            searchable: true,
          },
        ],
        titleField: 'name',
      };
      await putItem.mutateAsync({ kind: 'entities', key, body: entity });
      onClose();
      navigate(`/studio/entities/${key}`);
    } catch (e) {
      setError(e);
    }
  };

  return (
    <Modal show onHide={onClose} centered>
      <Modal.Header closeButton>
        <Modal.Title className="h5">{t('studio.newEntity')}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <ErrorAlert error={error} />
        <Field label={t('studio.singular')} controlId="ent-label">
          <LocalizedInput
            id="ent-label"
            value={label}
            onChange={(v) => {
              setLabel(v);
              if (!key && v.en)
                setKey(
                  v.en
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '_')
                    .replace(/^_+|_+$/g, '')
                    .slice(0, 40),
                );
            }}
          />
        </Field>
        <Field label={t('studio.plural')} controlId="ent-plural">
          <LocalizedInput id="ent-plural" value={plural} onChange={setPlural} />
        </Field>
        <Field
          label={t('studio.key')}
          controlId="ent-key"
          hint={t('studio.keyHint')}
          error={key && !keyOk ? t('studio.keyHint') : undefined}
        >
          <Form.Control
            value={key}
            onChange={(e) => setKey(e.target.value.toLowerCase())}
            className="font-monospace"
            dir="ltr"
          />
        </Field>
        <Field label={t('studio.icon')} controlId="ent-icon">
          <div className="d-flex flex-wrap gap-1">
            {ICONS.map((i) => (
              <Button
                key={i}
                size="sm"
                variant={icon === i ? 'primary' : 'outline-secondary'}
                onClick={() => setIcon(i)}
                aria-label={i}
              >
                <i className={`bi bi-${i}`} />
              </Button>
            ))}
          </div>
        </Field>
        <Form.Check
          type="switch"
          id="ent-org"
          label={t('studio.orgScoped')}
          checked={orgScoped}
          onChange={(e) => setOrgScoped(e.target.checked)}
        />
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button
          disabled={!keyOk || !Object.values(label).some(Boolean) || putItem.isPending}
          onClick={() => void create()}
        >
          {t('common.create')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

export function EntitiesTab() {
  const { t } = useTranslation();
  const label = useLabel();
  const { can } = useAuth();
  const { scope, layer, company } = useStudio();
  const [creating, setCreating] = useState(false);

  // In an override, the entities to extend are those the company defines.
  const custom = (scope === 'company' ? layer : company).entities.filter(
    (e) => e.kind === 'custom' || !e.kind,
  );
  const addedHere = new Map(layer.entities.map((e) => [e.key, e.fields.length]));
  const systemLabels: Record<string, LocalizedText> = {
    user: { en: 'User', hi: 'उपयोगकर्ता', ar: 'مستخدم' },
    org_unit: { en: 'Organization unit', hi: 'संगठन इकाई', ar: 'وحدة تنظيمية' },
  };

  const card = (key: string, title: string, sub: string, icon: string, badges: React.ReactNode) => (
    <Col md={6} xl={4} key={key}>
      <Card
        as={Link}
        to={`/studio/entities/${key}`}
        className="h-100 shadow-sm border-0 text-decoration-none"
      >
        <Card.Body className="d-flex gap-3 align-items-start">
          <div className="stat-icon rounded-3 bg-primary-subtle text-primary d-flex align-items-center justify-content-center flex-shrink-0">
            <i className={`bi bi-${icon} fs-4`} />
          </div>
          <div className="min-w-0">
            <div className="fw-semibold">{title}</div>
            <div className="small text-body-secondary font-monospace">{sub}</div>
            <div className="mt-1 d-flex gap-1 flex-wrap">{badges}</div>
          </div>
        </Card.Body>
      </Card>
    </Col>
  );

  return (
    <>
      {scope === 'company' && can('config.manage') && (
        <div className="mb-3">
          <Button onClick={() => setCreating(true)}>
            <i className="bi bi-plus-lg me-1" />
            {t('studio.newEntity')}
          </Button>
        </div>
      )}
      <Row className="g-3">
        {custom.map((e) =>
          card(
            e.key,
            label(e.pluralLabel ?? e.label) || e.key,
            e.key,
            e.icon ?? 'box',
            <>
              <Badge bg="light" text="dark" className="border">
                {t('studio.fields')}: {e.fields.filter((f) => !f.archived).length}
              </Badge>
              {e.archived && <Badge bg="secondary">{t('studio.archived')}</Badge>}
              {scope !== 'company' && addedHere.get(e.key) ? (
                <Badge bg="warning">+{addedHere.get(e.key)}</Badge>
              ) : null}
            </>,
          ),
        )}
        {SYSTEM_ENTITY_KEYS.map((k) =>
          card(
            k,
            label(systemLabels[k]),
            k,
            k === 'user' ? 'person' : 'diagram-3',
            <>
              <Badge bg="secondary">{t('studio.builtIn')}</Badge>
              {addedHere.get(k) ? (
                <Badge bg="light" text="dark" className="border">
                  +{addedHere.get(k)}
                </Badge>
              ) : null}
            </>,
          ),
        )}
      </Row>
      {!custom.length && <p className="text-body-secondary mt-3">{t('studio.empty')}</p>}
      {creating && <NewEntityDialog onClose={() => setCreating(false)} />}
    </>
  );
}
