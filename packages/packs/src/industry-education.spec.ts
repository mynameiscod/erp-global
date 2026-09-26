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
  type ConfigLayer,
  type EntityDef,
  type PackManifest,
  type TenantConfig,
} from '@erp/metadata';
import { INDIA } from './country-in';
import { EDUCATION } from './industry-education';

const base = [platformBaseLayer()];
const empty: TenantConfig = { company: emptyLayer(), orgUnits: {} };
const with_ = (...packs: PackManifest[]) =>
  packs.reduce<TenantConfig>((c, p) => installPack(c, p, { now: new Date('2026-09-26') }), empty);
const withIds = (v: unknown): unknown =>
  typeof v === 'string' && v.startsWith('@')
    ? 'a'.repeat(24)
    : Array.isArray(v)
      ? v.map(withIds)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withIds(x)]))
        : v;
const refsIn = (v: unknown): string[] =>
  typeof v === 'string' && v.startsWith('@')
    ? [v.slice(1)]
    : Array.isArray(v)
      ? v.flatMap(refsIn)
      : v && typeof v === 'object'
        ? Object.values(v).flatMap(refsIn)
        : [];
const effective = (...packs: PackManifest[]) =>
  resolveEffective(base, with_(...packs), { version: 1, defaultFiscalYearStart: 4 });

describe('Education pack', () => {
  it('has a well-formed manifest and layer', () => {
    expect(packManifestSchema.safeParse(EDUCATION).success).toBe(true);
    const layer = configLayerSchema.safeParse(normalizeLayer(EDUCATION.layer as ConfigLayer));
    expect(layer.success ? [] : layer.error.issues).toEqual([]);
  });

  it('validates on its own', () => {
    expect(validateTenantConfig(with_(EDUCATION), { base })).toEqual([]);
  });

  it('validates with India, installed in either order', () => {
    expect(validateTenantConfig(with_(INDIA, EDUCATION), { base })).toEqual([]);
    expect(validateTenantConfig(with_(EDUCATION, INDIA), { base })).toEqual([]);
  });

  it('targets dashboards and reports at its own roles by key', () => {
    const keys = new Set(EDUCATION.roles!.map((r) => r.key));
    const layer = normalizeLayer(EDUCATION.layer as ConfigLayer);
    for (const d of layer.dashboards) {
      expect(d.roleIds).toBeUndefined();
      for (const k of d.roleKeys ?? []) expect(keys).toContain(k);
    }
    for (const r of layer.reports) for (const k of r.roleKeys ?? []) expect(keys).toContain(k);
    for (const w of layer.workflows)
      for (const a of w.actions) for (const k of a.roleKeys ?? []) expect(keys).toContain(k);
    for (const a of layer.automations)
      for (const act of a.actions)
        if (act.type === 'notify')
          for (const r of act.recipients) if (r.type === 'role') expect(keys).toContain(r.roleKey);
    // Nothing is limited by role through a condition: roles are named by key instead.
    expect(JSON.stringify(layer)).not.toContain('HAS_ROLE');
    for (const r of EDUCATION.roles!)
      for (const p of r.permissions)
        expect(p).toMatch(/^(records\.edu_[a-z_]+\.(read|create|update|delete)|reports\.[a-z]+)$/);
  });

  it.each([
    ['alone', [EDUCATION]],
    ['with India', [INDIA, EDUCATION]],
  ])('has valid sample records (%s)', (_name, packs) => {
    const cfg = effective(...packs);
    const refs = new Set<string>();
    for (const s of EDUCATION.samples ?? []) {
      const entity = cfg.entities.find((e) => e.key === s.entity) as EntityDef;
      expect(entity).toBeDefined();
      // Every @ref, table rows included, names an earlier sample; the installer gives them ids.
      for (const r of refsIn(s.data)) if (r !== 'unit') expect(refs).toContain(r);
      refs.add(s.ref);
      const data = withIds(s.data) as Record<string, unknown>;
      const { issues } = validateRecord(entity, data, { cfg, companyCurrency: 'INR' });
      expect({ sample: s.ref, issues: issues.filter((i) => i.message !== 'Required') }).toEqual({
        sample: s.ref,
        issues: [],
      });
    }
  });

  it('totals a fee receipt through its line formulas without a Country Pack', () => {
    const cfg = effective(EDUCATION);
    const receipt = cfg.entities.find((e) => e.key === 'edu_fee_receipt')!;
    const { data, issues } = validateRecord(
      receipt,
      {
        customer: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        date: '2026-07-05',
        payment_mode: 'cash',
        lines: [
          { item: 'bbbbbbbbbbbbbbbbbbbbbbbb', qty: 1, rate: '12000' },
          { item: 'cccccccccccccccccccccccc', qty: 3, rate: '1500' },
        ],
      },
      { cfg, companyCurrency: 'INR' },
    );
    expect(issues).toEqual([]);
    expect((data.lines as { amount: number }[]).map((l) => l.amount)).toEqual([12000, 4500]);
    expect(data).toMatchObject({ subtotal: 16500, tax_total: 0, grand_total: 16500 });
  });

  it('with India, fee heads default to Exempt and a receipt carries no GST', () => {
    const cfg = effective(INDIA, EDUCATION);
    const head = cfg.entities.find((e) => e.key === 'edu_fee_head')!;
    expect(head.fields.find((f) => f.key === 'gst_category')).toMatchObject({
      default: 'gst_exempt',
    });
    // A new fee head gets the exempt category.
    const h = validateRecord(
      head,
      { name: 'Tuition fee', price: '12000' },
      {
        cfg,
        companyCurrency: 'INR',
      },
    );
    expect(h.issues).toEqual([]);
    expect(h.data.gst_category).toBe('gst_exempt');

    const receipt = cfg.entities.find((e) => e.key === 'edu_fee_receipt')!;
    expect(receipt.tax).toMatchObject({ lines: 'lines', category: 'tax_category' });
    expect(cfg.printTemplates.map((t) => t.key)).toEqual(
      expect.arrayContaining(['edu_fee_receipt', 'gst_invoice']),
    );
    // The line's category is copied from the fee head on save (`item.gst_category`).
    const { data, issues } = validateRecord(
      receipt,
      {
        customer: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        date: '2026-07-05',
        payment_mode: 'cash',
        place_of_supply: '36',
        lines: [{ qty: 1, rate: '12000', tax_category: h.data.gst_category }],
      },
      {
        cfg,
        companyCurrency: 'INR',
        taxContext: { sellerRegion: '36', buyerRegion: '36', companyCountry: 'IN' },
      },
    );
    expect(issues).toEqual([]);
    expect(data).toMatchObject({
      subtotal: 12000,
      tax_total: 0,
      grand_total: 12000,
      gst_section: 'B2CS',
    });
    expect((data.lines as { tax_amount: number }[])[0].tax_amount).toBe(0);
  });

  it('creates the student when an admission is admitted', () => {
    const layer = normalizeLayer(EDUCATION.layer as ConfigLayer);
    const wf = layer.workflows.find((w) => w.entity === 'edu_admission')!;
    expect(wf.states.map((s) => s.key)).toEqual([
      'applied',
      'verified',
      'approved',
      'admitted',
      'rejected',
    ]);
    const a = layer.automations.find((x) => x.key === 'edu_admit_create_student')!;
    expect(a.trigger).toEqual({ type: 'status_changed', to: 'admitted' });
    expect(a.actions).toContainEqual(
      expect.objectContaining({ type: 'create', entity: 'edu_student' }),
    );
    expect(wf.actions.find((x) => x.key === 'approve')!.roleKeys).toEqual(['principal']);
  });
});
