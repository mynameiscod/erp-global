import {
  amountInWords,
  bucketKey,
  bucketRange,
  compileFormula,
  emptyLayer,
  formatCurrency,
  FormulaError,
  integerInWords,
  parseTemplate,
  platformBaseLayer,
  previousRange,
  renderTemplate,
  resolveRelative,
  resolveReportPath,
  TemplateError,
  unsafeHtmlReason,
  validateRecord,
  validateTenantConfig,
  zonedDayStart,
  type ConfigLayer,
  type EntityDef,
  type PrintTemplateDef,
  type ReportDef,
  type TemplateScope,
  type TenantConfig,
} from './index';

const now = new Date('2026-09-24T10:00:00Z');

const invoice: EntityDef = {
  key: 'invoice',
  kind: 'custom',
  label: { en: 'Invoice' },
  pluralLabel: { en: 'Invoices' },
  titleField: 'customer',
  fields: [
    { key: 'customer', type: 'lookup', target: 'customer', label: { en: 'Customer' } },
    { key: 'invoice_date', type: 'date', label: { en: 'Date' } },
    {
      key: 'lines',
      type: 'table',
      label: { en: 'Lines' },
      columns: [
        { key: 'item', type: 'text', label: { en: 'Item' }, required: true },
        { key: 'qty', type: 'integer', label: { en: 'Qty' } },
        { key: 'rate', type: 'currency', label: { en: 'Rate' } },
        {
          key: 'amount',
          type: 'formula',
          label: { en: 'Amount' },
          formula: 'qty * rate',
          resultType: 'number',
        },
      ],
    },
    {
      key: 'total',
      type: 'formula',
      label: { en: 'Total' },
      formula: 'SUM(lines.amount)',
      resultType: 'number',
    },
  ],
};
const customer: EntityDef = {
  key: 'customer',
  kind: 'custom',
  label: { en: 'Customer' },
  pluralLabel: { en: 'Customers' },
  fields: [
    { key: 'name', type: 'text', label: { en: 'Name' } },
    { key: 'city', type: 'lookup', target: 'city', label: { en: 'City' } },
  ],
};
const city: EntityDef = {
  key: 'city',
  kind: 'custom',
  label: { en: 'City' },
  pluralLabel: { en: 'Cities' },
  fields: [{ key: 'name', type: 'text', label: { en: 'Name' } }],
};

describe('table fields and column aggregates', () => {
  const ctx = { cfg: { picklists: [] }, companyCurrency: 'INR', now };

  it('adds up a column with SUM, AVG, MIN, MAX and COUNT', () => {
    const fields = { lines: [{ amount: 100 }, { amount: 50.5 }, { amount: null }] };
    const ev = (src: string) => compileFormula(src).evaluate({ fields, now });
    expect(ev('SUM(lines.amount)')).toBe(150.5);
    expect(ev('SUM(lines.amount, 10)')).toBe(160.5);
    expect(ev('COUNT(lines.amount)')).toBe(2);
    expect(ev('AVG(lines.amount)')).toBe(75.25);
    expect(ev('MAX(lines.amount)')).toBe(100);
    expect(compileFormula('SUM(lines.amount)').evaluate({ fields: {}, now })).toBe(0);
  });

  it('refuses a table column outside an aggregate', () => {
    expect(() => compileFormula('lines.amount * 2')).toThrow(FormulaError);
    expect(() => compileFormula('ROUND(lines.amount)')).toThrow(FormulaError);
  });

  it('normalizes rows, computes row formulas and the record total', () => {
    const { data, issues } = validateRecord(
      invoice,
      {
        invoice_date: '2026-09-24',
        lines: [
          { _id: 'r1', item: 'Pens', qty: 10, rate: '12.50' },
          { item: 'Books', qty: '2', rate: { amount: 100, currency: 'INR' } },
        ],
      },
      ctx,
    );
    expect(issues).toEqual([]);
    expect(data.lines).toEqual([
      { item: 'Pens', qty: 10, rate: { amount: '12.50', currency: 'INR' }, amount: 125 },
      { item: 'Books', qty: 2, rate: { amount: '100.00', currency: 'INR' }, amount: 200 },
    ]);
    expect(data.total).toBe(325);
  });

  it('reports the row and column of a bad value', () => {
    const { issues } = validateRecord(invoice, { lines: [{ item: 'Pens' }, { qty: 'x' }] }, ctx);
    expect(issues[0]).toEqual({ field: 'lines', message: 'Row 2, Qty: Must be a whole number' });
    const missing = validateRecord(invoice, { lines: [{ qty: 1 }] }, ctx);
    expect(missing.issues[0].message).toBe('Row 1: Item is required');
    const unknown = validateRecord(invoice, { lines: [{ item: 'x', colour: 'red' }] }, ctx);
    expect(unknown.issues[0].message).toBe('Row 1: unknown column "colour"');
  });
});

