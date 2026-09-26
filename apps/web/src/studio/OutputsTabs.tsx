import { useState } from 'react';
import { Badge, Button, Card, Form, Modal, Table } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import { KEY_RE, type DashboardDef, type ReportDef } from '@erp/metadata';
import { useAuth } from '../auth/AuthContext';
import { useConfigActions, useEffectiveConfig, useLabel } from '../config/hooks';
import { ErrorAlert, Field, Loading } from '../components/ui';
import { DashboardBuilder, layout } from '../outputs/Dashboards';
import { clean, ReportBuilder, usePathOptions } from '../outputs/ReportBuilder';
import { useStudio } from './StudioContext';

function ReportDialog({ report, onClose }: { report?: ReportDef; onClose: () => void }) {
  const { t } = useTranslation();
  const { scope } = useStudio();
  const { putItem } = useConfigActions();
  // Built on the draft, so new entities and fields can be used before publishing.
  const cfg = useEffectiveConfig(undefined, 'draft');
  const [d, setD] = useState<Partial<ReportDef>>(
    report ?? { key: '', label: {}, columns: [], filters: [] },
  );
  const options = usePathOptions(cfg.data, d.entity);
  const ok = KEY_RE.test(d.key ?? '') && !!d.entity && Object.values(d.label ?? {}).some(Boolean);
  return (
    <Modal show onHide={onClose} size="xl" scrollable>
      <Modal.Header closeButton>
        <Modal.Title className="h5">{report ? report.key : t('reports.new')}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <ErrorAlert error={putItem.error} />
        <Field label={t('studio.key')} controlId="sr-key">
          <Form.Control
            dir="ltr"
            className="font-monospace"
            style={{ maxWidth: 320 }}
            value={d.key ?? ''}
            disabled={!!report}
            onChange={(e) => setD({ ...d, key: e.target.value.toLowerCase() })}
          />
        </Field>
        {cfg.data ? (
          <ReportBuilder
            value={d}
            onChange={setD}
            cfg={cfg.data}
            company
            format={{ locale: cfg.data.tenant.locale, timezone: cfg.data.tenant.timezone ?? 'UTC' }}
          />
        ) : (
          <Loading />
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button
          disabled={!ok || putItem.isPending}
          onClick={() =>
            void putItem
              .mutateAsync({ kind: 'reports', key: d.key!, body: clean(d, options), scope })
              .then(onClose)
          }
        >
          {t('common.save')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

export function ReportsTab() {
  const { t } = useTranslation();
  const label = useLabel();
  const { can } = useAuth();
  const { layer, scope } = useStudio();
  const { deleteItem } = useConfigActions();
  const [editing, setEditing] = useState<ReportDef | 'new' | null>(null);
  return (
    <Card className="shadow-sm border-0">
      <Card.Body>
        <p className="small text-body-secondary">{t('reports.studioIntro')}</p>
        <ErrorAlert error={deleteItem.error} />
        {can('config.manage') && (
          <Button size="sm" className="mb-3" onClick={() => setEditing('new')}>
            <i className="bi bi-plus-lg me-1" />
            {t('reports.new')}
          </Button>
        )}
        {!layer.reports.length && <p className="text-body-secondary">{t('reports.none')}</p>}
        <Table hover size="sm" className="align-middle mb-0">
          <tbody>
            {layer.reports.map((r) => (
              <tr key={r.key}>
                <td className="font-monospace small" dir="ltr">
                  {r.key}
                </td>
                <td>
                  {label(r.label)}{' '}
                  <Badge bg="light" text="dark">
                    {t(`reports.mode.${r.pivot ? 'pivot' : r.groupBy?.length ? 'groups' : 'rows'}`)}
                  </Badge>
                  {r.chart && <i className="bi bi-bar-chart ms-1 text-primary" />}
                </td>
                <td className="small text-body-secondary">
                  {r.entity}
                  {r.roleIds?.length
                    ? ` · ${t('reports.rolesCount', { count: r.roleIds.length })}`
                    : ''}
                </td>
                <td className="text-end text-nowrap">
                  {can('config.manage') && (
                    <>
                      <Button
                        size="sm"
                        variant="outline-primary"
                        className="me-1"
                        onClick={() => setEditing(r)}
                      >
                        <i className="bi bi-pencil" />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline-danger"
                        onClick={() =>
                          window.confirm(t('common.confirm')) &&
                          deleteItem.mutate({ kind: 'reports', key: r.key, scope })
                        }
                      >
                        <i className="bi bi-trash" />
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card.Body>
      {editing && (
        <ReportDialog
          report={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}

function DashboardDialog({
  dashboard,
  onClose,
}: {
  dashboard?: DashboardDef;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const label = useLabel();
  const { scope, layer, company } = useStudio();
  const { putItem } = useConfigActions();
  const [d, setD] = useState<Partial<DashboardDef>>(
    dashboard ?? { key: '', label: {}, widgets: [] },
  );
  const reports = [...(scope === 'company' ? [] : company.reports), ...layer.reports];
  const ok = KEY_RE.test(d.key ?? '') && Object.values(d.label ?? {}).some(Boolean);
  return (
    <Modal show onHide={onClose} size="xl" scrollable>
      <Modal.Header closeButton>
        <Modal.Title className="h5">{dashboard ? dashboard.key : t('dashboards.new')}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <ErrorAlert error={putItem.error} />
        <Field label={t('studio.key')} controlId="sd-key">
          <Form.Control
            dir="ltr"
            className="font-monospace"
            style={{ maxWidth: 320 }}
            value={d.key ?? ''}
            disabled={!!dashboard}
            onChange={(e) => setD({ ...d, key: e.target.value.toLowerCase() })}
          />
        </Field>
        <DashboardBuilder
          value={d}
          onChange={setD}
          company
          reportOptions={[
            ...new Map(reports.map((r) => [r.key, { ref: r.key, label: label(r.label) }])).values(),
          ]}
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
              .mutateAsync({
                kind: 'dashboards',
                key: d.key!,
                body: {
                  ...d,
                  widgets: layout(d.widgets ?? []),
                  roleIds: d.roleIds?.length ? d.roleIds : undefined,
                },
                scope,
              })
              .then(onClose)
          }
        >
          {t('common.save')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

export function DashboardsTab() {
  const { t } = useTranslation();
  const label = useLabel();
  const { can } = useAuth();
  const { layer, scope } = useStudio();
  const { deleteItem } = useConfigActions();
  const [editing, setEditing] = useState<DashboardDef | 'new' | null>(null);
  return (
    <Card className="shadow-sm border-0">
      <Card.Body>
        <p className="small text-body-secondary">{t('dashboards.studioIntro')}</p>
        <ErrorAlert error={deleteItem.error} />
        {can('config.manage') && (
          <Button size="sm" className="mb-3" onClick={() => setEditing('new')}>
            <i className="bi bi-plus-lg me-1" />
            {t('dashboards.new')}
          </Button>
        )}
        {!layer.dashboards.length && <p className="text-body-secondary">{t('dashboards.none')}</p>}
        <Table hover size="sm" className="align-middle mb-0">
          <tbody>
            {layer.dashboards.map((d) => (
              <tr key={d.key}>
                <td className="font-monospace small" dir="ltr">
                  {d.key}
                </td>
                <td>
                  {label(d.label)}{' '}
                  {d.home && (
                    <Badge bg="success-subtle" text="success-emphasis">
                      {t('dashboards.home')}
                    </Badge>
                  )}
                </td>
                <td className="small text-body-secondary">
                  {t('dashboards.widgetCount', { count: d.widgets.length })}
                  {d.roleIds?.length
                    ? ` · ${t('reports.rolesCount', { count: d.roleIds.length })}`
                    : ''}
                </td>
                <td className="text-end text-nowrap">
                  {can('config.manage') && (
                    <>
                      <Button
                        size="sm"
                        variant="outline-primary"
                        className="me-1"
                        onClick={() => setEditing(d)}
                      >
                        <i className="bi bi-pencil" />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline-danger"
                        onClick={() =>
                          window.confirm(t('common.confirm')) &&
                          deleteItem.mutate({ kind: 'dashboards', key: d.key, scope })
                        }
                      >
                        <i className="bi bi-trash" />
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card.Body>
      {editing && (
        <DashboardDialog
          dashboard={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}
