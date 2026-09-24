import { useState } from 'react';
import { Button, Card, Col, Form, Modal, Row, Table } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import {
  KEY_RE,
  renderNumber,
  validateNumberingPattern,
  type NumberingSeries,
} from '@erp/metadata';
import { useAuth } from '../auth/AuthContext';
import { useConfigActions, useEffectiveConfig, useLabel } from '../config/hooks';
import { LocalizedInput } from '../config/LocalizedInput';
import { ErrorAlert, Field } from '../components/ui';
import { useStudio } from './StudioContext';

function SeriesDialog({ series, onClose }: { series?: NumberingSeries; onClose: () => void }) {
  const { t } = useTranslation();
  const { scope } = useStudio();
  const { putItem } = useConfigActions();
  const cfg = useEffectiveConfig();
  const [s, setS] = useState<NumberingSeries>(
    series ?? {
      key: '',
      label: {},
      pattern: 'DOC/{FY}/{SEQ:5}',
      reset: 'yearly',
      scope: 'company',
    },
  );
  const problems = validateNumberingPattern(s.pattern);
  const fy = cfg.data?.settings.fiscalYearStartMonth ?? 4;
  const preview = problems.length
    ? []
    : [1, 2, 3].map((seq) =>
        renderNumber(s.pattern, { date: new Date(), fyStartMonth: fy, seq, branchCode: 'HYD' }),
      );

  return (
    <Modal show onHide={onClose} centered size="lg">
      <Modal.Header closeButton>
        <Modal.Title className="h5">{series ? series.key : t('studio.newSeries')}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <ErrorAlert error={putItem.error} />
        <Row>
          <Col md={6}>
            <Field label={t('studio.label')} controlId="ns-label">
              <LocalizedInput
                id="ns-label"
                value={s.label}
                onChange={(v) => setS({ ...s, label: v })}
              />
            </Field>
          </Col>
          <Col md={6}>
            <Field label={t('studio.key')} controlId="ns-key" hint={t('studio.keyHint')}>
              <Form.Control
                value={s.key}
                disabled={!!series}
                onChange={(e) => setS({ ...s, key: e.target.value.toLowerCase() })}
                className="font-monospace"
                dir="ltr"
              />
            </Field>
          </Col>
          <Col md={12}>
            <Field
              label={t('studio.pattern')}
              controlId="ns-pattern"
              hint={t('studio.patternHelp')}
              error={problems[0]}
            >
              <Form.Control
                value={s.pattern}
                onChange={(e) => setS({ ...s, pattern: e.target.value })}
                className="font-monospace"
                dir="ltr"
              />
            </Field>
          </Col>
          <Col md={6}>
            <Field label={t('studio.reset')} controlId="ns-reset">
              <Form.Select
                value={s.reset}
                onChange={(e) => setS({ ...s, reset: e.target.value as NumberingSeries['reset'] })}
              >
                <option value="never">{t('studio.resetNever')}</option>
                <option value="yearly">{t('studio.resetYearly')}</option>
                <option value="monthly">{t('studio.resetMonthly')}</option>
              </Form.Select>
            </Field>
          </Col>
          <Col md={6}>
            <Field label={t('studio.countPer')} controlId="ns-scope">
              <Form.Select
                value={s.scope}
                onChange={(e) => setS({ ...s, scope: e.target.value as NumberingSeries['scope'] })}
              >
                <option value="company">{t('studio.perCompany')}</option>
                <option value="org_unit">{t('studio.perOrgUnit')}</option>
              </Form.Select>
            </Field>
          </Col>
        </Row>
        {preview.length > 0 && (
          <div className="bg-body-tertiary rounded p-2">
            <div className="small text-body-secondary mb-1">{t('studio.nextNumbers')}</div>
            {preview.map((p) => (
              <div key={p} className="font-monospace" dir="ltr">
                {p}
              </div>
            ))}
          </div>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button
          disabled={
            !KEY_RE.test(s.key) ||
            problems.length > 0 ||
            !Object.values(s.label).some(Boolean) ||
            putItem.isPending
          }
          onClick={() =>
            void putItem
              .mutateAsync({ kind: 'numbering', key: s.key, body: s, scope })
              .then(onClose)
          }
        >
          {t('common.save')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

export function NumberingTab() {
  const { t } = useTranslation();
  const label = useLabel();
  const { can } = useAuth();
  const { layer, scope } = useStudio();
  const { deleteItem } = useConfigActions();
  const [editing, setEditing] = useState<NumberingSeries | 'new' | null>(null);
  return (
    <Card className="shadow-sm border-0">
      <Card.Body>
        <ErrorAlert error={deleteItem.error} />
        {can('config.manage') && (
          <Button size="sm" className="mb-3" onClick={() => setEditing('new')}>
            <i className="bi bi-plus-lg me-1" />
            {t('studio.newSeries')}
          </Button>
        )}
        {layer.numbering.length === 0 ? (
          <p className="text-body-secondary mb-0">{t('studio.empty')}</p>
        ) : (
          <Table hover size="sm" className="align-middle mb-0">
            <tbody>
              {layer.numbering.map((s) => (
                <tr key={s.key}>
                  <td className="fw-medium">{label(s.label)}</td>
                  <td className="font-monospace" dir="ltr">
                    {s.pattern}
                  </td>
                  <td className="small text-body-secondary">
                    {t(`studio.reset${s.reset[0].toUpperCase()}${s.reset.slice(1)}`)} ·{' '}
                    {s.scope === 'company' ? t('studio.perCompany') : t('studio.perOrgUnit')}
                  </td>
                  <td className="text-end text-nowrap">
                    <Button
                      size="sm"
                      variant="outline-primary"
                      className="me-1"
                      onClick={() => setEditing(s)}
                    >
                      <i className="bi bi-pencil" />
                    </Button>
                    {can('config.manage') && (
                      <Button
                        size="sm"
                        variant="outline-danger"
                        onClick={() =>
                          window.confirm(t('common.confirm')) &&
                          deleteItem.mutate({ kind: 'numbering', key: s.key, scope })
                        }
                      >
                        <i className="bi bi-trash" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card.Body>
      {editing && (
        <SeriesDialog
          series={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}
