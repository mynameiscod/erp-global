import { isEmpty, type EntityDef, type FieldDef, type RecordData } from '@erp/metadata';

type Values = Record<string, unknown>;
type Row = RecordData & { _id?: string };

/** A linked record to read, and how to copy its values into the form once it arrives. */
export interface DefaultFill {
  target: string;
  id: string;
  apply: (linked: RecordData, values: Values) => Values;
}

const ID_RE = /^[a-f0-9]{24}$/;

const sourceOf = (f: FieldDef) => {
  const [lookup, field] = (f.defaultFrom ?? '').split('.');
  return lookup && field ? { lookup, field } : undefined;
};

/** A copied value in the shape of the field it goes into (e.g. a price's amount into a number). */
export function coerceDefault(f: FieldDef, v: unknown, companyCurrency: string): unknown {
  const amount =
    typeof v === 'object' && v !== null && 'amount' in v ? (v as { amount: unknown }).amount : v;
  switch (f.type) {
    case 'integer':
    case 'decimal':
    case 'percent':
      return amount === undefined || amount === null ? undefined : String(amount);
    case 'currency':
      if (typeof v === 'object' && v !== null && 'amount' in v) return v;
      return amount === undefined || amount === null || amount === ''
        ? undefined
        : { amount: String(amount), currency: f.currency ?? companyCurrency };
    case 'text':
    case 'longtext':
      return typeof v === 'object' && v !== null ? undefined : String(v);
    default:
      return v;
  }
}

/** Fills empty fields in `values` from `linked` for the fields whose source is `lookup`. */
function fillFrom(
  fields: FieldDef[],
  lookup: string,
  values: RecordData,
  linked: RecordData,
  currency: string,
): RecordData {
  let out = values;
  for (const f of fields) {
    const src = sourceOf(f);
    if (f.archived || src?.lookup !== lookup || !isEmpty(out[f.key])) continue;
    const v = coerceDefault(f, linked[src.field], currency);
    if (!isEmpty(v)) out = { ...out, [f.key]: v };
  }
  return out;
}

/**
 * Lookups that changed between two versions of the form, and the fields (or line columns)
 * with `defaultFrom` that should take a value from the newly chosen record. Values already
 * typed are kept; the server fills the same fields on save.
 */
export function defaultFills(
  entity: EntityDef,
  prev: Values,
  next: Values,
  companyCurrency: string,
): DefaultFill[] {
  const fills: DefaultFill[] = [];
  const fields = entity.fields.filter((f) => !f.archived);
  const tables = fields.filter((f) => f.type === 'table' && f.columns?.some((c) => c.defaultFrom));
  const target = (f: FieldDef | undefined) =>
    f?.type === 'lookup' && f.target && f.target !== 'user' && f.target !== 'org_unit'
      ? f.target
      : undefined;

  // Record lookups: fill record fields, and line columns that read the record's lookup.
  for (const f of fields) {
    const tgt = target(f);
    const id = next[f.key];
    if (!tgt || typeof id !== 'string' || !ID_RE.test(id) || id === prev[f.key]) continue;
    const recordWants = fields.some((x) => sourceOf(x)?.lookup === f.key);
    const lineTables = tables.filter(
      (t) =>
        !t.columns!.some((c) => c.key === f.key) &&
        t.columns!.some((c) => sourceOf(c)?.lookup === f.key),
    );
    if (!recordWants && !lineTables.length) continue;
    fills.push({
      target: tgt,
      id,
      apply: (linked, values) => {
        if (values[f.key] !== id) return values;
        let out = fillFrom(fields, f.key, values, linked, companyCurrency);
        for (const t of lineTables) {
          if (!Array.isArray(out[t.key])) continue;
          out = {
            ...out,
            [t.key]: (out[t.key] as Row[]).map((r) =>
              fillFrom(t.columns!, f.key, r, linked, companyCurrency),
            ),
          };
        }
        return out;
      },
    });
  }

  // Line lookups: fill the other columns of the same line.
  for (const t of tables) {
    const rows = Array.isArray(next[t.key]) ? (next[t.key] as Row[]) : [];
    const before = Array.isArray(prev[t.key]) ? (prev[t.key] as Row[]) : [];
    const columns = t.columns!.filter((c) => !c.archived);
    rows.forEach((row, i) => {
      const old = row._id ? before.find((r) => r._id === row._id) : before[i];
      for (const c of columns) {
        const tgt = target(c);
        const id = row[c.key];
        if (!tgt || typeof id !== 'string' || !ID_RE.test(id) || id === old?.[c.key]) continue;
        if (!columns.some((x) => sourceOf(x)?.lookup === c.key)) continue;
        fills.push({
          target: tgt,
          id,
          apply: (linked, values) => {
            if (!Array.isArray(values[t.key])) return values;
            const list = values[t.key] as Row[];
            const at = row._id ? list.findIndex((r) => r._id === row._id) : i;
            if (at < 0 || list[at]?.[c.key] !== id) return values;
            const updated = fillFrom(columns, c.key, list[at], linked, companyCurrency);
            if (updated === list[at]) return values;
            return { ...values, [t.key]: list.map((r, j) => (j === at ? updated : r)) };
          },
        });
      }
    });
  }
  return fills;
}
