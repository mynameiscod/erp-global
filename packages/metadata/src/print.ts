import { z } from 'zod';
import {
  condition,
  fileId,
  hexColor,
  keySchema,
  langTag,
  localizedTextSchema,
  longLocalized,
} from './schema-base';
import type { LocalizedText } from './types';

/**
 * Print templates: invoices, receipts, certificates. A template is a list of
 * blocks (or, in advanced mode, HTML) with `{{placeholders}}` filled from the
 * record. document-service turns it into HTML and then a PDF.
 */

export const PAGE_SIZES = ['A4', 'A5', 'Letter', 'Legal', 'thermal80', 'thermal58'] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

/** Receipt printers: fixed width, the page is as long as the content. */
export const THERMAL_WIDTH_MM: Partial<Record<PageSize, number>> = { thermal80: 80, thermal58: 58 };

export type Align = 'left' | 'center' | 'right';

/** How a value is shown. `auto` follows the field type (currency with symbol, dates per locale…). */
export const VALUE_FORMATS = ['auto', 'text', 'number', 'currency', 'date', 'words'] as const;
export type ValueFormat = (typeof VALUE_FORMATS)[number];

interface BlockBase {
  /** Stable id within the template, for the designer. */
  id: string;
  /** Show the block only when this condition holds (formula language, e.g. `STATUS() = "paid"`). */
  condition?: string;
}

export interface PrintColumn {
  /** Column key of the row (or `lookup.field` for a linked record's field). */
  path: string;
  label?: LocalizedText;
  /** Share of the table width, in percent. */
  width?: number;
  align?: Align;
  format?: ValueFormat;
}

export type PrintBlock = BlockBase &
  (
    | {
        type: 'letterhead';
        /** Logo file; `{{unit.logo}}`-style fields are not supported, upload it here. */
        logo?: string;
        logoPosition?: Align;
        /** Lines of text with placeholders, e.g. `{{company.name}}`, `{{unit.address}}`. */
        lines: LocalizedText[];
      }
    | { type: 'title'; text: LocalizedText; align?: Align; size?: number }
    | {
        type: 'fields';
        columns: 1 | 2 | 3;
        items: { path: string; label?: LocalizedText; format?: ValueFormat }[];
      }
    | {
        type: 'table';
        /** A table field of the record, or `related:<entity>.<lookup field>` (records that point here). */
        source: string;
        columns: PrintColumn[];
        /** Column paths to add up in a totals row. */
        totals?: string[];
        /** Adds a "#" column with the row number. */
        numbered?: boolean;
      }
    | {
        type: 'totals';
        rows: {
          label: LocalizedText;
          /** Formula over the record, e.g. `SUM(lines.amount)` or `grand_total`. */
          value: string;
          format?: 'number' | 'currency';
          bold?: boolean;
        }[];
        /** Amount in words, e.g. of `grand_total`. */
        words?: { value: string; label?: LocalizedText };
      }
    | { type: 'text'; text: LocalizedText; align?: Align; size?: number; bold?: boolean }
    | {
        type: 'qr';
        /** Text with placeholders, e.g. a payment link or `{{number}}`. */
        value: string;
        size?: number;
        align?: Align;
        caption?: LocalizedText;
      }
    | { type: 'barcode'; value: string; height?: number; align?: Align }
    | {
        type: 'signature';
        image?: string;
        name?: LocalizedText;
        title?: LocalizedText;
        align?: Align;
      }
    | { type: 'image'; file: string; width?: number; align?: Align }
    | { type: 'divider' }
    | { type: 'spacer'; height: number }
    | { type: 'page_break' }
  );

export type PrintBlockType = PrintBlock['type'];

export interface PrintTemplateDef {
  key: string;
  /** The entity whose records this template prints. */
  entity: string;
  label: LocalizedText;
  active?: boolean;
  page: { size: PageSize; orientation?: 'portrait' | 'landscape'; margin?: number };
  /**
   * Languages of labels and text. Empty: the reader's language. Two: bilingual
   * (e.g. English and Telugu side by side).
   */
  languages?: string[];
  /** One PDF with a labelled copy each, e.g. "Original" and "Duplicate". */
  copies?: LocalizedText[];
  /** The first watermark whose condition holds is drawn across every page. */
  watermarks?: { text: LocalizedText; condition?: string }[];
  /** Base font size in points (default 10). */
  fontSize?: number;
  /** Colour of headings and table headers. */
  accent?: string;
  mode: 'blocks' | 'html';
  blocks?: PrintBlock[];
  /** Advanced mode: HTML with placeholders. Scripts are refused. */
  html?: string;
  css?: string;
  footer?: { text?: LocalizedText; pageNumbers?: boolean };
  /** Name of the PDF, with placeholders: `Receipt-{{number}}`. */
  fileName?: string;
  /** Record every print and download in the audit log (emailed PDFs always are). */
  auditPrints?: boolean;
}

