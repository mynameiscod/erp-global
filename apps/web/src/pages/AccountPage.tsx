import { useState } from 'react';
import {
  Alert,
  Button,
  ButtonGroup,
  Card,
  Col,
  Form,
  Image,
  ListGroup,
  Row,
} from 'react-bootstrap';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { changePasswordSchema, phoneSchema } from '@erp/contracts';
import { api } from '../api/client';
import type { LinkedAccountDto, MfaMethod, OtpSent } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { applyFieldErrors, ErrorAlert, Field, PageHeader } from '../components/ui';
import { formatDateTime } from '../lib/format';
import { DelegationCard, NotificationPreferencesCard } from './AccountWorkflowCards';

/** Runs an action with a busy flag and an error slot, the pattern every card here uses. */
function useAction() {
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
  return { error, busy, run };
}

function CodeRow({
  onSubmit,
  busy,
  submitLabel,
  variant = 'primary',
}: {
  onSubmit: (code: string) => Promise<void>;
  busy: boolean;
  submitLabel: string;
  variant?: string;
}) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  return (
    <Form
      className="d-flex gap-2 mt-2"
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(code).then(() => setCode(''));
      }}
    >
      <Form.Control
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
        placeholder={t('auth.mfaCode')}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        dir="ltr"
        style={{ maxWidth: 140 }}
        className="font-monospace"
      />
      <Button type="submit" variant={variant} disabled={busy || code.length !== 6}>
        {submitLabel}
      </Button>
    </Form>
  );
}

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

function PhoneCard() {
  const { t } = useTranslation();
  const { user, reload } = useAuth();
  const { error, busy, run } = useAction();
  const [editing, setEditing] = useState(false);
  const [phone, setPhone] = useState('');
  const [sent, setSent] = useState<OtpSent | null>(null);
  const [phoneError, setPhoneError] = useState<string>();

  const send = () => {
    const parsed = phoneSchema.safeParse(phone);
    if (!parsed.success) return setPhoneError(t('auth.mobileHint'));
    setPhoneError(undefined);
    return run(async () => {
      setSent(
        await api<OtpSent>('/identity/me/phone', { method: 'POST', body: { phone: parsed.data } }),
      );
    });
  };

  return (
    <Card className="shadow-sm border-0 h-100">
      <Card.Body>
        <h2 className="h6 mb-3">{t('security.phone')}</h2>
        <ErrorAlert error={error} />
        <p className="text-body-secondary">
          {user?.phone ? (
            <>
              <i className="bi bi-patch-check text-success me-2" />
              <span dir="ltr">{user.phone}</span>
            </>
          ) : (
            t('security.phoneNone')
          )}
        </p>
        {!editing && (
          <div className="d-flex gap-2">
            <Button variant="outline-primary" onClick={() => setEditing(true)}>
              {user?.phone ? t('security.changePhone') : t('security.addPhone')}
            </Button>
            {user?.phone && (
              <Button
                variant="outline-danger"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api('/identity/me/phone', { method: 'DELETE' });
                    await reload();
                  })
                }
              >
                {t('security.removePhone')}
              </Button>
            )}
          </div>
        )}
        {editing && !sent && (
          <Form
            className="d-flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <Form.Control
              type="tel"
              dir="ltr"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+91 98765 43210"
              autoComplete="tel"
            />
            <Button type="submit" disabled={busy || !phone}>
              <i className="bi bi-whatsapp me-1" />
              {t('security.sendCode')}
            </Button>
          </Form>
        )}
        {editing && !sent && phoneError && (
          <Form.Text className="text-danger">{phoneError}</Form.Text>
        )}
        {sent && (
          <>
            <p className="small mb-0">{t('security.codeSentTo', { to: sent.sentTo })}</p>
            <CodeRow
              busy={busy}
              submitLabel={t('auth.verify')}
              onSubmit={(code) =>
                run(async () => {
                  await api('/identity/me/phone/verify', { method: 'POST', body: { code } });
                  setSent(null);
                  setEditing(false);
                  setPhone('');
                  await reload();
                })
              }
            />
          </>
        )}
      </Card.Body>
    </Card>
  );
}

