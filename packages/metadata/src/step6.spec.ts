import {
  addWorkingTime,
  amountInWordsIn,
  checkIdentifier,
  computeTaxes,
  emptyLayer,
  installPack,
  packLayers,
  previewPack,
  removePack,
  withArchivedLeftovers,
  platformBaseLayer,
  resolveEffective,
  validateRecord,
  validateTenantConfig,
  withTaxFields,
  type EntityDef,
  type IdentifierType,
  type InstalledPack,
  type PackManifest,
  type TaxSetup,
  type TenantConfig,
} from './index';

const gst: TaxSetup = {
  components: [
    { key: 'cgst', label: { en: 'CGST' } },
    { key: 'sgst', label: { en: 'SGST' } },
    { key: 'igst', label: { en: 'IGST' } },
    { key: 'cess', label: { en: 'Cess' } },
  ],
  categories: [
    { key: 'gst_18', label: { en: 'GST 18%' }, rate: 18 },
    {
      key: 'gst_28_cess',
      label: { en: 'GST 28% + cess 12%' },
      rate: 28,
      extra: [{ component: 'cess', rate: 12 }],
    },
    { key: 'exempt', label: { en: 'Exempt' }, rate: 0, kind: 'exempt' },
  ],
  rules: [
    {
      key: 'export',
      label: { en: 'Export' },
      condition: 'buyer_country != "" && buyer_country != company_country',
      split: [],
      zero: true,
    },
    {
      key: 'intra',
      label: { en: 'Within the state' },
      condition: 'buyer_region = "" || seller_region = buyer_region',
      split: [
        { component: 'cgst', share: 0.5 },
        { component: 'sgst', share: 0.5 },
      ],
    },
    { key: 'inter', label: { en: 'Between states' }, split: [{ component: 'igst', share: 1 }] },
  ],
  roundTotal: true,
};

const invoice: EntityDef = {
  key: 'invoice',
  kind: 'custom',
  label: { en: 'Invoice' },
  pluralLabel: { en: 'Invoices' },
  roles: ['sales_invoice'],
  tax: { lines: 'lines', amount: 'amount', category: 'tax_category', document: 'invoice' },
  fields: [
    {
      key: 'lines',
      type: 'table',
      label: { en: 'Lines' },
      columns: [
        { key: 'item', type: 'text', label: { en: 'Item' } },
        { key: 'qty', type: 'integer', label: { en: 'Qty' } },
        { key: 'rate', type: 'currency', label: { en: 'Rate' } },
        {
          key: 'amount',
          type: 'formula',
          label: { en: 'Amount' },
          formula: 'qty * rate',
          resultType: 'number',
        },
        { key: 'tax_category', type: 'text', label: { en: 'Tax' } },
      ],
    },
    {
      key: 'payable',
      type: 'formula',
      label: { en: 'Payable' },
      formula: 'grand_total',
      resultType: 'number',
    },
  ],
};

