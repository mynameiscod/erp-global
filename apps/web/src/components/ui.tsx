import type { ReactNode } from 'react';
import { Alert, Badge, Form, Spinner } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api/client';

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="d-flex flex-wrap align-items-start justify-content-between gap-3 mb-4">
      <div>
        <h1 className="h3 mb-1">{title}</h1>
        {subtitle && <p className="text-body-secondary mb-0">{subtitle}</p>}
      </div>
      {actions && <div className="d-flex gap-2">{actions}</div>}
    </div>
  );
}

export function Field({
  label,
  error,
  hint,
  children,
  controlId,
}: {
  label: string;
  error?: string;
  hint?: ReactNode;
  children: ReactNode;
  controlId: string;
}) {
  return (
    <Form.Group className="mb-3" controlId={controlId}>
      <Form.Label>{label}</Form.Label>
      {children}
      {error ? (
        <Form.Control.Feedback type="invalid" className="d-block">
          {error}
        </Form.Control.Feedback>
      ) : (
        hint && <Form.Text muted>{hint}</Form.Text>
      )}
    </Form.Group>
  );
}

export function ErrorAlert({ error, onClose }: { error: unknown; onClose?: () => void }) {
  const { t } = useTranslation();
  if (!error) return null;
  const e = error instanceof ApiError ? error : null;
  return (
    <Alert variant="danger" dismissible={!!onClose} onClose={onClose}>
      {e?.message ?? t('errors.generic')}
      {e?.correlationId && (
        <div className="small text-body-secondary mt-1">
          {t('common.reference', { id: e.correlationId })}
        </div>
      )}
    </Alert>
  );
}

export function Loading() {
  const { t } = useTranslation();
  return (
    <div className="d-flex align-items-center gap-2 text-body-secondary p-4">
      <Spinner size="sm" /> {t('common.loading')}
    </div>
  );
}

const STATUS_VARIANT: Record<string, string> = {
  active: 'success',
  invited: 'info',
  inactive: 'secondary',
  deactivated: 'secondary',
  suspended: 'warning',
  provisioning: 'info',
  failed: 'danger',
};

export function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  return <Badge bg={STATUS_VARIANT[status] ?? 'secondary'}>{t(`status.${status}`, status)}</Badge>;
}

/** Maps API validation errors onto react-hook-form fields. */
export function applyFieldErrors(
  error: unknown,
  setError: (name: never, e: { message: string }) => void,
): boolean {
  if (!(error instanceof ApiError)) return false;
  const fields = error.fieldErrors();
  for (const [path, message] of Object.entries(fields)) setError(path as never, { message });
  return Object.keys(fields).length > 0;
}
