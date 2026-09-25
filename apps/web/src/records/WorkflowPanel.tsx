import { useState } from 'react';
import { Badge, Button, Card, Form, ListGroup, Modal } from 'react-bootstrap';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api/client';
import type { WorkflowView } from '../api/types';
import { useLabel } from '../config/hooks';
import { ErrorAlert } from '../components/ui';
import { formatDateTime } from '../lib/format';
import { DecisionDialog } from '../workflow/DecisionDialog';

export function useWorkflowView(entity: string, id: string | undefined) {
  return useQuery({
    queryKey: ['workflow', entity, id],
    enabled: !!id,
    queryFn: () => api<WorkflowView>(`/workflow/records/${entity}/${id}`),
  });
}

/** State badge coloured as configured. */
export function StateBadge({ label, color }: { label: string; color: string | null }) {
  return (
    <Badge className="fs-6 fw-medium" style={{ background: color ?? '#6c757d' }}>
      {label}
    </Badge>
  );
}

/** The record's workflow: state, the buttons I may press, approvals waiting, and history. */
export function WorkflowPanel({ entity, id }: { entity: string; id: string }) {
  const { t, i18n } = useTranslation();
  const label = useLabel();
  const qc = useQueryClient();
  const view = useWorkflowView(entity, id);
  const [pending, setPending] = useState<{
    key: string;
    label: string;
    commentRequired: boolean;
  } | null>(null);
  const [comment, setComment] = useState('');
  const [deciding, setDeciding] = useState<'approve' | 'reject' | null>(null);

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['workflow', entity, id] }),
      qc.invalidateQueries({ queryKey: ['record', entity, id] }),
      qc.invalidateQueries({ queryKey: ['records', entity] }),
      qc.invalidateQueries({ queryKey: ['approvals'] }),
    ]);
  const act = useMutation({
    mutationFn: (v: { action: string; comment?: string }) =>
      api(`/workflow/records/${entity}/${id}/actions/${v.action}`, {
        method: 'POST',
        body: { comment: v.comment },
      }),
    onSuccess: async () => {
      setPending(null);
      setComment('');
      await refresh();
    },
  });
  const decide = useMutation({
    mutationFn: async (v: {
      decision: 'approve' | 'reject';
      comment: string;
      taskIds: string[];
    }) => {
      const res = await api<{ results: { ok: boolean; error?: string }[] }>(
        '/workflow/tasks/decide',
        {
          method: 'POST',
          body: { taskIds: v.taskIds, decision: v.decision, comment: v.comment || undefined },
        },
      );
      const failed = res.results.find((r) => !r.ok);
      if (failed) throw new ApiError(409, 'DECISION_FAILED', failed.error ?? '');
    },
    onSettled: async () => {
      setDeciding(null);
      await refresh();
    },
  });

  const v = view.data;
  if (!v || !v.workflow) return null;
  const name = (key: string | null) =>
    label(v.states.find((s) => s.key === key)?.label) || key || '';

  return (
    <Card className="shadow-sm border-0 mb-3">
      <Card.Body>
        <ErrorAlert error={act.error ?? decide.error} />
        <div className="d-flex flex-wrap align-items-center gap-2">
          <span className="text-body-secondary small">{t('workflow.status')}</span>
          <StateBadge label={label(v.stateLabel)} color={v.color} />
          {v.locked && (
            <span className="small text-body-secondary">
              <i className="bi bi-lock me-1" />
              {t('workflow.lockedNote')}
            </span>
          )}
          <div className="ms-auto d-flex flex-wrap gap-2">
            {v.myTaskIds.length > 0 && (
              <>
                <Button variant="success" size="sm" onClick={() => setDeciding('approve')}>
                  <i className="bi bi-check-lg me-1" />
                  {t('approvals.approve')}
                </Button>
                <Button variant="outline-danger" size="sm" onClick={() => setDeciding('reject')}>
                  <i className="bi bi-x-lg me-1" />
                  {t('approvals.reject')}
                </Button>
              </>
            )}
            {v.actions.map((a) => (
              <Button
                key={a.key}
                size="sm"
                variant="outline-primary"
                disabled={act.isPending}
                onClick={() =>
                  setPending({
                    key: a.key,
                    label: label(a.label),
                    commentRequired: a.commentRequired,
                  })
                }
              >
                {label(a.label)}
              </Button>
            ))}
          </div>
        </div>
        {v.pending.length > 0 && (
          <div className="small mt-2">
            <span className="text-body-secondary">{t('workflow.waitingFor')}</span>{' '}
            {v.pending.map((p) => `${p.assigneeName} (${label(p.levelLabel)})`).join(', ')}
          </div>
        )}
        {v.history.length > 0 && (
          <details className="mt-3">
            <summary className="small text-body-secondary">
              {t('workflow.history', { count: v.history.length })}
            </summary>
            <ListGroup variant="flush" className="small mt-2">
              {[...v.history].reverse().map((h, i) => (
                <ListGroup.Item key={i} className="px-0">
                  <span className="fw-medium">{h.byName}</span>
                  {h.onBehalfOfName && (
                    <span className="text-body-secondary">
                      {' '}
                      ({t('approvals.onBehalfOf', { name: h.onBehalfOfName })})
                    </span>
                  )}{' '}
                  {t(`workflow.did.${h.action}`, { defaultValue: h.action })}
                  {h.from !== h.to && (
                    <>
                      {' '}
                      · {name(h.from)} → {name(h.to)}
                    </>
                  )}
                  <span className="text-body-secondary">
                    {' '}
                    · {formatDateTime(h.at, i18n.language)}
                  </span>
                  {h.comment && <div className="fst-italic">“{h.comment}”</div>}
                </ListGroup.Item>
              ))}
            </ListGroup>
          </details>
        )}
      </Card.Body>

      {pending && (
        <Modal show onHide={() => setPending(null)} centered>
          <Modal.Header closeButton>
            <Modal.Title className="h5">{pending.label}</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <Form.Label htmlFor="wf-comment">
              {t('approvals.comment')}
              {pending.commentRequired && <span className="text-danger ms-1">*</span>}
            </Form.Label>
            <Form.Control
              id="wf-comment"
              as="textarea"
              rows={3}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onClick={() => setPending(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={act.isPending || (pending.commentRequired && !comment.trim())}
              onClick={() =>
                act.mutate({ action: pending.key, comment: comment.trim() || undefined })
              }
            >
              {pending.label}
            </Button>
          </Modal.Footer>
        </Modal>
      )}
      {deciding && (
        <DecisionDialog
          decision={deciding}
          count={1}
          busy={decide.isPending}
          onClose={() => setDeciding(null)}
          onConfirm={(c) => decide.mutate({ decision: deciding, comment: c, taskIds: v.myTaskIds })}
        />
      )}
    </Card>
  );
}
