import { useState } from 'react';
import { Alert, Button, Form } from 'react-bootstrap';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { loginSchema, mfaCodeSchema } from '@erp/contracts';
import { lastCompany, useAuth } from '../../auth/AuthContext';
import { AuthLayout } from '../../components/AuthLayout';
import { ErrorAlert, Field } from '../../components/ui';

type LoginForm = z.input<typeof loginSchema>;

export function LoginPage() {
  const { t } = useTranslation();
  const { login, loginMfa } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const notice = params.get('notice');

  const form = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: { tenantSlug: params.get('company') ?? lastCompany(), email: '', password: '' },
  });
  const mfa = useForm<{ code: string }>({
    resolver: zodResolver(mfaCodeSchema),
    defaultValues: { code: '' },
  });

  const done = () =>
    navigate((location.state as { from?: string } | null)?.from ?? '/', { replace: true });

  const onLogin = form.handleSubmit(async (v) => {
    setError(null);
    try {
      const challenge = await login(v.tenantSlug, v.email, v.password);
      if (challenge) setMfaToken(challenge.mfaToken);
      else done();
    } catch (e) {
      setError(e);
    }
  });

  const onMfa = mfa.handleSubmit(async (v) => {
    setError(null);
    try {
      await loginMfa(mfaToken!, v.code);
      done();
    } catch (e) {
      setError(e);
      mfa.reset();
    }
  });

  if (mfaToken) {
    return (
      <AuthLayout title={t('auth.mfaTitle')} subtitle={t('auth.mfaPrompt')}>
        <ErrorAlert error={error} />
        <Form onSubmit={onMfa} noValidate>
          <Field
            label={t('auth.mfaCode')}
            controlId="code"
            error={mfa.formState.errors.code?.message}
          >
            <Form.Control
              {...mfa.register('code')}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              autoFocus
              className="text-center fs-4 font-monospace"
            />
          </Field>
          <Button type="submit" className="w-100" disabled={mfa.formState.isSubmitting}>
            {t('auth.verify')}
          </Button>
          <Button variant="link" className="w-100 mt-2" onClick={() => setMfaToken(null)}>
            {t('auth.backToLogin')}
          </Button>
        </Form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={t('auth.signIn')}>
      {notice && <Alert variant="success">{t(notice)}</Alert>}
      <ErrorAlert error={error} />
      <Form onSubmit={onLogin} noValidate>
        <Field
          label={t('auth.company')}
          controlId="tenantSlug"
          error={form.formState.errors.tenantSlug?.message}
          hint={t('auth.companyHint')}
        >
          <Form.Control
            {...form.register('tenantSlug')}
            autoComplete="organization"
            autoCapitalize="none"
          />
        </Field>
        <Field
          label={t('common.email')}
          controlId="email"
          error={form.formState.errors.email?.message}
        >
          <Form.Control type="email" {...form.register('email')} autoComplete="username" />
        </Field>
        <Field
          label={t('auth.password')}
          controlId="password"
          error={form.formState.errors.password?.message}
        >
          <Form.Control
            type="password"
            {...form.register('password')}
            autoComplete="current-password"
          />
        </Field>
        <Button type="submit" className="w-100" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? t('auth.signingIn') : t('auth.signIn')}
        </Button>
      </Form>
      <div className="d-flex justify-content-between mt-3 small">
        <Link to={`/forgot-password?company=${encodeURIComponent(form.watch('tenantSlug') ?? '')}`}>
          {t('auth.forgot')}
        </Link>
        <span>
          {t('auth.noAccount')} <Link to="/signup">{t('auth.createAccount')}</Link>
        </span>
      </div>
    </AuthLayout>
  );
}