describe('tax engine', () => {
  const run = (
    rows: Record<string, unknown>[],
    ctx: Parameters<typeof computeTaxes>[3],
    setup = gst,
  ) => {
    const data: Record<string, unknown> = { lines: rows };
    computeTaxes(invoice, data, setup, ctx);
    return data;
  };
  const india = { companyCountry: 'IN', sellerRegion: '36' };

  it('splits GST into CGST and SGST within a state', () => {
    const d = run(
      [
        { amount: 1000, tax_category: 'gst_18' },
        { amount: 250.5, tax_category: 'gst_18' },
      ],
      {
        ...india,
        buyerRegion: '36',
      },
    );
    expect(d.tax_rule).toBe('intra');
    expect(d.subtotal).toBe(1250.5);
    expect(d.tax_total).toBe(225.1);
    expect(d.tax_summary).toEqual([
      { component: 'cgst', rate: 9, taxable: 1250.5, amount: 112.55 },
      { component: 'sgst', rate: 9, taxable: 1250.5, amount: 112.55 },
    ]);
    // 1475.60 rounded to the rupee.
    expect(d.grand_total).toBe(1476);
    expect(d.round_off).toBe(0.4);
  });

  it('charges IGST between states, cess on top, nothing on exempt lines', () => {
    const d = run(
      [
        { amount: 1000, tax_category: 'gst_28_cess' },
        { amount: 500, tax_category: 'exempt' },
      ],
      { ...india, buyerRegion: '29' },
    );
    expect(d.tax_rule).toBe('inter');
    expect((d.lines as { tax_amount: number }[]).map((l) => l.tax_amount)).toEqual([400, 0]);
    expect(d.tax_summary).toEqual([
      { component: 'igst', rate: 28, taxable: 1000, amount: 280 },
      { component: 'cess', rate: 12, taxable: 1000, amount: 120 },
    ]);
  });

  it('zero-rates exports and handles prices that include tax and reverse charge', () => {
    expect(
      run([{ amount: 1000, tax_category: 'gst_18' }], { ...india, buyerCountry: 'US' }).tax_total,
    ).toBe(0);
    const incl = { ...invoice, tax: { ...invoice.tax!, inclusive: true } };
    const data: Record<string, unknown> = { lines: [{ amount: 1180, tax_category: 'gst_18' }] };
    computeTaxes(incl, data, gst, { ...india, buyerRegion: '36' });
    expect(data).toMatchObject({ subtotal: 1000, tax_total: 180, grand_total: 1180 });
    const rcm = run([{ amount: 1000, tax_category: 'gst_18' }], {
      ...india,
      buyerRegion: '36',
      reverseCharge: true,
    });
    expect(rcm).toMatchObject({ tax_total: 180, grand_total: 1000 });
  });

  it('runs on save: line formulas first, record formulas after', () => {
    const entity = withTaxFields(invoice);
    const { data, issues } = validateRecord(
      entity,
      { lines: [{ item: 'Pens', qty: 10, rate: '10', tax_category: 'gst_18' }] },
      {
        cfg: { picklists: [], taxes: gst },
        companyCurrency: 'INR',
        taxContext: { ...india, buyerRegion: '36' },
      },
    );
    expect(issues).toEqual([]);
    expect(data).toMatchObject({ subtotal: 100, tax_total: 18, grand_total: 118, payable: 118 });
    // Clients cannot set the engine's fields.
    const bad = validateRecord(
      entity,
      { grand_total: 1 },
      { cfg: { picklists: [] }, companyCurrency: 'INR' },
    );
    expect(bad.issues[0]).toEqual({ field: 'grand_total', message: 'Calculated automatically' });
  });
});

describe('identifiers', () => {
  const gstin: IdentifierType = {
    key: 'gstin',
    label: { en: 'GSTIN' },
    pattern: '[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]',
    checksum: 'luhn_mod36',
    uppercase: true,
  };
  it('checks format and check digits', () => {
    expect(checkIdentifier(gstin, ' 27aapfu0939f1zv ')).toEqual({ value: '27AAPFU0939F1ZV' });
    expect(checkIdentifier(gstin, '27AAPFU0939F1ZW')).toEqual({
      error: 'GSTIN check digit does not match',
    });
    expect(checkIdentifier(gstin, '27AAPFU0939')).toMatchObject({
      error: expect.stringMatching(/Not a valid GSTIN/),
    });
    expect(
      checkIdentifier(
        { key: 'x', label: { en: 'Card' }, pattern: '\\d+', checksum: 'luhn' },
        '79927398713',
      ),
    ).toEqual({
      value: '79927398713',
    });
    expect(
      checkIdentifier(
        { key: 'v', label: { en: 'Id' }, pattern: '\\d+', checksum: 'verhoeff' },
        '2363',
      ),
    ).toEqual({ value: '2363' });
  });
  it('validates fields that name an identifier type', () => {
    const e: EntityDef = {
      ...invoice,
      tax: undefined,
      fields: [{ key: 'gstin', type: 'text', label: { en: 'GSTIN' }, identifier: 'gstin' }],
    };
    const ctx = { cfg: { picklists: [], identifierTypes: [gstin] }, companyCurrency: 'INR' };
    expect(validateRecord(e, { gstin: '27aapfu0939f1zv' }, ctx).data.gstin).toBe('27AAPFU0939F1ZV');
    expect(validateRecord(e, { gstin: '27AAPFU0939F1ZW' }, ctx).issues[0].message).toMatch(
      /check digit/,
    );
  });
});

