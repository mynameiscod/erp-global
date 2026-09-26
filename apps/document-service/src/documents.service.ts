import { Inject, Injectable } from '@nestjs/common';
import bwipjs from 'bwip-js';
import type { Connection } from 'mongoose';
import { PDFDocument } from 'pdf-lib';
import QRCode from 'qrcode';
import { EventTypes, NotifyTypes, type AclEntry, type MailSendPayload } from '@erp/contracts';
import { OutboxWriter } from '@erp/events';
import {
  escapeHtml,
  findEntity,
  pickText,
  printTemplateSchema,
  unsafeHtmlReason,
  type EffectiveConfig,
  type EntityDef,
  type PrintTemplateDef,
  type RecordData,
} from '@erp/metadata';
import {
  AppError,
  MONGO_CONNECTION,
  UpstreamError,
  type EffectiveConfigResponse,
} from '@erp/service-kit';
import { requireContext } from '@erp/tenancy';
import { CLIENTS, type Clients } from './clients';
import { fontCss } from './fonts';
import { PdfEngine } from './pdf-engine';
import { DocumentRenderer, type DocData, type DocRecord } from './renderer';

/** Services act for the whole company (automations). */
export const COMPANY_ACL: AclEntry[] = [{ ou: 'company', path: '/', p: ['records.*.*'] }];

export interface PdfRequest {
  entity: string;
  ids: string[];
  /** Template key; the entity's first active template when empty. */
  template?: string;
  lang: string;
  acl: AclEntry[];
}

export interface Pdf {
  bytes: Buffer;
  fileName: string;
  template: PrintTemplateDef;
  records: DocRecord[];
}

const COMPANY_PATH = '/';

@Injectable()
export class DocumentsService {
  constructor(
    @Inject(CLIENTS) private readonly clients: Clients,
    @Inject(MONGO_CONNECTION) private readonly conn: Connection,
    private readonly engine: PdfEngine,
    private readonly outbox: OutboxWriter,
  ) {}

  private config(orgPath?: string): Promise<EffectiveConfigResponse> {
    return this.clients.config.effective(orgPath && orgPath !== COMPANY_PATH ? orgPath : undefined);
  }

  private pickTemplate(cfg: EffectiveConfig, entity: string, key?: string): PrintTemplateDef {
    const list = cfg.printTemplates.filter((t) => t.entity === entity && t.active !== false);
    const t = key ? list.find((x) => x.key === key) : list[0];
    if (!t) throw AppError.notFound(key ? 'Print template' : 'Print template for this');
    return t;
  }

  private async data(entity: string, ids: string[], acl: AclEntry[], related: string[] = []) {
    try {
      return await this.clients.records.post<DocData>(
        '/internal/outputs/documents/data',
        {
          entity,
          ids,
          acl,
          related: related.map((r) => {
            const [e, field] = r.slice('related:'.length).split('.');
            return { entity: e, field };
          }),
        },
        { timeoutMs: 30_000 },
      );
    } catch (e) {
      // Pass on "not found" and "not allowed" as they are.
      if (e instanceof UpstreamError && e.status < 500 && e.body) {
        throw new AppError(e.status, e.body.error.code, e.body.error.message, e.body.error.details);
      }
      throw e;
    }
  }

  /** Images the template shows, as data URIs, keyed by file id. */
  private async images(t: PrintTemplateDef): Promise<Record<string, string>> {
    const ids = new Set<string>();
    for (const b of t.blocks ?? []) {
      if (b.type === 'letterhead' && b.logo) ids.add(b.logo);
      if (b.type === 'signature' && b.image) ids.add(b.image);
      if (b.type === 'image') ids.add(b.file);
    }
    const out: Record<string, string> = {};
    await Promise.all(
      [...ids].map(async (id) => {
        try {
          const { bytes, contentType } = await this.clients.files.getBytes(
            `/internal/files/${encodeURIComponent(id)}/bytes`,
          );
          if (contentType.startsWith('image/'))
            out[id] = `data:${contentType};base64,${bytes.toString('base64')}`;
        } catch {
          // A missing image leaves its place empty rather than failing the document.
        }
      }),
    );
    return out;
  }

