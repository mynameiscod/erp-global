import { Types } from 'mongoose';
import type { CurrencyValue, EntityDef, FieldDef, RecordData } from '@erp/metadata';

/**
 * Money and decimals travel as strings ("1500.50") so no precision is lost,
 * and are stored as Decimal128 so the database sorts and compares them as
 * numbers. Date-times are stored as dates.
 */
export function toStorage(entity: Pick<EntityDef, 'fields'>, data: RecordData): RecordData {
  return fieldsToStorage(entity.fields, data);
}

function fieldsToStorage(fields: FieldDef[], data: RecordData): RecordData {
  const out: RecordData = { ...data };
  for (const f of fields) {
    const v = out[f.key];
    if (v === undefined || v === null) continue;
    if (f.type === 'table' && Array.isArray(v)) {
      // Rows keep the same storage types as fields, so totals and sorting stay exact.
      out[f.key] = v.map((row) => fieldsToStorage(f.columns ?? [], row as RecordData));
    } else if ((f.type === 'decimal' || f.type === 'percent') && typeof v === 'string') {
      out[f.key] = Types.Decimal128.fromString(v);
    } else if (f.type === 'currency' && typeof v === 'object') {
      const c = v as CurrencyValue;
      out[f.key] = { amount: Types.Decimal128.fromString(c.amount), currency: c.currency };
    } else if (f.type === 'datetime' && typeof v === 'string') {
      out[f.key] = new Date(v);
    }
  }
  return out;
}

function decimalString(v: unknown, scale: number): string {
  return Number(String(v)).toFixed(scale);
}

export function fromStorage(
  entity: Pick<EntityDef, 'fields'> | undefined,
  data: RecordData,
): RecordData {
  const out: RecordData = {};
  const fields = new Map(entity?.fields.map((f) => [f.key, f]));
  for (const [k, v] of Object.entries(data ?? {})) {
    const f = fields.get(k);
    if (f?.type === 'table' && Array.isArray(v)) {
      out[k] = v.map((row) => fromStorage({ fields: f.columns ?? [] }, row as RecordData));
    } else if (v instanceof Types.Decimal128) out[k] = decimalString(v, f?.scale ?? 2);
    else if (v instanceof Date) out[k] = v.toISOString();
    else if (f?.type === 'currency' && v && typeof v === 'object') {
      const c = v as { amount: unknown; currency: string };
      out[k] = { amount: decimalString(c.amount, f.scale ?? 2), currency: c.currency };
    } else out[k] = v;
  }
  return out;
}

/** Normalized text for unique checks: case-insensitive for text-like values. */
export function uniqueKey(v: unknown): string {
  if (v && typeof v === 'object' && 'amount' in v) return String((v as CurrencyValue).amount);
  return String(v).trim().toLowerCase();
}
