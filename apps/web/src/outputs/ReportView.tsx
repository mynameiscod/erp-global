import { useMemo } from 'react';
import { Alert, Table } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';
import type { ColDef } from 'ag-grid-community';
import {
  formatCurrency,
  formatDate,
  formatDateTime,
  formatNumber,
  type GroupRow,
  type ReportResult,
  type ResultColumn,
} from '@erp/metadata';
import { DataGrid } from '../components/DataGrid';

export interface CellFormat {
  locale: string;
  timezone: string;
}

const NUMERIC = new Set(['integer', 'decimal', 'currency', 'percent', 'number']);
export const isNumeric = (c: ResultColumn | undefined) => !!c && NUMERIC.has(c.type);

/** A value as text for its column type, in the company's formats. */
export function formatCell(c: ResultColumn | undefined, v: unknown, f: CellFormat): string {
  if (v === null || v === undefined || v === '') return '';
  switch (c?.type) {
    case 'currency':
      return c.currency ? formatCurrency(v, c.currency, f.locale) : formatNumber(v, f.locale, 2);
    case 'integer':
      return formatNumber(v, f.locale, 0);
    case 'decimal':
    case 'percent':
    case 'number':
      return typeof v === 'number'
        ? formatNumber(v, f.locale, Number.isInteger(v) ? 0 : 2)
        : String(v);
    case 'date':
      return formatDate(v, f.locale) || String(v);
    case 'datetime':
      return formatDateTime(v, f.locale, f.timezone) || String(v);
    case 'boolean':
      return v ? '✓' : '✗';
    default:
      return Array.isArray(v) ? v.join(', ') : String(v);
  }
}

/** Subtotals right after the rows they add up (same order as the exports). */
export function orderedGroups(rows: GroupRow[], subtotals: GroupRow[], depth: number): GroupRow[] {
  const keyList = (r: GroupRow) =>
    Array.from({ length: depth - r.level }, (_, i) => String(r.keys[`g${i}`] ?? ''));
  return [...rows, ...subtotals].sort((a, b) => {
    const ka = keyList(a);
    const kb = keyList(b);
    for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
      if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    }
    return kb.length - ka.length;
  });
}

export function ReportView({
  result,
  format,
  onDrill,
  onOpenRecord,
  height,
}: {
  result: ReportResult;
  format: CellFormat;
  /** Clicking a group or pivot cell: the group keys behind it. */
  onDrill?: (keys: Record<string, unknown>) => void;
  onOpenRecord?: (id: string) => void;
  height?: number;
}) {
  const { t } = useTranslation();
  const truncated = result.kind !== 'rows' && result.truncated;
  return (
    <>
      {truncated && (
        <Alert variant="warning" className="py-2 small">
          {t('reports.truncated')}
        </Alert>
      )}
      {result.kind === 'rows' && (
        <RowsView result={result} format={format} onOpenRecord={onOpenRecord} height={height} />
      )}
      {result.kind === 'groups' && <GroupsView result={result} format={format} onDrill={onDrill} />}
      {result.kind === 'pivot' && <PivotView result={result} format={format} onDrill={onDrill} />}
    </>
  );
}

type RowsResult = Extract<ReportResult, { kind: 'rows' }>;
type Row = Record<string, unknown>;

function RowsView({
  result,
  format,
  onOpenRecord,
  height,
}: {
  result: RowsResult;
  format: CellFormat;
  onOpenRecord?: (id: string) => void;
  height?: number;
}) {
  const { t } = useTranslation();
  const columns = useMemo<ColDef<Row>[]>(
    () =>
      result.columns.map((c) => ({
        headerName: c.label,
        valueGetter: (p) => p.data?.[c.key],
        valueFormatter: (p) => formatCell(c, p.value, format),
        type: isNumeric(c) ? 'rightAligned' : undefined,
        comparator: isNumeric(c)
          ? (a: unknown, b: unknown) => Number(a ?? 0) - Number(b ?? 0)
          : undefined,
        onCellClicked: onOpenRecord
          ? // Line-item reports number rows `<record id>:<line>`; open the record.
            (p) => p.data && onOpenRecord(String(p.data.__id).split(':')[0])
          : undefined,
        cellClass: onOpenRecord ? 'cursor-pointer' : undefined,
      })),
    [result.columns, format, onOpenRecord],
  );
  return (
    <>
      <DataGrid<Row>
        rows={result.rows}
        columns={columns}
        rowId={(r) => String(r.__id)}
        height={height ?? 480}
      />
      <div className="small text-body-secondary mt-1">
        {t('reports.rowsShown', { shown: result.rows.length, total: result.total })}
      </div>
    </>
  );
}