  private async codes(values: { qr: string[]; bar: string[] }, into: Record<string, string>) {
    for (const v of values.qr) {
      if (into[`qr:${v}`] || !v) continue;
      const svg = await QRCode.toString(v, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
      into[`qr:${v}`] = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    }
    for (const v of values.bar) {
      if (into[`bar:${v}`] || !v) continue;
      try {
        const svg = bwipjs.toSVG({
          bcid: 'code128',
          text: v,
          height: 10,
          includetext: true,
          textxalign: 'center',
        });
        into[`bar:${v}`] = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
      } catch {
        // Text a barcode cannot carry prints no barcode.
      }
    }
  }

  private async company(rec: DocRecord | undefined, cfg: EffectiveConfigResponse) {
    const fallback = { name: cfg.tenant.name ?? '', custom: {} as Record<string, unknown> };
    if (!rec?.orgUnitId) return { company: fallback, unit: undefined };
    try {
      const chain = await this.clients.org.get<
        { id: string; name: string; code: string | null; custom?: Record<string, unknown> }[]
      >(`/internal/org/units/${rec.orgUnitId}/ancestors`);
      const root = chain[0];
      const own = chain[chain.length - 1];
      return {
        company: { name: cfg.tenant.name || root?.name || '', custom: root?.custom ?? {} },
        unit: own ? { name: own.name, code: own.code, custom: own.custom ?? {} } : undefined,
      };
    } catch {
      return { company: fallback, unit: undefined };
    }
  }

  private async printedBy(): Promise<string | undefined> {
    const actor = requireContext().actor;
    if (actor?.type !== 'user') return undefined;
    const [u] = await this.clients.identity
      .post<{ id: string; name: string }[]>('/internal/users/batch', { ids: [actor.id] })
      .catch(() => []);
    return u?.name;
  }

  /** Renders one template for one record into PDF bytes (all copies). */
  private async renderRecord(
    template: PrintTemplateDef,
    rec: DocRecord,
    data: DocData,
    cfg: EffectiveConfigResponse,
    lang: string,
    images: Record<string, string>,
    printedBy?: string,
  ): Promise<{ pdfs: Buffer[]; fileName: string }> {
    const { company, unit } = await this.company(rec, cfg);
    const renderer = new DocumentRenderer(template, {
      cfg,
      data,
      company,
      unit,
      lang,
      printedBy,
      images,
    });
    await this.codes(renderer.codes(rec), images);
    const doc = renderer.render(rec);
    const pdfs: Buffer[] = [];
    for (const html of doc.pages) pdfs.push(await this.engine.render(html, doc.pdf));
    return { pdfs, fileName: doc.fileName };
  }

  private async merge(pdfs: Buffer[]): Promise<Buffer> {
    if (pdfs.length === 1) return pdfs[0];
    const out = await PDFDocument.create();
    for (const p of pdfs) {
      const src = await PDFDocument.load(p);
      for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
    }
    return Buffer.from(await out.save());
  }

  /** PDF of one or more records (merged), with the template that applies where each lives. */
  async pdf(req: PdfRequest): Promise<Pdf> {
    const first = await this.data(req.entity, req.ids, req.acl);
    // Branches can override a template, so choose it where each record lives.
    const perRecord = await Promise.all(
      first.records.map(async (r) => {
        const cfg = await this.config(r.orgPath);
        return { rec: r, cfg, template: this.pickTemplate(cfg, req.entity, req.template) };
      }),
    );
    const related = [
      ...new Set(
        perRecord.flatMap((p) =>
          (p.template.blocks ?? []).flatMap((b) =>
            b.type === 'table' && b.source.startsWith('related:') ? [b.source] : [],
          ),
        ),
      ),
    ];
    const data = related.length ? await this.data(req.entity, req.ids, req.acl, related) : first;
    const printedBy = await this.printedBy();
    const imageCache = new Map<string, Record<string, string>>();
    const pdfs: Buffer[] = [];
    let fileName = 'document.pdf';
    for (const p of perRecord) {
      const rec = data.records.find((r) => r.id === p.rec.id) ?? p.rec;
      let images = imageCache.get(p.template.key);
      if (!images) imageCache.set(p.template.key, (images = await this.images(p.template)));
      const out = await this.renderRecord(
        p.template,
        rec,
        data,
        p.cfg,
        req.lang,
        images,
        printedBy,
      );
      pdfs.push(...out.pdfs);
      fileName = out.fileName;
    }
    if (perRecord.length > 1) {
      fileName = `${pickText(perRecord[0].template.label, req.lang)}-${perRecord.length}.pdf`;
    }
    const template = perRecord[0].template;
    if (template.auditPrints) {
      await this.conn.transaction((session) =>
        this.outbox.record(
          EventTypes.DocumentPrinted,
          { entity: req.entity, recordIds: req.ids, template: template.key },
          { session },
        ),
      );
    }
    return { bytes: await this.merge(pdfs), fileName, template, records: data.records };
  }

  /** A draft template, for the designer: on a real record, or on sample values. */
  async preview(input: { template: unknown; recordId?: string; lang: string; acl: AclEntry[] }) {
    const parsed = printTemplateSchema.safeParse(input.template);
    if (!parsed.success) {
      throw AppError.badRequest(
        'The template is not complete',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    const template = parsed.data as PrintTemplateDef;
    const unsafe =
      template.mode === 'html'
        ? unsafeHtmlReason(`${template.html}\n${template.css ?? ''}`)
        : undefined;
    if (unsafe) throw AppError.badRequest(unsafe);
    let data: DocData;
    let rec: DocRecord;
    let cfg: EffectiveConfigResponse;
    if (input.recordId) {
      const related = (template.blocks ?? []).flatMap((b) =>
        b.type === 'table' && b.source.startsWith('related:') ? [b.source] : [],
      );
      data = await this.data(template.entity, [input.recordId], input.acl, related);
      rec = data.records[0];
      cfg = await this.config(rec.orgPath);
    } else {
      cfg = await this.config();
      const entity = findEntity(cfg, template.entity);
      if (!entity) throw AppError.notFound('Entity');
      rec = sampleRecord(entity, cfg);
      data = { records: [rec], links: {}, users: {}, units: {}, related: {} };
    }
    const images = await this.images(template);
    const out = await this.renderRecord(
      template,
      rec,
      data,
      cfg,
      input.lang,
      images,
      await this.printedBy(),
    );
    return { bytes: await this.merge(out.pdfs), fileName: out.fileName };
  }

  /** Stores a PDF in file-service. */
  private async store(
    bytes: Buffer,
    fileName: string,
  ): Promise<{ id: string; name: string; size: number }> {
    return this.clients.files.postBytes(
      `/internal/files/bytes?name=${encodeURIComponent(fileName)}&type=application%2Fpdf`,
      bytes,
      { timeoutMs: 30_000 },
    );
  }

  /** Emails a record's PDF. The PDF is kept in file-service, so what was sent can be found again. */
  async email(req: PdfRequest & { to: string[]; subject?: string; message?: string }) {
    const pdf = await this.pdf(req);
    const file = await this.store(pdf.bytes, pdf.fileName);
    const rec = pdf.records[0];
    const title = pickText(pdf.template.label, req.lang);
    const subject = req.subject || `${title} ${rec.number ?? ''}`.trim();
    const text = req.message || `Please find the attached ${title.toLowerCase()}.`;
    await this.conn.transaction(async (session) => {
      await this.outbox.record<MailSendPayload>(
        NotifyTypes.MailSend,
        {
          to: req.to,
          subject,
          text,
          html: `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`,
          attachments: [{ fileId: file.id, name: pdf.fileName }],
        },
        { session },
      );
      await this.outbox.record(
        EventTypes.DocumentEmailed,
        {
          entity: req.entity,
          recordId: rec.id,
          template: pdf.template.key,
          to: req.to,
          fileId: file.id,
        },
        { session },
      );
    });
    return { fileId: file.id, fileName: pdf.fileName, to: req.to };
  }

  /**
   * For automations: make the PDF, optionally put it in a file field of the record and
   * email it to addresses or to email fields of the record.
   */
  async generate(input: {
    entity: string;
    recordId: string;
    template?: string;
    lang?: string;
    attachField?: string;
    emailTo?: string[];
    emailFields?: string[];
    subject?: string;
    message?: string;
    depth: number;
  }) {
    const cfg = await this.config();
    const lang = input.lang ?? cfg.tenant.defaultLanguage ?? 'en';
    const req = {
      entity: input.entity,
      ids: [input.recordId],
      template: input.template,
      lang,
      acl: COMPANY_ACL,
    };
    const pdf = await this.pdf(req);
    const rec = pdf.records[0];
    const file = await this.store(pdf.bytes, pdf.fileName);
    if (input.attachField) {
      await this.clients.records.request(
        'PATCH',
        `/internal/records/${input.entity}/${input.recordId}`,
        { data: { [input.attachField]: file.id }, depth: input.depth + 1 },
      );
      await this.conn.transaction((session) =>
        this.outbox.record(
          EventTypes.DocumentAttached,
          { entity: input.entity, recordId: rec.id, field: input.attachField, fileId: file.id },
          { session },
        ),
      );
    }
    const to = [
      ...(input.emailTo ?? []),
      ...(input.emailFields ?? []).flatMap((f) => {
        const v = rec.data[f];
        return typeof v === 'string' && v.includes('@') ? [v] : [];
      }),
    ];
    if (to.length) {
      const title = pickText(pdf.template.label, lang);
      const subject = input.subject || `${title} ${rec.number ?? ''}`.trim();
      const text = input.message || `Please find the attached ${title.toLowerCase()}.`;
      await this.conn.transaction(async (session) => {
        await this.outbox.record<MailSendPayload>(
          NotifyTypes.MailSend,
          { to, subject, text, attachments: [{ fileId: file.id, name: pdf.fileName }] },
          { session },
        );
        await this.outbox.record(
          EventTypes.DocumentEmailed,
          {
            entity: input.entity,
            recordId: rec.id,
            template: pdf.template.key,
            to,
            fileId: file.id,
          },
          { session },
        );
      });
    }
    return { fileId: file.id, fileName: pdf.fileName, emailedTo: to };
  }

  /** A plain table as PDF (report exports), stored in file-service. */
  async tablePdf(input: {
    title: string;
    subtitle?: string;
    columns: { label: string; align?: 'left' | 'right' | 'center' }[];
    rows: string[][];
    landscape?: boolean;
    lang: string;
    fileName: string;
  }) {
    const cols = input.columns;
    const head = cols
      .map((c) => `<th class="${c.align ?? 'left'}">${escapeHtml(c.label)}</th>`)
      .join('');
    const body = input.rows
      .map(
        (r) =>
          `<tr>${cols.map((c, i) => `<td class="${c.align ?? 'left'}">${escapeHtml(r[i] ?? '')}</td>`).join('')}</tr>`,
      )
      .join('');
    const text = input.title + (input.subtitle ?? '') + head + body;
    const font = fontCss(text);
    const dir = ['ar', 'he', 'fa', 'ur'].includes(input.lang.split('-')[0]) ? 'rtl' : 'ltr';
    const html = `<!doctype html><html lang="${escapeHtml(input.lang)}" dir="${dir}"><head><meta charset="utf-8"><style>${font.css}
body{margin:0;font-family:${font.family};font-size:8pt;color:#111}
h1{font-size:13pt;margin:0 0 1mm}.sub{color:#555;margin-bottom:3mm}
table{width:100%;border-collapse:collapse}thead{display:table-header-group}
th{background:#1f3a5f;color:#fff;padding:1.2mm 1.5mm;font-weight:600}
td{border-bottom:1px solid #ddd;padding:1mm 1.5mm}tr{page-break-inside:avoid}
.left{text-align:start}.right{text-align:end}.center{text-align:center}
</style></head><body><div class="doc"><h1>${escapeHtml(input.title)}</h1>${
      input.subtitle ? `<div class="sub">${escapeHtml(input.subtitle)}</div>` : ''
    }<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div></body></html>`;
    const bytes = await this.engine.render(html, {
      size: { format: 'A4', landscape: input.landscape ?? cols.length > 6 },
      marginMm: 10,
      footerTemplate:
        '<div style="font-size:7px;width:100%;text-align:center;color:#555"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    });
    return this.store(bytes, input.fileName);
  }
}

/** Believable values for each field, so a template can be designed before any record exists. */
export function sampleRecord(entity: EntityDef, cfg: EffectiveConfigResponse): DocRecord {
  const today = new Date().toISOString().slice(0, 10);
  const sample = (f: EntityDef['fields'][number], i: number): unknown => {
    switch (f.type) {
      case 'integer':
        return 2 + i;
      case 'decimal':
      case 'percent':
        return '12.50';
      case 'currency':
        return { amount: '1250.00', currency: f.currency ?? cfg.tenant.currency };
      case 'date':
        return today;
      case 'datetime':
        return new Date().toISOString();
      case 'boolean':
        return true;
      case 'select':
        return cfg.picklists.find((p) => p.key === f.picklist)?.options[0]?.value;
      case 'formula':
        return f.resultType === 'number' ? 2500 : f.resultType === 'date' ? today : 'Sample';
      case 'table':
        return [0, 1].map((r) =>
          Object.fromEntries((f.columns ?? []).map((c, j) => [c.key, sample(c, j + r)])),
        );
      case 'lookup':
      case 'lookup_many':
      case 'file':
      case 'image':
        return undefined;
      case 'email':
        return 'someone@example.com';
      case 'phone':
        return '+919876543210';
      default:
        return `Sample ${pickText(f.label, 'en')}`;
    }
  };
  const data: RecordData = {};
  entity.fields.forEach((f, i) => {
    const v = sample(f, i);
    if (v !== undefined) data[f.key] = v;
  });
  const now = new Date().toISOString();
  return {
    id: '000000000000000000000000',
    entity: entity.key,
    number: 'SAMPLE-0001',
    status: null,
    orgUnitId: null,
    orgPath: COMPANY_PATH,
    data,
    createdAt: now,
    updatedAt: now,
    createdBy: '',
  };
}
