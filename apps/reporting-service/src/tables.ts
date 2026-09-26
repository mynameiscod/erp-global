import {
  formatCurrency,
  formatDate,
  formatDateTime,
  formatNumber,
  type GroupRow,
  type ReportResult,
  type ResultColumn,
} from '@erp/metadata';

/** A report result as one flat table, the shape every export format writes. */
export interface FlatTable {
  columns: ResultColumn[];
  /** Raw values: numbers stay numbers so spreadsheets can add them up. */
  rows: unknown[][];
  /** Rows that are subtotals or the grand total (shown in bold). */
  totals: Set<number>;
}

const NUMERIC = new Set(['integer', 'decimal', 'currency', 'percent', 'number']);
export const isNumeric = (c: ResultColumn) => NUMERIC.has(c.type);

/**
 * Subtotals come right after the rows they add up: compare group keys level by level,
 * and when one row's keys are a prefix of the other's, the shorter one (the subtotal)
 * goes last.
 */
function ordered(rows: GroupRow[], subtotals: GroupRow[], depth: number): GroupRow[] {
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

export function flatten(result: ReportResult, totalLabel = 'Total'): FlatTable {
  if (result.kind === 'rows') {
    return {
      columns: result.columns,
      rows: result.rows.map((r) => result.columns.map((c) => r[c.key] ?? null)),
      totals: new Set(),
    };
  }
  if (result.kind === 'groups') {
    const groupCols = result.columns.filter((c) => /^g\d+$/.test(c.key));
    const valueCols = result.columns.filter((c) => /^a\d+$/.test(c.key));
    const depth = groupCols.length;
    const rows: unknown[][] = [];
    const totals = new Set<number>();
    for (const r of ordered(result.rows, result.subtotals, depth)) {
      const shown = depth - r.level;
      if (r.level > 0) totals.add(rows.length);
      rows.push([
        ...groupCols.map((c, i) =>
          i < shown ? (r.labels[c.key] ?? '') : i === shown ? totalLabel : '',
        ),
        ...valueCols.map((c) => r.values[c.key] ?? null),
      ]);
    }
    totals.add(rows.length);
    rows.push([
      ...groupCols.map((_, i) => (i === 0 ? totalLabel : '')),
      ...valueCols.map((c) => result.grandTotal[c.key] ?? null),
    ]);
    return { columns: result.columns, rows, totals };
  }
  // Pivot: one column per (column value × measure), then row totals.
  const multi = result.values.length > 1;
  const cellCols: ResultColumn[] = [];
  const keys: { col: string; value: string }[] = [];
  for (const ck of [...result.columnKeys, { key: '__total', label: totalLabel }]) {
    for (const v of result.values) {
      cellCols.push({
        ...v,
        key: `${ck.key}|${v.key}`,
        label: multi ? `${ck.label} · ${v.label}` : ck.label,
      });
      keys.push({ col: ck.key, value: v.key });
    }
  }
  const rows = result.rows.map((r) => [
    ...result.rowColumns.map((c) => r.labels[c.key] ?? ''),
    ...keys.map((k) => r.cells[k.col]?.[k.value] ?? null),
  ]);
  const totals = new Set([rows.length]);
  rows.push([
    ...result.rowColumns.map((_, i) => (i === 0 ? totalLabel : '')),
    ...keys.map((k) =>
      k.col === '__total'
        ? (result.grandTotal[k.value] ?? null)
        : (result.columnTotals[k.col]?.[k.value] ?? null),
    ),
  ]);
  return { columns: [...result.rowColumns, ...cellCols], rows, totals };
}

/** Display text of a value, for CSV, PDF and email. */
export function display(
  c: ResultColumn,
  v: unknown,
  opts: { locale: string; timezone: string },
): string {
  if (v === null || v === undefined) return '';
  switch (c.type) {
    case 'currency':
      return c.currency
        ? formatCurrency(v, c.currency, opts.locale)
        : formatNumber(v, opts.locale, 2);
    case 'integer':
      return formatNumber(v, opts.locale, 0);
    case 'decimal':
    case 'percent':
    case 'number':
      return typeof v === 'number'
        ? formatNumber(v, opts.locale, Number.isInteger(v) ? 0 : 2)
        : String(v);
    case 'date':
      return formatDate(v, opts.locale) || String(v);
    case 'datetime':
      return formatDateTime(v, opts.locale, opts.timezone) || String(v);
    case 'boolean':
      return v ? 'Yes' : 'No';
    default:
      return Array.isArray(v) ? v.join(', ') : String(v);
  }
}

/** How many data rows a result has (for "skip when empty"). */
export function resultSize(result: ReportResult): number {
  if (result.kind === 'rows') return result.total;
  return result.rows.length;
}