describe('Hindi amounts and working time', () => {
  it('writes amounts in Hindi with lakh and crore', () => {
    expect(amountInWordsIn('12500.50', 'INR', 'hi')).toBe(
      'रुपये बारह हज़ार पाँच सौ और पचास पैसे मात्र',
    );
    expect(amountInWordsIn(12345678, 'INR', 'hi-IN')).toBe(
      'रुपये एक करोड़ तेईस लाख पैंतालीस हज़ार छह सौ अठहत्तर मात्र',
    );
    expect(amountInWordsIn(5, 'USD', 'hi')).toBe('Five Dollars Only');
  });

  it('counts working hours, skipping nights, the weekend and holidays', () => {
    const cal = {
      weekend: [0],
      hours: { start: '09:00', end: '18:00' },
      holidays: [{ date: '2026-10-02', label: { en: 'Gandhi Jayanti' } }],
    };
    // Thu 1 Oct 2026, 17:00 IST + 3 working hours: 1 h Thursday, Friday is a holiday, 2 h on Saturday.
    const start = new Date('2026-10-01T11:30:00Z');
    expect(addWorkingTime(start, 3, cal, 'Asia/Kolkata').toISOString()).toBe(
      '2026-10-03T05:30:00.000Z',
    );
    // Sat 18:00 + 1 h → Monday 10:00 (Sunday off).
    expect(
      addWorkingTime(new Date('2026-10-03T12:30:00Z'), 1, cal, 'Asia/Kolkata').toISOString(),
    ).toBe('2026-10-05T04:30:00.000Z');
  });
});

describe('packs', () => {
  const industry: PackManifest = {
    id: 'industry.demo',
    type: 'industry',
    version: '1.0.0',
    name: { en: 'Demo' },
    description: { en: 'Demo' },
    layer: {
      entities: [
        invoice,
        {
          key: 'client',
          kind: 'custom',
          label: { en: 'Client' },
          pluralLabel: { en: 'Clients' },
          roles: ['customer'],
          fields: [{ key: 'name', type: 'text', label: { en: 'Name' } }],
        },
      ],
    },
  };
  const country: PackManifest = {
    id: 'country.demo',
    type: 'country',
    version: '1.0.0',
    name: { en: 'Country' },
    description: { en: 'Country' },
    layer: {
      taxes: gst,
      identifierTypes: [{ key: 'gstin', label: { en: 'GSTIN' }, pattern: '.{15}' }],
    },
    patches: [
      {
        role: 'customer',
        fields: [{ key: 'gstin', type: 'text', label: { en: 'GSTIN' }, identifier: 'gstin' }],
      },
      { role: 'sales_invoice', tax: { sellerRegion: 'unit.state' } },
      {
        role: 'sales_invoice',
        reports: [
          {
            key: 'hsn',
            label: { en: 'Tax by rate' },
            entity: '$entity',
            columns: [],
            filters: [],
            groupBy: [{ path: 'tax_rule' }],
            aggregates: [{ fn: 'sum', path: 'tax_total' }],
          },
        ],
      },
    ],
  };
  const installed = (m: PackManifest): InstalledPack => ({
    id: m.id,
    version: m.version,
    installedAt: '2026-09-26',
    manifest: m,
  });

  it('applies country patches to industry entities by role, below the company', () => {
    const config: TenantConfig = {
      company: {
        ...emptyLayer(),
        entities: [
          { key: 'client', fields: [{ key: 'city', type: 'text', label: { en: 'City' } }] },
        ],
      },
      orgUnits: {},
      packs: [installed(industry), installed(country)],
    };
    const eff = resolveEffective([platformBaseLayer()], config, {
      version: 1,
      defaultFiscalYearStart: 4,
    });
    const client = eff.entities.find((e) => e.key === 'client')!;
    expect(client.fields.map((f) => f.key)).toEqual(['name', 'gstin', 'city']);
    const inv = eff.entities.find((e) => e.key === 'invoice')!;
    expect(inv.tax).toMatchObject({ lines: 'lines', sellerRegion: 'unit.state' });
    expect(inv.fields.map((f) => f.key)).toContain('grand_total');
    expect(eff.reports.map((r) => r.key)).toEqual(['hsn']);
    expect(eff.taxes?.rules.map((r) => r.key)).toEqual(['export', 'intra', 'inter']);
    expect(validateTenantConfig(config, { base: [platformBaseLayer()] })).toEqual([]);
    expect(packLayers(config.packs)).toHaveLength(3);
  });

  it('refuses a pack upgrade that drops a published field without retiring it', () => {
    const v1: TenantConfig = { company: emptyLayer(), orgUnits: {}, packs: [installed(industry)] };
    const smaller = {
      ...industry,
      version: '2.0.0',
      layer: { entities: [industry.layer.entities![1]] },
    };
    const v2: TenantConfig = { company: emptyLayer(), orgUnits: {}, packs: [installed(smaller)] };
    const issues = validateTenantConfig(v2, { base: [platformBaseLayer()], previous: v1 });
    expect(issues.some((i) => i.scope === 'packs' && /cannot be deleted/.test(i.message))).toBe(
      true,
    );
  });
});

