import {
  configLayerSchema,
  emptyLayer,
  installPack,
  normalizeLayer,
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
import { HEALTHCARE } from './industry-healthcare';

const base = [platformBaseLayer()];
const empty: TenantConfig = { company: emptyLayer(), orgUnits: {} };
const with_ = (...packs: PackManifest[]) =>
  packs.reduce<TenantConfig>((c, p) => installPack(c, p, { now: new Date('2026-09-26') }), empty);
const effective = (...packs: PackManifest[]) =>
  resolveEffective(base, with_(...packs), { version: 1, defaultFiscalYearStart: 4 });
const PATIENT_ID = '0123456789abcdef01234567';
/** Stands in an id for every `@ref`, at any depth, as the installer does. */
const withIds = (v: unknown): unknown =>
  typeof v === 'string' && v.startsWith('@')
    ? PATIENT_ID
    : Array.isArray(v)
      ? v.map(withIds)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withIds(x)]))
        : v;
const entity = (cfg: ReturnType<typeof effective>, key: string) =>
  cfg.entities.find((e) => e.key === key) as EntityDef;

describe('Healthcare pack', () => {
  it('is a well-formed manifest', () => {
    expect(packManifestSchema.safeParse(HEALTHCARE).success).toBe(true);
    // validateTenantConfig checks the shape of the company layer only, so check the pack's here.
    expect(
      configLayerSchema.safeParse(normalizeLayer(HEALTHCARE.layer)).error?.issues,
    ).toBeUndefined();
  });

  it('validates on its own', () => {
    expect(validateTenantConfig(with_(HEALTHCARE), { base })).toEqual([]);
  });

  it('validates with India, installed in either order', () => {
    expect(validateTenantConfig(with_(INDIA, HEALTHCARE), { base })).toEqual([]);
    expect(validateTenantConfig(with_(HEALTHCARE, INDIA), { base })).toEqual([]);
  });

  it.each([
    ['alone', [HEALTHCARE]],
    ['with India', [INDIA, HEALTHCARE]],
  ] as const)('has valid sample records (%s)', (_name, packs) => {
    const cfg = effective(...packs);
    for (const s of HEALTHCARE.samples ?? []) {
      const e = entity(cfg, s.entity);
      expect(e).toBeDefined();
      // References to other samples (@ref) and the top unit get ids at install, table rows too.
      const data = withIds(s.data) as Record<string, unknown>;
      const { issues } = validateRecord(e, data, { cfg, companyCurrency: 'INR' });
      expect({ sample: s.ref, issues: issues.filter((i) => i.message !== 'Required') }).toEqual({
        sample: s.ref,
        issues: [],
      });
    }
  });

  it('totals a bill without a Country Pack', () => {
    const cfg = effective(HEALTHCARE);
    const { data, issues } = validateRecord(
      entity(cfg, 'hc_bill'),
      {
        customer: PATIENT_ID,
        date: '2026-10-01',
        lines: [
          { qty: 1, rate: '500' },
          { qty: 2, rate: '250.50' },
        ],
      },
      { cfg, companyCurrency: 'INR' },
    );
    expect(issues).toEqual([]);
    expect(data).toMatchObject({ subtotal: 1001, tax_total: 0, grand_total: 1001 });
  });

  it('with India: services default to GST exempt, and a taxable line gets GST', () => {
    const cfg = effective(HEALTHCARE, INDIA);
    const service = entity(cfg, 'hc_service');
    expect(service.fields.find((f) => f.key === 'gst_category')?.default).toBe('gst_exempt');
    expect(service.fields.map((f) => f.key)).toContain('hsn');
    expect(entity(cfg, 'hc_patient').fields.map((f) => f.key)).toContain('gstin');
    expect(cfg.printTemplates.map((t) => t.key)).toEqual(
      expect.arrayContaining(['hc_bill_receipt', 'gst_invoice']),
    );

    const bill = entity(cfg, 'hc_bill');
    expect(bill.tax).toMatchObject({ lines: 'lines', category: 'tax_category' });
    const { data, issues } = validateRecord(
      bill,
      {
        customer: PATIENT_ID,
        date: '2026-10-01',
        place_of_supply: '36',
        lines: [
          { qty: 1, rate: '500', tax_category: 'gst_exempt', hsn: '999312' },
          { qty: 1, rate: '1000', tax_category: 'gst_18', hsn: '999722' },
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
      subtotal: 1500,
      tax_total: 180,
      grand_total: 1680,
      gst_section: 'B2CS',
    });
  });
});
