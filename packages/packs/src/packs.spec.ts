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
import { CATALOG } from './index';

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

const countries = CATALOG.filter((p) => p.type === 'country');
const industries = CATALOG.filter((p) => p.type === 'industry');

/** A tiny industry following the conventions, to test country patches before real industries. */
const demo: PackManifest = {
  id: 'industry.demo_shop',
  type: 'industry',
  version: '1.0.0',
  name: { en: 'Demo shop' },
  description: { en: 'Test' },
  layer: {
    entities: [
      {
        key: 'shop_customer',
        kind: 'custom',
        label: { en: 'Customer' },
        pluralLabel: { en: 'Customers' },
        titleField: 'name',
        orgScoped: false,
        roles: ['customer'],
        fields: [{ key: 'name', type: 'text', label: { en: 'Name' }, required: true }],
      },
      {
        key: 'shop_item',
        kind: 'custom',
        label: { en: 'Item' },
        pluralLabel: { en: 'Items' },
        titleField: 'name',
        orgScoped: false,
        roles: ['item'],
        fields: [
          { key: 'name', type: 'text', label: { en: 'Name' }, required: true },
          { key: 'price', type: 'currency', label: { en: 'Price' } },
        ],
      },
      {
        key: 'shop_bill',
        kind: 'custom',
        label: { en: 'Bill' },
        pluralLabel: { en: 'Bills' },
        roles: ['sales_invoice'],
        tax: { lines: 'lines', amount: 'amount', document: 'invoice' },
        fields: [
          { key: 'customer', type: 'lookup', target: 'shop_customer', label: { en: 'Customer' } },
          { key: 'date', type: 'date', label: { en: 'Date' } },
          {
            key: 'lines',
            type: 'table',
            label: { en: 'Items' },
            columns: [
              { key: 'item', type: 'lookup', target: 'shop_item', label: { en: 'Item' } },
              { key: 'qty', type: 'integer', label: { en: 'Qty' } },
              { key: 'rate', type: 'currency', label: { en: 'Rate' }, defaultFrom: 'item.price' },
              {
                key: 'amount',
                type: 'formula',
                label: { en: 'Amount' },
                formula: 'qty * rate',
                resultType: 'number',
              },
            ],
          },
        ],
      },
    ],
  },
};

describe('pack catalog', () => {
  it('has well-formed manifests with unique ids', () => {
    for (const p of CATALOG) expect(packManifestSchema.safeParse(p).success).toBe(true);
    expect(new Set(CATALOG.map((p) => p.id)).size).toBe(CATALOG.length);
  });

  it.each(CATALOG.map((p) => [p.id, p] as const))('%s validates on its own', (_id, pack) => {
    expect(validateTenantConfig(with_(pack), { base })).toEqual([]);
  });

  it.each(
    countries.flatMap((c) =>
      [...industries, demo].map((i) => [`${c.id} + ${i.id}`, c, i] as const),
    ),
  )('%s validates together', (_name, country, industry) => {
    expect(validateTenantConfig(with_(country, industry), { base })).toEqual([]);
    // Installed the other way round too.
    expect(validateTenantConfig(with_(industry, country), { base })).toEqual([]);
  });

  it('validates every industry together with every country', () => {
    expect(validateTenantConfig(with_(...CATALOG), { base })).toEqual([]);
  });

  it.each(CATALOG.map((p) => [p.id, p] as const))(
    '%s samples refer only to earlier samples and to known entities',
    (_id, pack) => {
      const cfg = resolveEffective(base, with_(pack), { version: 1, defaultFiscalYearStart: 4 });
      const seen = new Set<string>();
      const refs = (v: unknown): string[] =>
        typeof v === 'string' && v.startsWith('@') && v !== '@unit'
          ? [v.slice(1)]
          : Array.isArray(v)
            ? v.flatMap(refs)
            : v && typeof v === 'object'
              ? Object.values(v).flatMap(refs)
              : [];
      for (const s of pack.samples ?? []) {
        expect({ ref: s.ref, entity: cfg.entities.some((e) => e.key === s.entity) }).toEqual({
          ref: s.ref,
          entity: true,
        });
        expect({ ref: s.ref, missing: refs(s.data).filter((r) => !seen.has(r)) }).toEqual({
          ref: s.ref,
          missing: [],
        });
        seen.add(s.ref);
      }
    },
  );

  // (Skipped while the catalog has no industries.)
  (industries.length
    ? it.each(industries.map((p) => [p.id, p] as const))
    : it.skip.each([['none', demo] as const]))('%s sample records are valid', (_id, pack) => {
    const cfg = resolveEffective(base, with_(pack), { version: 1, defaultFiscalYearStart: 4 });
    for (const s of pack.samples ?? []) {
      const entity = cfg.entities.find((e) => e.key === s.entity) as EntityDef;
      expect(entity).toBeDefined();
      // References to other samples (@ref) and the top unit get ids at install, table rows too.
      const data = withIds(s.data) as Record<string, unknown>;
      const { issues } = validateRecord(entity, data, { cfg, companyCurrency: 'INR' });
      expect({ sample: s.ref, issues: issues.filter((i) => i.message !== 'Required') }).toEqual({
        sample: s.ref,
        issues: [],
      });
    }
  });
});

