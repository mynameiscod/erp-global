import { useState } from 'react';
import { Alert, Button, Dropdown, Form, Modal } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import type { PrintTemplateDef } from '@erp/metadata';
import { api, apiBlob, openBlob, saveBlob } from '../api/client';
import { useLabel } from '../config/hooks';
import { ErrorAlert, Field } from '../components/ui';

function EmailDialog({
  entity,
  id,
  template,
  onClose,
}: {
  entity: string;
  id: string;
  template: PrintTemplateDef;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const list = to.split(/[\s,;]+/).filter(Boolean);
  const ok = list.length > 0 && list.every((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/documents/${entity}/${id}/email`, {
        method: 'POST',
        body: {
          template: template.key,
          to: list,
          subject: subject || undefined,
          message: message || undefined,
        },
      });
      setSent(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal show onHide={onClose} centered>
      <Modal.Header closeButton>
        <Modal.Title className="h5">{t('print.emailTitle')}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {sent ? (
          <Alert variant="success" className="mb-0">
            <i className="bi bi-check-circle me-2" />
            {t('print.emailSent', { count: list.length })}
          </Alert>
        ) : (
          <>
            <ErrorAlert error={error} />
            <Field label={t('print.emailTo')} controlId="pm-to" hint={t('print.emailToHint')}>
              <Form.Control dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
            <Field
              label={`${t('reports.subject')} (${t('common.optional')})`}
              controlId="pm-subject"
            >
              <Form.Control value={subject} onChange={(e) => setSubject(e.target.value)} />
            </Field>
            <Field label={`${t('print.message')} (${t('common.optional')})`} controlId="pm-message">
              <Form.Control
                as="textarea"
                rows={3}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </Field>
          </>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          {t('common.close')}
        </Button>
        {!sent && (
          <Button disabled={!ok || busy} onClick={() => void send()}>
            <i className="bi bi-send me-1" />
            {t('print.send')}
          </Button>
        )}
      </Modal.Footer>
    </Modal>
  );
}

/**
 * Print, download or email a record's PDF with one of the entity's templates, or print
 * several records at once into one PDF.
 */
export function PrintMenu({
  entity,
  ids,
  templates,
}: {
  entity: string;
  ids: string[];
  templates: PrintTemplateDef[];
}) {
  const { t } = useTranslation();
  const label = useLabel();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [emailing, setEmailing] = useState<PrintTemplateDef | null>(null);
  if (!templates.length || !ids.length) return null;
  const single = ids.length === 1;
  const run = async (template: PrintTemplateDef, download: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const { blob, fileName } = single
        ? await apiBlob(
            `/documents/${entity}/${ids[0]}/pdf?template=${encodeURIComponent(template.key)}`,
          )
        : await apiBlob(`/documents/${entity}/pdf`, {
            method: 'POST',
            body: { ids, template: template.key },
          });
      if (download || !single) saveBlob(blob, fileName);
      else openBlob(blob);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Dropdown>
        <Dropdown.Toggle variant="outline-secondary" disabled={busy}>
          <i className="bi bi-printer me-1" />
          {single ? t('print.print') : t('print.printSelected', { count: ids.length })}
        </Dropdown.Toggle>
        <Dropdown.Menu>
          {templates.map((tpl) => (
            <div key={tpl.key}>
              {templates.length > 1 && <Dropdown.Header>{label(tpl.label)}</Dropdown.Header>}
              <Dropdown.Item onClick={() => void run(tpl, false)}>
                <i className="bi bi-file-earmark-pdf me-2" />
                {single ? t('print.openPdf') : t('print.downloadAll')}
              </Dropdown.Item>
              {single && (
                <>
                  <Dropdown.Item onClick={() => void run(tpl, true)}>
                    <i className="bi bi-download me-2" />
                    {t('print.download')}
                  </Dropdown.Item>
                  <Dropdown.Item onClick={() => setEmailing(tpl)}>
                    <i className="bi bi-envelope me-2" />
                    {t('print.email')}
                  </Dropdown.Item>
                </>
              )}
            </div>
          ))}
        </Dropdown.Menu>
      </Dropdown>
      {error ? (
        <div className="position-fixed bottom-0 end-0 p-3" style={{ zIndex: 1080, maxWidth: 420 }}>
          <ErrorAlert error={error} onClose={() => setError(null)} />
        </div>
      ) : null}
      {emailing && single && (
        <EmailDialog
          entity={entity}
          id={ids[0]}
          template={emailing}
          onClose={() => setEmailing(null)}
        />
      )}
    </>
  );
}