// ---- schema ----

const align = z.enum(['left', 'center', 'right']).optional();
const blockId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const pathSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,3}$/, {
  message: 'Use a field key, e.g. amount or customer.name',
});
const templateText = z.string().max(2000);
const format = z.enum(VALUE_FORMATS).optional();
const base = { id: blockId, condition };

export const printBlockSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...base,
      type: z.literal('letterhead'),
      logo: fileId.optional(),
      logoPosition: align,
      lines: z.array(longLocalized).max(10),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('title'),
      text: longLocalized,
      align,
      size: z.number().min(6).max(40).optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('fields'),
      columns: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      items: z
        .array(
          z.object({ path: pathSchema, label: localizedTextSchema.optional(), format }).strict(),
        )
        .min(1)
        .max(60),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('table'),
      source: z
        .string()
        .regex(/^([a-z][a-z0-9_]{1,39}|related:[a-z][a-z0-9_]{1,39}\.[a-z][a-z0-9_]{1,39})$/),
      columns: z
        .array(
          z
            .object({
              path: pathSchema,
              label: localizedTextSchema.optional(),
              width: z.number().min(1).max(100).optional(),
              align,
              format,
            })
            .strict(),
        )
        .min(1)
        .max(20),
      totals: z.array(pathSchema).max(20).optional(),
      numbered: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('totals'),
      rows: z
        .array(
          z
            .object({
              label: localizedTextSchema,
              value: z.string().trim().min(1).max(2000),
              format: z.enum(['number', 'currency']).optional(),
              bold: z.boolean().optional(),
            })
            .strict(),
        )
        .max(20),
      words: z
        .object({
          value: z.string().trim().min(1).max(2000),
          label: localizedTextSchema.optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('text'),
      text: longLocalized,
      align,
      size: z.number().min(6).max(40).optional(),
      bold: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('qr'),
      value: templateText.min(1),
      size: z.number().min(10).max(80).optional(),
      align,
      caption: localizedTextSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('barcode'),
      value: templateText.min(1),
      height: z.number().min(5).max(40).optional(),
      align,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('signature'),
      image: fileId.optional(),
      name: localizedTextSchema.optional(),
      title: localizedTextSchema.optional(),
      align,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('image'),
      file: fileId,
      width: z.number().min(5).max(300).optional(),
      align,
    })
    .strict(),
  z.object({ ...base, type: z.literal('divider') }).strict(),
  z.object({ ...base, type: z.literal('spacer'), height: z.number().min(1).max(200) }).strict(),
  z.object({ ...base, type: z.literal('page_break') }).strict(),
]);

export const printTemplateSchema = z
  .object({
    key: keySchema,
    entity: keySchema,
    label: localizedTextSchema,
    active: z.boolean().optional(),
    page: z
      .object({
        size: z.enum(PAGE_SIZES),
        orientation: z.enum(['portrait', 'landscape']).optional(),
        margin: z.number().min(0).max(50).optional(),
      })
      .strict(),
    languages: z.array(langTag).max(2).optional(),
    copies: z.array(localizedTextSchema).max(5).optional(),
    watermarks: z
      .array(z.object({ text: localizedTextSchema, condition }).strict())
      .max(10)
      .optional(),
    fontSize: z.number().min(6).max(16).optional(),
    accent: hexColor.optional(),
    mode: z.enum(['blocks', 'html']),
    blocks: z.array(printBlockSchema).max(80).optional(),
    html: z.string().max(100_000).optional(),
    css: z.string().max(20_000).optional(),
    footer: z
      .object({ text: longLocalized.optional(), pageNumbers: z.boolean().optional() })
      .strict()
      .optional(),
    fileName: z.string().max(120).optional(),
    auditPrints: z.boolean().optional(),
  })
  .strict();

// ---- placeholders ----

/**
 * A small, logic-less template language:
 *
 *   {{number}}                 a value, formatted for its field type
 *   {{amount|words}}           with a format: text, number, currency, date, words
 *   {{customer.name}}          a field of a linked record
 *   {{#each lines}}…{{/each}}  repeat for each row; inside, {{qty}} and {{@index}}
 *   {{#if paid}}…{{else}}…{{/if}}
 *
 * Output is always escaped. There are no expressions and no way to run code.
 */
export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

export type TemplateNode =
  | { kind: 'text'; value: string }
  | { kind: 'value'; path: string; format?: ValueFormat }
  | { kind: 'each'; path: string; body: TemplateNode[] }
  | { kind: 'if'; path: string; then: TemplateNode[]; else: TemplateNode[] };

const TAG_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;
const PATH_RE = /^(@index|[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,3})$/;
const MAX_TEMPLATE = 100_000;
const MAX_NESTING = 5;

