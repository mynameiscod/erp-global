import { useState } from 'react';
import { Alert, Button, Card, Col, Form, Image, Row } from 'react-bootstrap';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { changePasswordSchema } from '@erp/contracts';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { applyFieldErrors, ErrorAlert, Field, PageHeader } from '../components/ui';

function PasswordCard() {
  const { t } = useTranslation();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const form = useForm<z.input<typeof changePasswordSchema>>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: '', newPassword: '' },
  });
  const submit = form.handleSubmit(async (v) => {
    setError(null);
    setDone(false);
    try {
      await api('/identity/me/password', { method: 'POST', body: v });
      form.reset();
      setDone(true);
    } catch (e) {
      if (!applyFieldErrors(e, form.setError as never)) setError(e);
    }
  });
  return (
    <Card className="shadow-sm border-0 h-100">
      <Card.Body>
        <h2 className="h6 mb-3">{t('security.changePassword')}</h2>
        {done && <Alert variant="success">{t('common.saved')}</Alert>}
        <ErrorAlert error={error} />
        <Form onSubmit={submit} noValidate>
          <Field
            label={t('security.currentPassword')}
            controlId="currentPassword"
            error={form.formState.errors.currentPassword?.message}
          >
            <Form.Control
              type="password"
              {...form.register('currentPassword')}
              autoComplete="current-password"
            />
          </Field>
          <Field
            label={t('auth.newPassword')}
            controlId="newPassword"
            error={form.formState.errors.newPassword?.message}
            hint={t('auth.passwordHint')}
          >
            <Form.Control
              type="password"
              {...form.register('newPassword')}
              autoComplete="new-password"
            />
          </Field>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {t('common.save')}
          </Button>
        </Form>
      </Card.Body>
    </Card>
  );
}

function MfaCard() {
  const { t } = useTranslation();
  const { user, reload } = useAuth();
  const [setup, setSetup] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="shadow-sm border-0 h-100">
      <Card.Body>
        <h2 className="h6 mb-3">{t('security.mfa')}</h2>
        <ErrorAlert error={error} />
        <p className={user?.mfaEnabled ? 'text-success' : 'text-body-secondary'}>
          <i className={`bi ${user?.mfaEnabled ? 'bi-shield-check' : 'bi-shield'} me-2`} />
          {user?.mfaEnabled ? t('security.mfaOn') : t('security.mfaOff')}
        </p>
        {!user?.mfaEnabled && !setup && (
          <Button
            disabled={busy}
            onClick={() =>
              run(async () => setSetup(await api('/identity/me/mfa/setup', { method: 'POST' })))
            }
          >
            {t('security.enable')}
          </Button>
        )}
        {setup && (
          <>
            <p className="small">{t('security.scan')}</p>
            <Image
              src={setup.qrDataUrl}
              alt="QR"
              width={180}
              height={180}
              className="border rounded mb-2"
            />
            <p className="small text-body-secondary" dir="ltr">
              {t('security.secret', { secret: setup.secret })}
            </p>
          </>
        )}
        {(setup || user?.mfaEnabled) && (
          <Form
            className="d-flex gap-2 mt-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api(
                  user?.mfaEnabled ? '/identity/me/mfa/disable' : '/identity/me/mfa/enable',
                  { method: 'POST', body: { code } },
                );
                setSetup(null);
                setCode('');
                await reload();
              });
            }}
          >
            <Form.Control
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={t('auth.mfaCode')}
              inputMode="numeric"
              maxLength={6}
              style={{ maxWidth: 140 }}
              className="font-monospace"
            />
            <Button
              type="submit"
              variant={user?.mfaEnabled ? 'outline-danger' : 'primary'}
              disabled={busy || code.length !== 6}
            >
              {user?.mfaEnabled ? t('security.disable') : t('auth.verify')}
            </Button>
          </Form>
        )}
      </Card.Body>
    </Card>
  );
}

export function AccountPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  return (
    <>
      <PageHeader title={t('security.title')} subtitle={`${user?.name} · ${user?.email}`} />
      <Row className="g-3">
        <Col lg={6}>
          <MfaCard />
        </Col>
        <Col lg={6}>
          <PasswordCard />
        </Col>
      </Row>
    </>
  );
}
