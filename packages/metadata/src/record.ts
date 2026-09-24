import { compileFormula, FormulaError } from './formula';
import { COMPUTED_TYPES, type EffectiveConfig, type EntityDef, type FieldDef } from './types';

export type RecordData = Record<string, unknown>;

export interface RecordIssue {
  field: string;
  message: string;
}

export interface RecordContext {
  cfg: Pick<EffectiveConfig, 'picklists'>;
  /** Used for currency fields without a fixed currency. */
  companyCurrency: string;
  now?: Date;
}

export interface CurrencyValue {
  amount: string;
  currency: string;
}

type Result = { ok: true; value: unknown } | { ok: false; message: string };
const ok = (value: unknown): Result => ({ ok: true, value });
const fail = (message: string): Result => ({ ok: false, message });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID_RE = /^[a-f0-9]{24}$/;
const FILE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DECIMAL_RE = /^-?\d{1,15}(\.\d{1,12})?$/;

export function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

function toDecimal(v: unknown, scale: number): string | undefined {
  const s =
    typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim().replace(/,/g, '') : '';
  if (!DECIMAL_RE.test(s)) return undefined;
  return Number(s).toFixed(scale);
}

function inRange(n: number, f: FieldDef): string | undefined {
  if (f.min !== undefined && n < f.min) return `Must be at least ${f.min}`;
  if (f.max !== undefined && n > f.max) return `Must be at most ${f.max}`;
  return undefined;
}

