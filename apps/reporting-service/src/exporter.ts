import { Inject, Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import type { ReportDef, ReportResult, ReportRunParams } from '@erp/metadata';
import { AppError } from '@erp/service-kit';
import { ReportCatalog, type Viewer } from './catalog';
import { CLIENTS, type Clients } from './clients';
import type { ExportFormat } from './models';
import { display, flatten, isNumeric, type FlatTable } from './tables';

/** Most rows one export reads (the design's limit). */
export const MAX_EXPORT_ROWS = 100_000;
/** PDF is for reading, not for data: longer reports go to Excel. */
export const MAX_PDF_ROWS = 5_000;
const PAGE = 5_000;

export interface StoredFile {
  id: string;
  name: string;
  size: number;
}

const MIME: Record<ExportFormat, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  pdf: 'application/pdf',
};

@Injectable()
export class Exporter {
  constructor(
    @Inject(CLIENTS) private readonly clients: Clients,
    private readonly catalog: ReportCatalog,
  ) {}

  /** The whole report: every page of rows (up to the limit), or the groups / pivot. */
  async fetchAll(v: Viewer, def: ReportDef, params: ReportRunParams): Promise<ReportResult> {
    const first = await this.catalog.run(v, def, { ...params, page: 1, pageSize: PAGE }, 'export');
    if (first.kind !== 'rows' || first.total <= first.rows.length) return first;
    const rows = [...first.rows];
    const last = Math.ceil(Math.min(first.total, MAX_EXPORT_ROWS) / PAGE);
    for (let page = 2; page <= last; page++) {
      const next = await this.catalog.run(v, def, { ...params, page, pageSize: PAGE }, 'export');
      if (next.kind !== 'rows') break;
      rows.push(...next.rows);
    }
    return { ...first, rows: rows.slice(0, MAX_EXPORT_ROWS), page: 1, pageSize: rows.length };
  }

  /** Builds the file and stores it in file-service. */
  async build(
    result: ReportResult,
    format: ExportFormat,
    meta: {
      title: string;
      subtitle?: string;
      lang: string;
      locale: string;
      timezone: string;
      baseName: string;
    },
  ): Promise<StoredFile & { rows: number }> {
    const table = flatten(result, meta.lang.startsWith('hi') ? 'कुल' : 'Total');
    const name = `${meta.baseName}.${format}`;
    if (format === 'pdf') {
      if (table.rows.length > MAX_PDF_ROWS) {
        throw AppError.badRequest(
          `PDF exports hold at most ${MAX_PDF_ROWS} rows; this report has ${table.rows.length}. Use Excel.`,
        );
      }
      const file = await this.clients.documents.post<StoredFile>(
        '/internal/documents/table-pdf',
        {
          title: meta.title,
          subtitle: meta.subtitle,
          columns: table.columns.map((c) => ({
            label: c.label,
            align: isNumeric(c) ? 'right' : 'left',
          })),
          rows: table.rows.map((r) => r.map((v, i) => display(table.columns[i], v, meta))),
          lang: meta.lang,
          fileName: name,
        },
        { timeoutMs: 120_000 },
      );
      return { ...file, rows: table.rows.length };
    }
    const bytes = format === 'xlsx' ? await this.xlsx(table, meta) : this.csv(table, meta);
    const file = await this.clients.files.postBytes<StoredFile>(
      `/internal/files/bytes?name=${encodeURIComponent(name)}&type=${encodeURIComponent(MIME[format])}`,
      bytes,
      { timeoutMs: 60_000 },
    );
    return { ...file, rows: table.rows.length };
  }

  private async xlsx(t: FlatTable, meta: { title: string; subtitle?: string }): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'global-erp';
    const ws = wb.addWorksheet(meta.title.slice(0, 31).replace(/[\\/?*[\]:]/g, ' ') || 'Report', {
      views: [{ state: 'frozen', ySplit: meta.subtitle ? 3 : 2 }],
    });
    ws.addRow([meta.title]).font = { bold: true, size: 13 };
    if (meta.subtitle)
      ws.addRow([meta.subtitle]).font = { italic: true, color: { argb: 'FF555555' } };
    const header = ws.addRow(t.columns.map((c) => c.label));
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
    });
    t.rows.forEach((values, i) => {
      const row = ws.addRow(
        values.map((v, j) => {
          const c = t.columns[j];
          if (v === null || v === undefined) return null;
          if (isNumeric(c) && typeof v === 'number') return v;
          if (c.type === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v))
            return new Date(`${v}T00:00:00Z`);
          if (c.type === 'datetime' && typeof v === 'string') return new Date(v);
          if (c.type === 'boolean') return !!v;
          return Array.isArray(v) ? v.join(', ') : String(v);
        }),
      );
      if (t.totals.has(i)) row.font = { bold: true };
    });
    t.columns.forEach((c, j) => {
      const col = ws.getColumn(j + 1);
      if (c.type === 'currency' || c.type === 'decimal' || c.type === 'number')
        col.numFmt = '#,##0.00';
      else if (c.type === 'integer') col.numFmt = '#,##0';
      else if (c.type === 'percent') col.numFmt = '0.00';
      else if (c.type === 'date') col.numFmt = 'dd-mmm-yyyy';
      else if (c.type === 'datetime') col.numFmt = 'dd-mmm-yyyy hh:mm';
      col.width = Math.min(40, Math.max(10, c.label.length + 2));
    });
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  private csv(t: FlatTable, meta: { locale: string; timezone: string }): Buffer {
    const cell = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const lines = [
      t.columns.map((c) => cell(c.label)).join(','),
      // Numbers stay plain (no grouping) so spreadsheets read them as numbers.
      ...t.rows.map((r) =>
        r
          .map((v, i) => {
            const c = t.columns[i];
            if (v === null || v === undefined) return '';
            if (isNumeric(c) && typeof v === 'number') return String(v);
            return cell(display(c, v, meta));
          })
          .join(','),
      ),
    ];
    // A byte-order mark makes Excel read the file as UTF-8 (Indian scripts, Arabic).
    return Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
  }
}
