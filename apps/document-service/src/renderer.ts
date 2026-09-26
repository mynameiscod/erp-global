import {
  amountInWords,
  compileFormula,
  escapeHtml,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatNumber,
  FormulaError,
  parseTemplate,
  pickText,
  renderTemplate,
  THERMAL_WIDTH_MM,
  workflowFor,
  type EffectiveConfig,
  type EntityDef,
  type FieldDef,
  type LocalizedText,
  type PrintBlock,
  type PrintColumn,
  type PrintTemplateDef,
  type RecordData,
  type TemplateNode,
  type TemplateScope,
  type ValueFormat,
} from '@erp/metadata';
import { fontCss } from './fonts';
import type { PdfPage } from './pdf-engine';

/** What records-service returns for printing (see its document data). */
export interface DocRecord {
  id: string;
  entity: string;
  number: string | null;
  status: string | null;
  orgUnitId: string | null;
  orgPath: string;
  data: RecordData;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface DocData {
  records: DocRecord[];
  links: Record<string, DocRecord & { title: string }>;
  users: Record<string, { name: string; email: string }>;
  units: Record<string, { name: string; code: string | null; custom: Record<string, unknown> }>;
  related: Record<string, Record<string, DocRecord[]>>;
}

export interface RenderContext {
  cfg: EffectiveConfig & {
    tenant: { currency: string; locale: string; timezone?: string; name?: string };
  };
  data: DocData;
  /** The company (top of the org tree) and the record's own unit. */
  company: { name: string; custom: Record<string, unknown> };
  unit?: { name: string; code: string | null; custom: Record<string, unknown> };
  /** The reader's language, used when the template does not fix its languages. */
  lang: string;
  printedBy?: string;
  /** Images (logos, signatures) by file id, as data URIs. */
  images: Record<string, string>;
  now?: Date;
}

export interface RenderedDocument {
  /** One HTML page per copy (one when the template has no copies). */
  pages: string[];
  pdf: PdfPage;
  fileName: string;
}

const RTL = new Set(['ar', 'he', 'fa', 'ur']);
const YES: Record<string, [string, string]> = {
  en: ['Yes', 'No'],
  hi: ['हाँ', 'नहीं'],
  te: ['అవును', 'కాదు'],
  ta: ['ஆம்', 'இல்லை'],
  ar: ['نعم', 'لا'],
};

/** Turns a print template and a record into HTML pages ready for the PDF engine. */
export class DocumentRenderer {
  private readonly languages: string[];
  private readonly locale: string;
  private readonly tz: string;
  private readonly entities: Map<string, EntityDef>;

  constructor(
    private readonly template: PrintTemplateDef,
    private readonly ctx: RenderContext,
  ) {
    this.languages = template.languages?.length ? template.languages : [ctx.lang];
    this.locale = ctx.cfg.tenant.locale || 'en';
    this.tz = ctx.cfg.tenant.timezone ?? 'UTC';
    this.entities = new Map(ctx.cfg.entities.map((e) => [e.key, e]));
  }

  private get lang(): string {
    return this.languages[0];
  }

  /** A label in the template's languages: "Receipt / రసీదు" when bilingual. */
  private label(t: LocalizedText | undefined): string {
    if (!t) return '';
    const texts = this.languages.map((l) => pickText(t, l));
    return [...new Set(texts.filter(Boolean))].join(' / ');
  }

  // ---- values ----

  private field(entity: string, key: string): FieldDef | undefined {
    return this.entities.get(entity)?.fields.find((f) => f.key === key);
  }

