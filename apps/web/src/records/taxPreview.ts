import {
  computeFormulas,
  computeTaxes,
  isEmpty,
  TAX_LINE_FIELDS,
  TAX_RECORD_FIELDS,
  type EntityDef,
  type RecordData,
  type TaxContext,
  type TaxSetup,
} from '@erp/metadata';
import type { OrgUnitDto } from '../api/types';

type Values = Record<string, unknown>;

/** Tax inputs of an entity (`place_of_supply`, `customer.state`, `unit.state`). */
export function taxSources(entity: EntityDef | undefined): string[] {
  const t = entity?.tax;
  if (!t) return [];
  return [t.sellerRegion, t.buyerRegion, t.buyerCountry, t.buyerRegistered, t.reverseCharge].filter(
    (s): s is string => !!s,
  );
}

/** Units from the chosen one up to the top, nearest first (only those the user can see). */
export function unitChain(units: OrgUnitDto[] | undefined, orgUnitId: string): OrgUnitDto[] {
  const unit = units?.find((u) => u.id === orgUnitId);
  if (!unit || !units) return [];
  const ids = [...unit.path.split('/').filter(Boolean), unit.id].filter(
    (id, i, a) => a.indexOf(id) === i,
  );
  return ids
    .reverse()
    .map((id) => units.find((u) => u.id === id))
    .filter((u): u is OrgUnitDto => !!u);
}

/**
 * Where the sale happens, resolved in the browser the way the server does it: from a field,
 * a linked record's field or the org unit's custom field. `unresolved` is true when a region
 * could not be found here (the server may still find it, e.g. on a unit the user cannot see).
 */
export function browserTaxContext(
  entity: EntityDef,
  values: Values,
  chain: OrgUnitDto[],
  linked: Map<string, RecordData | null | undefined>,
  companyCountry: string | undefined,
): { ctx: TaxContext; unresolved: boolean } {
  const t = entity.tax!;
  const read = (source: string | undefined): unknown => {
    if (!source) return undefined;
    const [first, second] = source.split('.');
    if (first === 'unit') {
      for (const u of chain) {
        const v = u.custom?.[second];
        if (!isEmpty(v)) return v;
      }
      return undefined;
    }
    if (second === undefined) return values[first];
    return linked.get(first)?.[second];
  };
  const text = (v: unknown) => (v === undefined || v === null || v === '' ? null : String(v));
  const ctx: TaxContext = {
    sellerRegion: text(read(t.sellerRegion)),
    buyerRegion: text(read(t.buyerRegion)),
    buyerCountry: text(read(t.buyerCountry)),
    companyCountry: companyCountry ?? null,
    buyerRegistered: !isEmpty(read(t.buyerRegistered)),
    reverseCharge: read(t.reverseCharge) === true,
  };
  const unresolved =
    (!!t.sellerRegion && !ctx.sellerRegion) || (!!t.buyerRegion && !ctx.buyerRegion);
  return { ctx, unresolved };
}

/**
 * Taxes for the values being edited: row formulas first (the line amount is often one),
 * then the tax engine. Returns the values with the tax columns and totals filled in.
 * Values typed so far may be incomplete; the server calculates again on save.
 */
export function previewTaxes(
  entity: EntityDef,
  values: Values,
  setup: TaxSetup | undefined,
  ctx: TaxContext,
): Values {
  const t = entity.tax;
  const table = t && entity.fields.find((f) => f.key === t.lines && f.type === 'table');
  if (!t || !table) return values;
  const columns = (table.columns ?? []).filter((c) => !c.archived);
  const rowEntity = { fields: columns } as EntityDef;
  const rows = Array.isArray(values[t.lines]) ? (values[t.lines] as RecordData[]) : [];
  const computed = rows.map((r) => {
    const copy: RecordData = { ...r };
    for (const c of columns) {
      if (c.type === 'integer' || c.type === 'decimal' || c.type === 'percent') {
        const n = Number(copy[c.key]);
        if (!isEmpty(copy[c.key]) && Number.isFinite(n)) copy[c.key] = n;
      }
    }
    try {
      computeFormulas(rowEntity, copy);
    } catch {
      /* incomplete rows have no amount yet */
    }
    return copy;
  });
  const data: RecordData = { [t.lines]: computed };
  try {
    computeTaxes(entity, data, setup, ctx);
  } catch {
    return values;
  }
  const out: Values = { ...values };
  for (const k of TAX_RECORD_FIELDS) {
    if (data[k] === undefined) delete out[k];
    else out[k] = data[k];
  }
  if (rows.length)
    out[t.lines] = rows.map((r, i) => {
      const next: RecordData = { ...r };
      for (const k of TAX_LINE_FIELDS) next[k] = computed[i][k];
      return next;
    });
  return out;
}
