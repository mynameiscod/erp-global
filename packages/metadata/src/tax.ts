import { z } from 'zod';
import { compileFormula, FormulaError } from './formula';
import { condition, keySchema, localizedTextSchema } from './schema-base';
import type { EntityDef, FieldDef, LocalizedText } from './types';

type RecordData = Record<string, unknown>;

/**
 * A country-neutral tax engine. Countries supply data: the tax components (CGST, VAT…),
 * the categories an item is taxed at, and the rules that choose the components for a
 * sale. Entities opt in by mapping their line items (`EntityTaxSettings`).
 */

export interface TaxComponent {
  key: string;
  label: LocalizedText;
}

export type TaxCategoryKind = 'taxable' | 'exempt' | 'nil' | 'non_taxable';

export interface TaxCategory {
  key: string;
  label: LocalizedText;
  /** The main rate in percent, split across components by the rule that applies. */
  rate: number;
  /** Taxes charged on top whatever the rule (e.g. cess). */
  extra?: { component: string; rate: number }[];
  kind?: TaxCategoryKind;
}

export interface TaxRule {
  key: string;
  label: LocalizedText;
  /**
   * When the rule applies, over: seller_region, buyer_region, buyer_country,
   * company_country, buyer_registered, reverse_charge. The first rule that holds wins.
   */
  condition?: string;
  /** How the main rate is shared, e.g. CGST 0.5 + SGST 0.5, or IGST 1. */
  split: { component: string; share: number }[];
  /** No tax at all under this rule (e.g. exports). */
  zero?: boolean;
}

export interface TaxSetup {
  components: TaxComponent[];
  categories: TaxCategory[];
  rules: TaxRule[];
  /** Category for lines that name none. */
  defaultCategory?: string;
  /** Round the grand total to a whole unit (e.g. rupee), showing the difference as round-off. */
  roundTotal?: boolean;
}

/** Where a tax input comes from: a field (`place_of_supply`), a linked record's field (`customer.state`) or the org unit's (`unit.state`). */
export type TaxSource = string;

export interface EntityTaxSettings {
  /** The table field with the line items. */
  lines: string;
  /** The line's value before tax (a number, currency or formula column). */
  amount: string;
  /** The line's tax category (a select column with category keys). */
  category?: string;
  /** HSN/SAC or similar code column, kept for reports. */
  code?: string;
  sellerRegion?: TaxSource;
  buyerRegion?: TaxSource;
  buyerCountry?: TaxSource;
  buyerRegistered?: TaxSource;
  reverseCharge?: TaxSource;
  /** Line values include tax. */
  inclusive?: boolean;
  /** What kind of document this is, for tax reports and templates. */
  document?: 'invoice' | 'credit_note' | 'debit_note' | 'bill_of_supply' | 'receipt';
}

/** Values the rules read, resolved by the server (from fields, linked records and the org unit). */
export interface TaxContext {
  sellerRegion?: string | null;
  buyerRegion?: string | null;
  buyerCountry?: string | null;
  companyCountry?: string | null;
  buyerRegistered?: boolean;
  reverseCharge?: boolean;
}

// ---- fields the engine fills ----

/** Keys the engine adds to each line and to the record. They cannot be used for other fields. */
export const TAX_LINE_FIELDS = ['taxable_value', 'tax_rate', 'tax_amount'] as const;
export const TAX_RECORD_FIELDS = [
  'subtotal',
  'tax_total',
  'round_off',
  'grand_total',
  'tax_rule',
  'tax_summary',
] as const;

const calc = (
  key: string,
  type: FieldDef['type'],
  en: string,
  extra: Partial<FieldDef> = {},
): FieldDef => ({
  key,
  type,
  label: { en },
  calculated: 'tax',
  ...extra,
});

