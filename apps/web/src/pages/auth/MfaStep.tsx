import { useEffect, useState } from 'react';
import { Alert, Button, Form } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import type { MfaChallenge, OtpChannel } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { AuthLayout } from '../../components/AuthLayout';
import { ErrorAlert } from '../../components/ui';

/** Seconds left before "send again" is allowed. */
export function useCountdown(initial = 0): [number, (s: number) => void] {
  const [left, setLeft] = useState(initial);
  useEffect(() => {
    if (left <= 0) return;
    const id = window.setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => window.clearTimeout(id);
  }, [left]);
  return [left, setLeft];
}

/** A 6-digit one-time code box with a submit button. */
export function CodeForm({
  onSubmit,
  label,
  busy,
}: {
  onSubmit: (code: string) => Promise<void>;
  label: string;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  return (
    <Form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setSending(true);
        void onSubmit(code)
          .catch(() => setCode(''))
          .finally(() => setSending(false));
      }}
    >
      <Form.Group className="mb-3" controlId="code">
        <Form.Label>{label}</Form.Label>
        <Form.Control
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          autoFocus
          dir="ltr"
          className="text-center fs-4 font-monospace"
        />
      </Form.Group>
      <Button type="submit" className="w-100" disabled={busy || sending || code.length !== 6}>
        {t('auth.verify')}
      </Button>
    </Form>
  );
}

/** Second step of sign-in: authenticator app, or a code sent on WhatsApp / by email. */
export function MfaStep({
  challenge,
  onDone,
  onBack,
}: {
  challenge: MfaChallenge;
  onDone: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const { loginMfa, resendMfa } = useAuth();
  const [error, setError] = useState<unknown>(null);
  const [sent, setSent] = useState({ channel: challenge.channel, sentTo: challenge.sentTo });
  const [wait, setWait] = useCountdown(challenge.resendAfter ?? 0);
  const method = challenge.mfaMethod ?? 'totp';

  const prompt =
    method === 'totp'
      ? t('auth.mfaPrompt')
      : sent.sentTo
        ? t(sent.channel === 'whatsapp' ? 'auth.mfaPromptWhatsapp' : 'auth.mfaPromptEmail', {
            to: sent.sentTo,
          })
        : t('auth.mfaPromptCode');

  const resend = async (channel: OtpChannel) => {
    setError(null);
    try {
      const r = await resendMfa(challenge.mfaToken, channel);
      setSent({ channel: r.channel ?? channel, sentTo: r.sentTo });
      setWait(r.resendAfter ?? 60);
    } catch (e) {
      setError(e);
    }
  };

  return (
    <AuthLayout title={t('auth.mfaTitle')} subtitle={prompt}>
      <ErrorAlert error={error} />
      {challenge.codeSent === false && !error && (
        <Alert variant="info" className="small">
          {t('auth.codeAlreadySent')}
        </Alert>
      )}
      <CodeForm
        label={t('auth.mfaCode')}
        onSubmit={async (code) => {
          setError(null);
          try {
            await loginMfa(challenge.mfaToken, code);
            onDone();
          } catch (e) {
            setError(e);
            throw e;
          }
        }}
      />
      {method !== 'totp' && (
        <div className="d-flex flex-column align-items-center mt-2 small">
          <Button
            variant="link"
            size="sm"
            disabled={wait > 0}
            onClick={() => void resend(sent.channel ?? 'email')}
          >
            {wait > 0 ? t('auth.resendIn', { s: wait }) : t('auth.resend')}
          </Button>
          {sent.channel === 'whatsapp' && (
            <Button
              variant="link"
              size="sm"
              disabled={wait > 0}
              onClick={() => void resend('email')}
            >
              {t('auth.sendEmail')}
            </Button>
          )}
        </div>
      )}
      <Button variant="link" className="w-100 mt-2" onClick={onBack}>
        {t('auth.backToLogin')}
      </Button>
    </AuthLayout>
  );
}