describe('installing, upgrading and removing packs', () => {
  const v1: PackManifest = {
    id: 'industry.school',
    type: 'industry',
    version: '1.0.0',
    name: { en: 'School' },
    description: { en: 'School' },
    layer: {
      entities: [
        {
          key: 'student',
          kind: 'custom',
          label: { en: 'Student' },
          pluralLabel: { en: 'Students' },
          fields: [
            { key: 'name', type: 'text', label: { en: 'Name' } },
            { key: 'roll', type: 'text', label: { en: 'Roll' } },
          ],
        },
      ],
      forms: [
        {
          entity: 'student',
          sections: [{ key: 'main', label: { en: 'Main' }, columns: 2, fields: ['name', 'roll'] }],
        },
      ],
    },
  };
  const v2: PackManifest = {
    ...v1,
    version: '1.1.0',
    layer: {
      entities: [
        {
          ...v1.layer.entities![0],
          fields: [{ key: 'name', type: 'text', label: { en: 'Full name' } }],
        },
      ],
      forms: [
        {
          entity: 'student',
          sections: [{ key: 'main', label: { en: 'Student' }, columns: 1, fields: ['name'] }],
        },
      ],
    },
  };
  const base = [platformBaseLayer()];
  const empty: TenantConfig = { company: emptyLayer(), orgUnits: {} };

  it('installs into the draft and validates', () => {
    const draft = installPack(empty, v1, {});
    expect(previewPack(empty, v1)).toMatchObject({
      action: 'install',
      added: expect.arrayContaining(['Student', 'Student › Name']),
    });
    expect(validateTenantConfig(draft, { base })).toEqual([]);
  });

  it('upgrades, reports conflicts with the company, and resolves them either way', () => {
    const published = installPack(empty, v1, {});
    // The company changed the pack's form.
    const mine = {
      ...published,
      company: {
        ...emptyLayer(),
        forms: [
          {
            entity: 'student',
            sections: [
              { key: 'mine', label: { en: 'Mine' }, columns: 2 as const, fields: ['name', 'roll'] },
            ],
          },
        ],
      },
    };
    const preview = previewPack(mine, v2);
    expect(preview).toMatchObject({ action: 'upgrade', from: '1.0.0', to: '1.1.0' });
    expect(preview.removed).toContain('Student › Roll');
    expect(preview.conflicts).toEqual([{ path: 'forms.student', label: 'student' }]);

    const kept = installPack(mine, v2, { published: mine });
    expect(kept.company.forms).toHaveLength(1);
    // The dropped field held data: it is archived, not lost, and the upgrade validates.
    expect(kept.retired?.entities[0].fields).toEqual([
      { key: 'roll', type: 'text', label: { en: 'Roll' }, archived: true },
    ]);
    expect(validateTenantConfig(kept, { base, previous: mine })).toEqual([]);

    const taken = installPack(mine, v2, {
      published: mine,
      resolutions: { 'forms.student': 'pack' },
    });
    expect(taken.company.forms).toEqual([]);
  });

  it('removes a pack keeping published data reachable, and rolls back', () => {
    const published = installPack(empty, v1, {});
    const removed = removePack(published, v1.id, { published });
    expect(removed.packs).toBeUndefined();
    expect(removed.retired?.entities[0]).toMatchObject({ key: 'student', archived: true });
    expect(validateTenantConfig(removed, { base, previous: published })).toEqual([]);
    // Rolling back to before the install keeps the entity archived.
    const back = withArchivedLeftovers(empty, published);
    expect(back.retired?.entities[0]).toMatchObject({ key: 'student', archived: true });
    expect(validateTenantConfig(back, { base, previous: published })).toEqual([]);
  });
});