describe('print placeholders', () => {
  const scope = (values: Record<string, unknown>): TemplateScope => ({
    text: (p, f) => (f === 'words' ? `words(${String(values[p])})` : String(values[p] ?? '')),
    truthy: (p) => !!values[p],
    each: (p) => ((values[p] as Record<string, unknown>[]) ?? []).map((r) => scope(r)),
  });

  it('fills values, sections and loops, escaping everything', () => {
    const nodes = parseTemplate(
      '<h1>{{number}}</h1>{{#if paid}}PAID{{else}}DUE{{/if}}' +
        '{{#each lines}}<tr><td>{{@index}}</td><td>{{item}}</td></tr>{{/each}}{{total|words}}',
    );
    const html = renderTemplate(
      nodes,
      scope({
        number: 'INV/1',
        paid: false,
        lines: [{ item: '<b>Pens</b>' }, { item: 'Books & more' }],
        total: 12,
      }),
    );
    expect(html).toBe(
      '<h1>INV/1</h1>DUE<tr><td>1</td><td>&lt;b&gt;Pens&lt;/b&gt;</td></tr>' +
        '<tr><td>2</td><td>Books &amp; more</td></tr>words(12)',
    );
  });

  it('rejects broken templates and unsafe HTML', () => {
    for (const bad of ['{{#each lines}}x', '{{/if}}', '{{a|shout}}', '{{a b}}', '{{else}}']) {
      expect(() => parseTemplate(bad)).toThrow(TemplateError);
    }
    expect(unsafeHtmlReason('<p onclick="x()">')).toBeDefined();
    expect(unsafeHtmlReason('<script>alert(1)</script>')).toBeDefined();
    expect(unsafeHtmlReason('<a href="javascript:x">')).toBeDefined();
    expect(unsafeHtmlReason('<p class="total">{{total}}</p>')).toBeUndefined();
  });
});

describe('formatting and amounts in words', () => {
  it('writes Indian and international amounts', () => {
    expect(integerInWords(125000, 'indian')).toBe('One Lakh Twenty Five Thousand');
    expect(integerInWords(123456789, 'indian')).toBe(
      'Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine',
    );
    expect(integerInWords(12345678901, 'indian')).toBe(
      'One Thousand Two Hundred Thirty Four Crore Fifty Six Lakh Seventy Eight Thousand Nine Hundred One',
    );
    expect(integerInWords(1250000, 'international')).toBe('One Million Two Hundred Fifty Thousand');
    expect(amountInWords('12500.50', 'INR')).toBe(
      'Rupees Twelve Thousand Five Hundred and Fifty Paise Only',
    );
    expect(amountInWords({ amount: '1999.99', currency: 'USD' }, 'USD')).toBe(
      'One Thousand Nine Hundred Ninety Nine Dollars and Ninety Nine Cents Only',
    );
    expect(amountInWords(0, 'AED')).toBe('Zero Dirhams Only');
  });

  it('groups digits the way the locale does', () => {
    expect(formatCurrency('1234567.5', 'INR', 'en-IN')).toBe('₹12,34,567.50');
    expect(formatCurrency(1234567.5, 'USD', 'en-US')).toBe('$1,234,567.50');
  });
});