  /** Display text of a value for its field. */
  format(f: FieldDef | undefined, value: unknown, fmt: ValueFormat = 'auto'): string {
    if (value === null || value === undefined || value === '') return '';
    const currencyOf = () =>
      (typeof value === 'object' && value && 'currency' in value
        ? String((value as { currency: string }).currency)
        : undefined) ??
      f?.currency ??
      this.ctx.cfg.tenant.currency;
    const amount =
      typeof value === 'object' && value && 'amount' in value
        ? (value as { amount: unknown }).amount
        : value;
    switch (fmt) {
      case 'text':
        return Array.isArray(value) ? value.join(', ') : String(amount);
      case 'number':
        return formatNumber(
          amount,
          this.locale,
          f?.scale ?? (Number.isInteger(Number(amount)) ? 0 : 2),
        );
      case 'currency':
        return formatCurrency(amount, currencyOf(), this.locale, f?.scale ?? 2);
      case 'date':
        return String(value).length > 10
          ? formatDateTime(value, this.locale, this.tz)
          : formatDate(value, this.locale);
      case 'words':
        return amountInWords(amount, currencyOf());
    }
    if (!f) return Array.isArray(value) ? value.join(', ') : String(amount);
    switch (f.type) {
      case 'integer':
        return formatNumber(value, this.locale, 0);
      case 'decimal':
        return formatNumber(value, this.locale, f.scale ?? 2);
      case 'percent':
        return `${formatNumber(value, this.locale, f.scale ?? 2)}%`;
      case 'currency':
        return formatCurrency(amount, currencyOf(), this.locale, f.scale ?? 2);
      case 'date':
        return formatDate(value, this.locale);
      case 'datetime':
        return formatDateTime(value, this.locale, this.tz);
      case 'boolean': {
        const [yes, no] = YES[this.lang.split('-')[0]] ?? YES.en;
        return value ? yes : no;
      }
      case 'select':
      case 'multiselect': {
        const list = this.ctx.cfg.picklists.find((p) => p.key === f.picklist);
        const one = (v: unknown) => {
          const o = list?.options.find((x) => x.value === v);
          return o ? this.label(o.label) : String(v);
        };
        return Array.isArray(value) ? value.map(one).join(', ') : one(value);
      }
      case 'lookup':
      case 'lookup_many': {
        const one = (id: unknown) => {
          const s = String(id);
          if (f.target === 'user') return this.ctx.data.users[s]?.name ?? '';
          if (f.target === 'org_unit') return this.ctx.data.units[s]?.name ?? '';
          return this.ctx.data.links[s]?.title ?? '';
        };
        return Array.isArray(value) ? value.map(one).join(', ') : one(value);
      }
      case 'formula':
        if (f.resultType === 'number')
          return formatNumber(value, this.locale, Number.isInteger(Number(value)) ? 0 : 2);
        if (f.resultType === 'date') return formatDate(value, this.locale);
        return String(value);
      case 'file':
      case 'image':
      case 'table':
        return '';
      default:
        return String(value);
    }
  }

  /** A scope over one record (or one table row) for placeholders. */
  scope(
    rec: DocRecord | undefined,
    entity: string,
    row?: { data: RecordData; columns: FieldDef[] },
    copy = '',
  ): TemplateScope {
    const data = row?.data ?? rec?.data ?? {};
    const fieldOf = (key: string) =>
      row ? row.columns.find((c) => c.key === key) : this.field(entity, key);
    const resolve = (path: string): { f?: FieldDef; value: unknown } => {
      const [first, ...rest] = path.split('.');
      switch (first) {
        case 'company':
          return {
            value: rest[0] === 'name' ? this.ctx.company.name : this.ctx.company.custom[rest[0]],
          };
        case 'unit': {
          const u = this.ctx.unit;
          if (!u) return { value: '' };
          return {
            value: rest[0] === 'name' ? u.name : rest[0] === 'code' ? u.code : u.custom[rest[0]],
          };
        }
        case 'today':
          return {
            value: (this.ctx.now ?? new Date()).toISOString().slice(0, 10),
            f: { key: 'today', type: 'date', label: {} },
          };
        case 'copy':
          return { value: copy };
        case 'printedBy':
          return { value: this.ctx.printedBy ?? '' };
      }
      if (!row && rec) {
        if (first === 'number') return { value: rec.number };
        if (first === 'status') {
          const state = workflowFor(this.ctx.cfg, entity)?.states.find((s) => s.key === rec.status);
          return { value: state ? this.label(state.label) : rec.status };
        }
        if (first === 'createdAt' || first === 'updatedAt')
          return { value: rec[first], f: { key: first, type: 'datetime', label: {} } };
        if (first === 'orgUnitId')
          return { value: rec.orgUnitId ? this.ctx.data.units[rec.orgUnitId]?.name : '' };
        if (first === 'createdBy') return { value: this.ctx.data.users[rec.createdBy]?.name ?? '' };
      }
      const f = fieldOf(first);
      const value = data[first];
      if (!rest.length) return { f, value };
      if (f?.type === 'currency')
        return { value: (value as Record<string, unknown> | undefined)?.[rest[0]] };
      if (f?.type === 'lookup') {
        const id = String(value ?? '');
        if (f.target === 'user') return { value: this.ctx.data.users[id]?.name };
        if (f.target === 'org_unit') return { value: this.ctx.data.units[id]?.name };
        const linked = this.ctx.data.links[id];
        if (!linked) return { value: '' };
        if (rest[0] === 'number') return { value: linked.number };
        if (rest[0] === 'name' && !this.field(linked.entity, 'name'))
          return { value: linked.title };
        return { f: this.field(linked.entity, rest[0]), value: linked.data[rest[0]] };
      }
      return { value: undefined };
    };
    return {
      text: (path, fmt) => {
        const { f, value } = resolve(path);
        return this.format(f, value, fmt);
      },
      truthy: (path) => {
        const v = resolve(path).value;
        return !(
          v === null ||
          v === undefined ||
          v === '' ||
          v === false ||
          (Array.isArray(v) && !v.length)
        );
      },
      each: (path) => {
        const f = fieldOf(path);
        const rows = data[path];
        if (f?.type !== 'table' || !Array.isArray(rows)) return [];
        return rows.map((r) =>
          this.scope(rec, entity, { data: r as RecordData, columns: f.columns ?? [] }, copy),
        );
      },
    };
  }

