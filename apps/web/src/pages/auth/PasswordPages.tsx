import { useState } from 'react';
import { Alert, Button, Form } from 'react-bootstrap';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { passwordResetRequestSchema, passwordSchema } from '@erp/contracts';
import { api } from '../../api/client';
import { lastCompany } from '../../auth/AuthContext';
import { AuthLayout } from '../../components/AuthLayout';
import { ErrorAlert, Field, Loading } from '../../components/ui';

export function ForgotPasswordPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const form = useForm<z.input<typeof passwordResetRequestSchema>>({
    resolver: zodResolver(passwordResetRequestSchema),
    defaultValues: { tenantSlug: params.get('company') || lastCompany(), email: '' },
  });
  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      await api('/identity/auth/password/forgot', { method: 'POST', auth: false, body: v });
      setSent(true);
    } catch (e) {
      setError(e);
    }
  });
  return (
    <AuthLayout title={t('auth.forgotTitle')} subtitle={t('auth.forgotHelp')}>
      {sent ? (
        <Alert variant="success">{t('auth.linkSent')}</Alert>
      ) : (
        <Form onSubmit={onSubmit} noValidate>
          <ErrorAlert error={error} />
          <Field
            label={t('auth.company')}
            controlId="tenantSlug"
            error={form.formState.errors.tenantSlug?.message}
          >
            <Form.Control {...form.register('tenantSlug')} autoCapitalize="none" />
          </Field>
          <Field
            label={t('common.email')}
            controlId="email"
            error={form.formState.errors.email?.message}
          >
            <Form.Control type="email" {...form.register('email')} />
          </Field>
          <Button type="submit" className="w-100" disabled={form.formState.isSubmitting}>
            {t('auth.sendLink')}
          </Button>
        </Form>
      )}
      <p className="text-center small mt-3 mb-0">
        <Link to="/login">{t('auth.backToLogin')}</Link>
      </p>
    </AuthLayout>
  );
}

const newPasswordSchema = z.object({ password: passwordSchema });

function NewPasswordForm({
  submitLabel,
  onSubmit,
}: {
  submitLabel: string;
  onSubmit: (password: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<unknown>(null);
  const form = useForm<{ password: string }>({
    resolver: zodResolver(newPasswordSchema),
    defaultValues: { password: '' },
  });
  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      await onSubmit(v.password);
    } catch (e) {
      setError(e);
    }
  });
  return (
    <Form onSubmit={submit} noValidate>
      <ErrorAlert error={error} />
      <Field
        label={t('auth.newPassword')}
        controlId="password"
        error={form.formState.errors.password?.message}
        hint={t('auth.passwordHint')}
      >
        <Form.Control
          type="password"
          {...form.register('password')}
          autoComplete="new-password"
          autoFocus
        />
      </Field>
      <Button type="submit" className="w-100" disabled={form.formState.isSubmitting}>
        {submitLabel}
      </Button>
    </Form>
  );
}

export function ResetPasswordPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';
  return (
    <AuthLayout title={t('auth.forgotTitle')}>
      <NewPasswordForm
        submitLabel={t('auth.setPassword')}
        onSubmit={async (password) => {
          await api('/identity/auth/password/reset', {
            method: 'POST',
            auth: false,
            body: { token, password },
          });
          navigate('/login?notice=auth.passwordUpdated');
        }}
      />
    </AuthLayout>
  );
}

export function AcceptInvitePage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';
  const invite = useQuery({
    queryKey: ['invite', token],
    queryFn: () =>
      api<{ email: string; name: string; company: string }>('/identity/auth/invite', {
        auth: false,
        query: { token },
      }),
    retry: false,
  });
  if (invite.isLoading) return <Loading />;
  if (invite.error) {
    return (
      <AuthLayout title={t('auth.activate')}>
        <ErrorAlert error={invite.error} />
        <Link to="/login">{t('auth.backToLogin')}</Link>
      </AuthLayout>
    );
  }
  const d = invite.data!;
  return (
    <AuthLayout
      title={t('auth.inviteTitle', { company: d.company })}
      subtitle={t('auth.inviteHelp', { name: d.name, email: d.email })}
    >
      <NewPasswordForm
        submitLabel={t('auth.activate')}
        onSubmit={async (password) => {
          await api('/identity/auth/invite/accept', {
            method: 'POST',
            auth: false,
            body: { token, password },
          });
          navigate('/login?notice=auth.activated');
        }}
      />
    </AuthLayout>
  );
}
