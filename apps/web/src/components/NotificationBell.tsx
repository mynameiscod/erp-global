import { useEffect } from 'react';
import { Badge, Button, Dropdown } from 'react-bootstrap';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, getAccessToken, refreshAccessToken } from '../api/client';
import type { NotificationDto, Page } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { formatDateTime } from '../lib/format';

type Inbox = Page<NotificationDto> & { unread: number };

/**
 * Keeps the bell current: a live stream (server-sent events, read with fetch so the
 * access token can be sent) plus a slow poll in case the stream is not available.
 */
export function useNotificationStream() {
  const qc = useQueryClient();
  const { status, isPlatform } = useAuth();
  useEffect(() => {
    if (status !== 'authenticated' || isPlatform) return;
    let stopped = false;
    let ctrl: AbortController | undefined;
    let wait = 2000;
    const refresh = () => {
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      void qc.invalidateQueries({ queryKey: ['approvals'] });
    };
    const connect = async () => {
      while (!stopped) {
        ctrl = new AbortController();
        try {
          const token = getAccessToken() ?? (await refreshAccessToken());
          const res = await fetch('/api/v1/notifications/stream', {
            headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
            signal: ctrl.signal,
          });
          if (res.status === 401) await refreshAccessToken();
          if (!res.ok || !res.body) throw new Error(String(res.status));
          wait = 2000;
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split('\n\n');
            buffer = events.pop() ?? '';
            if (events.some((e) => e.includes('event: notification'))) refresh();
          }
        } catch {
          /* reconnect below */
        }
        if (stopped) return;
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 60_000);
      }
    };
    void connect();
    return () => {
      stopped = true;
      ctrl?.abort();
    };
  }, [status, isPlatform, qc]);
}

export function NotificationBell() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  useNotificationStream();
  const inbox = useQuery({
    queryKey: ['notifications', 'latest'],
    queryFn: () => api<Inbox>('/notifications', { query: { pageSize: 8 } }),
    refetchInterval: 60_000,
  });
  const readAll = useMutation({
    mutationFn: () => api('/notifications/read-all', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const open = async (n: NotificationDto) => {
    if (!n.read) {
      await api(`/notifications/${n.id}/read`, { method: 'POST' }).catch(() => undefined);
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    }
    if (n.link) navigate(n.link);
  };
  const unread = inbox.data?.unread ?? 0;

  return (
    <Dropdown align="end">
      <Dropdown.Toggle
        variant="light"
        size="sm"
        className="position-relative no-caret"
        aria-label={t('notifications.title')}
      >
        <i className="bi bi-bell" />
        {unread > 0 && (
          <Badge pill bg="danger" className="position-absolute top-0 start-100 translate-middle">
            {unread > 99 ? '99+' : unread}
          </Badge>
        )}
      </Dropdown.Toggle>
      <Dropdown.Menu style={{ width: 340, maxWidth: '90vw' }}>
        <div className="d-flex align-items-center px-3 py-1">
          <span className="fw-semibold small">{t('notifications.title')}</span>
          {unread > 0 && (
            <Button
              size="sm"
              variant="link"
              className="ms-auto p-0 small"
              onClick={() => readAll.mutate()}
            >
              {t('notifications.readAll')}
            </Button>
          )}
        </div>
        <Dropdown.Divider />
        {!inbox.data?.items.length && (
          <Dropdown.ItemText className="small text-body-secondary">
            {t('notifications.empty')}
          </Dropdown.ItemText>
        )}
        {inbox.data?.items.map((n) => (
          <Dropdown.Item
            key={n.id}
            onClick={() => void open(n)}
            className={`small text-wrap ${n.read ? '' : 'fw-semibold'}`}
          >
            <div>{n.title}</div>
            <div className="text-body-secondary fw-normal" style={{ fontSize: '0.75rem' }}>
              {formatDateTime(n.createdAt, i18n.language)}
            </div>
          </Dropdown.Item>
        ))}
        <Dropdown.Divider />
        <Dropdown.Item className="small text-center" onClick={() => navigate('/notifications')}>
          {t('notifications.all')}
        </Dropdown.Item>
      </Dropdown.Menu>
    </Dropdown>
  );
}
