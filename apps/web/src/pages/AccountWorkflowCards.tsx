import { useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Form, Row, Table } from 'react-bootstrap';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import type { Page, UserDto } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ErrorAlert } from '../components/ui';
import { formatDate } from '../lib/format';
import { currentSubscription, disablePush, enablePush, pushSupported } from '../workflow/push';

interface Delegation {
  toUserId: string;
  toName: string | null;
  from: string;
  until: string;
  note: string | null;
  active: boolean;
}

const toLocalInput = (d: Date) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/** Out of office: someone else may approve for me between two dates. */
export function DelegationCard() {
  const { t, i18n } = useTranslation();
  const { user, can } = useAuth();
  const qc = useQueryClient();
  const current = useQuery({
    queryKey: ['me', 'delegation'],
    queryFn: () => api<Delegation | null>('/identity/me/delegation'),
  });
  const users = useQuery({
    queryKey: ['users', 'active'],
    enabled: can('identity.user.read'),
    queryFn: () =>
      api<Page<UserDto>>('/identity/users', { query: { status: 'active', pageSize: 200 } }),
  });
  const [toUserId, setTo] = useState('');
  const [from, setFrom] = useState(() => toLocalInput(new Date()));
  const [until, setUntil] = useState(() => toLocalInput(new Date(Date.now() + 7 * 86_400_000)));
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api<Delegation>('/identity/me/delegation', {
        method: 'PUT',
        body: {
          toUserId,
          from: new Date(from).toISOString(),
          until: new Date(until).toISOString(),
          note: note || undefined,
        },
      }),
    onSuccess: (d) => qc.setQueryData(['me', 'delegation'], d),
  });
  const clear = useMutation({
    mutationFn: () => api('/identity/me/delegation', { method: 'DELETE' }),
    onSuccess: () => qc.setQueryData(['me', 'delegation'], null),
  });
  const d = current.data;

  return (
    <Card className="shadow-sm border-0 h-100">
      <Card.Body>
        <h2 className="h6 mb-3">{t('delegation.title')}</h2>
        <ErrorAlert error={save.error ?? clear.error} />
        {d ? (
          <>
            <Alert variant={d.active ? 'info' : 'light'}>
              {t(d.active ? 'delegation.activeNow' : 'delegation.planned', {
                name: d.toName ?? d.toUserId,
                from: formatDate(d.from, i18n.language),
                until: formatDate(d.until, i18n.language),
              })}
              {d.note && <div className="small fst-italic">{d.note}</div>}
            </Alert>
            <Button
              variant="outline-danger"
              size="sm"
              disabled={clear.isPending}
              onClick={() => clear.mutate()}
            >
              {t('delegation.end')}
            </Button>
          </>
        ) : (
          <Form
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <p className="small text-body-secondary">{t('delegation.help')}</p>
            <Form.Group className="mb-2" controlId="dg-to">
              <Form.Label>{t('delegation.to')}</Form.Label>
              {users.data ? (
                <Form.Select value={toUserId} onChange={(e) => setTo(e.target.value)}>
                  <option value="">{t('records.choose')}</option>
                  {users.data.items
                    .filter((u) => u.id !== user?.id)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name} · {u.email}
                      </option>
                    ))}
                </Form.Select>
              ) : (
                <Form.Control
                  dir="ltr"
                  placeholder={t('automation.userIds')}
                  value={toUserId}
                  onChange={(e) => setTo(e.target.value.trim())}
                />
              )}
            </Form.Group>
            <Row className="g-2 mb-2">
              <Col sm={6}>
                <Form.Label htmlFor="dg-from">{t('delegation.from')}</Form.Label>
                <Form.Control
                  id="dg-from"
                  type="datetime-local"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </Col>
              <Col sm={6}>
                <Form.Label htmlFor="dg-until">{t('delegation.until')}</Form.Label>
                <Form.Control
                  id="dg-until"
                  type="datetime-local"
                  value={until}
                  onChange={(e) => setUntil(e.target.value)}
                />
              </Col>
            </Row>
            <Form.Group className="mb-3" controlId="dg-note">
              <Form.Label>{t('delegation.note')}</Form.Label>
              <Form.Control
                value={note}
                maxLength={200}
                onChange={(e) => setNote(e.target.value)}
              />
            </Form.Group>
            <Button type="submit" disabled={!toUserId || save.isPending}>
              {t('delegation.save')}
            </Button>
          </Form>
        )}
      </Card.Body>
    </Card>
  );
}