describe('relative dates and buckets', () => {
  const opts = { timezone: 'Asia/Kolkata', fyStartMonth: 4, now };

  it('resolves periods in the company time zone and fiscal year', () => {
    expect(resolveRelative('today', opts)).toEqual({ from: '2026-09-24', to: '2026-09-25' });
    // 23:30 UTC is already the next day in India.
    expect(resolveRelative('today', { ...opts, now: new Date('2026-09-24T23:30:00Z') }).from).toBe(
      '2026-09-25',
    );
    expect(resolveRelative('this_week', opts)).toEqual({ from: '2026-09-21', to: '2026-09-28' });
    expect(resolveRelative('last_month', opts)).toEqual({ from: '2026-08-01', to: '2026-09-01' });
    expect(resolveRelative('this_quarter', opts)).toEqual({ from: '2026-07-01', to: '2026-10-01' });
    expect(resolveRelative('this_fiscal_year', opts)).toEqual({
      from: '2026-04-01',
      to: '2027-04-01',
    });
    expect(resolveRelative('last_fiscal_year', opts).from).toBe('2025-04-01');
    expect(resolveRelative('last_n_days', { ...opts, n: 7 })).toEqual({
      from: '2026-09-18',
      to: '2026-09-25',
    });
  });

  it('finds the period before', () => {
    expect(previousRange({ from: '2026-09-01', to: '2026-10-01' })).toEqual({
      from: '2026-08-01',
      to: '2026-09-01',
    });
    expect(previousRange({ from: '2026-09-18', to: '2026-09-25' })).toEqual({
      from: '2026-09-11',
      to: '2026-09-18',
    });
  });

  it('names buckets and turns them back into ranges', () => {
    expect(bucketKey('2026-09-24', 'month', 4)).toBe('2026-09');
    expect(bucketKey('2026-09-24', 'quarter', 4)).toBe('2026-27 Q2');
    expect(bucketKey('2027-02-01', 'fiscal_year', 4)).toBe('2026-27');
    expect(bucketKey('2026-01-01', 'week', 1)).toBe('2026-W01');
    expect(bucketKey('2027-01-01', 'week', 1)).toBe('2026-W53');
    expect(bucketRange('2026-27 Q2', 'quarter', 4)).toEqual({
      from: '2026-07-01',
      to: '2026-10-01',
    });
    expect(bucketRange('2026-W53', 'week', 1)).toEqual({ from: '2026-12-28', to: '2027-01-04' });
    expect(bucketRange('2026-27', 'fiscal_year', 4)).toEqual({
      from: '2026-04-01',
      to: '2027-04-01',
    });
  });
});

describe('report paths', () => {
  const entities = [invoice, customer, city];

  it('follows links up to two hops', () => {
    const r = resolveReportPath(entities, 'invoice', 'customer.city.name');
    expect(typeof r).toBe('object');
    expect(r).toMatchObject({ entity: 'city', type: 'text' });
    expect(resolveReportPath(entities, 'invoice', 'total')).toMatchObject({ type: 'number' });
    expect(resolveReportPath(entities, 'invoice', 'createdAt')).toMatchObject({ type: 'datetime' });
  });

  it('explains paths that cannot be used', () => {
    expect(resolveReportPath(entities, 'invoice', 'lines')).toMatch(/table/);
    expect(resolveReportPath(entities, 'invoice', 'invoice_date.name')).toMatch(/not a link/);
    expect(resolveReportPath(entities, 'invoice', 'customer.nope')).toMatch(/Unknown field/);
  });
});