type GroupsResult = Extract<ReportResult, { kind: 'groups' }>;

function GroupsView({
  result,
  format,
  onDrill,
}: {
  result: GroupsResult;
  format: CellFormat;
  onDrill?: (keys: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const groupCols = result.columns.filter((c) => /^g\d+$/.test(c.key));
  const valueCols = result.columns.filter((c) => /^a\d+$/.test(c.key));
  const depth = groupCols.length;
  const rows = orderedGroups(result.rows, result.subtotals, depth);
  return (
    <div className="table-responsive">
      <Table size="sm" hover className="align-middle report-table">
        <thead className="table-light">
          <tr>
            {groupCols.map((c) => (
              <th key={c.key}>{c.label}</th>
            ))}
            {valueCols.map((c) => (
              <th key={c.key} className="text-end">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const shown = depth - r.level;
            const total = r.level > 0;
            return (
              <tr
                key={i}
                className={`${total ? 'fw-semibold table-group-divider-sm' : ''} ${onDrill ? 'cursor-pointer' : ''}`}
                onClick={() => onDrill?.(r.keys)}
              >
                {groupCols.map((c, j) => (
                  <td key={c.key}>
                    {j < shown ? r.labels[c.key] || '—' : j === shown ? t('reports.total') : ''}
                  </td>
                ))}
                {valueCols.map((c) => (
                  <td key={c.key} className="text-end">
                    {formatCell(c, r.values[c.key], format)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="fw-bold border-top border-2">
            <td colSpan={Math.max(1, depth)}>{t('reports.grandTotal')}</td>
            {valueCols.map((c) => (
              <td key={c.key} className="text-end">
                {formatCell(c, result.grandTotal[c.key], format)}
              </td>
            ))}
          </tr>
        </tfoot>
      </Table>
    </div>
  );
}

type PivotResult = Extract<ReportResult, { kind: 'pivot' }>;

function PivotView({
  result,
  format,
  onDrill,
}: {
  result: PivotResult;
  format: CellFormat;
  onDrill?: (keys: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const multi = result.values.length > 1;
  const colKey = `g${result.rowColumns.length}`;
  return (
    <div className="table-responsive">
      <Table size="sm" hover bordered className="align-middle report-table">
        <thead className="table-light">
          <tr>
            {result.rowColumns.map((c) => (
              <th key={c.key} rowSpan={multi ? 2 : 1}>
                {c.label}
              </th>
            ))}
            {[...result.columnKeys, { key: '__total', label: t('reports.total') }].map((ck) => (
              <th key={ck.key} colSpan={result.values.length} className="text-center">
                {ck.label}
              </th>
            ))}
          </tr>
          {multi && (
            <tr>
              {[...result.columnKeys, { key: '__total', label: '' }].flatMap((ck) =>
                result.values.map((v) => (
                  <th key={`${ck.key}|${v.key}`} className="text-end small">
                    {v.label}
                  </th>
                )),
              )}
            </tr>
          )}
        </thead>
        <tbody>
          {result.rows.map((r, i) => (
            <tr key={i}>
              {result.rowColumns.map((c) => (
                <td key={c.key}>{r.labels[c.key] || '—'}</td>
              ))}
              {[...result.columnKeys.map((c) => c.key), '__total'].flatMap((ck) =>
                result.values.map((v) => (
                  <td
                    key={`${ck}|${v.key}`}
                    className={`text-end ${ck === '__total' ? 'fw-semibold' : ''} ${onDrill ? 'cursor-pointer' : ''}`}
                    onClick={() =>
                      onDrill?.(
                        ck === '__total' ? r.keys : { ...r.keys, [colKey]: ck === '' ? null : ck },
                      )
                    }
                  >
                    {formatCell(v, r.cells[ck]?.[v.key], format)}
                  </td>
                )),
              )}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="fw-bold border-top border-2">
            <td colSpan={result.rowColumns.length}>{t('reports.grandTotal')}</td>
            {[...result.columnKeys.map((c) => c.key), '__total'].flatMap((ck) =>
              result.values.map((v) => (
                <td key={`${ck}|${v.key}`} className="text-end">
                  {formatCell(
                    v,
                    ck === '__total' ? result.grandTotal[v.key] : result.columnTotals[ck]?.[v.key],
                    format,
                  )}
                </td>
              )),
            )}
          </tr>
        </tfoot>
      </Table>
    </div>
  );
}