/** The entity with the tax fields added (to its line items and to the record). */
export function withTaxFields<T extends Pick<EntityDef, 'fields' | 'tax'>>(entity: T): T {
  const tax = entity.tax;
  if (!tax) return entity;
  const lines = entity.fields.find((f) => f.key === tax.lines && f.type === 'table');
  if (!lines) return entity;
  const lineFields = [
    calc('taxable_value', 'decimal', 'Taxable value', { scale: 2 }),
    calc('tax_rate', 'percent', 'Tax rate', { scale: 2 }),
    calc('tax_amount', 'decimal', 'Tax', { scale: 2 }),
  ];
  const existing = new Set((lines.columns ?? []).map((c) => c.key));
  const table: FieldDef = {
    ...lines,
    columns: [...(lines.columns ?? []), ...lineFields.filter((f) => !existing.has(f.key))],
  };
  const recordFields = [
    calc('subtotal', 'decimal', 'Subtotal', { scale: 2 }),
    calc('tax_total', 'decimal', 'Tax total', { scale: 2 }),
    calc('round_off', 'decimal', 'Round off', { scale: 2 }),
    calc('grand_total', 'decimal', 'Grand total', { scale: 2 }),
    calc('tax_rule', 'text', 'Tax type'),
    calc('tax_summary', 'table', 'Tax summary', {
      columns: [
        calc('component', 'text', 'Tax'),
        calc('rate', 'percent', 'Rate', { scale: 2 }),
        calc('taxable', 'decimal', 'Taxable value', { scale: 2 }),
        calc('amount', 'decimal', 'Amount', { scale: 2 }),
      ],
    }),
  ];
  const has = new Set(entity.fields.map((f) => f.key));
  return {
    ...entity,
    fields: [
      ...entity.fields.map((f) => (f.key === tax.lines ? table : f)),
      ...recordFields.filter((f) => !has.has(f.key)),
    ],
  };
}

// ---- calculation ----

const round = (n: number, dp = 2) => {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
};

const numberOf = (v: unknown): number => {
  const raw =
    typeof v === 'object' && v !== null && 'amount' in v ? (v as { amount: unknown }).amount : v;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
};

/** The first rule whose condition holds for this sale. */
export function pickTaxRule(setup: TaxSetup, ctx: TaxContext): TaxRule | undefined {
  const fields = {
    seller_region: ctx.sellerRegion ?? '',
    buyer_region: ctx.buyerRegion ?? '',
    buyer_country: ctx.buyerCountry ?? '',
    company_country: ctx.companyCountry ?? '',
    buyer_registered: !!ctx.buyerRegistered,
    reverse_charge: !!ctx.reverseCharge,
  };
  for (const r of setup.rules) {
    if (!r.condition?.trim()) return r;
    try {
      const v = compileFormula(r.condition).evaluate({ fields, now: new Date() });
      if (v !== null && v !== false && v !== 0 && v !== '') return r;
    } catch (e) {
      if (!(e instanceof FormulaError)) throw e;
    }
  }
  return undefined;
}

/**
 * Fills the tax fields of a record in place: per line the taxable value, rate and tax;
 * per record the summary by component and rate, totals and round-off.
 */
