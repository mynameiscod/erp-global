import { Badge, Button, Card, ListGroup } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext';
import { useConfigActions, useVersions } from '../config/hooks';
import { ErrorAlert, Loading } from '../components/ui';
import { formatDateTime } from '../lib/format';

/** Published versions, newest first. Rolling back publishes the old configuration as a new version. */
export function VersionsTab() {
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const versions = useVersions();
  const { rollback } = useConfigActions();
  if (versions.isLoading) return <Loading />;
  return (
    <Card className="shadow-sm border-0">
      <Card.Body>
        <ErrorAlert error={versions.error ?? rollback.error} />
        {!versions.data?.length && <p className="text-body-secondary mb-0">{t('studio.empty')}</p>}
        <ListGroup variant="flush">
          {versions.data?.map((v, i) => (
            <ListGroup.Item key={v.version} className="px-0">
              <div className="d-flex flex-wrap align-items-center gap-2">
                <Badge bg={i === 0 ? 'success' : 'secondary'}>v{v.version}</Badge>
                {i === 0 && (
                  <Badge bg="success-subtle" text="success-emphasis">
                    {t('studio.current')}
                  </Badge>
                )}
                {v.rolledBackFrom && (
                  <Badge bg="warning-subtle" text="warning-emphasis">
                    {t('studio.rolledBackFrom', { version: v.rolledBackFrom })}
                  </Badge>
                )}
                <span className="small text-body-secondary">
                  {formatDateTime(v.publishedAt, i18n.language)}
                </span>
                {v.note && <span className="fw-medium">{v.note}</span>}
                {i > 0 && can('config.publish') && (
                  <Button
                    size="sm"
                    variant="outline-warning"
                    className="ms-auto"
                    disabled={rollback.isPending}
                    onClick={() =>
                      window.confirm(t('studio.rollbackConfirm', { version: v.version })) &&
                      rollback.mutate(v.version)
                    }
                  >
                    <i className="bi bi-arrow-counterclockwise me-1" />
                    {t('studio.rollback')}
                  </Button>
                )}
              </div>
              {v.summary.length > 0 && (
                <ul className="small text-body-secondary mb-0 mt-1">
                  {v.summary.slice(0, 8).map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                  {v.summary.length > 8 && <li>… +{v.summary.length - 8}</li>}
                </ul>
              )}
            </ListGroup.Item>
          ))}
        </ListGroup>
      </Card.Body>
    </Card>
  );
}