describe('India pack', () => {
  const india = CATALOG.find((p) => p.id === 'country.in')!;

  it('adds GST to a conforming industry and calculates it', () => {
    const cfg = resolveEffective(base, with_(demo, india), {
      version: 1,
      defaultFiscalYearStart: 4,
    });
    const bill = cfg.entities.find((e) => e.key === 'shop_bill')!;
    expect(bill.tax).toMatchObject({
      lines: 'lines',
      category: 'tax_category',
      buyerRegion: 'place_of_supply',
      sellerRegion: 'unit.state',
    });
    const lines = bill.fields.find((f) => f.key === 'lines')!;
    expect(lines.columns!.map((c) => c.key)).toEqual(
      expect.arrayContaining([
        'item',
        'qty',
        'rate',
        'amount',
        'hsn',
        'tax_category',
        'taxable_value',
      ]),
    );
    expect(cfg.printTemplates.map((t) => t.key)).toContain('gst_invoice');
    // Labels name the entity in each language; keys and paths use its key.
    const hsn = cfg.reports.find((r) => r.key === 'gstr1_hsn')!;
    expect(hsn.label.en).toContain('(Bill)');
    expect(hsn.entity).toBe('shop_bill');
    expect(cfg.reports.map((r) => r.key)).toEqual(
      expect.arrayContaining(['gstr1_b2b', 'gstr1_b2cs', 'gstr1_hsn', 'gstr3b_outward']),
    );
    const { data, issues } = validateRecord(
      bill,
      {
        customer_gstin: '36aabcu9603r1zo',
        place_of_supply: '29',
        lines: [{ qty: 2, rate: '1000', tax_category: 'gst_18', hsn: '8471' }],
      },
      {
        cfg,
        companyCurrency: 'INR',
        taxContext: {
          sellerRegion: '36',
          buyerRegion: '29',
          buyerRegistered: true,
          companyCountry: 'IN',
        },
      },
    );
    expect(issues).toEqual([]);
    expect(data).toMatchObject({
      tax_rule: 'inter',
      tax_total: 360,
      grand_total: 2360,
      gst_section: 'B2B',
    });
  });

  it('keeps statutory fields from being retyped', () => {
    const c = with_(india);
    c.company.entities.push({
      key: 'org_unit',
      fields: [{ key: 'gstin', type: 'longtext', label: { en: 'GSTIN' } }],
    });
    expect(validateTenantConfig(c, { base }).map((i) => i.message)).toContain(
      'This field is required by a Country Pack; it can be relabelled but not retyped or archived',
    );
  });
});