export function computeTaxes(
  entity: Pick<EntityDef, 'tax'>,
  data: RecordData,
  setup: TaxSetup | undefined,
  ctx: TaxContext,
): void {
  const settings = entity.tax;
  if (!settings) return;
  const rows = Array.isArray(data[settings.lines]) ? (data[settings.lines] as RecordData[]) : [];
  const categories = new Map((setup?.categories ?? []).map((c) => [c.key, c]));
  const rule = setup ? pickTaxRule(setup, ctx) : undefined;
  const summary = new Map<
    string,
    { component: string; rate: number; taxable: number; amount: number }
  >();
  let subtotal = 0;
  let taxTotal = 0;
  for (const row of rows) {
    const base = numberOf(row[settings.amount]);
    const catKey = settings.category ? (row[settings.category] as string | undefined) : undefined;
    const cat = categories.get(catKey ?? '') ?? categories.get(setup?.defaultCategory ?? '');
    const taxable = !!cat && (cat.kind ?? 'taxable') === 'taxable' && !!rule && !rule.zero;
    const mainRate = taxable ? cat!.rate : 0;
    const extras = taxable ? (cat!.extra ?? []) : [];
    const totalRate = mainRate + extras.reduce((s, e) => s + e.rate, 0);
    const value = settings.inclusive ? base / (1 + totalRate / 100) : base;
    const lineTaxable = round(value);
    const parts: { component: string; rate: number; amount: number }[] = [];
    if (taxable) {
      for (const s of rule!.split) {
        const rate = round(mainRate * s.share, 4);
        parts.push({ component: s.component, rate, amount: round((lineTaxable * rate) / 100) });
      }
      for (const e of extras)
        parts.push({
          component: e.component,
          rate: e.rate,
          amount: round((lineTaxable * e.rate) / 100),
        });
    }
    const lineTax = round(parts.reduce((s, p) => s + p.amount, 0));
    row.taxable_value = lineTaxable;
    row.tax_rate = round(totalRate, 4);
    row.tax_amount = lineTax;
    subtotal += lineTaxable;
    taxTotal += lineTax;
    for (const p of parts) {
      const key = `${p.component}|${p.rate}`;
      const s = summary.get(key) ?? { component: p.component, rate: p.rate, taxable: 0, amount: 0 };
      s.taxable = round(s.taxable + lineTaxable);
      s.amount = round(s.amount + p.amount);
      summary.set(key, s);
    }
  }
  subtotal = round(subtotal);
  taxTotal = round(taxTotal);
  // Under reverse charge the buyer pays the tax; the document shows it but does not charge it.
  const charged = ctx.reverseCharge ? subtotal : round(subtotal + taxTotal);
  const grand = setup?.roundTotal ? Math.round(charged) : charged;
  data.subtotal = subtotal;
  data.tax_total = taxTotal;
  data.round_off = round(grand - charged);
  data.grand_total = round(grand);
  if (rule) data.tax_rule = rule.key;
  else delete data.tax_rule;
  const list = [...summary.values()].filter((s) => s.amount !== 0 || s.taxable !== 0);
  if (list.length) data.tax_summary = list;
  else delete data.tax_summary;
}

// ---- schema ----

const rate = z.number().min(0).max(100);

export const taxSetupSchema = z
  .object({
    components: z.array(z.object({ key: keySchema, label: localizedTextSchema }).strict()).max(20),
    categories: z
      .array(
        z
          .object({
            key: keySchema,
            label: localizedTextSchema,
            rate,
            extra: z
              .array(z.object({ component: keySchema, rate }).strict())
              .max(5)
              .optional(),
            kind: z.enum(['taxable', 'exempt', 'nil', 'non_taxable']).optional(),
          })
          .strict(),
      )
      .max(100),
    rules: z
      .array(
        z
          .object({
            key: keySchema,
            label: localizedTextSchema,
            condition,
            split: z
              .array(z.object({ component: keySchema, share: z.number().min(0).max(1) }).strict())
              .max(5),
            zero: z.boolean().optional(),
          })
          .strict(),
      )
      .max(20),
    defaultCategory: keySchema.optional(),
    roundTotal: z.boolean().optional(),
  })
  .strict();

const source = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{1,39}(\.[a-z][a-z0-9_]{1,39})?$/,
    'Use a field, linked field or unit.field',
  );

export const entityTaxSchema = z
  .object({
    lines: keySchema,
    amount: keySchema,
    category: keySchema.optional(),
    code: keySchema.optional(),
    sellerRegion: source.optional(),
    buyerRegion: source.optional(),
    buyerCountry: source.optional(),
    buyerRegistered: source.optional(),
    reverseCharge: source.optional(),
    inclusive: z.boolean().optional(),
    document: z
      .enum(['invoice', 'credit_note', 'debit_note', 'bill_of_supply', 'receipt'])
      .optional(),
  })
  .strict();

/** Merges tax data of several layers: later layers add or replace items by key. */
export function mergeTaxSetups(list: (TaxSetup | undefined)[]): TaxSetup | undefined {
  const present = list.filter((t): t is TaxSetup => !!t);
  if (!present.length) return undefined;
  const byKey = <T extends { key: string }>(pick: (t: TaxSetup) => T[]) => {
    const m = new Map<string, T>();
    for (const t of present) for (const x of pick(t)) m.set(x.key, x);
    return [...m.values()];
  };
  const last = <K extends keyof TaxSetup>(k: K) =>
    present.reduce<TaxSetup[K] | undefined>((v, t) => t[k] ?? v, undefined);
  return {
    components: byKey((t) => t.components),
    categories: byKey((t) => t.categories),
    rules: byKey((t) => t.rules),
    defaultCategory: last('defaultCategory'),
    roundTotal: last('roundTotal'),
  };
}
