import type { CurrencyValue, EffectiveConfig, FieldDef, LocalizedText } from '@erp/metadata';
import { formatCurrency, formatDate, formatDateTime, formatNumber } from '../lib/format';

export interface DisplayContext {
  cfg: EffectiveConfig;
  locale: string;
  label: (t: LocalizedText | undefined) => string;
  /** Titles of linked records, users and org units, by id. */
  titles?: Map<string, string>;
}

/** A field value as plain text for lists and read-only views. */
export function displayValue(f: FieldDef | undefined, v: unknown, ctx: DisplayContext): string {
  if (v === undefined || v === null || v === '') return '';
  if (!f) return String(v);
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