  /** Fills `{{placeholders}}` in text; broken text is shown as it is rather than failing the print. */
  private fill(src: string | undefined, scope: TemplateScope): string {
    if (!src) return '';
    try {
      const nodes = parseTemplate(src);
      // Block text is plain text; only advanced HTML templates may carry markup.
      return renderTemplate(this.template.mode === 'html' ? nodes : escapeText(nodes), scope);
    } catch {
      return escapeHtml(src);
    }
  }

  private fillLocalized(
    t: LocalizedText | undefined,
    scope: TemplateScope,
    joiner = ' / ',
  ): string {
    if (!t) return '';
    const texts = [...new Set(this.languages.map((l) => pickText(t, l)).filter(Boolean))];
    return texts.map((x) => this.fill(x, scope)).join(joiner);
  }

  /** Evaluates a formula over the record (fields, table columns, STATUS()). */
  private evaluate(src: string | undefined, rec: DocRecord): unknown {
    if (!src?.trim()) return undefined;
    try {
      return compileFormula(src).evaluate({
        fields: rec.data,
        now: this.ctx.now ?? new Date(),
        status: rec.status,
      });
    } catch (e) {
      if (e instanceof FormulaError) return undefined;
      throw e;
    }
  }

  private holds(condition: string | undefined, rec: DocRecord): boolean {
    if (!condition?.trim()) return true;
    const v = this.evaluate(condition, rec);
    return v !== null && v !== undefined && v !== false && v !== 0 && v !== '';
  }

  // ---- blocks ----

  private alignClass(a?: string) {
    return a ? ` align-${a}` : '';
  }