export function parseTemplate(src: string): TemplateNode[] {
  if (src.length > MAX_TEMPLATE) throw new TemplateError('Template is too long');
  const root: TemplateNode[] = [];
  // Open sections: the list new nodes go into, and what opened it.
  const stack: {
    nodes: TemplateNode[];
    open?: Extract<TemplateNode, { kind: 'each' | 'if' }>;
    inElse?: boolean;
  }[] = [{ nodes: root }];
  let last = 0;
  const top = () => stack[stack.length - 1];
  const push = (n: TemplateNode) => {
    const t = top();
    if (t.open?.kind === 'if' && t.inElse) t.open.else.push(n);
    else t.nodes.push(n);
  };
  for (const m of src.matchAll(TAG_RE)) {
    if (m.index! > last) push({ kind: 'text', value: src.slice(last, m.index) });
    last = m.index! + m[0].length;
    const tag = m[1];
    if (tag.startsWith('#each ') || tag.startsWith('#if ')) {
      const [kw, path] = tag.slice(1).split(/\s+/, 2);
      if (!path || !PATH_RE.test(path)) throw new TemplateError(`Invalid name in {{${tag}}}`);
      if (stack.length > MAX_NESTING) throw new TemplateError('Sections are nested too deeply');
      const node: Extract<TemplateNode, { kind: 'each' | 'if' }> =
        kw === 'each' ? { kind: 'each', path, body: [] } : { kind: 'if', path, then: [], else: [] };
      push(node);
      stack.push({ nodes: node.kind === 'each' ? node.body : node.then, open: node });
      continue;
    }
    if (tag === 'else') {
      const t = top();
      if (t.open?.kind !== 'if' || t.inElse) throw new TemplateError('{{else}} without {{#if}}');
      t.inElse = true;
      continue;
    }
    if (tag === '/each' || tag === '/if') {
      const t = top();
      if (!t.open || `/${t.open.kind}` !== tag) throw new TemplateError(`Unexpected {{${tag}}}`);
      stack.pop();
      continue;
    }
    const [path, fmt] = tag.split('|').map((s) => s.trim());
    if (!PATH_RE.test(path)) throw new TemplateError(`Invalid placeholder {{${tag}}}`);
    if (fmt !== undefined && !(VALUE_FORMATS as readonly string[]).includes(fmt)) {
      throw new TemplateError(`Unknown format "${fmt}" in {{${tag}}}`);
    }
    push({ kind: 'value', path, format: fmt as ValueFormat | undefined });
  }
  if (last < src.length) push({ kind: 'text', value: src.slice(last) });
  if (stack.length > 1) throw new TemplateError(`{{#${top().open!.kind}}} is not closed`);
  return root;
}

/** What a template reads its values from. */
export interface TemplateScope {
  /** The value at `path`, formatted for display (not yet escaped). */
  text(path: string, format?: ValueFormat): string;
  truthy(path: string): boolean;
  /** Rows of a table field or list, as scopes of their own. */
  each(path: string): TemplateScope[];
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const MAX_OUTPUT = 5_000_000;

/** Renders parsed nodes. Values are escaped with `escape` (HTML by default). */
export function renderTemplate(
  nodes: TemplateNode[],
  scope: TemplateScope,
  escape: (s: string) => string = escapeHtml,
): string {
  let out = '';
  const walk = (list: TemplateNode[], s: TemplateScope, index: number | undefined) => {
    for (const n of list) {
      if (out.length > MAX_OUTPUT) throw new TemplateError('The document is too large');
      switch (n.kind) {
        case 'text':
          out += n.value;
          break;
        case 'value':
          out += escape(n.path === '@index' ? String(index ?? '') : s.text(n.path, n.format));
          break;
        case 'if':
          walk(s.truthy(n.path) ? n.then : n.else, s, index);
          break;
        case 'each':
          s.each(n.path).forEach((row, i) => walk(n.body, row, i + 1));
          break;
      }
    }
  };
  walk(nodes, scope, undefined);
  return out;
}

/**
 * Placeholder paths a template reads at the top level, for checking them against the
 * entity. Paths inside `{{#each}}` refer to the rows and are not included.
 */
export function templatePaths(nodes: TemplateNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.kind === 'value' && n.path !== '@index') out.push(n.path);
    if (n.kind === 'if') out.push(n.path, ...templatePaths([...n.then, ...n.else]));
    if (n.kind === 'each') out.push(n.path);
  }
  return out;
}

/** Advanced HTML must not carry scripts, frames or event handlers. */
export function unsafeHtmlReason(html: string): string | undefined {
  if (/<\s*(script|iframe|frame|object|embed|link|meta|base|form|input|button)\b/i.test(html))
    return 'Scripts, frames, forms and external links are not allowed in templates';
  if (/\son[a-z]+\s*=/i.test(html)) return 'Event handlers (onclick=…) are not allowed';
  if (/(javascript|vbscript)\s*:/i.test(html)) return 'Script links are not allowed';
  if (/@import|expression\s*\(/i.test(html)) return 'CSS imports and expressions are not allowed';
  return undefined;
}