const KINDS = [
  'approval.requested',
  'approval.reminder',
  'approval.approved',
  'approval.rejected',
] as const;
const CHANNELS = ['inapp', 'email', 'whatsapp', 'push'] as const;

/** Which messages arrive on which channel, the daily digest, and push on this device. */
export function NotificationPreferencesCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const prefs = useQuery({
    queryKey: ['notifications', 'preferences'],
    queryFn: () => api<{ disabled: string[]; digest: boolean }>('/notifications/preferences'),
  });
  const save = useMutation({
    mutationFn: (body: { disabled: string[]; digest: boolean }) =>
      api<{ disabled: string[]; digest: boolean }>('/notifications/preferences', {
        method: 'PUT',
        body,
      }),
    onSuccess: (p) => qc.setQueryData(['notifications', 'preferences'], p),
  });
  const [push, setPush] = useState<'unsupported' | 'off' | 'on' | 'denied'>('off');
  const [pushError, setPushError] = useState<unknown>(null);
  useEffect(() => {
    if (!pushSupported()) setPush('unsupported');
    else if (Notification.permission === 'denied') setPush('denied');
    else void currentSubscription().then((s) => setPush(s ? 'on' : 'off'));
  }, []);

  const p = prefs.data;
  const toggle = (kind: string, channel: string, on: boolean) => {
    if (!p) return;
    const key = `${kind}:${channel}`;
    save.mutate({
      ...p,
      disabled: on ? p.disabled.filter((x) => x !== key) : [...p.disabled, key],
    });
  };

  return (
    <Card className="shadow-sm border-0 h-100">
      <Card.Body>
        <h2 className="h6 mb-3">{t('prefs.title')}</h2>
        <ErrorAlert error={save.error ?? pushError} />
        {p && (
          <>
            <Table size="sm" className="align-middle small">
              <thead>
                <tr>
                  <th />
                  {CHANNELS.map((c) => (
                    <th key={c} className="text-center">
                      {t(`automation.channel.${c}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {KINDS.map((k) => (
                  <tr key={k}>
                    <td>{t(`prefs.kind.${k}`)}</td>
                    {CHANNELS.map((c) => {
                      const essential =
                        c === 'inapp' && (k === 'approval.requested' || k === 'approval.reminder');
                      return (
                        <td key={c} className="text-center">
                          <Form.Check
                            aria-label={`${k} ${c}`}
                            className="d-inline-block"
                            checked={essential || !p.disabled.includes(`${k}:${c}`)}
                            disabled={essential || save.isPending}
                            onChange={(e) => toggle(k, c, e.target.checked)}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </Table>
            <Form.Check
              id="pref-digest"
              type="switch"
              label={t('prefs.digest')}
              checked={p.digest}
              disabled={save.isPending}
              onChange={(e) => save.mutate({ ...p, digest: e.target.checked })}
            />
            <Form.Text muted className="d-block mb-3">
              {t('prefs.digestHelp')}
            </Form.Text>
          </>
        )}
        <div className="d-flex align-items-center gap-2">
          <i className="bi bi-phone" />
          <span className="small">{t(`prefs.push.${push}`)}</span>
          {push === 'off' && (
            <Button
              size="sm"
              className="ms-auto"
              onClick={() =>
                void enablePush()
                  .then((ok) =>
                    setPush(ok ? 'on' : Notification.permission === 'denied' ? 'denied' : 'off'),
                  )
                  .catch(setPushError)
              }
            >
              {t('prefs.enablePush')}
            </Button>
          )}
          {push === 'on' && (
            <Button
              size="sm"
              variant="outline-secondary"
              className="ms-auto"
              onClick={() => void disablePush().then(() => setPush('off'))}
            >
              {t('prefs.disablePush')}
            </Button>
          )}
        </div>
      </Card.Body>
    </Card>
  );
}
