import { Col, Row, Table } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import { formatNumber, type EffectiveConfig } from '@erp/metadata';
import { useLabel } from '../config/hooks';
import { taxComponentLabel, taxRuleLabel, type TaxSummaryLine } from './display';

/**
 * Taxes of a record under its line items: the summary by component and rate, and the
 * totals. While editing it shows the browser's preview; after saving, the server's figures.
 */
export function TaxPanel({
  cfg,
  values,
  currency,
  preview,
  unresolved,
}: {
  cfg: EffectiveConfig;
  values: Record<string, unknown>;
  currency: string;
  /** Figures are the browser's preview (the form has unsaved changes). */
  preview: boolean;
  /** The preview could not find the seller's or buyer's region. */
  unresolved: boolean;
}) {
  const { t, i18n } = useTranslation();
  const label = useLabel();
  const ctx = { cfg, locale: i18n.language, label };
  const num = (v: unknown) => formatNumber(v ?? 0, i18n.language, 2);
  const summary = Array.isArray(values.tax_summary) ? (values.tax_summary as TaxSummaryLine[]) : [];
  const roundOff = Number(values.round_off ?? 0);
  const rule = typeof values.tax_rule === 'string' ? values.tax_rule : undefined;

  return (
    <Row className="g-3 mb-3 justify-content-end">
      <Col lg={7}>
        <div className="small fw-semibold text-body-secondary mb-1">
          {t('records.tax.summary')}
          {rule && (
            <span className="badge bg-secondary-subtle text-secondary-emphasis ms-2">
              {taxRuleLabel(rule, ctx)}
            </span>
          )}
        </div>
        {summary.length ? (
          <Table size="sm" bordered className="mb-0 small">
            <thead className="table-light">
              <tr>
                <th>{t('records.tax.component')}</th>
                <th className="text-end">{t('records.tax.rate')}</th>
                <th className="text-end">{t('records.tax.taxable')}</th>
                <th className="text-end">{t('records.tax.amount')}</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((s) => (
                <tr key={`${s.component}|${s.rate}`}>
                  <td>{taxComponentLabel(s.component, ctx)}</td>
                  <td className="text-end" dir="ltr">
                    {formatNumber(s.rate, i18n.language)}%
                  </td>
                  <td className="text-end" dir="ltr">
                    {num(s.taxable)}
                  </td>
                  <td className="text-end" dir="ltr">
                    {num(s.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <div className="small text-body-secondary">{t('records.tax.none')}</div>
        )}
      </Col>
      <Col lg={5}>
        <Table size="sm" borderless className="mb-0">
          <tbody>
            <tr>
              <td>{t('records.tax.subtotal')}</td>
              <td className="text-end" dir="ltr">
                {num(values.subtotal)}
              </td>
            </tr>
            <tr>
              <td>{t('records.tax.taxTotal')}</td>
              <td className="text-end" dir="ltr">
                {num(values.tax_total)}
              </td>
            </tr>
            {roundOff !== 0 && (
              <tr>
                <td>{t('records.tax.roundOff')}</td>
                <td className="text-end" dir="ltr">
                  {num(roundOff)}
                </td>
              </tr>
            )}
            <tr className="border-top fw-semibold">
              <td>
                {t('records.tax.grandTotal')}{' '}
                <span className="text-body-secondary">{currency}</span>
              </td>
              <td className="text-end" dir="ltr">
                {num(values.grand_total)}
              </td>
            </tr>
          </tbody>
        </Table>
      </Col>
      {preview && (
        <Col xs={12}>
          <div className={`small ${unresolved ? 'text-warning-emphasis' : 'text-body-secondary'}`}>
            <i className={`bi ${unresolved ? 'bi-exclamation-triangle' : 'bi-info-circle'} me-1`} />
            {unresolved ? t('records.tax.unresolved') : t('records.tax.previewNote')}
          </div>
        </Col>
      )}
    </Row>
  );
}
