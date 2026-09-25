import { useState } from 'react';
import { Button, ButtonGroup, Card, ListGroup } from 'react-bootstrap';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import type { NotificationDto, Page } from '../api/types';
import { ErrorAlert, Loading, PageHeader } from '../components/ui';
import { formatDateTime } from '../lib/format';

export function NotificationsPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['notifications', 'page', unreadOnly, page],
    queryFn: () =>
      api<Page<NotificationDto> & { unread: number }>('/notifications', {
        query: { unread: unreadOnly ? 'true' : undefined, page, pageSize: 30 },
      }),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['notifications'] });
  const readAll = useMutation({
    mutationFn: () => api('/notifications/read-all', { method: 'POST' }),
    onSuccess: invalidate,
  });
  const read = useMutation({
    mutationFn: (id: string) => api(`/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: invalidate,
  });

  return (
    <>
      <PageHeader
        title={t('notifications.title')}
        actions={
          <Button
            variant="outline-secondary"
            disabled={!list.data?.unread}
            onClick={() => readAll.mutate()}
          >
            <i className="bi bi-check2-all me-1" />
            {t('notifications.readAll')}
          </Button>
        }
      />
      <ButtonGroup className="mb-3">
        <Button
          variant={unreadOnly ? 'outline-primary' : 'primary'}
          onClick={() => {
            setUnreadOnly(false);
            setPage(1);
          }}
        >
          {t('notifications.allTab')}
        </Button>
        <Button
          variant={unreadOnly ? 'primary' : 'outline-primary'}
          onClick={() => {
            setUnreadOnly(true);
            setPage(1);
          }}
        >
          {t('notifications.unreadTab', { count: list.data?.unread ?? 0 })}
        </Button>
      </ButtonGroup>
      <ErrorAlert error={list.error ?? readAll.error} />
      {list.isLoading ? (
        <Loading />
      ) : (
        <Card className="shadow-sm border-0">
          <ListGroup variant="flush">
            {!list.data?.items.length && (
              <ListGroup.Item className="text-body-secondary">
                {t('notifications.empty')}
              </ListGroup.Item>
            )}
            {list.data?.items.map((n) => (
              <ListGroup.Item
                key={n.id}
                action={!!n.link}
                className="d-flex gap-3 align-items-start"
                onClick={() => {
                  if (!n.read) read.mutate(n.id);
                  if (n.link) navigate(n.link);
                }}
              >
                <i
                  className={`bi ${n.read ? 'bi-envelope-open text-body-secondary' : 'bi-envelope-fill text-primary'} mt-1`}
                />
                <div className="flex-grow-1">
                  <div className={n.read ? '' : 'fw-semibold'}>{n.title}</div>
                  {n.body && <div className="small text-body-secondary">{n.body}</div>}
                </div>
                <small className="text-body-secondary text-nowrap">
                  {formatDateTime(n.createdAt, i18n.language)}
                </small>
              </ListGroup.Item>
            ))}
          </ListGroup>
          {(list.data?.total ?? 0) > 30 && (
            <Card.Footer className="d-flex justify-content-between">
              <Button
                size="sm"
                variant="outline-secondary"
                disabled={page === 1}
                onClick={() => setPage(page - 1)}
              >
                {t('common.previous')}
              </Button>
              <Button
                size="sm"
                variant="outline-secondary"
                disabled={page * 30 >= (list.data?.total ?? 0)}
                onClick={() => setPage(page + 1)}
              >
                {t('common.next')}
              </Button>
            </Card.Footer>
          )}
        </Card>
      )}
    </>
  );
}