  private tableBlock(
    b: Extract<PrintBlock, { type: 'table' }>,
    rec: DocRecord,
    scope: TemplateScope,
    copy: string,
  ): string {
    let rows: { data: RecordData; entity: string; columns: FieldDef[]; rec?: DocRecord }[] = [];
    if (b.source.startsWith('related:')) {
      const [entity, field] = b.source.slice('related:'.length).split('.');
      const list = this.ctx.data.related[rec.id]?.[`${entity}.${field}`] ?? [];
      const columns = this.entities.get(entity)?.fields ?? [];
      rows = list.map((r) => ({ data: r.data, entity, columns, rec: r }));
    } else {
      const f = this.field(rec.entity, b.source);
      const list = Array.isArray(rec.data[b.source]) ? (rec.data[b.source] as RecordData[]) : [];
      rows = list.map((data) => ({ data, entity: rec.entity, columns: f?.columns ?? [] }));
    }
    const cellScope = (r: (typeof rows)[number]) =>
      r.rec
        ? this.scope(r.rec, r.entity, undefined, copy)
        : this.scope(rec, rec.entity, { data: r.data, columns: r.columns }, copy);
    const colField = (r: (typeof rows)[number] | undefined, c: PrintColumn) =>
      r?.columns.find((x) => x.key === c.path.split('.')[0]);
    const numeric = (c: PrintColumn) => {
      const f = colField(rows[0], c);
      return (
        c.format === 'currency' ||
        c.format === 'number' ||
        ['integer', 'decimal', 'currency', 'percent'].includes(f?.type ?? '') ||
        (f?.type === 'formula' && f.resultType === 'number')
      );
    };
    const head = b.columns
      .map((c) => {
        const f = colField(rows[0], c);
        const label = c.label ? this.label(c.label) : f ? this.label(f.label) : c.path;
        const width = c.width ? ` style="width:${c.width}%"` : '';
        return `<th class="${c.align ? `align-${c.align}` : numeric(c) ? 'align-right' : ''}"${width}>${escapeHtml(label)}</th>`;
      })
      .join('');
    const body = rows
      .map((r, i) => {
        const s = cellScope(r);
        const cells = b.columns
          .map((c) => {
            const cls = c.align ? `align-${c.align}` : numeric(c) ? 'align-right' : '';
            return `<td class="${cls}">${escapeHtml(s.text(c.path, c.format))}</td>`;
          })
          .join('');
        return `<tr>${b.numbered ? `<td class="num">${i + 1}</td>` : ''}${cells}</tr>`;
      })
      .join('');
    let totals = '';
    if (b.totals?.length) {
      const cells = b.columns
        .map((c) => {
          if (!b.totals!.includes(c.path)) return '<td></td>';
          const sum = rows.reduce((s, r) => {
            const v = r.data[c.path];
            const n = Number(
              typeof v === 'object' && v && 'amount' in v ? (v as { amount: unknown }).amount : v,
            );
            return Number.isFinite(n) ? s + n : s;
          }, 0);
          const f = colField(rows[0], c);
          const fmt: ValueFormat =
            c.format && c.format !== 'auto'
              ? c.format
              : f?.type === 'currency'
                ? 'currency'
                : 'number';
          return `<td class="align-right">${escapeHtml(this.format(f?.type === 'currency' ? f : undefined, sum, fmt))}</td>`;
        })
        .join('');
      totals = `<tr class="total">${b.numbered ? '<td></td>' : ''}${cells}</tr>`;
    }
    void scope;
    return `<table class="items"><thead><tr>${b.numbered ? '<th class="num">#</th>' : ''}${head}</tr></thead><tbody>${body}${totals}</tbody></table>`;
  }

  private block(b: PrintBlock, rec: DocRecord, scope: TemplateScope, copy: string): string {
    if (!this.holds(b.condition, rec)) return '';
    switch (b.type) {
      case 'letterhead': {
        const logo =
          b.logo && this.ctx.images[b.logo]
            ? `<img class="logo" src="${this.ctx.images[b.logo]}">`
            : '';
        const lines = b.lines
          .map(
            (l, i) =>
              `<div class="${i === 0 ? 'lh-first' : 'lh-line'}">${this.fillLocalized(l, scope)}</div>`,
          )
          .join('');
        const pos = b.logoPosition ?? 'left';
        return `<header class="letterhead logo-${pos}">${logo}<div class="lh-text">${lines}</div></header>`;
      }
      case 'title':
        return `<h1 class="title${this.alignClass(b.align ?? 'center')}"${b.size ? ` style="font-size:${b.size}pt"` : ''}>${this.fillLocalized(b.text, scope)}</h1>`;
      case 'fields': {
        const items = b.items
          .map((i) => {
            const [first] = i.path.split('.');
            const f = this.field(rec.entity, first);
            const label = i.label ? this.label(i.label) : f ? this.label(f.label) : i.path;
            return `<div class="fld"><span class="lbl">${escapeHtml(label)}</span><span class="val">${escapeHtml(scope.text(i.path, i.format))}</span></div>`;
          })
          .join('');
        return `<section class="fields cols-${b.columns}">${items}</section>`;
      }
      case 'table':
        return this.tableBlock(b, rec, scope, copy);
      case 'totals': {
        const rows = b.rows
          .map((r) => {
            const v = this.evaluate(r.value, rec);
            const text = this.format(undefined, v, r.format ?? 'currency');
            return `<tr class="${r.bold ? 'strong' : ''}"><td>${escapeHtml(this.label(r.label))}</td><td class="align-right">${escapeHtml(text)}</td></tr>`;
          })
          .join('');
        const words = b.words
          ? `<p class="words">${b.words.label ? `<span class="lbl">${escapeHtml(this.label(b.words.label))}</span> ` : ''}${escapeHtml(this.format(undefined, this.evaluate(b.words.value, rec), 'words'))}</p>`
          : '';
        return `<section class="totals"><table>${rows}</table>${words}</section>`;
      }
      case 'text': {
        const style = [b.size ? `font-size:${b.size}pt` : '', b.bold ? 'font-weight:700' : '']
          .filter(Boolean)
          .join(';');
        const html = this.fillLocalized(b.text, scope, '<br>').replace(/\n/g, '<br>');
        return `<p class="text${this.alignClass(b.align)}"${style ? ` style="${style}"` : ''}>${html}</p>`;
      }
      case 'qr': {
        const value = this.plainFill(b.value, scope);
        const svg = this.ctx.images[`qr:${value}`] ?? '';
        const size = b.size ?? 30;
        const caption = b.caption
          ? `<div class="caption">${escapeHtml(this.label(b.caption))}</div>`
          : '';
        return `<div class="code${this.alignClass(b.align)}"><img src="${svg}" style="width:${size}mm;height:${size}mm">${caption}</div>`;
      }
      case 'barcode': {
        const value = this.plainFill(b.value, scope);
        const svg = this.ctx.images[`bar:${value}`] ?? '';
        return `<div class="code${this.alignClass(b.align)}"><img src="${svg}" style="height:${b.height ?? 12}mm"></div>`;
      }
      case 'signature': {
        const img =
          b.image && this.ctx.images[b.image]
            ? `<img src="${this.ctx.images[b.image]}">`
            : '<div class="sign-line"></div>';
        return `<div class="signature${this.alignClass(b.align ?? 'right')}">${img}<div class="lbl">${escapeHtml(this.label(b.name))}</div><div>${escapeHtml(this.label(b.title))}</div></div>`;
      }
      case 'image': {
        const src = this.ctx.images[b.file];
        return src
          ? `<div class="image${this.alignClass(b.align)}"><img src="${src}" style="width:${b.width ?? 40}mm"></div>`
          : '';
      }
      case 'divider':
        return '<hr>';
      case 'spacer':
        return `<div style="height:${b.height}mm"></div>`;
      case 'page_break':
        return '<div class="page-break"></div>';
    }
  }

