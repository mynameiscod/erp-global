import {
  compileFormula,
  computeFormulas,
  diffConfigs,
  withArchivedLeftovers,
  emptyLayer,
  fiscalYearLabel,
  fiscalYearStartFor,
  FormulaError,
  mergeLayers,
  numberingPeriod,
  pickText,
  platformBaseLayer,
  renderNumber,
  resolveEffective,
  validateNumberingPattern,
  validateRecord,
  validateTenantConfig,
  type ConfigLayer,
  type EntityDef,
  type TenantConfig,
} from './index';

const now = new Date('2026-09-24T10:00:00Z');
const evalF = (src: string, fields: Record<string, unknown> = {}) =>
  compileFormula(src).evaluate({ fields, now });

describe('formula language', () => {
  it('does arithmetic with precedence', () => {
    expect(evalF('2 + 3 * 4')).toBe(14);
    expect(evalF('(2 + 3) * 4')).toBe(20);
    expect(evalF('10 - 4 - 3')).toBe(3);
    expect(evalF('-qty * rate', { qty: 2, rate: '12.50' })).toBe(-25);
  });

  it('supports conditions, text and dates', () => {
    expect(evalF('IF(age >= 18, "Adult", "Minor")', { age: 17 })).toBe('Minor');
    expect(evalF('CONCAT(first, " ", last)', { first: 'Asha', last: 'Rao' })).toBe('Asha Rao');
    expect(evalF('first & "-" & last', { first: 'A', last: 'B' })).toBe('A-B');
    expect(evalF('DAYS_BETWEEN(joined, TODAY())', { joined: '2026-09-20' })).toBe(4);
    expect(evalF('YEAR(dob)', { dob: '2010-05-01' })).toBe(2010);
    expect(evalF('AND(a > 1, b = "x")', { a: 2, b: 'x' })).toBe(true);
    expect(evalF('COALESCE(nick, name)', { name: 'Asha' })).toBe('Asha');
  });

  it('uses currency amounts as numbers and returns null on divide by zero', () => {
    expect(evalF('fee * 2', { fee: { amount: '100.50', currency: 'INR' } })).toBe(201);
    expect(evalF('a / b', { a: 1, b: 0 })).toBe(null);
  });

  it('only evaluates the IF branch it needs', () => {
    expect(evalF('IF(TRUE, 1, 1 / "x")')).toBe(1);
  });

  it('reports referenced fields', () => {
    expect(compileFormula('IF(a > b, c, ROUND(d, 2))').fields.sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('rejects anything that is not the language', () => {
    for (const bad of [
      'process.exit()',
      'a;b',
      'constructor["x"]',
      '1 +',
      'FOO(1)',
      'IF(1)',
      '`x`',
      '"open',
    ]) {
      expect(() => compileFormula(bad)).toThrow(FormulaError);
    }
    expect(() => compileFormula('('.repeat(60) + '1' + ')'.repeat(60))).toThrow(FormulaError);
  });
});

describe('fiscal years and numbering', () => {
  it('uses the country fiscal year', () => {
    expect(fiscalYearStartFor('IN')).toBe(4);
    expect(fiscalYearStartFor('AE')).toBe(1);
    expect(fiscalYearLabel(new Date('2027-03-31T00:00:00Z'), 4)).toBe('2026-27');
    expect(fiscalYearLabel(new Date('2027-04-01T00:00:00Z'), 4)).toBe('2027-28');
    expect(fiscalYearLabel(new Date('2027-04-01T00:00:00Z'), 1)).toBe('2027');
  });

  it('validates patterns', () => {
    expect(validateNumberingPattern('ADM/{FY}/{BRANCH}/{SEQ:5}')).toEqual([]);
    expect(validateNumberingPattern('ADM')).toContain(
      'Pattern must contain {SEQ} exactly once, e.g. {SEQ:5}',
    );
    expect(validateNumberingPattern('{SEQ}{SEQ}').length).toBeGreaterThan(0);
    expect(validateNumberingPattern('{FOO}{SEQ}')).toContain('Unknown token {FOO}');
    expect(validateNumberingPattern('A<script>{SEQ}').length).toBeGreaterThan(0);
  });

  it('renders numbers and resets by period', () => {
    const d = new Date('2026-09-24T00:00:00Z');
    expect(
      renderNumber('ADM/{FY}/{BRANCH}/{SEQ:5}', {
        date: d,
        fyStartMonth: 4,
        seq: 42,
        branchCode: 'HYD',
      }),
    ).toBe('ADM/2026-27/HYD/00042');
    expect(renderNumber('INV-{YY}{MM}-{SEQ:3}', { date: d, fyStartMonth: 4, seq: 7 })).toBe(
      'INV-2609-007',
    );
    expect(numberingPeriod({ reset: 'yearly' }, new Date('2027-02-01T00:00:00Z'), 4)).toBe(
      'FY2026',
    );
    expect(numberingPeriod({ reset: 'monthly' }, d, 4)).toBe('2026-09');
    expect(numberingPeriod({ reset: 'never' }, d, 4)).toBe('all');
  });
});

const student = (extra: Partial<EntityDef> = {}): EntityDef => ({
  key: 'student',
  kind: 'custom',
  label: { en: 'Student', hi: 'छात्र' },
  pluralLabel: { en: 'Students' },
  titleField: 'name',
  orgScoped: true,
  fields: [
    { key: 'name', type: 'text', label: { en: 'Name' }, required: true },
    { key: 'grade', type: 'select', label: { en: 'Grade' }, picklist: 'grades' },
    { key: 'fee', type: 'currency', label: { en: 'Fee' }, min: 0 },
    { key: 'qty', type: 'integer', label: { en: 'Qty' }, default: 1 },
    {
      key: 'total',
      type: 'formula',
      label: { en: 'Total' },
      formula: 'fee * qty',
      resultType: 'number',
    },
    { key: 'adm_no', type: 'autonumber', label: { en: 'Admission no' }, numbering: 'admission' },
  ],
  ...extra,
});

const companyLayer = (): ConfigLayer => ({
  ...emptyLayer(),
  entities: [student()],
  picklists: [
    {
      key: 'grades',
      label: { en: 'Grades' },
      options: [
        { value: 'g1', label: { en: 'Grade 1' } },
        { value: 'g2', label: { en: 'Grade 2' }, active: false },
      ],
    },
  ],
  numbering: [
    {
      key: 'admission',
      label: { en: 'Admission' },
      pattern: 'ADM/{FY}/{SEQ:4}',
      reset: 'yearly',
      scope: 'company',
    },
  ],
  forms: [
    {
      entity: 'student',
      sections: [{ key: 'main', label: { en: 'Main' }, columns: 2, fields: ['name', 'grade'] }],
    },
  ],
  listViews: [
    {
      entity: 'student',
      columns: ['number', 'name', 'grade'],
      sort: { field: 'createdAt', dir: 'desc' },
    },
  ],
});

const base = [platformBaseLayer()];

describe('layers', () => {
  it('lets an org unit add a field and its own number series', () => {
    const config: TenantConfig = {
      company: companyLayer(),
      orgUnits: {
        hyd: {
          ...emptyLayer(),
          path: '/root/hyd/',
          entities: [
            {
              key: 'student',
              fields: [{ key: 'hostel', type: 'boolean', label: { en: 'Hostel' } }],
            },
          ],
          numbering: [
            {
              key: 'admission',
              label: { en: 'HYD' },
              pattern: 'HYD/{SEQ:4}',
              reset: 'never',
              scope: 'company',
            },
          ],
        },
      },
    };
    const atRoot = resolveEffective(base, config, {
      version: 1,
      orgPath: '/root/',
      defaultFiscalYearStart: 4,
    });
    const atHyd = resolveEffective(base, config, {
      version: 1,
      orgPath: '/root/hyd/team/',
      defaultFiscalYearStart: 4,
    });
    const fieldsAt = (c: typeof atRoot) =>
      c.entities.find((e) => e.key === 'student')!.fields.map((f) => f.key);
    expect(fieldsAt(atRoot)).not.toContain('hostel');
    expect(fieldsAt(atHyd)).toContain('hostel');
    expect(atHyd.entities.find((e) => e.key === 'student')!.label.en).toBe('Student');
    expect(atHyd.numbering.find((n) => n.key === 'admission')!.pattern).toBe('HYD/{SEQ:4}');
    expect(atRoot.settings.fiscalYearStartMonth).toBe(4);
    expect(atRoot.entities.map((e) => e.key)).toEqual(['user', 'org_unit', 'student']);
  });

  it('merges by key, later layers winning', () => {
    const merged = mergeLayers([
      {
        ...emptyLayer(),
        picklists: [
          { key: 'p', label: { en: 'A' }, options: [{ value: 'x', label: { en: 'X' } }] },
        ],
      },
      {
        ...emptyLayer(),
        picklists: [
          { key: 'p', label: { en: 'B' }, options: [{ value: 'y', label: { en: 'Y' } }] },
        ],
      },
    ]);
    expect(merged.picklists).toHaveLength(1);
    expect(merged.picklists[0].label.en).toBe('B');
  });

  it('picks labels in the user language', () => {
    expect(pickText({ en: 'Student', hi: 'छात्र' }, 'hi-IN')).toBe('छात्र');
    expect(pickText({ en: 'Student' }, 'ar')).toBe('Student');
    expect(pickText({ hi: 'छात्र' }, 'ar')).toBe('छात्र');
  });
});

describe('publish validation', () => {
  const valid = (): TenantConfig => ({ company: companyLayer(), orgUnits: {} });

  it('accepts a correct configuration', () => {
    expect(validateTenantConfig(valid(), { base })).toEqual([]);
  });

  it('finds broken references', () => {
    const c = valid();
    const e = c.company.entities[0];
    e.fields.push(
      { key: 'x1', type: 'select', label: { en: 'x' }, picklist: 'nope' },
      { key: 'x2', type: 'lookup', label: { en: 'x' }, target: 'nope' },
      { key: 'x3', type: 'autonumber', label: { en: 'x' }, numbering: 'nope' },
      {
        key: 'x4',
        type: 'formula',
        label: { en: 'x' },
        formula: 'missing + 1',
        resultType: 'number',
      },
      { key: 'x5', type: 'formula', label: { en: 'x' }, formula: '1 +', resultType: 'number' },
    );
    c.company.forms[0].sections[0].fields.push('ghost');
    c.company.listViews[0].columns.push('ghost');
    const messages = validateTenantConfig(c, { base }).map((i) => i.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        'Unknown option list "nope"',
        'Unknown entity "nope"',
        'Unknown number series "nope"',
        'Unknown field "missing" in formula',
        'Formula ends unexpectedly',
        'Unknown field "ghost"',
        'Unknown column "ghost"',
      ]),
    );
  });

  it('rejects formula loops, reserved keys and duplicates', () => {
    const c = valid();
    c.company.entities[0].fields.push(
      { key: 'aa', type: 'formula', label: { en: 'a' }, formula: 'bb + 1', resultType: 'number' },
      { key: 'bb', type: 'formula', label: { en: 'b' }, formula: 'aa + 1', resultType: 'number' },
      { key: 'number', type: 'text', label: { en: 'x' } },
      { key: 'name', type: 'text', label: { en: 'dup' } },
    );
    const messages = validateTenantConfig(c, { base }).map((i) => i.message);
    expect(messages.some((m) => m.startsWith('Formulas refer to each other in a loop'))).toBe(true);
    expect(messages).toContain('"number" is reserved');
    expect(messages).toContain('Duplicate entities.student.fields "name"');
  });

  it('rejects creating a custom entity with a built-in key', () => {
    const c = valid();
    c.company.entities.push({
      key: 'user',
      kind: 'custom',
      label: { en: 'U' },
      pluralLabel: { en: 'U' },
      fields: [],
    });
    expect(validateTenantConfig(c, { base }).map((i) => i.message)).toContain(
      '"user" is a built-in entity',
    );
  });

  it('blocks deleting or incompatibly retyping published fields', () => {
    const previous = valid();
    const next = valid();
    next.company.entities[0].fields = next.company.entities[0].fields.filter(
      (f) => f.key !== 'fee',
    );
    const qty = next.company.entities[0].fields.find((f) => f.key === 'qty')!;
    qty.type = 'decimal'; // integer -> decimal is compatible
    const name = next.company.entities[0].fields.find((f) => f.key === 'name')!;
    name.type = 'integer'; // text -> integer is not
    const messages = validateTenantConfig(next, { base, previous }).map((i) => i.message);
    expect(messages).toContain(
      'A published field cannot be deleted. Archive it instead, so its data is kept.',
    );
    expect(messages).toContain('Changing the type from text to integer would break existing data');
    expect(messages.some((m) => m.includes('integer to decimal'))).toBe(false);
  });

  it('reports invalid shapes with paths', () => {
    const c = valid();
    (c.company.entities[0].fields[0] as { key: string }).key = 'Bad Key';
    const issues = validateTenantConfig(c, { base });
    expect(issues[0].path).toContain('fields');
  });
});

describe('record validation', () => {
  const cfg = companyLayer();
  const entity = student();
  const ctx = { cfg, companyCurrency: 'INR', now };

  it('normalizes values, applies defaults and computes formulas', () => {
    const { data, issues } = validateRecord(
      entity,
      { name: '  Asha ', grade: 'g1', fee: '1,500.5' },
      ctx,
    );
    expect(issues).toEqual([]);
    expect(data).toEqual({
      name: 'Asha',
      grade: 'g1',
      fee: { amount: '1500.50', currency: 'INR' },
      qty: 1,
      total: 1500.5,
    });
  });

  it('reports every problem by field', () => {
    const { issues } = validateRecord(
      entity,
      { grade: 'g2', fee: { amount: '-5' }, qty: 1.5, total: 3, ghost: 1 },
      ctx,
    );
    expect(Object.fromEntries(issues.map((i) => [i.field, i.message]))).toEqual({
      grade: 'Choose one of the options',
      fee: 'Must be at least 0',
      qty: 'Must be a whole number',
      total: 'Calculated automatically',
      ghost: 'Unknown field',
      name: 'Required',
    });
  });

  it('merges updates with existing data and can clear optional fields', () => {
    const existing = { name: 'Asha', qty: 2, fee: { amount: '10.00', currency: 'INR' }, total: 20 };
    const { data, issues } = validateRecord(entity, { qty: 3, grade: null }, ctx, existing);
    expect(issues).toEqual([]);
    expect(data.total).toBe(30);
    const cleared = validateRecord(entity, { name: '' }, ctx, existing);
    expect(cleared.issues).toEqual([{ field: 'name', message: 'Required' }]);
  });

  it('validates each type', () => {
    const e: EntityDef = {
      ...student(),
      fields: [
        { key: 'email', type: 'email', label: { en: 'e' } },
        { key: 'phone', type: 'phone', label: { en: 'p' } },
        { key: 'dob', type: 'date', label: { en: 'd' } },
        { key: 'site', type: 'url', label: { en: 'u' } },
        { key: 'class', type: 'lookup', label: { en: 'l' }, target: 'klass' },
        { key: 'photo', type: 'image', label: { en: 'i' } },
        { key: 'at', type: 'time', label: { en: 't' } },
      ],
    };
    const good = validateRecord(
      e,
      {
        email: 'A@B.CO',
        phone: '+91 98765-43210',
        dob: '2012-02-29',
        site: 'https://x.test/a',
        class: 'a'.repeat(24),
        photo: '123e4567-e89b-12d3-a456-426614174000',
        at: '09:30',
      },
      ctx,
    );
    expect(good.issues).toEqual([]);
    expect(good.data.email).toBe('a@b.co');
    expect(good.data.phone).toBe('+919876543210');
    const bad = validateRecord(
      e,
      { dob: '2013-02-29', site: 'javascript:alert(1)', class: 'x', at: '25:00' },
      ctx,
    );
    expect(bad.issues.map((i) => i.field).sort()).toEqual(['at', 'class', 'dob', 'site']);
  });

  it('leaves a formula empty when it cannot be computed', () => {
    const e: EntityDef = {
      ...student(),
      fields: [
        { key: 'a', type: 'text', label: { en: 'a' } },
        { key: 'b', type: 'formula', label: { en: 'b' }, formula: 'a * 2', resultType: 'number' },
      ],
    };
    const data: Record<string, unknown> = { a: 'abc' };
    computeFormulas(e, data, now);
    expect(data.b).toBeUndefined();
  });
});

describe('diff and rollback', () => {
  it('summarizes changes', () => {
    const prev: TenantConfig = { company: companyLayer(), orgUnits: {} };
    const next: TenantConfig = structuredClone(prev);
    next.company.entities[0].fields.push({
      key: 'hostel',
      type: 'boolean',
      label: { en: 'Hostel' },
    });
    next.company.picklists = [];
    expect(diffConfigs(prev, next)).toEqual([
      'student: Added field Hostel (hostel)',
      'Removed option list grades',
    ]);
  });

  it('keeps newer fields as archived when rolling back', () => {
    const older: TenantConfig = { company: companyLayer(), orgUnits: {} };
    const current: TenantConfig = structuredClone(older);
    current.company.entities[0].fields.push({
      key: 'hostel',
      type: 'boolean',
      label: { en: 'Hostel' },
    });
    const rolled = withArchivedLeftovers(older, current);
    const hostel = rolled.company.entities[0].fields.find((f) => f.key === 'hostel');
    expect(hostel?.archived).toBe(true);
    expect(validateTenantConfig(rolled, { base, previous: current })).toEqual([]);
  });

  it('archives only the fields an override added, not the whole entity', () => {
    const older: TenantConfig = { company: companyLayer(), orgUnits: {} };
    const current: TenantConfig = structuredClone(older);
    current.orgUnits.hyd = {
      ...emptyLayer(),
      path: '/root/hyd/',
      entities: [
        { key: 'student', fields: [{ key: 'hostel', type: 'boolean', label: { en: 'Hostel' } }] },
      ],
    };
    const rolled = withArchivedLeftovers(older, current);
    const atHyd = resolveEffective(base, rolled, {
      version: 3,
      orgPath: '/root/hyd/',
      defaultFiscalYearStart: 4,
    });
    const student = atHyd.entities.find((e) => e.key === 'student')!;
    expect(student.archived).toBeFalsy();
    expect(student.fields.find((f) => f.key === 'hostel')?.archived).toBe(true);
    expect(validateTenantConfig(rolled, { base, previous: current })).toEqual([]);
  });
});