function MfaCard() {
  const { t } = useTranslation();
  const { user, reload } = useAuth();
  const { error, busy, run } = useAction();
  const [method, setMethod] = useState<MfaMethod>('totp');
  const [setup, setSetup] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [sent, setSent] = useState<OtpSent | null>(null);
  const on = !!user?.mfaEnabled;
  const current = user?.mfaMethod ?? 'totp';
  const methodLabel = (m: MfaMethod) =>
    t(
      m === 'totp'
        ? 'security.methodTotp'
        : m === 'whatsapp'
          ? 'security.methodWhatsapp'
          : 'security.methodEmail',
    );

  const start = () =>
    run(async () => {
      if (method === 'totp') setSetup(await api('/identity/me/mfa/setup', { method: 'POST' }));
      else
        setSent(
          await api<OtpSent>('/identity/me/mfa/otp/setup', { method: 'POST', body: { method } }),
        );
    });
  const finish = async () => {
    setSetup(null);
    setSent(null);
    await reload();
  };

  return (
    <Card className="shadow-sm border-0 h-100">
      <Card.Body>
        <h2 className="h6 mb-3">{t('security.mfa')}</h2>
        <ErrorAlert error={error} />
        <p className={on ? 'text-success' : 'text-body-secondary'}>
          <i className={`bi ${on ? 'bi-shield-check' : 'bi-shield'} me-2`} />
          {on ? t('security.mfaOnWith', { method: methodLabel(current) }) : t('security.mfaOff')}
        </p>

        {!on && !setup && !sent && (
          <>
            <Form.Label className="small">{t('security.mfaMethod')}</Form.Label>
            <div className="mb-3">
              <ButtonGroup className="flex-wrap">
                {(['totp', 'whatsapp', 'email'] as const).map((m) => (
                  <Button
                    key={m}
                    variant={method === m ? 'primary' : 'outline-primary'}
                    onClick={() => setMethod(m)}
                  >
                    {methodLabel(m)}
                  </Button>
                ))}
              </ButtonGroup>
              {method === 'whatsapp' && !user?.phone && (
                <Form.Text className="d-block text-warning">
                  {t('security.needPhoneForWhatsapp')}
                </Form.Text>
              )}
            </div>
            <Button
              disabled={busy || (method === 'whatsapp' && !user?.phone)}
              onClick={() => void start()}
            >
              {t('security.enable')}
            </Button>
          </>
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
            <CodeRow
              busy={busy}
              submitLabel={t('auth.verify')}
              onSubmit={(code) =>
                run(async () => {
                  await api('/identity/me/mfa/enable', { method: 'POST', body: { code } });
                  await finish();
                })
              }
            />
          </>
        )}

        {sent && !on && (
          <>
            <p className="small mb-0">{t('security.codeSentTo', { to: sent.sentTo })}</p>
            <CodeRow
              busy={busy}
              submitLabel={t('auth.verify')}
              onSubmit={(code) =>
                run(async () => {
                  await api('/identity/me/mfa/otp/enable', { method: 'POST', body: { code } });
                  await finish();
                })
              }
            />
          </>
        )}

        {on && (
          <>
            {current !== 'totp' && (
              <Button
                variant="link"
                size="sm"
                className="px-0"
                disabled={busy}
                onClick={() =>
                  run(async () =>
                    setSent(await api<OtpSent>('/identity/me/mfa/code', { method: 'POST' })),
                  )
                }
              >
                {t('security.getDisableCode')}
              </Button>
            )}
            {sent && <p className="small mb-0">{t('security.codeSentTo', { to: sent.sentTo })}</p>}
            <CodeRow
              busy={busy}
              variant="outline-danger"
              submitLabel={t('security.disable')}
              onSubmit={(code) =>
                run(async () => {
                  await api('/identity/me/mfa/disable', { method: 'POST', body: { code } });
                  await finish();
                })
              }
            />
          </>
        )}
      </Card.Body>
    </Card>
  );
}

function LinkedAccountsCard() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const { error, busy, run } = useAction();
  const linked = useQuery({
    queryKey: ['linked-accounts'],
    queryFn: () => api<LinkedAccountDto[]>('/identity/me/linked-accounts'),
  });
  const justLinked = params.get('linked');
  const name = (p: string) => (p === 'microsoft' ? 'Microsoft' : 'Google');

  const link = (provider: 'google' | 'microsoft') =>
    run(async () => {
      const { url } = await api<{ url: string }>(`/identity/me/sso/${provider}/link`, {
        method: 'POST',
      });
      window.location.assign(url);
    });

  return (
    <Card className="shadow-sm border-0 h-100">
      <Card.Body>
        <h2 className="h6 mb-3">{t('security.linked')}</h2>
        {justLinked && (
          <Alert variant="success">
            {t('security.linkedDone', { provider: name(justLinked) })}
          </Alert>
        )}
        <ErrorAlert error={error} />
        {linked.data?.length ? (
          <ListGroup variant="flush" className="mb-3">
            {linked.data.map((a) => (
              <ListGroup.Item key={a.id} className="d-flex align-items-center gap-2 px-0">
                <i className={`bi bi-${a.provider}`} />
                <div className="flex-grow-1">
                  <div>{a.email ?? name(a.provider)}</div>
                  {a.lastUsedAt && (
                    <div className="small text-body-secondary">
                      {t('security.lastUsed', {
                        when: formatDateTime(a.lastUsedAt, i18n.language, user?.timezone),
                      })}
                    </div>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="outline-danger"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await api(`/identity/me/linked-accounts/${a.id}`, { method: 'DELETE' });
                      await qc.invalidateQueries({ queryKey: ['linked-accounts'] });
                    })
                  }
                >
                  {t('security.unlink')}
                </Button>
              </ListGroup.Item>
            ))}
          </ListGroup>
        ) : (
          <p className="text-body-secondary">{t('security.linkedNone')}</p>
        )}
        <div className="d-flex gap-2 flex-wrap">
          {(['google', 'microsoft'] as const).map((p) => (
            <Button
              key={p}
              variant="outline-secondary"
              disabled={busy}
              onClick={() => void link(p)}
            >
              <i className={`bi bi-${p} me-2`} />
              {t('security.link', { provider: name(p) })}
            </Button>
          ))}
        </div>
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
          <PhoneCard />
        </Col>
        <Col lg={6}>
          <LinkedAccountsCard />
        </Col>
        <Col lg={6}>
          <PasswordCard />
        </Col>
        <Col lg={6}>
          <DelegationCard />
        </Col>
        <Col lg={6}>
          <NotificationPreferencesCard />
        </Col>
      </Row>
    </>
  );
}