  /** Placeholder text without HTML escaping, for QR and barcode content. */
  plainFill(src: string, scope: TemplateScope): string {
    try {
      return renderTemplate(parseTemplate(src), scope, (s) => s);
    } catch {
      return src;
    }
  }

  /** QR and barcode values the template needs, so they can be drawn before rendering. */
  codes(rec: DocRecord): { qr: string[]; bar: string[] } {
    const scope = this.scope(rec, rec.entity);
    const qr: string[] = [];
    const bar: string[] = [];
    for (const b of this.template.blocks ?? []) {
      if (!this.holds(b.condition, rec)) continue;
      if (b.type === 'qr') qr.push(this.plainFill(b.value, scope));
      if (b.type === 'barcode') bar.push(this.plainFill(b.value, scope));
    }
    return { qr, bar };
  }

  // ---- document ----

  private css(bodyText: string): string {
    const t = this.template;
    const accent = t.accent ?? '#1f3a5f';
    const font = fontCss(bodyText);
    return `${font.css}
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;font-family:${font.family};font-size:${t.fontSize ?? 10}pt;color:#111;line-height:1.35}
.align-left{text-align:left}.align-center{text-align:center}.align-right{text-align:right}
h1.title{font-size:16pt;margin:4mm 0;color:${accent}}
.letterhead{display:flex;gap:4mm;align-items:center;border-bottom:2px solid ${accent};padding-bottom:3mm;margin-bottom:3mm}
.letterhead.logo-right{flex-direction:row-reverse}.letterhead.logo-center{flex-direction:column;text-align:center}
.letterhead .logo{max-height:22mm;max-width:45mm}
.lh-first{font-size:14pt;font-weight:700;color:${accent}}
.fields{display:grid;gap:1.5mm 6mm;margin:3mm 0}
.fields.cols-1{grid-template-columns:1fr}.fields.cols-2{grid-template-columns:1fr 1fr}.fields.cols-3{grid-template-columns:1fr 1fr 1fr}
.fld .lbl{color:#555;margin-inline-end:2mm}.fld .val{font-weight:600}
table.items{width:100%;border-collapse:collapse;margin:3mm 0}
table.items thead{display:table-header-group}
table.items th{background:${accent};color:#fff;font-weight:600;padding:1.5mm 2mm;text-align:start}
table.items td{border-bottom:1px solid #ddd;padding:1.5mm 2mm;vertical-align:top}
table.items tr{page-break-inside:avoid}
table.items tr.total td{font-weight:700;border-top:2px solid ${accent};border-bottom:none}
table.items .num{width:8mm;text-align:center}
table.items th.align-right{text-align:right}
.totals{display:flex;flex-direction:column;align-items:flex-end;margin:2mm 0}
.totals table{border-collapse:collapse;min-width:60mm}
.totals td{padding:1mm 2mm}.totals tr.strong td{font-weight:700;border-top:1px solid #333}
.words{margin:2mm 0;font-style:italic;text-align:start;width:100%}
.code{margin:2mm 0}.code .caption{font-size:8pt;color:#555}
.signature{margin-top:12mm}.signature img{max-height:18mm}.signature .sign-line{display:inline-block;width:50mm;border-bottom:1px solid #333;height:10mm}
.signature .lbl{font-weight:600}
hr{border:none;border-top:1px solid #bbb;margin:3mm 0}
.page-break{page-break-after:always}
.copy-label{position:fixed;top:0;inset-inline-end:0;font-size:8pt;border:1px solid #999;padding:0.5mm 2mm;color:#333}
.watermark{position:fixed;top:40%;left:0;right:0;text-align:center;font-size:64pt;font-weight:700;color:rgba(200,0,0,0.12);transform:rotate(-30deg);z-index:-1}
.doc-footer{position:fixed;bottom:0;left:0;right:0;font-size:8pt;color:#555;text-align:center}
${t.mode === 'html' ? (t.css ?? '') : ''}`;
  }

