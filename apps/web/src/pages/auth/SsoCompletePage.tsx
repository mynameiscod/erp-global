import { useEffect, useMemo, useState } from 'react';
import { Alert } from 'react-bootstrap';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { MfaChallenge, MfaMethod, OtpChannel } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { AuthLayout } from '../../components/AuthLayout';
import { Loading } from '../../components/ui';
import { MfaStep } from './MfaStep';

const KNOWN_ERRORS = new Set([
  'not_invited',
  'email_not_verified',
  'domain_not_allowed',
  'personal_account_not_allowed',
  'method_disabled',
  'account_disabled',
  'not_configured',
  'unknown_company',
  'invalid_state',
  'invalid_token',
  'provider_error',
  'cancelled',
  'already_linked',
  'try_again',
]);

/**
 * Where Google/Microsoft sign-in lands. The result is in the URL fragment: `ok`, an
 * `mfaToken` for the second step, `linked` after linking an account, or an `error` code.
 */
export function SsoCompletePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { reload } = useAuth();
  const params = useMemo(() => new URLSearchParams(window.location.hash.slice(1)), []);
  const [challenge, setChallenge] = useState<MfaChallenge | null>(null);

  useEffect(() => {
    // Keep tokens out of the address bar and history.
    window.history.replaceState(null, '', window.location.pathname);
    if (params.get('ok')) {
      void reload().then(() => navigate('/', { replace: true }));
    } else if (params.get('linked')) {
      void reload().then(() =>
        navigate(`/account?linked=${params.get('linked')}`, { replace: true }),
      );
    } else if (params.get('mfaToken')) {
      setChallenge({
        mfaRequired: true,
        mfaToken: params.get('mfaToken')!,
        mfaMethod: (params.get('mfaMethod') as MfaMethod) ?? 'totp',
        channel: (params.get('channel') as OtpChannel) ?? undefined,
        sentTo: params.get('sentTo') ?? undefined,
      });
    }
  }, [params, reload, navigate]);

  if (challenge) {
    return (
      <MfaStep
        challenge={challenge}
        onDone={() => navigate('/', { replace: true })}
        onBack={() => navigate('/login', { replace: true })}
      />
    );
  }

  const error = params.get('error');
  if (!error) return <Loading />;
  const code = KNOWN_ERRORS.has(error) ? error : 'generic';
  const provider = params.get('provider') === 'microsoft' ? 'Microsoft' : 'Google';
  return (
    <AuthLayout title={t('sso.failedTitle')}>
      <Alert variant="warning">{t(`sso.errors.${code}`, { provider })}</Alert>
      <Link to="/login">{t('auth.backToLogin')}</Link>
    </AuthLayout>
  );
}