/** Checks and normalizes one value for its field type. */
export function normalizeValue(f: FieldDef, v: unknown, ctx: RecordContext): Result {
  switch (f.type) {
    case 'text':
    case 'longtext': {
      if (typeof v !== 'string') return fail('Must be text');
      const s = v.trim();
      const max = f.maxLength ?? (f.type === 'text' ? 500 : 10000);
      if (s.length > max) return fail(`At most ${max} characters`);
      if (f.minLength && s.length < f.minLength) return fail(`At least ${f.minLength} characters`);
      if (f.pattern && !new RegExp(f.pattern).test(s))
        return fail('Does not match the required format');
      return ok(s);
    }
    case 'integer': {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isSafeInteger(n)) return fail('Must be a whole number');
      const r = inRange(n, f);
      return r ? fail(r) : ok(n);
    }
    case 'decimal':
    case 'percent': {
      const d = toDecimal(v, f.scale ?? 2);
      if (d === undefined) return fail('Must be a number');
      const r = inRange(Number(d), f);
      return r ? fail(r) : ok(d);
    }
    case 'currency': {
      const raw =
        typeof v === 'object' && v !== null
          ? (v as Partial<CurrencyValue>)
          : { amount: v as string };
      const currency = (raw.currency ?? f.currency ?? ctx.companyCurrency).toUpperCase();
      if (f.currency && currency !== f.currency) return fail(`Currency must be ${f.currency}`);
      if (!/^[A-Z]{3}$/.test(currency)) return fail('Invalid currency');
      const amount = toDecimal(raw.amount, f.scale ?? 2);
      if (amount === undefined) return fail('Must be an amount');
      const r = inRange(Number(amount), f);
      return r ? fail(r) : ok({ amount, currency } satisfies CurrencyValue);
    }
    case 'date': {
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v))
        return fail('Use the format YYYY-MM-DD');
      const d = new Date(`${v}T00:00:00Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v)
        return fail('Not a valid date');
      return ok(v);
    }
    case 'datetime': {
      const d = typeof v === 'string' ? new Date(v) : undefined;
      if (!d || Number.isNaN(d.getTime())) return fail('Not a valid date and time');
      return ok(d.toISOString());
    }
    case 'time':
      return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(v)
        ? ok(v)
        : fail('Use the format HH:MM');
    case 'boolean':
      return typeof v === 'boolean' ? ok(v) : fail('Must be yes or no');
    case 'email': {
      const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
      return s.length <= 254 && EMAIL_RE.test(s) ? ok(s) : fail('Not a valid email');
    }
    case 'phone': {
      const s = typeof v === 'string' ? v.replace(/[\s\-().]/g, '') : '';
      return /^\+[1-9]\d{6,14}$/.test(s)
        ? ok(s)
        : fail('Use international format, e.g. +919876543210');
    }
    case 'url': {
      if (typeof v !== 'string' || v.length > 2000) return fail('Not a valid link');
      try {
        const u = new URL(v.trim());
        return ['http:', 'https:'].includes(u.protocol)
          ? ok(u.toString())
          : fail('Link must start with http or https');
      } catch {
        return fail('Not a valid link');
      }
    }
    case 'select':
    case 'multiselect': {
      const list = ctx.cfg.picklists.find((p) => p.key === f.picklist);
      const allowed = new Set(list?.options.filter((o) => o.active !== false).map((o) => o.value));
      if (f.type === 'select')
        return typeof v === 'string' && allowed.has(v) ? ok(v) : fail('Choose one of the options');
      if (!Array.isArray(v) || v.length > 100) return fail('Choose from the options');
      const unique = [...new Set(v)];
      return unique.every((x) => typeof x === 'string' && allowed.has(x))
        ? ok(unique)
        : fail('Choose from the options');
    }
    case 'lookup':
      return typeof v === 'string' && ID_RE.test(v) ? ok(v) : fail('Invalid reference');
    case 'lookup_many': {
      if (!Array.isArray(v) || v.length > 100) return fail('Invalid references');
      const unique = [...new Set(v)];
      return unique.every((x) => typeof x === 'string' && ID_RE.test(x))
        ? ok(unique)
        : fail('Invalid references');
    }
    case 'file':
    case 'image':
      return typeof v === 'string' && FILE_ID_RE.test(v) ? ok(v) : fail('Invalid file');
    case 'formula':
    case 'autonumber':
      return fail('Calculated automatically');
  }
}

function coerceFormula(f: FieldDef, v: unknown): unknown {
  if (v === null || v === undefined) return undefined;
  switch (f.resultType) {
    case 'number': {
      const n = Number(v);
      return Number.isFinite(n) ? Math.round(n * 1e10) / 1e10 : undefined;
    }
    case 'boolean':
      return Boolean(v);
    case 'date': {
      const d = new Date(String(v));
      return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
    }
    default:
      return String(v);
  }
}

/** Formula fields in an order where each one's inputs are computed first. */
export function formulaOrder(entity: EntityDef): FieldDef[] {
  const formulas = new Map(
    entity.fields.filter((f) => f.type === 'formula' && f.formula).map((f) => [f.key, f]),
  );
  const order: FieldDef[] = [];
  const seen = new Set<string>();
  const visit = (key: string, depth: number) => {
    if (seen.has(key) || depth > formulas.size) return;
    const f = formulas.get(key)!;
    for (const dep of compileFormula(f.formula!).fields)
      if (formulas.has(dep)) visit(dep, depth + 1);
    seen.add(key);
    order.push(f);
  };
  for (const key of formulas.keys()) visit(key, 0);
  return order;
}

/** Evaluates formula fields in place. A formula that cannot be evaluated leaves the field empty. */
export function computeFormulas(entity: EntityDef, data: RecordData, now = new Date()): void {
  for (const f of formulaOrder(entity)) {
    let value: unknown;
    try {
      value = coerceFormula(f, compileFormula(f.formula!).evaluate({ fields: data, now }));
    } catch (err) {
      if (!(err instanceof FormulaError)) throw err;
      value = undefined;
    }
    if (value === undefined) delete data[f.key];
    else data[f.key] = value;
  }
}

/**
 * Validates client input for a record and returns the full, normalized data
 * (existing values + changes + defaults + formulas). Used by the server before
 * saving and by the browser for instant feedback, so both apply the same rules.
 * Auto-numbers, uniqueness and lookups are checked by the server afterwards.
 */
export function validateRecord(
  entity: EntityDef,
  input: unknown,
  ctx: RecordContext,
  existing?: RecordData,
): { data: RecordData; issues: RecordIssue[] } {
  const issues: RecordIssue[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { data: {}, issues: [{ field: '', message: 'Record data must be an object' }] };
  }
  const fields = new Map(entity.fields.map((f) => [f.key, f]));
  const data: RecordData = { ...(existing ?? {}) };

  if (!existing) {
    for (const f of entity.fields) {
      if (
        !f.archived &&
        !COMPUTED_TYPES.has(f.type) &&
        f.default !== undefined &&
        !(f.key in input)
      ) {
        const r = normalizeValue(f, f.default, ctx);
        if (r.ok) data[f.key] = r.value;
      }
    }
  }

  for (const [key, value] of Object.entries(input)) {
    const f = fields.get(key);
    if (!f) {
      issues.push({ field: key, message: 'Unknown field' });
      continue;
    }
    if (COMPUTED_TYPES.has(f.type)) {
      if (!isEmpty(value)) issues.push({ field: key, message: 'Calculated automatically' });
      continue;
    }
    if (f.archived) {
      if (!isEmpty(value)) issues.push({ field: key, message: 'This field is archived' });
      continue;
    }
    if (isEmpty(value)) {
      delete data[key];
      continue;
    }
    const r = normalizeValue(f, value, ctx);
    if (r.ok) data[key] = r.value;
    else issues.push({ field: key, message: r.message });
  }

  for (const f of entity.fields) {
    if (f.required && !f.archived && !COMPUTED_TYPES.has(f.type) && isEmpty(data[f.key])) {
      if (!issues.some((i) => i.field === f.key))
        issues.push({ field: f.key, message: 'Required' });
    }
  }

  if (!issues.length) computeFormulas(entity, data, ctx.now);
  return { data, issues };
}
