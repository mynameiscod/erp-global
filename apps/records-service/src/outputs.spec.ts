import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { signAccessToken, signServiceToken } from '@erp/auth';
import type { AclEntry } from '@erp/contracts';
import {
  bucketKey,
  emptyLayer,
  platformBaseLayer,
  resolveEffective,
  type ConfigLayer,
  type DateBucket,
  type ReportDef,
} from '@erp/metadata';
import { PLACEMENT_RESOLVER, SharedPlacementResolver, UpstreamError } from '@erp/service-kit';
import {
  fakeId,
  serviceTestEnv,
  startMongo,
  testKeys,
  TEST_INTERNAL_SECRET,
  type TestMongo,
} from '@erp/testing';
import { AppModule } from './app.module';
import { CLIENTS } from './clients';

const ROOT = fakeId(1);
const HYD = fakeId(2);
const BLR = fakeId(3);
const USER = fakeId(99);
const units: Record<
  string,
  { id: string; name: string; code: string; path: string; status: string }
> = {
  [ROOT]: { id: ROOT, name: 'Acme', code: 'HQ', path: `/${ROOT}/`, status: 'active' },
  [HYD]: { id: HYD, name: 'Hyderabad', code: 'HYD', path: `/${ROOT}/${HYD}/`, status: 'active' },
  [BLR]: { id: BLR, name: 'Bangalore', code: 'BLR', path: `/${ROOT}/${BLR}/`, status: 'active' },
};

const company: ConfigLayer = {
  ...emptyLayer(),
  picklists: [
    {
      key: 'mode',
      label: { en: 'Mode' },
      options: [
        { value: 'cash', label: { en: 'Cash' } },
        { value: 'upi', label: { en: 'UPI' } },
      ],
    },
  ],
  entities: [
    {
      key: 'city',
      kind: 'custom',
      label: { en: 'City' },
      pluralLabel: { en: 'Cities' },
      titleField: 'name',
      orgScoped: false,
      fields: [{ key: 'name', type: 'text', label: { en: 'Name' } }],
    },
    {
      key: 'customer',
      kind: 'custom',
      label: { en: 'Customer' },
      pluralLabel: { en: 'Customers' },
      titleField: 'name',
      orgScoped: false,
      fields: [
        { key: 'name', type: 'text', label: { en: 'Name' } },
        { key: 'city', type: 'lookup', target: 'city', label: { en: 'City' } },
      ],
    },
    {
      key: 'invoice',
      kind: 'custom',
      label: { en: 'Invoice' },
      pluralLabel: { en: 'Invoices' },
      titleField: 'ref',
      fields: [
        { key: 'ref', type: 'text', label: { en: 'Ref' } },
        { key: 'customer', type: 'lookup', target: 'customer', label: { en: 'Customer' } },
        { key: 'invoice_date', type: 'date', label: { en: 'Date' } },
        { key: 'mode', type: 'select', picklist: 'mode', label: { en: 'Mode' } },
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
          ],
        },
        { key: 'total', type: 'currency', label: { en: 'Total' } },
      ],
    },
    {
      key: 'payment',
      kind: 'custom',
      label: { en: 'Payment' },
      pluralLabel: { en: 'Payments' },
      fields: [
        { key: 'invoice', type: 'lookup', target: 'invoice', label: { en: 'Invoice' } },
        { key: 'paid', type: 'currency', label: { en: 'Paid' } },
      ],
    },
  ],
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86_400_000));

