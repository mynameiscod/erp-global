import { useState } from 'react';
import { Alert, Badge, Button, Card, Form, Nav, Table } from 'react-bootstrap';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import type { ApprovalTaskDto, Page } from '../api/types';
import { useEffectiveConfig, useLabel } from '../config/hooks';
import { ErrorAlert, Loading, PageHeader } from '../components/ui';
import { formatDateTime } from '../lib/format';
import { DecisionDialog } from '../workflow/DecisionDialog';

type Decision = 'approve' | 'reject';

export function ApprovalsPage() {
  const { t, i18n } = useTranslation();
  const label = useLabel();
  const qc = useQueryClient();
  const cfg = useEffectiveConfig();
  const [tab, setTab] = useState<'pending' | 'done'>('pending');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deciding, setDeciding] = useState<Decision | null>(null);
  const [result, setResult] = useState<{ ok: number; failed: string[] } | null>(null);
  const tasks = useQuery({
    queryKey: ['approvals', tab],
    queryFn: () =>
      api<Page<ApprovalTaskDto>>('/workflow/tasks', { query: { status: tab, pageSize: 100 } }),
  });
  const decide = useMutation({
    mutationFn: (v: { decision: Decision; comment: string }) =>
      api<{ results: { taskId: string; ok: boolean; error?: string }[] }>(
        '/workflow/tasks/decide',
        {
          method: 'POST',
          body: { taskIds: [...selected], decision: v.decision, comment: v.comment || undefined },
        },
      ),
    onSuccess: (res) => {
      setResult({
        ok: res.results.filter((r) => r.ok).length,
        failed: res.results.filter((r) => !r.ok).map((r) => r.error ?? ''),
      });
      setSelected(new Set());
      setDeciding(null);
      void qc.invalidateQueries({ queryKey: ['approvals'] });
    },
  });
  const entityLabel = (key: string) =>
    label(cfg.data?.entities.find((e) => e.key === key)?.label) || key;
  const items = tasks.data?.items ?? [];
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  return (
    <>
      <PageHeader title={t('approvals.title')} subtitle={t('approvals.subtitle')} />
      <Nav
        variant="tabs"
        className="mb-3"
        activeKey={tab}
        onSelect={(k) => {
          setTab(k as 'pending' | 'done');
          setSelected(new Set());
        }}
      >
        <Nav.Item>
          <Nav.Link eventKey="pending">{t('approvals.pending')}</Nav.Link>
        </Nav.Item>
        <Nav.Item>
          <Nav.Link eventKey="done">{t('approvals.done')}</Nav.Link>
        </Nav.Item>
      </Nav>
      {result && (
        <Alert
          variant={result.failed.length ? 'warning' : 'success'}
          dismissible
          onClose={() => setResult(null)}
        >
          {t('approvals.result', { count: result.ok })}
          {result.failed.map((f, i) => (
            <div key={i} className="small">
              {f}
            </div>
          ))}
        </Alert>
      )}
      <ErrorAlert error={tasks.error ?? decide.error} />
      {tab === 'pending' && items.length > 0 && (
        <div className="d-flex gap-2 mb-2">
          <Button
            variant="success"
            size="sm"
            disabled={!selected.size}
            onClick={() => setDeciding('approve')}
          >
            <i className="bi bi-check-lg me-1" />
            {t('approvals.approveSelected', { count: selected.size })}
          </Button>
          <Button
            variant="outline-danger"
            size="sm"
            disabled={!selected.size}
            onClick={() => setDeciding('reject')}
          >
            <i className="bi bi-x-lg me-1" />
            {t('approvals.rejectSelected', { count: selected.size })}
          </Button>
        </div>
      )}
      {tasks.isLoading ? (
        <Loading />
      ) : (
        <Card className="shadow-sm border-0">
          <Table hover responsive className="align-middle mb-0">
            <thead>
              <tr className="small text-body-secondary">
                {tab === 'pending' && (
                  <th style={{ width: 36 }}>
                    <Form.Check
                      aria-label={t('approvals.selectAll')}
                      checked={items.length > 0 && selected.size === items.length}
                      onChange={(e) =>
                        setSelected(e.target.checked ? new Set(items.map((i) => i.id)) : new Set())
                      }
                    />
                  </th>
                )}
                <th>{t('approvals.request')}</th>
                <th>{t('approvals.level')}</th>
                <th>{t('approvals.requester')}</th>
                <th>{tab === 'pending' ? t('approvals.waitingSince') : t('approvals.decided')}</th>
              </tr>
            </thead>
            <tbody>
              {!items.length && (
                <tr>
                  <td colSpan={5} className="text-body-secondary">
                    {tab === 'pending' ? t('approvals.nothing') : t('approvals.nothingDone')}
                  </td>
                </tr>
              )}
              {items.map((task) => (
                <tr key={task.id}>
                  {tab === 'pending' && (
                    <td>
                      <Form.Check
                        aria-label={task.recordTitle}
                        checked={selected.has(task.id)}
                        onChange={() => toggle(task.id)}
                      />
                    </td>
                  )}
                  <td>
                    <Link to={`/r/${task.entity}/${task.recordId}`} className="fw-medium">
                      {task.recordTitle}
                    </Link>
                    <div className="small text-body-secondary">{entityLabel(task.entity)}</div>
                    {task.onBehalfOf && (
                      <Badge bg="info-subtle" text="info-emphasis" className="mt-1">
                        {t('approvals.onBehalfOf', { name: task.onBehalfOf })}
                      </Badge>
                    )}
                  </td>
                  <td>{label(task.levelLabel)}</td>
                  <td>{task.requesterName}</td>
                  <td className="small text-nowrap">
                    {tab === 'pending' ? (
                      formatDateTime(task.createdAt, i18n.language)
                    ) : (
                      <>
                        <Badge
                          bg={
                            task.status === 'approved'
                              ? 'success'
                              : task.status === 'rejected'
                                ? 'danger'
                                : 'secondary'
                          }
                        >
                          {t(`approvals.status.${task.status}`)}
                        </Badge>{' '}
                        {formatDateTime(task.decidedAt, i18n.language)}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      {deciding && (
        <DecisionDialog
          decision={deciding}
          count={selected.size}
          busy={decide.isPending}
          onClose={() => setDeciding(null)}
          onConfirm={(comment) => decide.mutate({ decision: deciding, comment })}
        />
      )}
    </>
  );
}