describe('validating print templates, reports and dashboards', () => {
  const base = [platformBaseLayer()];
  const layer = (extra: Partial<ConfigLayer>): TenantConfig => ({
    company: { ...emptyLayer(), entities: [invoice, customer, city], ...extra },
    orgUnits: {},
  });
  const template = (t: Partial<PrintTemplateDef>): PrintTemplateDef => ({
    key: 'invoice_a4',
    entity: 'invoice',
    label: { en: 'Invoice' },
    page: { size: 'A4' },
    mode: 'blocks',
    blocks: [
      {
        id: 'h',
        type: 'letterhead',
        lines: [{ en: '{{company.name}}' }, { en: '{{unit.address}}' }],
      },
      { id: 't', type: 'title', text: { en: 'Tax invoice {{number}}' } },
      {
        id: 'f',
        type: 'fields',
        columns: 2,
        items: [{ path: 'customer.name' }, { path: 'invoice_date' }],
      },
      {
        id: 'l',
        type: 'table',
        source: 'lines',
        columns: [{ path: 'item' }, { path: 'qty' }, { path: 'amount', format: 'currency' }],
        totals: ['amount'],
      },
      {
        id: 's',
        type: 'totals',
        rows: [{ label: { en: 'Total' }, value: 'SUM(lines.amount)' }],
        words: { value: 'total' },
      },
      { id: 'q', type: 'qr', value: 'upi://pay?am={{total}}', condition: 'STATUS() != "paid"' },
    ],
    ...t,
  });
  const report = (r: Partial<ReportDef>): ReportDef => ({
    key: 'sales_by_city',
    label: { en: 'Sales by city' },
    entity: 'invoice',
    columns: [],
    filters: [{ path: 'invoice_date', op: 'relative', relative: { period: 'this_fiscal_year' } }],
    groupBy: [{ path: 'customer.city.name' }, { path: 'invoice_date', bucket: 'month' }],
    aggregates: [{ fn: 'count' }, { fn: 'sum', path: 'total' }],
    chart: { type: 'stacked_bar' },
    ...r,
  });

  it('accepts a correct template, report and dashboard', () => {
    const cfg = layer({
      printTemplates: [template({})],
      reports: [report({})],
      dashboards: [
        {
          key: 'sales',
          label: { en: 'Sales' },
          widgets: [{ id: 'w1', type: 'chart', report: 'sales_by_city', x: 0, y: 0, w: 6, h: 4 }],
        },
      ],
    });
    expect(validateTenantConfig(cfg, { base })).toEqual([]);
  });

  it('finds unknown fields, bad sources and unsafe HTML', () => {
    const cfg = layer({
      printTemplates: [
        template({
          blocks: [
            { id: 'a', type: 'title', text: { en: '{{nope}}' } },
            { id: 'b', type: 'table', source: 'customer', columns: [{ path: 'x' }] },
            { id: 'c', type: 'totals', rows: [{ label: { en: 'T' }, value: 'SUM(lines.price)' }] },
          ],
        }),
        template({ key: 'raw', mode: 'html', html: '<img src=x onerror="alert(1)">' }),
      ],
    });
    const messages = validateTenantConfig(cfg, { base }).map((i) => i.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        'Unknown field "nope" in {{nope}}',
        '"customer" is not a table field',
        'Unknown field "lines.price"',
        'Event handlers (onclick=…) are not allowed',
      ]),
    );
  });

  it('checks report columns, groups and totals', () => {
    const cfg = layer({
      reports: [
        report({
          groupBy: [{ path: 'customer.name', bucket: 'month' }],
          aggregates: [{ fn: 'sum', path: 'customer.name' }],
        }),
      ],
      dashboards: [
        {
          key: 'dash',
          label: { en: 'D' },
          widgets: [{ id: 'w', type: 'kpi', report: 'missing', x: 0, y: 0, w: 3, h: 2 }],
        },
      ],
    });
    const messages = validateTenantConfig(cfg, { base }).map((i) => i.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        '"customer.name" is not a date',
        '"customer.name" is not a number',
        'A stacked bar needs two groups',
        'Unknown report "missing"',
      ]),
    );
  });

  it('checks table columns', () => {
    const bad: EntityDef = {
      ...invoice,
      fields: [
        {
          key: 'lines',
          type: 'table',
          label: { en: 'Lines' },
          columns: [
            { key: 'doc', type: 'file', label: { en: 'Doc' } },
            {
              key: 'aa',
              type: 'formula',
              label: { en: 'A' },
              formula: 'bb + 1',
              resultType: 'number',
            },
            {
              key: 'bb',
              type: 'formula',
              label: { en: 'B' },
              formula: 'aa + 1',
              resultType: 'number',
            },
          ],
        },
      ],
    };
    const cfg: TenantConfig = { company: { ...emptyLayer(), entities: [bad] }, orgUnits: {} };
    const messages = validateTenantConfig(cfg, { base }).map((i) => i.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        'A table column cannot be of type file',
        'Formulas refer to each other in a loop: aa → bb → aa',
      ]),
    );
  });
});

describe('zoned day start', () => {
  it('finds midnight in the company time zone', () => {
    expect(zonedDayStart('2026-09-24', 'Asia/Kolkata').toISOString()).toBe(
      '2026-09-23T18:30:00.000Z',
    );
    expect(zonedDayStart('2026-07-01', 'America/New_York').toISOString()).toBe(
      '2026-07-01T04:00:00.000Z',
    );
    expect(zonedDayStart('2026-01-01', 'UTC').toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});