  /** The HTML pages (one per copy) for one record. */
  render(rec: DocRecord): RenderedDocument {
    const t = this.template;
    const copies = t.copies?.length ? t.copies.map((c) => this.label(c)) : [''];
    const watermark = (t.watermarks ?? []).find((w) => this.holds(w.condition, rec));
    const dir = RTL.has(this.lang.split('-')[0]) ? 'rtl' : 'ltr';
    const pages = copies.map((copy) => {
      const scope = this.scope(rec, rec.entity, undefined, copy);
      const body =
        t.mode === 'html'
          ? this.fill(t.html, scope)
          : (t.blocks ?? []).map((b) => this.block(b, rec, scope, copy)).join('\n');
      const extras = [
        copy ? `<div class="copy-label">${escapeHtml(copy)}</div>` : '',
        watermark ? `<div class="watermark">${escapeHtml(this.label(watermark.text))}</div>` : '',
        t.footer?.text
          ? `<div class="doc-footer">${this.fillLocalized(t.footer.text, scope)}</div>`
          : '',
      ].join('');
      const text = body + extras;
      return `<!doctype html><html lang="${escapeHtml(this.lang)}" dir="${dir}"><head><meta charset="utf-8"><style>${this.css(text)}</style></head><body>${extras}<div class="doc">${body}</div></body></html>`;
    });
    const width = THERMAL_WIDTH_MM[t.page.size];
    const margin = t.page.margin ?? (width ? 2 : 12);
    const footerTemplate = t.footer?.pageNumbers
      ? '<div style="font-size:8px;width:100%;text-align:center;color:#555"><span class="pageNumber"></span> / <span class="totalPages"></span></div>'
      : '';
    const pdf: PdfPage = width
      ? { size: { widthMm: width }, marginMm: margin }
      : {
          size: {
            format: t.page.size as 'A4' | 'A5' | 'Letter' | 'Legal',
            landscape: t.page.orientation === 'landscape',
          },
          marginMm: margin,
          footerTemplate,
        };
    const scope = this.scope(rec, rec.entity);
    const name = t.fileName
      ? this.plainFill(t.fileName, scope)
      : `${pickText(t.label, this.lang)}-${rec.number ?? rec.id}`;
    return {
      pages,
      pdf,
      fileName: `${safeFileName(name) || 'document'}.pdf`,
    };
  }
}

/** A file name without path separators, reserved characters or control characters. */
function safeFileName(name: string): string {
  return [...name]
    .map((ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? '_' : ch))
    .join('')
    .slice(0, 100);
}

/** Escapes the literal text of a parsed template (values are escaped when rendered). */
function escapeText(nodes: TemplateNode[]): TemplateNode[] {
  return nodes.map((n): TemplateNode => {
    switch (n.kind) {
      case 'text':
        return { kind: 'text', value: escapeHtml(n.value) };
      case 'each':
        return { ...n, body: escapeText(n.body) };
      case 'if':
        return { ...n, then: escapeText(n.then), else: escapeText(n.else) };
      default:
        return n;
    }
  });
}
