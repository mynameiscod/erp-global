import {
  formatNumber as formatScaled,
  type CurrencyValue,
  type EffectiveConfig,
  type FieldDef,
  type LocalizedText,
} from '@erp/metadata';
import { formatCurrency, formatDate, formatDateTime, formatNumber } from '../lib/format';

export interface DisplayContext {
  cfg: EffectiveConfig;
  locale: string;
  label: (t: LocalizedText | undefined) => string;
  /** Titles of linked records, users and org units, by id. */
  titles?: Map<string, string>;
}

export interface TaxSummaryLine {
  component: string;
  rate: number;
  taxable: number;
  amount: number;
}

/** Name of a tax component (CGST, VAT…) from the tax data, or its key. */
export function taxComponentLabel(key: string, ctx: DisplayContext): string {
  return ctx.label(ctx.cfg.taxes?.components.find((c) => c.key === key)?.label) || key;
}

/** Name of the tax rule that applied (e.g. "Intra-state"), or its key. */
export function taxRuleLabel(key: string, ctx: DisplayContext): string {
  return ctx.label(ctx.cfg.taxes?.rules.find((r) => r.key === key)?.label) || key;
}

/** Values the tax engine fills: amounts with their decimals, the rule and summary by name. */
function taxValue(f: FieldDef, v: unknown, ctx: DisplayContext): string {
  if (f.key === 'tax_rule') return taxRuleLabel(String(v), ctx);
  if (f.key === 'tax_summary' && Array.isArray(v))
    return (v as TaxSummaryLine[])
      .map(
        (s) =>
          `${taxComponentLabel(s.component, ctx)} ${formatScaled(s.rate, ctx.locale)}%: ${formatScaled(s.amount, ctx.locale, 2)}`,
      )
      .join(' · ');
  if (f.type === 'percent') return `${formatScaled(v, ctx.locale)}%`;
  if (f.type === 'decimal') return formatScaled(v, ctx.locale, f.scale ?? 2);
  return String(v);
}

/** A field value as plain text for lists and read-only views. */
export function displayValue(f: FieldDef | undefined, v: unknown, ctx: DisplayContext): string {
  if (v === undefined || v === null || v === '') return '';
  if (!f) return String(v);
  if (f.calculated === 'tax') return taxValue(f, v, ctx);
  switch (f.type) {
    case 'currency': {
      const c = v as CurrencyValue;
      return formatCurrency(Number(c.amount), c.currency, ctx.locale);
    }
    case 'decimal':
    case 'integer':
      return formatNumber(Number(v), ctx.locale);
    case 'percent':
      return `${formatNumber(Number(v), ctx.locale)}%`;
    case 'formula':
      if (f.resultType === 'number') return formatNumber(Number(v), ctx.locale);
      if (f.resultType === 'date') return formatDate(String(v), ctx.locale, 'UTC');
      if (f.resultType === 'boolean') return v ? '✓' : '✗';
      return String(v);
    case 'date':
      return formatDate(`${String(v)}T00:00:00Z`, ctx.locale, 'UTC');
    case 'datetime':
      return formatDateTime(String(v), ctx.locale);
    case 'boolean':
      return v ? '✓' : '✗';
    case 'select':
    case 'multiselect': {
      const list = ctx.cfg.picklists.find((p) => p.key === f.picklist);
      const values = Array.isArray(v) ? v : [v];
      return values
        .map((x) => ctx.label(list?.options.find((o) => o.value === x)?.label) || String(x))
        .join(', ');
    }
    case 'lookup':
    case 'lookup_many': {
      const values = Array.isArray(v) ? v : [v];
      return values.map((id) => ctx.titles?.get(String(id)) ?? '…').join(', ');
    }
    case 'file':
    case 'image':
      return '📎';
    case 'table':
      return Array.isArray(v) ? `▦ ${v.length}` : '';
    default:
      return String(v);
  }
}
