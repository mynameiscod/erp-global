import { useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Form,
  ListGroup,
  Modal,
  Row,
  Spinner,
} from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { LocalizedText, PackPreview } from '@erp/metadata';
import { api } from '../api/client';
import { ErrorAlert, Loading, PageHeader } from '../components/ui';
import { useLabel } from '../config/hooks';
import { formatDateTime } from '../lib/format';

/** A catalog pack as pack-service returns it (GET /packs). */
export interface PackDto {
  id: string;
  type: 'country' | 'industry';
  version: string;
  name: LocalizedText;
  description: LocalizedText;
  uses: string[];
  suggested: boolean;
  draft: string | null;
  published: string | null;
  upgrade: boolean;
  contents: {
    entities: { key: string; label: LocalizedText }[];
    reports: number;
    dashboards: number;
    printTemplates: number;
    workflows: number;
    automations: number;
    patches: number;
    roles: { key: string; name: LocalizedText }[];
    samples: number;
  };
  samples: { added: boolean; count: number; version: string | null };
  history: {
    action: 'installed' | 'upgraded' | 'removed' | 'samples_added' | 'samples_removed';
    version: string;
    fromVersion?: string;
    by: string;
    at: string;
  }[];
}

type Notice = { kind: 'installed' | 'removed'; name: string };

const PUBLISH_PATH = '/studio/versions';

export function PacksPage() {
  const { t } = useTranslation();
  const label = useLabel();
  const qc = useQueryClient();
  const [previewing, setPreviewing] = useState<PackDto | null>(null);
  const [removing, setRemoving] = useState<PackDto | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const packs = useQuery({ queryKey: ['packs'], queryFn: () => api<PackDto[]>('/packs') });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['packs'] });
    // Installing or removing changes the Studio draft.
    void qc.invalidateQueries({ queryKey: ['config', 'draft'] });
  };

  const list = packs.data ?? [];
  const countryInstalled = list.some((p) => p.type === 'country' && !!p.draft);
  const groups: { type: PackDto['type']; title: string; help: string }[] = [
    { type: 'country', title: t('packs.countryPacks'), help: t('packs.countryHelp') },
    { type: 'industry', title: t('packs.industryPacks'), help: t('packs.industryHelp') },
  ];

  return (
    <>
      <PageHeader title={t('packs.title')} subtitle={t('packs.subtitle')} />
      <ErrorAlert error={packs.error} />
      {notice && (
        <Alert variant="success" dismissible onClose={() => setNotice(null)}>
          <i className="bi bi-check-circle me-2" />
          {t(notice.kind === 'installed' ? 'packs.installedNotice' : 'packs.removedNotice', {
            name: notice.name,
          })}{' '}
          <Link to={PUBLISH_PATH}>{t('packs.goPublish')}</Link>
        </Alert>
      )}
      {packs.isLoading && <Loading />}
      {groups.map((g) => {
        const items = list.filter((p) => p.type === g.type);
        if (!packs.data) return null;
        return (
          <section key={g.type} className="mb-4">
            <h2 className="h5 mb-1">{g.title}</h2>
            <p className="small text-body-secondary">{g.help}</p>
            {items.length === 0 ? (
              <p className="text-body-secondary">{t('packs.none')}</p>
            ) : (
              <Row className="g-3">
                {items.map((p) => (
                  <Col key={p.id} md={6} xl={4}>
                    <PackCard
                      pack={p}
                      needsCountry={
                        p.type === 'industry' &&
                        !!p.draft &&
                        p.uses.includes('tax') &&
                        !countryInstalled
                      }
                      onPreview={() => setPreviewing(p)}
                      onRemove={() => setRemoving(p)}
                      onChanged={refresh}
                    />
                  </Col>
                ))}
              </Row>
            )}
          </section>
        );
      })}
      {previewing && (
        <PreviewDialog
          pack={previewing}
          onClose={() => setPreviewing(null)}
          onDone={() => {
            setNotice({ kind: 'installed', name: label(previewing.name) || previewing.id });
            setPreviewing(null);
            refresh();
          }}
        />
      )}
      {removing && (
        <RemoveDialog
          pack={removing}
          onClose={() => setRemoving(null)}
          onDone={() => {
            setNotice({ kind: 'removed', name: label(removing.name) || removing.id });
            setRemoving(null);
            refresh();
          }}
        />
      )}
    </>
  );
}

