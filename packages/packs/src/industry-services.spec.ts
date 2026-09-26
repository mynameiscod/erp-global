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
import { SERVICES } from './industry-services';

const base = [platformBaseLayer()];
const empty: TenantConfig = { company: emptyLayer(), orgUnits: {} };
const with_ = (...packs: PackManifest[]) =>
  packs.reduce<TenantConfig>((c, p) => installPack(c, p, { now: new Date('2026-09-26') }), empty);
const CLIENT_ID = '64b7f0c2a1b2c3d4e5f60718';

/** Stands in an id for every `@ref`, at any depth, as the installer does. */
const withIds = (v: unknown): unknown =>
  typeof v === 'string' && v.startsWith('@')
    ? CLIENT_ID
    : Array.isArray(v)
      ? v.map(withIds)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withIds(x)]))
        : v;
const effective = (...packs: PackManifest[]) =>
  resolveEffective(base, with_(...packs), { version: 1, defaultFiscalYearStart: 4 });

describe('Services pack', () => {
  it('is a well-formed manifest', () => {
    expect(packManifestSchema.safeParse(SERVICES).success).toBe(true);
  });

  it('validates on its own', () => {
    expect(validateTenantConfig(with_(SERVICES), { base })).toEqual([]);
  });

  it('validates with India, installed in either order', () => {
    expect(validateTenantConfig(with_(INDIA, SERVICES), { base })).toEqual([]);
    expect(validateTenantConfig(with_(SERVICES, INDIA), { base })).toEqual([]);
  });

  it.each([
    ['alone', [SERVICES]],
    ['with India', [INDIA, SERVICES]],
  ] as const)('has valid sample records (%s)', (_name, packs) => {
    const cfg = effective(...packs);
    for (const s of SERVICES.samples ?? []) {
      const entity = cfg.entities.find((e) => e.key === s.entity) as EntityDef;
      expect(entity).toBeDefined();
      // References to other samples (@ref) get ids at install, table rows included.
      const data = withIds(s.data) as Record<string, unknown>;
      const { issues } = validateRecord(entity, data, { cfg, companyCurrency: 'INR' });
      expect({ sample: s.ref, issues: issues.filter((i) => i.message !== 'Required') }).toEqual({
        sample: s.ref,
        issues: [],
      });
    }
  });

  it('sends large quotations to the Owner role and limits invoice actions by role key', () => {
    const cfg = effective(SERVICES);
    const quote = cfg.workflows.find((w) => w.entity === 'svc_quotation')!;
    const level = quote.actions.find((a) => a.key === 'submit')!.approval!.levels[0];
    expect(level.condition).toBe('total > 100000');
    expect(level.approvers).toEqual([{ type: 'role', roleKey: 'svc_owner' }]);
    const invoice = cfg.workflows.find((w) => w.entity === 'svc_invoice')!;
    for (const key of ['issue', 'cancel'])
      expect(invoice.actions.find((a) => a.key === key)!.roleKeys).toEqual([
        'svc_owner',
        'svc_accounts',
      ]);
    const roles = new Set((SERVICES.roles ?? []).map((r) => r.key));
    const used = [...quote.actions, ...invoice.actions].flatMap((a) => a.roleKeys ?? []);
    for (const k of used) expect(roles).toContain(k);
  });

  it('works out totals, the due date and the balance without a Country Pack', () => {
    const cfg = effective(SERVICES);
    const invoice = cfg.entities.find((e) => e.key === 'svc_invoice')!;
    const { data, issues } = validateRecord(
      invoice,
      {
        customer: CLIENT_ID,
        date: '2026-09-10',
        terms_days: 30,
        lines: [
          { qty: 12, rate: '3000' },
          { qty: 1, rate: '40000' },
        ],
        amount_paid: '26000',
      },
      { cfg, companyCurrency: 'INR' },
    );
    expect(issues).toEqual([]);
    expect(data).toMatchObject({
      subtotal: 76000,
      tax_total: 0,
      grand_total: 76000,
      balance: 50000,
      due_date: '2026-10-10',
    });
    expect(data.tax_rule).toBeUndefined();
  });

  describe('with India', () => {
    const cfg = effective(INDIA, SERVICES);
    const invoice = cfg.entities.find((e) => e.key === 'svc_invoice')!;
    // A services company in Hyderabad (Telangana, 36) invoicing ₹1,00,000 of consulting at 18%.
    const bill = (placeOfSupply: string) =>
      validateRecord(
        invoice,
        {
          customer: CLIENT_ID,
          date: '2026-09-10',
          place_of_supply: placeOfSupply,
          lines: [{ qty: 1, rate: '100000', hsn: '998311', tax_category: 'gst_18' }],
        },
        {
          cfg,
          companyCurrency: 'INR',
          taxContext: { sellerRegion: '36', buyerRegion: placeOfSupply, companyCountry: 'IN' },
        },
      );

    it('adds GST fields to clients, services and invoices, but not to quotations', () => {
      const keys = (k: string) => cfg.entities.find((e) => e.key === k)!.fields.map((f) => f.key);
      expect(keys('svc_client')).toEqual(expect.arrayContaining(['gstin', 'state']));
      expect(keys('svc_service')).toEqual(expect.arrayContaining(['hsn', 'gst_category']));
      expect(keys('svc_invoice')).toEqual(
        expect.arrayContaining(['customer_gstin', 'place_of_supply', 'grand_total']),
      );
      expect(keys('svc_quotation')).not.toContain('place_of_supply');
      expect(keys('svc_quotation')).not.toContain('grand_total');
      expect(cfg.printTemplates.map((t) => t.key)).toEqual(
        expect.arrayContaining(['svc_invoice_pdf', 'gst_invoice']),
      );
    });

    it('charges CGST 9% + SGST 9% to a client in Telangana', () => {
      const { data, issues } = bill('36');
      expect(issues).toEqual([]);
      expect(data).toMatchObject({
        tax_rule: 'intra',
        tax_total: 18000,
        grand_total: 118000,
        balance: 118000,
        tax_summary: [
          { component: 'cgst', rate: 9, taxable: 100000, amount: 9000 },
          { component: 'sgst', rate: 9, taxable: 100000, amount: 9000 },
        ],
      });
    });

    it('charges IGST 18% to a client in Karnataka', () => {
      const { data, issues } = bill('29');
      expect(issues).toEqual([]);
      expect(data).toMatchObject({
        tax_rule: 'inter',
        tax_total: 18000,
        grand_total: 118000,
        tax_summary: [{ component: 'igst', rate: 18, taxable: 100000, amount: 18000 }],
      });
    });
  });
});