describe('records-service reports and document data', () => {
  let mongo: TestMongo;
  let app: INestApplication;
  let baseUrl = '';
  const http = () => request(baseUrl);
  const full: AclEntry[] = [{ ou: ROOT, path: units[ROOT].path, p: ['records.*.*'] }];
  const hydOnly: AclEntry[] = [
    { ou: HYD, path: units[HYD].path, p: ['records.invoice.read'] },
    { ou: ROOT, path: units[ROOT].path, p: ['records.customer.read', 'records.city.read'] },
  ];
  const noCities: AclEntry[] = [{ ou: ROOT, path: units[ROOT].path, p: ['records.invoice.read'] }];
  const bearer = `Bearer ${signAccessToken({ sub: USER, tid: 'tA', sid: 's', acl: full }, testKeys().privateKey, 300)}`;
  const svc = () =>
    signServiceToken({ sub: 'svc:reporting-service', tid: 'tA' }, TEST_INTERNAL_SECRET);

  const clients = {
    config: {
      effective: async (orgPath?: string) => ({
        ...resolveEffective(
          [platformBaseLayer()],
          { company, orgUnits: {} },
          {
            version: 1,
            orgPath,
            defaultFiscalYearStart: 4,
          },
        ),
        tenant: {
          countryCode: 'IN',
          currency: 'INR',
          locale: 'en-IN',
          defaultLanguage: 'en',
          timezone: 'Asia/Kolkata',
        },
      }),
      invalidate: () => undefined,
    },
    configApi: { post: async () => ({ number: 'X' }) },
    org: {
      get: async (path: string) => {
        const u = units[path.split('/').pop()!];
        if (!u) throw new UpstreamError('org-service', 404, undefined);
        return u;
      },
      post: async (_p: string, body: { ids: string[] }) =>
        body.ids
          .filter((i) => units[i])
          .map((i) => ({ ...units[i], custom: { address: `${units[i].name} Road` } })),
    },
    identity: {
      get: async () => ({}),
      post: async (_p: string, body: { ids: string[] }) =>
        body.ids.map((id) => ({ id, name: `User ${id.slice(-2)}`, email: 'u@x.test' })),
    },
    files: { get: async () => ({}) },
    access: { get: async () => [] },
  };

  const create = async (
    entity: string,
    orgUnitId: string | undefined,
    data: Record<string, unknown>,
  ) =>
    (
      await http()
        .post(`/api/v1/records/${entity}`)
        .set('authorization', bearer)
        .send({ orgUnitId, data })
        .expect(201)
    ).body as { id: string; data: Record<string, unknown> };

  const run = (
    report: Partial<ReportDef>,
    acl: AclEntry[] = full,
    params: Record<string, unknown> = {},
  ) =>
    http()
      .post('/internal/outputs/reports/run')
      .set('x-service-token', svc())
      .send({
        report: {
          key: 'r1',
          label: { en: 'R' },
          entity: 'invoice',
          columns: [],
          filters: [],
          ...report,
        },
        params,
        acl,
        lang: 'en',
      });

  const ids: Record<string, string> = {};

  beforeAll(async () => {
    mongo = await startMongo();
    Object.assign(
      process.env,
      serviceTestEnv(mongo.uri, 'erp_records_outputs', {
        CONFIG_SERVICE_URL: 'http://config.test',
        ORG_SERVICE_URL: 'http://org.test',
        IDENTITY_SERVICE_URL: 'http://identity.test',
        FILE_SERVICE_URL: 'http://file.test',
      }),
    );
    const ref = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PLACEMENT_RESOLVER)
      .useClass(SharedPlacementResolver)
      .overrideProvider(CLIENTS)
      .useValue(clients)
      .compile();
    app = ref.createNestApplication();
    await app.listen(0, '127.0.0.1');
    baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');

    ids.hydCity = (await create('city', undefined, { name: 'Hyderabad' })).id;
    ids.blrCity = (await create('city', undefined, { name: 'Bengaluru' })).id;
    ids.ravi = (await create('customer', undefined, { name: 'Ravi', city: ids.hydCity })).id;
    ids.meena = (await create('customer', undefined, { name: 'Meena', city: ids.blrCity })).id;
    const invoice = (
      unit: string,
      ref: string,
      customer: string,
      date: string,
      total: string,
      mode: string,
    ) =>
      create('invoice', unit, {
        ref,
        customer,
        invoice_date: date,
        total,
        mode,
        lines: [{ item: 'Pens', qty: 2, rate: '50' }],
      });
    ids.i1 = (await invoice(HYD, 'H-1', ids.ravi, daysAgo(0), '1000', 'cash')).id;
    ids.i2 = (await invoice(HYD, 'H-2', ids.ravi, daysAgo(0), '500', 'upi')).id;
    ids.i3 = (await invoice(BLR, 'B-1', ids.meena, daysAgo(0), '2000', 'upi')).id;
    ids.i4 = (await invoice(BLR, 'B-2', ids.ravi, '2025-01-15', '300', 'cash')).id;
    await create('payment', HYD, { invoice: ids.i1, paid: '600' });
    await create('payment', HYD, { invoice: ids.i1, paid: '400' });
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
  });

  it('stores table rows with row formulas and exact money', async () => {
    const res = await http()
      .get(`/api/v1/records/invoice/${ids.i1}`)
      .set('authorization', bearer)
      .expect(200);
    expect(res.body.data.lines).toEqual([
      { item: 'Pens', qty: 2, rate: { amount: '50.00', currency: 'INR' }, amount: 100 },
    ]);
  });

  it('lists rows with linked fields and labels, sorted and paged', async () => {
    const res = await run(
      {
        columns: [
          { path: 'ref' },
          { path: 'customer.name' },
          { path: 'customer.city.name' },
          { path: 'mode' },
          { path: 'total' },
          { path: 'orgUnitId' },
        ],
        sort: [{ path: 'ref', dir: 'asc' }],
      },
      full,
      { pageSize: 3 },
    ).expect(200);
    expect(res.body.kind).toBe('rows');
    expect(res.body.total).toBe(4);
    expect(res.body.rows).toHaveLength(3);
    expect(res.body.rows[0]).toMatchObject({
      c0: 'B-1',
      c1: 'Meena',
      c2: 'Bengaluru',
      c3: 'UPI',
      c4: 2000,
      c5: 'Bangalore',
    });
    expect(res.body.columns[4]).toMatchObject({
      label: 'Total',
      type: 'currency',
      currency: 'INR',
    });
    expect(res.body.columns[2].label).toBe('Customer › City › Name');
  });

  it('shows each viewer only the records in their units', async () => {
    const res = await run({ columns: [{ path: 'ref' }] }, hydOnly).expect(200);
    expect(res.body.rows.map((r: { c0: string }) => r.c0).sort()).toEqual(['H-1', 'H-2']);
    const denied = await run({ columns: [{ path: 'customer.city.name' }] }, noCities).expect(403);
    expect(denied.body.error.message).toMatch(/customer/);
    await run({ columns: [{ path: 'ref' }] }, hydOnly, { orgUnitId: BLR }).expect(403);
  });

  it('groups with subtotals, a grand total and distinct counts', async () => {
    const res = await run({
      groupBy: [{ path: 'customer.city.name' }, { path: 'mode' }],
      aggregates: [
        { fn: 'count' },
        { fn: 'sum', path: 'total' },
        { fn: 'count_distinct', path: 'customer' },
      ],
    }).expect(200);
    expect(res.body.kind).toBe('groups');
    const leaf = res.body.rows.map(
      (r: { labels: Record<string, string>; values: Record<string, number> }) => [
        r.labels.g0,
        r.labels.g1,
        r.values.a0,
        r.values.a1,
      ],
    );
    expect(leaf).toEqual([
      ['Bengaluru', 'UPI', 1, 2000],
      ['Hyderabad', 'Cash', 2, 1300],
      ['Hyderabad', 'UPI', 1, 500],
    ]);
    const hyd = res.body.subtotals.find(
      (s: { labels: Record<string, string> }) => s.labels.g0 === 'Hyderabad',
    );
    expect(hyd.values).toMatchObject({ a0: 3, a1: 1800, a2: 1 });
    expect(res.body.grandTotal).toEqual({ a0: 4, a1: 3800, a2: 2 });
    expect(res.body.columns.map((c: { label: string }) => c.label)).toEqual([
      'Customer › City › Name',
      'Mode',
      'Count',
      'Sum of Total',
      'Distinct count of Customer',
    ]);
  });

  it('pivots rows by columns with totals', async () => {
    const res = await run({
      pivot: {
        rows: [{ path: 'orgUnitId' }],
        column: { path: 'mode' },
        values: [{ fn: 'sum', path: 'total' }],
      },
    }).expect(200);
    expect(res.body.columnKeys).toEqual([
      { key: 'cash', label: 'Cash' },
      { key: 'upi', label: 'UPI' },
    ]);
    const blr = res.body.rows.find(
      (r: { labels: Record<string, string> }) => r.labels.g0 === 'Bangalore',
    );
    expect(blr.cells).toEqual({ cash: { a0: 300 }, upi: { a0: 2000 }, __total: { a0: 2300 } });
    expect(res.body.columnTotals).toEqual({ cash: { a0: 1300 }, upi: { a0: 2500 } });
    expect(res.body.grandTotal).toEqual({ a0: 3800 });
  });

  it('applies relative dates, prompts, dashboard ranges and drill-down', async () => {
    const thisMonth = await run({
      columns: [{ path: 'ref' }],
      filters: [
        { path: 'invoice_date', op: 'relative', relative: { period: 'last_n_days', n: 30 } },
      ],
    }).expect(200);
    expect(thisMonth.body.total).toBe(3);

    const prompted = {
      columns: [{ path: 'ref' }],
      filters: [{ path: 'mode', op: 'eq' as const, prompt: true }],
    };
    expect((await run(prompted).expect(200)).body.total).toBe(4);
    expect(
      (await run(prompted, full, { filters: { '0': { value: 'upi' } } }).expect(200)).body.total,
    ).toBe(2);

    const ranged = await run({ columns: [{ path: 'ref' }], dateField: 'invoice_date' }, full, {
      dateRange: { from: '2025-01-01', to: '2025-01-31' },
    }).expect(200);
    expect(ranged.body.rows.map((r: { c0: string }) => r.c0)).toEqual(['B-2']);

    const month = bucketKey('2025-01-15', 'month', 4);
    const drilled = await run({ columns: [{ path: 'ref' }] }, full, {
      drill: [
        { path: 'invoice_date', bucket: 'month', value: month },
        { path: 'mode', value: 'cash' },
      ],
    }).expect(200);
    expect(drilled.body.rows.map((r: { c0: string }) => r.c0)).toEqual(['B-2']);
  });

  it('lists the records behind a group for drill-down', async () => {
    const res = await run(
      {
        groupBy: [{ path: 'mode' }],
        aggregates: [{ fn: 'sum', path: 'total' }],
        dateField: 'invoice_date',
      },
      full,
      { records: true, drill: [{ path: 'mode', value: 'upi' }] },
    ).expect(200);
    expect(res.body.kind).toBe('rows');
    expect(res.body.columns.map((c: { label: string }) => c.label)).toEqual([
      'Number',
      'Ref',
      'Date',
      'Total',
    ]);
    expect(res.body.rows.map((r: { c1: string }) => r.c1).sort()).toEqual(['B-1', 'H-2']);
  });

  it('makes the same date buckets as the metadata package', async () => {
    const dates = ['2026-01-01', '2026-03-31', '2026-04-01', '2026-12-31', '2027-01-03'];
    for (const [i, d] of dates.entries()) {
      await create('invoice', HYD, { ref: `D-${i}`, invoice_date: d, total: '1' });
    }
    for (const bucket of [
      'day',
      'week',
      'month',
      'quarter',
      'year',
      'fiscal_year',
    ] as DateBucket[]) {
      const res = await run({
        filters: [{ path: 'ref', op: 'contains', value: 'D-' }],
        groupBy: [{ path: 'invoice_date', bucket }],
        aggregates: [{ fn: 'count' }],
      }).expect(200);
      const got = res.body.rows.map((r: { keys: { g0: string } }) => r.keys.g0);
      const want = [...new Set(dates.map((d) => bucketKey(d, bucket, 4)))].sort();
      expect({ bucket, got }).toEqual({ bucket, got: want });
    }
  });

  it('refuses reports that do not match the configuration', async () => {
    const res = await run({ columns: [{ path: 'customer.nope' }] }).expect(400);
    expect(res.body.error.details[0].message).toMatch(/Unknown field/);
  });

  it('gives document-service a record with its links, units and related records', async () => {
    const res = await http()
      .post('/internal/outputs/documents/data')
      .set('x-service-token', svc())
      .send({
        entity: 'invoice',
        ids: [ids.i1],
        acl: full,
        related: [{ entity: 'payment', field: 'invoice' }],
      })
      .expect(200);
    const [rec] = res.body.records;
    expect(rec).toMatchObject({
      id: ids.i1,
      orgUnitId: HYD,
      data: { ref: 'H-1', total: { amount: '1000.00' } },
    });
    expect(res.body.links[ids.ravi]).toMatchObject({
      title: 'Ravi',
      data: { name: 'Ravi', city: ids.hydCity },
    });
    expect(res.body.units[HYD]).toEqual({
      name: 'Hyderabad',
      code: 'HYD',
      custom: { address: 'Hyderabad Road' },
    });
    expect(res.body.users[USER].name).toBe(`User ${USER.slice(-2)}`);
    expect(
      res.body.related[ids.i1]['payment.invoice'].map(
        (p: { data: { paid: { amount: string } } }) => p.data.paid.amount,
      ),
    ).toEqual(['600.00', '400.00']);

    await http()
      .post('/internal/outputs/documents/data')
      .set('x-service-token', svc())
      .send({ entity: 'invoice', ids: [ids.i3], acl: hydOnly })
      .expect(403);
  });
});
