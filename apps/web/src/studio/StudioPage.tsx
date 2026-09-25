import { useState } from 'react';
import { Alert, Badge, Button, Card, Form, ListGroup, Modal, Nav } from 'react-bootstrap';
import { useQuery } from '@tanstack/react-query';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api/client';
import type { OrgUnitDto } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { useConfigActions, useDraft, type ConfigIssue } from '../config/hooks';
import { ErrorAlert, Loading, PageHeader } from '../components/ui';
import { AutomationsTab } from './AutomationsTab';
import { EntitiesTab } from './EntitiesTab';
import { EntityEditor } from './EntityEditor';
import { NumberingTab } from './NumberingTab';
import { PicklistsTab } from './PicklistsTab';
import { RulesTab } from './RulesTab';
import { SettingsTab } from './SettingsTab';
import { TemplatesTab } from './TemplatesTab';
import { WorkflowsTab } from './WorkflowsTab';
import { layerFor, StudioContext } from './StudioContext';
import { VersionsTab } from './VersionsTab';

const SCOPE_KEY = 'erp.studio.scope';

function PublishDialog({ changes, onClose }: { changes: string[]; onClose: () => void }) {
  const { t } = useTranslation();
  const { publish } = useConfigActions();
  const [note, setNote] = useState('');
  const [issues, setIssues] = useState<ConfigIssue[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<number | null>(null);

  const submit = async () => {
    setError(null);
    setIssues(null);
    try {
      const res = await publish.mutateAsync(note || undefined);
      setDone(res.version);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFIG_INVALID')
        setIssues(e.details as ConfigIssue[]);
      else setError(e);
    }
  };

  return (
    <Modal show onHide={onClose} centered size="lg" scrollable>
      <Modal.Header closeButton>
        <Modal.Title className="h5">{t('studio.publish')}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {done !== null ? (
          <Alert variant="success" className="mb-0">
            <i className="bi bi-check-circle me-2" />
            {t('studio.publishedOk', { version: done })}
          </Alert>
        ) : (
          <>
            <ErrorAlert error={error} />
            {issues && (
              <Alert variant="danger">
                <div className="fw-semibold mb-1">{t('studio.issues')}</div>
                <ul className="mb-0 small">
                  {issues.map((i, n) => (
                    <li key={n}>
                      <code>{i.path}</code> — {i.message}
                    </li>
                  ))}
                </ul>
              </Alert>
            )}
            <ListGroup variant="flush" className="mb-3 small">
              {changes.map((c) => (
                <ListGroup.Item key={c}>{c}</ListGroup.Item>
              ))}
            </ListGroup>
            <Form.Control
              as="textarea"
              rows={2}
              placeholder={t('studio.publishNote')}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          {t('common.close')}
        </Button>
        {done === null && (
          <Button onClick={() => void submit()} disabled={publish.isPending || !changes.length}>
            <i className="bi bi-rocket-takeoff me-1" />
            {t('studio.publish')}
          </Button>
        )}
      </Modal.Footer>
    </Modal>
  );
}

export function StudioPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const draft = useDraft();
  const { discard, removeOverride } = useConfigActions();
  const units = useQuery({
    queryKey: ['org-units', false],
    queryFn: () => api<OrgUnitDto[]>('/org/units'),
  });
  const [publishing, setPublishing] = useState(false);
  const [scope, setScopeState] = useState(() => {
    try {
      return sessionStorage.getItem(SCOPE_KEY) ?? 'company';
    } catch {
      return 'company';
    }
  });
  const setScope = (s: string) => {
    setScopeState(s);
    try {
      sessionStorage.setItem(SCOPE_KEY, s);
    } catch {
      /* ignore */
    }
  };

  if (draft.isLoading) return <Loading />;
  if (!draft.data) return <ErrorAlert error={draft.error} />;
  const d = draft.data;
  const scopeUnit = units.data?.find((u) => u.id === scope);
  const tabs: [string, string, string][] = [
    ['entities', 'studio.entities', 'boxes'],
    ['picklists', 'studio.picklists', 'list-ul'],
    ['numbering', 'studio.numbering', '123'],
    ['workflows', 'studio.workflows', 'diagram-2'],
    ['rules', 'studio.rules', 'shield-check'],
    ['automations', 'studio.automations', 'lightning-charge'],
    ['templates', 'studio.templates', 'chat-square-text'],
    ['versions', 'studio.versions', 'clock-history'],
    ['settings', 'studio.settings', 'sliders'],
  ];

  return (
    <StudioContext.Provider
      value={{ scope, draft: d, layer: layerFor(d, scope), company: d.config.company }}
    >
      <PageHeader title={t('studio.title')} subtitle={t('studio.subtitle')} />

      <Card className="shadow-sm border-0 mb-3">
        <Card.Body className="d-flex flex-wrap align-items-center gap-3">
          <Badge bg="success-subtle" text="success-emphasis" className="fs-6">
            {t('studio.live', { version: d.publishedVersion })}
          </Badge>
          <span
            className={
              d.changes.length ? 'text-warning-emphasis fw-semibold' : 'text-body-secondary'
            }
          >
            {d.changes.length
              ? t('studio.changes', { count: d.changes.length })
              : t('studio.noChanges')}
          </span>
          <div className="d-flex align-items-center gap-2 ms-lg-4">
            <Form.Label htmlFor="studio-scope" className="mb-0 small text-body-secondary">
              {t('studio.scope')}
            </Form.Label>
            <Form.Select
              id="studio-scope"
              size="sm"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              style={{ minWidth: 220 }}
            >
              <option value="company">{t('studio.company')}</option>
              {units.data
                ?.filter((u) => u.depth > 0 && can('config.manage', u.path))
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {'— '.repeat(u.depth)}
                    {u.name}
                    {d.config.orgUnits[u.id] ? ' •' : ''}
                  </option>
                ))}
            </Form.Select>
          </div>
          <div className="ms-auto d-flex gap-2">
            {scope !== 'company' && d.config.orgUnits[scope] && (
              <Button
                size="sm"
                variant="outline-danger"
                onClick={() => window.confirm(t('common.confirm')) && removeOverride.mutate(scope)}
              >
                {t('studio.removeOverride')}
              </Button>
            )}
            {d.changes.length > 0 && can('config.manage') && (
              <Button
                size="sm"
                variant="outline-secondary"
                onClick={() => window.confirm(t('studio.discardConfirm')) && discard.mutate()}
              >
                {t('studio.discard')}
              </Button>
            )}
            {can('config.publish') && (
              <Button size="sm" disabled={!d.changes.length} onClick={() => setPublishing(true)}>
                <i className="bi bi-rocket-takeoff me-1" />
                {t('studio.publish')}
              </Button>
            )}
          </div>
        </Card.Body>
        {scope !== 'company' && scopeUnit && (
          <Card.Footer className="small bg-warning-subtle">
            <i className="bi bi-diagram-3 me-1" />
            {t('studio.overrideFor', { name: scopeUnit.name })}
          </Card.Footer>
        )}
      </Card>
      <ErrorAlert error={discard.error ?? removeOverride.error} />

      <Nav variant="tabs" className="mb-3">
        {tabs.map(([path, key, icon]) => (
          <Nav.Item key={path}>
            <Nav.Link as={NavLink} to={`/studio/${path}`}>
              <i className={`bi bi-${icon} me-1`} />
              {t(key)}
            </Nav.Link>
          </Nav.Item>
        ))}
      </Nav>

      <Routes>
        <Route index element={<Navigate to="entities" replace />} />
        <Route path="entities" element={<EntitiesTab />} />
        <Route path="entities/:key" element={<EntityEditor />} />
        <Route path="picklists" element={<PicklistsTab />} />
        <Route path="numbering" element={<NumberingTab />} />
        <Route path="workflows" element={<WorkflowsTab />} />
        <Route path="rules" element={<RulesTab />} />
        <Route path="automations" element={<AutomationsTab />} />
        <Route path="templates" element={<TemplatesTab />} />
        <Route path="versions" element={<VersionsTab />} />
        <Route path="settings" element={<SettingsTab />} />
      </Routes>

      {publishing && <PublishDialog changes={d.changes} onClose={() => setPublishing(false)} />}
    </StudioContext.Provider>
  );
}
