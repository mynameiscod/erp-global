import { useState } from 'react';
import { Button, Form, Modal } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';

export type Decision = 'approve' | 'reject';

/** Approve or reject, with an optional comment (required by some workflows' reject). */
export function DecisionDialog({
  decision,
  count,
  onConfirm,
  onClose,
  busy,
}: {
  decision: Decision;
  count: number;
  onConfirm: (comment: string) => void;
  onClose: () => void;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  const [comment, setComment] = useState('');
  return (
    <Modal show onHide={onClose} centered>
      <Modal.Header closeButton>
        <Modal.Title className="h5">
          {t(decision === 'approve' ? 'approvals.approveTitle' : 'approvals.rejectTitle', {
            count,
          })}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <Form.Label htmlFor="decision-comment">{t('approvals.comment')}</Form.Label>
        <Form.Control
          id="decision-comment"
          as="textarea"
          rows={3}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button
          variant={decision === 'approve' ? 'success' : 'danger'}
          disabled={busy}
          onClick={() => onConfirm(comment.trim())}
        >
          {t(decision === 'approve' ? 'approvals.approve' : 'approvals.reject')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
