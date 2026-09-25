import { useEffect, useState } from 'react';
import { Alert, Button, Form, Nav } from 'react-bootstrap';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { loginSchema, phoneSchema } from '@erp/contracts';
import { api } from '../../api/client';
import type {
  CompanyLookup,
  LoginMethods,
  MfaChallenge,
  OtpChannel,
  OtpSent,
} from '../../api/types';
import { lastCompany, useAuth } from '../../auth/AuthContext';
import { AuthLayout } from '../../components/AuthLayout';
import { ErrorAlert, Field } from '../../components/ui';
import { CodeForm, MfaStep, useCountdown } from './MfaStep';

type LoginForm = z.input<typeof loginSchema>;
const PASSWORD_ONLY: LoginMethods = { password: true, otp: false, google: false, microsoft: false };

/** Which sign-in options the company allows; the server enforces the same rules. */
function useLoginMethods(slug: string) {
  const [debounced, setDebounced] = useState(slug);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(slug.trim().toLowerCase()), 400);
    return () => window.clearTimeout(id);
  }, [slug]);
  const q = useQuery({
    queryKey: ['company-lookup', debounced],
    queryFn: () =>
      api<CompanyLookup>(`/tenants/lookup/${encodeURIComponent(debounced)}`, { auth: false }),
    enabled: debounced.length >= 2,
    retry: false,
    staleTime: 60_000,
  });
  return q.data?.loginMethods ?? PASSWORD_ONLY;
}

function SsoButtons({ slug, methods }: { slug: string; methods: LoginMethods }) {
  const { t } = useTranslation();
  if (!methods.google && !methods.microsoft) return null;
  const href = (p: string) =>
    `/api/v1/identity/sso/${p}/start?company=${encodeURIComponent(slug.trim().toLowerCase())}`;
  return (
    <div className="d-grid gap-2 mt-3">
      <div className="text-center small text-body-secondary">{t('auth.or')}</div>
      {methods.google && (
        <Button variant="outline-secondary" href={href('google')} disabled={!slug}>
          <i className="bi bi-google me-2" />
          {t('auth.continueGoogle')}
        </Button>
      )}
      {methods.microsoft && (
        <Button variant="outline-secondary" href={href('microsoft')} disabled={!slug}>
          <i className="bi bi-microsoft me-2" />
          {t('auth.continueMicrosoft')}
        </Button>
      )}
    </div>
  );
}

function MobileSignIn({
  slug,
  onMfa,
  onDone,
}: {
  slug: string;
  onMfa: (c: MfaChallenge) => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { requestOtp, loginOtp } = useAuth();
  const [phone, setPhone] = useState('');
  const [phoneError, setPhoneError] = useState<string>();
  const [sent, setSent] = useState<(OtpSent & { phone: string }) | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useCountdown();

  const send = async (channel: OtpChannel) => {
    setError(null);
    const parsed = phoneSchema.safeParse(sent?.phone ?? phone);
    if (!parsed.success) return setPhoneError(t('auth.mobileHint'));
    setPhoneError(undefined);
    setBusy(true);
    try {
      const r = await requestOtp(slug.trim().toLowerCase(), parsed.data, channel);
      setSent({ ...r, phone: parsed.data });
      setWait(r.resendAfter ?? 60);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <>
        <p className="small text-body-secondary">
          {sent.channel === 'whatsapp'
            ? t('auth.codeSentWhatsapp', { to: sent.sentTo })
            : t('auth.codeSentEmail')}
        </p>
        <ErrorAlert error={error} />
        <CodeForm
          label={t('auth.mfaCode')}
          onSubmit={async (code) => {
            setError(null);
            try {
              const challenge = await loginOtp(sent.otpToken!, code);
              if (challenge) onMfa(challenge);
              else onDone();
            } catch (e) {
              setError(e);
              throw e;
            }
          }}
        />
        <div className="d-flex flex-column align-items-center mt-2 small">
          <Button
            variant="link"
            size="sm"
            disabled={wait > 0 || busy}
            onClick={() => void send(sent.channel ?? 'whatsapp')}
          >
            {wait > 0 ? t('auth.resendIn', { s: wait }) : t('auth.resend')}
          </Button>
          {sent.channel === 'whatsapp' && (
            <Button
              variant="link"
              size="sm"
              disabled={wait > 0 || busy}
              onClick={() => void send('email')}
            >
              {t('auth.sendEmail')}
            </Button>
          )}
          <Button variant="link" size="sm" onClick={() => setSent(null)}>
            {t('auth.useDifferentNumber')}
          </Button>
        </div>
      </>
    );
  }

  return (
    <Form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void send('whatsapp');
      }}
    >
      <ErrorAlert error={error} />
      <Field
        label={t('auth.mobile')}
        controlId="phone"
        error={phoneError}
        hint={t('auth.mobileHint')}
      >
        <Form.Control
          type="tel"
          dir="ltr"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          autoComplete="tel"
          placeholder="+91 98765 43210"
        />
      </Field>
      <Button type="submit" className="w-100" disabled={busy || !slug}>
        <i className="bi bi-whatsapp me-2" />
        {t('auth.sendWhatsapp')}
      </Button>
    </Form>
  );
}

export function LoginPage() {
  const { t } = useTranslation();
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const [challenge, setChallenge] = useState<MfaChallenge | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tab, setTab] = useState<'password' | 'mobile'>('password');
  const notice = params.get('notice');

  const form = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: { tenantSlug: params.get('company') ?? lastCompany(), email: '', password: '' },
  });
  const slug = form.watch('tenantSlug') ?? '';
  const methods = useLoginMethods(slug);
  const active = !methods.password && methods.otp ? 'mobile' : methods.otp ? tab : 'password';

  const done = () =>
    navigate((location.state as { from?: string } | null)?.from ?? '/', { replace: true });

  const onLogin = form.handleSubmit(async (v) => {
    setError(null);
    try {
      const c = await login(v.tenantSlug, v.email, v.password);
      if (c) setChallenge(c);
      else done();
    } catch (e) {
      setError(e);
    }
  });

  if (challenge) {
    return <MfaStep challenge={challenge} onDone={done} onBack={() => setChallenge(null)} />;
  }

  return (
    <AuthLayout title={t('auth.signIn')}>
      {notice && <Alert variant="success">{t(notice)}</Alert>}
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

      {methods.password && methods.otp && (
        <Nav
          variant="tabs"
          className="mb-3"
          activeKey={active}
          onSelect={(k) => setTab(k as 'password' | 'mobile')}
        >
          <Nav.Item>
            <Nav.Link eventKey="password">{t('auth.tabPassword')}</Nav.Link>
          </Nav.Item>
          <Nav.Item>
            <Nav.Link eventKey="mobile">{t('auth.tabMobile')}</Nav.Link>
          </Nav.Item>
        </Nav>
      )}

      {active === 'mobile' ? (
        <MobileSignIn slug={slug} onMfa={setChallenge} onDone={done} />
      ) : methods.password ? (
        <Form onSubmit={onLogin} noValidate>
          <ErrorAlert error={error} />
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
      ) : null}

      <SsoButtons slug={slug} methods={methods} />

      <div className="d-flex justify-content-between mt-3 small">
        {methods.password ? (
          <Link to={`/forgot-password?company=${encodeURIComponent(slug)}`}>
            {t('auth.forgot')}
          </Link>
        ) : (
          <span />
        )}
        <span>
          {t('auth.noAccount')} <Link to="/signup">{t('auth.createAccount')}</Link>
        </span>
      </div>
    </AuthLayout>
  );
}