function PackStatus({ pack }: { pack: PackDto }) {
  const { t } = useTranslation();
  const { draft, published } = pack;
  const badges: { bg: string; text: string }[] = [];
  if (!draft && !published) badges.push({ bg: 'secondary', text: t('packs.status.notInstalled') });
  else if (!draft && published)
    badges.push({ bg: 'warning', text: t('packs.status.removedInDraft', { version: published }) });
  else if (draft && draft === published)
    badges.push({ bg: 'success', text: t('packs.status.live', { version: published }) });
  else {
    if (published)
      badges.push({ bg: 'success', text: t('packs.status.live', { version: published }) });
    badges.push({ bg: 'info', text: t('packs.status.inDraft', { version: draft }) });
  }
  if (pack.upgrade)
    badges.push({ bg: 'primary', text: t('packs.status.upgrade', { version: pack.version }) });
  return (
    <div className="d-flex flex-wrap gap-1">
      {badges.map((b) => (
        <Badge
          key={b.text}
          bg={b.bg}
          className={b.bg === 'warning' || b.bg === 'info' ? 'text-dark' : ''}
        >
          {b.text}
        </Badge>
      ))}
    </div>
  );
}

function PackCard({
  pack,
  needsCountry,
  onPreview,
  onRemove,
  onChanged,
}: {
  pack: PackDto;
  needsCountry: boolean;
  onPreview: () => void;
  onRemove: () => void;
  onChanged: () => void;
}) {
  const { t, i18n } = useTranslation();
  const label = useLabel();
  const [error, setError] = useState<unknown>(null);
  const c = pack.contents;
  const live = !!pack.published && pack.draft === pack.published;

  const samples = useMutation({
    mutationFn: (add: boolean) =>
      api(`/packs/${encodeURIComponent(pack.id)}/samples`, { method: add ? 'POST' : 'DELETE' }),
    onSuccess: () => {
      setError(null);
      onChanged();
    },
    onError: setError,
  });

  const counts = [
    ['entities', c.entities.length],
    ['reports', c.reports],
    ['dashboards', c.dashboards],
    ['printTemplates', c.printTemplates],
    ['workflows', c.workflows],
    ['automations', c.automations],
    ['roles', c.roles.length],
    ['samples', c.samples],
  ] as const;

  const installLabel = pack.draft
    ? t('packs.upgrade', { version: pack.version })
    : t('packs.previewInstall');

  return (
    <Card className="shadow-sm border-0 h-100">
      <Card.Body className="d-flex flex-column gap-2">
        <div className="d-flex align-items-start justify-content-between gap-2">
          <div>
            <Card.Title className="h6 mb-1">{label(pack.name) || pack.id}</Card.Title>
            <div className="small text-body-secondary">
              {t('packs.version', { version: pack.version })}
            </div>
          </div>
          {pack.suggested && (
            <Badge bg="warning" className="text-dark">
              <i className="bi bi-star-fill me-1" />
              {t('packs.suggested')}
            </Badge>
          )}
        </div>
        <PackStatus pack={pack} />
        <p className="small mb-0">{label(pack.description)}</p>
        <ErrorAlert error={error} onClose={() => setError(null)} />
        {needsCountry && (
          <Alert variant="info" className="small py-2 mb-0">
            <i className="bi bi-info-circle me-1" />
            {t('packs.usesTax')}
          </Alert>
        )}
        {!pack.draft && pack.published && (
          <Alert variant="warning" className="small py-2 mb-0">
            {t('packs.removedPending')} <Link to={PUBLISH_PATH}>{t('packs.goPublish')}</Link>
          </Alert>
        )}
        {pack.draft && pack.draft !== pack.published && (
          <Alert variant="info" className="small py-2 mb-0">
            {t('packs.draftPending')} <Link to={PUBLISH_PATH}>{t('packs.goPublish')}</Link>
          </Alert>
        )}

        <div className="small">
          <div className="fw-semibold mb-1">{t('packs.contains')}</div>
          <div className="d-flex flex-wrap gap-1 mb-1">
            {counts
              .filter(([, n]) => n > 0)
              .map(([k, n]) => (
                <Badge key={k} bg="light" text="dark" className="border">
                  {t(`packs.counts.${k}`, { count: n })}
                </Badge>
              ))}
            {c.patches > 0 && (
              <Badge bg="light" text="dark" className="border">
                {t('packs.counts.patches', { count: c.patches })}
              </Badge>
            )}
          </div>
          {c.entities.length > 0 && (
            <div className="text-body-secondary">
              <span className="fw-semibold">{t('packs.entities')}: </span>
              {c.entities.map((e) => label(e.label) || e.key).join(', ')}
            </div>
          )}
          {c.roles.length > 0 && (
            <div className="text-body-secondary">
              <span className="fw-semibold">{t('packs.roles')}: </span>
              {c.roles.map((r) => label(r.name) || r.key).join(', ')}
            </div>
          )}
        </div>

        {live && c.samples > 0 && (
          <div className="small text-body-secondary">
            {pack.samples.added
              ? t('packs.samplesAdded', { count: pack.samples.count })
              : t('packs.samplesAvailable')}
          </div>
        )}

        <div className="d-flex flex-wrap gap-2 mt-auto pt-2">
          {(!pack.draft || pack.upgrade) && (
            <Button size="sm" onClick={onPreview}>
              <i className={`bi ${pack.upgrade ? 'bi-arrow-up-circle' : 'bi-download'} me-1`} />
              {installLabel}
            </Button>
          )}
          {pack.draft && (
            <Button size="sm" variant="outline-danger" onClick={onRemove}>
              <i className="bi bi-trash me-1" />
              {t('packs.remove')}
            </Button>
          )}
          {live && c.samples > 0 && !pack.samples.added && (
            <Button
              size="sm"
              variant="outline-secondary"
              disabled={samples.isPending}
              onClick={() => window.confirm(t('packs.addSamplesConfirm')) && samples.mutate(true)}
            >
              {samples.isPending && <Spinner size="sm" className="me-1" />}
              <i className="bi bi-database-add me-1" />
              {t('packs.addSamples')}
            </Button>
          )}
          {pack.samples.added && (
            <Button
              size="sm"
              variant="outline-secondary"
              disabled={samples.isPending}
              onClick={() =>
                window.confirm(t('packs.removeSamplesConfirm')) && samples.mutate(false)
              }
            >
              {samples.isPending && <Spinner size="sm" className="me-1" />}
              <i className="bi bi-database-dash me-1" />
              {t('packs.removeSamples')}
            </Button>
          )}
        </div>

        {pack.history.length > 0 && (
          <details className="small">
            <summary className="text-body-secondary">{t('packs.history')}</summary>
            <ul className="list-unstyled mb-0 mt-1">
              {pack.history.slice(0, 5).map((h, i) => (
                <li key={i} className="d-flex justify-content-between gap-2">
                  <span>
                    {t(`packs.actions.${h.action}`, {
                      version: h.version,
                      from: h.fromVersion ?? '',
                    })}
                  </span>
                  <span className="text-body-secondary text-nowrap">
                    {formatDateTime(h.at, i18n.language)}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card.Body>
    </Card>
  );
}

function ChangeList({
  title,
  items,
  variant,
}: {
  title: string;
  items: string[];
  variant: string;
}) {
  const { t } = useTranslation();
  if (!items.length) return null;
  const shown = items.slice(0, 50);
  return (
    <div className="mb-3">
      <div className="fw-semibold small mb-1">
        <Badge bg={variant} className="me-1">
          {items.length}
        </Badge>
        {title}
      </div>
      <ListGroup
        variant="flush"
        className="small border rounded"
        style={{ maxHeight: 180, overflowY: 'auto' }}
      >
        {shown.map((s, i) => (
          <ListGroup.Item key={i} className="py-1">
            {s}
          </ListGroup.Item>
        ))}
        {items.length > shown.length && (
          <ListGroup.Item className="py-1 text-body-secondary">
            {t('packs.andMore', { count: items.length - shown.length })}
          </ListGroup.Item>
        )}
      </ListGroup>
    </div>
  );
}

function PreviewDialog({
  pack,
  onClose,
  onDone,
}: {
  pack: PackDto;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const label = useLabel();
  const [choices, setChoices] = useState<Record<string, 'mine' | 'pack'>>({});
  const preview = useQuery({
    queryKey: ['packs', pack.id, 'preview', pack.version],
    queryFn: () =>
      api<PackPreview>(`/packs/${encodeURIComponent(pack.id)}/preview`, { method: 'POST' }),
    gcTime: 0,
  });
  const install = useMutation({
    mutationFn: () => {
      const conflicts = preview.data?.conflicts ?? [];
      // Keep mine is the default for every conflict.
      const resolutions = Object.fromEntries(
        conflicts.map((c) => [c.path, choices[c.path] ?? 'mine']),
      );
      return api<{ changes: unknown[] }>(`/packs/${encodeURIComponent(pack.id)}`, {
        method: 'PUT',
        body: conflicts.length ? { resolutions } : {},
      });
    },
    onSuccess: onDone,
  });
  const p = preview.data;
  const nothing = p && !p.added.length && !p.changed.length && !p.removed.length;

  return (
    <Modal show onHide={onClose} size="lg" scrollable>
      <Modal.Header closeButton>
        <Modal.Title className="h5">
          {t(
            p?.action === 'upgrade'
              ? 'packs.preview.upgradeTitle'
              : p?.action === 'reinstall'
                ? 'packs.preview.reinstallTitle'
                : 'packs.preview.installTitle',
            { name: label(pack.name) || pack.id, from: p?.from ?? '', to: p?.to ?? pack.version },
          )}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <ErrorAlert error={preview.error ?? install.error} />
        {preview.isLoading && <Loading />}
        {p && (
          <>
            <p className="small text-body-secondary">{t('packs.preview.help')}</p>
            {nothing && <p className="text-body-secondary">{t('packs.preview.nothing')}</p>}
            <ChangeList title={t('packs.preview.added')} items={p.added} variant="success" />
            <ChangeList title={t('packs.preview.changed')} items={p.changed} variant="info" />
            <ChangeList title={t('packs.preview.removed')} items={p.removed} variant="warning" />
            {p.removed.length > 0 && (
              <p className="small text-body-secondary">{t('packs.preview.removedHelp')}</p>
            )}
            {p.conflicts.length > 0 && (
              <div className="mb-2">
                <h3 className="h6">
                  <i className="bi bi-exclamation-triangle text-warning me-1" />
                  {t('packs.preview.conflicts', { count: p.conflicts.length })}
                </h3>
                <p className="small text-body-secondary">{t('packs.preview.conflictsHelp')}</p>
                <ListGroup className="small">
                  {p.conflicts.map((c) => {
                    const value = choices[c.path] ?? 'mine';
                    return (
                      <ListGroup.Item
                        key={c.path}
                        className="d-flex flex-wrap align-items-center justify-content-between gap-2"
                      >
                        <div>
                          <div className="fw-semibold">{c.label}</div>
                          <code className="small text-body-secondary">{c.path}</code>
                        </div>
                        <div className="d-flex gap-3">
                          <Form.Check
                            type="radio"
                            id={`${c.path}-mine`}
                            name={c.path}
                            label={t('packs.preview.keepMine')}
                            checked={value === 'mine'}
                            onChange={() => setChoices({ ...choices, [c.path]: 'mine' })}
                          />
                          <Form.Check
                            type="radio"
                            id={`${c.path}-pack`}
                            name={c.path}
                            label={t('packs.preview.takePack')}
                            checked={value === 'pack'}
                            onChange={() => setChoices({ ...choices, [c.path]: 'pack' })}
                          />
                        </div>
                      </ListGroup.Item>
                    );
                  })}
                </ListGroup>
              </div>
            )}
            <Alert variant="light" className="small border mb-0">
              <i className="bi bi-info-circle me-1" />
              {t('packs.preview.draftNote')}
            </Alert>
          </>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button disabled={!p || install.isPending} onClick={() => install.mutate()}>
          {install.isPending && <Spinner size="sm" className="me-1" />}
          {p?.action === 'upgrade' ? t('packs.preview.upgrade') : t('packs.preview.install')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

function RemoveDialog({
  pack,
  onClose,
  onDone,
}: {
  pack: PackDto;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const label = useLabel();
  const remove = useMutation({
    mutationFn: () => api(`/packs/${encodeURIComponent(pack.id)}`, { method: 'DELETE' }),
    onSuccess: onDone,
  });
  return (
    <Modal show onHide={onClose} centered>
      <Modal.Header closeButton>
        <Modal.Title className="h5">
          {t('packs.removeTitle', { name: label(pack.name) || pack.id })}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <ErrorAlert error={remove.error} />
        <p>{t('packs.removeHelp')}</p>
        <ul className="small text-body-secondary mb-0">
          <li>{t('packs.removeKeepsData')}</li>
          <li>{t('packs.removeArchived')}</li>
          <li>{t('packs.removePublish')}</li>
        </ul>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
          {remove.isPending && <Spinner size="sm" className="me-1" />}
          {t('packs.remove')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
