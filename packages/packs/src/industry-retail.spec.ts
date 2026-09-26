import {
  emptyLayer,
  installPack,
  packManifestSchema,
  platformBaseLayer,
  resolveEffective,
  validateRecord,
  validateTenantConfig,
  type EntityDef,
  type PackManifest,
  type TenantConfig,
} from '@erp/metadata';
import { INDIA } from './country-in';
import { RETAIL } from './industry-retail';

const base = [platformBaseLayer()];
const empty: TenantConfig = { company: emptyLayer(), orgUnits: {} };
const with_ = (...packs: PackManifest[]) =>
  packs.reduce<TenantConfig>((c, p) => installPack(c, p, { now: new Date('2026-09-26') }), empty);
/** Stands in an id for every `@ref`, at any depth, as the installer does. */
const withIds = (v: unknown): unknown =>
  typeof v === 'string' && v.startsWith('@')
    ? 'a'.repeat(24)
    : Array.isArray(v)
      ? v.map(withIds)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withIds(x)]))
        : v;
const effective = (...packs: PackManifest[]) =>
  resolveEffective(base, with_(...packs), { version: 1, defaultFiscalYearStart: 4 });

describe('Retail pack', () => {
  it('is a well-formed manifest', () => {
    expect(packManifestSchema.safeParse(RETAIL).success).toBe(true);
  });

  it('validates on its own and with India in either order', () => {
    expect(validateTenantConfig(with_(RETAIL), { base })).toEqual([]);
    expect(validateTenantConfig(with_(INDIA, RETAIL), { base })).toEqual([]);
    expect(validateTenantConfig(with_(RETAIL, INDIA), { base })).toEqual([]);
  });

  it.each([
    ['alone', [RETAIL]],
    ['with India', [INDIA, RETAIL]],
  ] as const)('has valid sample records (%s)', (_name, packs) => {
    const cfg = effective(...packs);
    const seen = new Set<string>();
    for (const s of RETAIL.samples ?? []) {
      const entity = cfg.entities.find((e) => e.key === s.entity) as EntityDef;
      expect(entity).toBeDefined();
      const data = withIds(s.data) as Record<string, unknown>;
      const { issues } = validateRecord(entity, data, { cfg, companyCurrency: 'INR' });
      for (const ref of JSON.stringify(s.data).match(/"@[a-z0-9_]+"/g) ?? [])
        expect(seen).toContain(ref.slice(2, -1));
      seen.add(s.ref);
      expect({ sample: s.ref, issues: issues.filter((i) => i.message !== 'Required') }).toEqual({
        sample: s.ref,
        issues: [],
      });
    }
  });

  it('totals a bill without a Country Pack, with change for cash', () => {
    const cfg = effective(RETAIL);
    const sale = cfg.entities.find((e) => e.key === 'rt_sale')!;
    const { data, issues } = validateRecord(
      sale,
      {
        date: '2026-09-26',
        payment_mode: 'cash',
        amount_tendered: '500',
        lines: [
          { qty: 2, rate: '165' },
          { qty: 1.5, rate: '60' },
        ],
      },
      { cfg, companyCurrency: 'INR' },
    );
    expect(issues).toEqual([]);
    expect(data).toMatchObject({
      subtotal: 420,
      tax_total: 0,
      grand_total: 420,
      change_due: 80,
      total_qty: 3.5,
    });
  });

  it('with India, splits GST-inclusive prices into CGST and SGST within the state', () => {
    const cfg = effective(INDIA, RETAIL);
    const sale = cfg.entities.find((e) => e.key === 'rt_sale')!;
    expect(sale.tax).toMatchObject({
      inclusive: true,
      category: 'tax_category',
      document: 'invoice',
    });
    const item = cfg.entities.find((e) => e.key === 'rt_item')!;
    expect(item.fields.map((f) => f.key)).toEqual(expect.arrayContaining(['hsn', 'gst_category']));
    expect(cfg.printTemplates.map((t) => t.key)).toEqual(
      expect.arrayContaining(['rt_pos_receipt', 'rt_invoice', 'gst_invoice', 'gst_credit_note']),
    );

    const { data, issues } = validateRecord(
      sale,
      {
        date: '2026-09-26',
        payment_mode: 'upi',
        place_of_supply: '36',
        lines: [
          { qty: 2, rate: '590', tax_category: 'gst_18', hsn: '1006' },
          { qty: 1, rate: '105', tax_category: 'gst_5', hsn: '3306' },
        ],
      },
      {
        cfg,
        companyCurrency: 'INR',
        taxContext: { sellerRegion: '36', buyerRegion: '36', companyCountry: 'IN' },
      },
    );
    expect(issues).toEqual([]);
    expect(data).toMatchObject({
      tax_rule: 'intra',
      subtotal: 1100,
      tax_total: 185,
      grand_total: 1285,
      gst_section: 'B2CS',
    });
    expect(data.tax_summary).toEqual(
      expect.arrayContaining([
        { component: 'cgst', rate: 9, taxable: 1000, amount: 90 },
        { component: 'sgst', rate: 9, taxable: 1000, amount: 90 },
        { component: 'cgst', rate: 2.5, taxable: 100, amount: 2.5 },
        { component: 'sgst', rate: 2.5, taxable: 100, amount: 2.5 },
      ]),
    );
  });

  it('keeps the sales return tax-inclusive as a credit note', () => {
    const cfg = effective(RETAIL, INDIA);
    const ret = cfg.entities.find((e) => e.key === 'rt_sales_return')!;
    expect(ret.tax).toMatchObject({ inclusive: true, document: 'credit_note', lines: 'lines' });
  });
});
