import { Button, Table } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import {
  computeFormulas,
  isCalculated,
  TABLE_MAX_ROWS,
  type EntityDef,
  type RecordData,
} from '@erp/metadata';
import { useLabel } from '../config/hooks';
import { formatNumber } from '../lib/format';
import { displayValue } from './display';
import { FieldInput, type FieldInputProps } from './FieldInput';

type Row = RecordData & { _id?: string };

let rowSeq = 0;
const rowId = () => `r${Date.now().toString(36)}${(rowSeq++).toString(36)}`;

/**
 * Line items: one row per item, each column its own input. Row formulas (e.g. qty × rate)
 * are shown as you type; the server computes them again on save.
 */
export function TableInput({
  field,
  value,
  onChange,
  cfg,
  currency,
  id,
  invalid,
}: FieldInputProps) {
  const { t, i18n } = useTranslation();
  const label = useLabel();
  const columns = (field.columns ?? []).filter((c) => !c.archived);
  const rows: Row[] = Array.isArray(value) ? (value as Row[]) : [];
  const max = Math.min(field.maxRows ?? TABLE_MAX_ROWS, TABLE_MAX_ROWS);
  const rowEntity = { fields: columns } as EntityDef;
  const withIds = rows.map((r) => (r._id ? r : { ...r, _id: rowId() }));
  const set = (next: Row[]) => onChange(next.length ? next : null);
  const setCell = (i: number, key: string, v: unknown) =>
    set(
      withIds.map((r, j) => {
        if (j !== i) return r;
        const next: Row = { ...r };
        if (v === null || v === undefined || v === '') delete next[key];
        else next[key] = v;
        return next;
      }),
    );
  const shown = (r: Row) => {
    const copy: RecordData = { ...r };
    // Formulas need numbers; values being typed may still be text.
    for (const c of columns) {
      if (c.type === 'integer' || c.type === 'decimal' || c.type === 'percent') {
        const n = Number(copy[c.key]);
        if (copy[c.key] !== undefined && Number.isFinite(n)) copy[c.key] = n;
      }
    }
    try {
      computeFormulas(rowEntity, copy);
    } catch {
      /* incomplete rows show no result */
    }
    return copy;
  };
  return (
    <div id={id} className={`table-responsive ${invalid ? 'border border-danger rounded' : ''}`}>
      <Table size="sm" className="align-middle mb-1">
        <thead className="table-light">
          <tr>
            <th style={{ width: 36 }}>#</th>
            {columns.map((c) => (
              <th key={c.key} className={isCalculated(c) ? 'text-end' : ''}>
                {label(c.label)}
                {c.required && <span className="text-danger ms-1">*</span>}
              </th>
            ))}
            <th style={{ width: 40 }} />
          </tr>
        </thead>
        <tbody>
          {withIds.map((r, i) => {
            const computed = shown(r);
            return (
              <tr key={r._id}>
                <td className="text-body-secondary small">{i + 1}</td>
                {columns.map((c) => (
                  <td
                    key={c.key}
                    style={{
                      minWidth: isCalculated(c)
                        ? 90
                        : c.type === 'text' || c.type === 'lookup'
                          ? 180
                          : 110,
                    }}
                  >
                    {isCalculated(c) ? (
                      <div className="text-end">
                        {c.calculated
                          ? displayValue(c, computed[c.key], {
                              cfg,
                              locale: i18n.language,
                              label,
                            })
                          : typeof computed[c.key] === 'number'
                            ? formatNumber(computed[c.key] as number, i18n.language)
                            : String(computed[c.key] ?? '')}
                      </div>
                    ) : (
                      <FieldInput
                        field={c}
                        id={`${id}-${i}-${c.key}`}
                        cfg={cfg}
                        currency={currency}
                        value={r[c.key]}
                        onChange={(v) => setCell(i, c.key, v)}
                      />
                    )}
                  </td>
                ))}
                <td>
                  <Button
                    size="sm"
                    variant="link"
                    className="text-danger"
                    onClick={() => set(withIds.filter((_, j) => j !== i))}
                    aria-label={t('records.removeRow')}
                  >
                    <i className="bi bi-x-lg" />
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
      <Button
        size="sm"
        variant="outline-primary"
        disabled={withIds.length >= max}
        onClick={() => set([...withIds, { _id: rowId() }])}
      >
        <i className="bi bi-plus me-1" />
        {t('records.addRow')}
      </Button>
    </div>
  );
}
