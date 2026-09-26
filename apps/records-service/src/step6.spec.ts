import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { signAccessToken, signServiceToken } from '@erp/auth';
import type { AclEntry } from '@erp/contracts';
import {
  emptyLayer,
  platformBaseLayer,
  resolveEffective,
  type ConfigLayer,
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
const units: Record<
  string,
  {
    id: string;
    name: string;
    code: string;
    path: string;
    status: string;
    custom: Record<string, unknown>;
  }
> = {
  [ROOT]: {
    id: ROOT,
    name: 'Acme',
    code: 'HQ',
    path: `/${ROOT}/`,
    status: 'active',
    custom: { state: '29' },
  },
  [HYD]: {
    id: HYD,
    name: 'Hyderabad',
    code: 'HYD',
    path: `/${ROOT}/${HYD}/`,
    status: 'active',
    custom: { state: '36' },
  },
};

const company: ConfigLayer = {
  ...emptyLayer(),
  identifierTypes: [
    {
      key: 'gstin',
      label: { en: 'GSTIN' },
      pattern: '[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]',
      checksum: 'luhn_mod36',
      uppercase: true,
    },
  ],
  taxes: {
    components: [
      { key: 'cgst', label: { en: 'CGST' } },
      { key: 'sgst', label: { en: 'SGST' } },
      { key: 'igst', label: { en: 'IGST' } },
    ],
    categories: [
      { key: 'gst_18', label: { en: 'GST 18%' }, rate: 18 },
      { key: 'gst_5', label: { en: 'GST 5%' }, rate: 5 },
    ],
    rules: [
      {
        key: 'intra',
        label: { en: 'Intra' },
        condition: 'buyer_region = "" || seller_region = buyer_region',
        split: [
          { component: 'cgst', share: 0.5 },
          { component: 'sgst', share: 0.5 },
        ],
      },
      { key: 'inter', label: { en: 'Inter' }, split: [{ component: 'igst', share: 1 }] },
    ],
    defaultCategory: 'gst_18',
  },
  picklists: [
    {
      key: 'states',
      label: { en: 'States' },
      options: [
        { value: '36', label: { en: 'Telangana' } },
        { value: '29', label: { en: 'Karnataka' } },
      ],
    },
  ],
  entities: [
    {
      key: 'customer',
      kind: 'custom',
      label: { en: 'Customer' },
      pluralLabel: { en: 'Customers' },
      titleField: 'name',
      orgScoped: false,
      fields: [
        { key: 'name', type: 'text', label: { en: 'Name' } },
        { key: 'state', type: 'select', picklist: 'states', label: { en: 'State' } },
        { key: 'gstin', type: 'text', label: { en: 'GSTIN' }, identifier: 'gstin' },
      ],
    },
    {
      key: 'invoice',
      kind: 'custom',
      label: { en: 'Invoice' },
      pluralLabel: { en: 'Invoices' },
      tax: {
        lines: 'lines',
        amount: 'amount',
        category: 'tax_category',
        code: 'hsn',
        sellerRegion: 'unit.state',
        buyerRegion: 'customer.state',
        buyerRegistered: 'customer.gstin',
        document: 'invoice',
      },
      fields: [
        { key: 'customer', type: 'lookup', target: 'customer', label: { en: 'Customer' } },
        {
          key: 'lines',
          type: 'table',
          label: { en: 'Lines' },
          columns: [
            { key: 'item', type: 'text', label: { en: 'Item' } },
            { key: 'hsn', type: 'text', label: { en: 'HSN' } },
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
      ],
    },
  ],
};

describe('records-service taxes, identifiers and line-item reports', () => {
  let mongo: TestMongo;
  let app: INestApplication;
  let baseUrl = '';
  const http = () => request(baseUrl);
  const acl: AclEntry[] = [{ ou: ROOT, path: `/${ROOT}/`, p: ['records.*.*'] }];
  const bearer = `Bearer ${signAccessToken({ sub: fakeId(99), tid: 'tA', sid: 's', acl }, testKeys().privateKey, 300)}`;
  const svc = () => signServiceToken({ sub: 'svc:pack-service', tid: 'tA' }, TEST_INTERNAL_SECRET);
  const clients = {
    config: {
      effective: async (orgPath?: string) => ({
        ...resolveEffective(
          [platformBaseLayer()],
          { company, orgUnits: {} },
          { version: 1, orgPath, defaultFiscalYearStart: 4 },
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
        if (path.endsWith('/ancestors')) {
          const u = units[path.split('/').at(-2)!];
          return u.path
            .split('/')
            .filter(Boolean)
            .map((id) => units[id]);
        }
        const u = units[path.split('/').pop()!];
        if (!u) throw new UpstreamError('org-service', 404, undefined);
        return u;
      },
      post: async (_p: string, body: { ids: string[] }) =>
        body.ids.filter((i) => units[i]).map((i) => units[i]),
    },
    identity: { get: async () => ({}), post: async () => [] },
    files: { get: async () => ({}) },
    access: { get: async () => [] },
  };

  const create = (entity: string, orgUnitId: string | undefined, data: Record<string, unknown>) =>
    http().post(`/api/v1/records/${entity}`).set('authorization', bearer).send({ orgUnitId, data });

  beforeAll(async () => {
    mongo = await startMongo();
    Object.assign(
      process.env,
      serviceTestEnv(mongo.uri, 'erp_records_step6', {
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
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
  });

  const ids: Record<string, string> = {};

  it('validates identifiers', async () => {
    const bad = await create('customer', undefined, { name: 'X', gstin: '36AAPFU0939F1ZV' }).expect(
      400,
    );
    expect(bad.body.error.details[0].message).toMatch(/check digit/);
    ids.local = (
      await create('customer', undefined, {
        name: 'Local',
        state: '36',
        gstin: '36aabcu9603r1zo',
      }).expect(201)
    ).body.id;
    ids.away = (
      await create('customer', undefined, { name: 'Away', state: '29' }).expect(201)
    ).body.id;
  });

  it('calculates GST on save from the branch and customer states', async () => {
    const lines = [
      { item: 'Laptop', hsn: '8471', qty: 1, rate: '50000', tax_category: 'gst_18' },
      { item: 'Book', hsn: '4901', qty: 2, rate: '100', tax_category: 'gst_5' },
    ];
    const intra = (await create('invoice', HYD, { customer: ids.local, lines }).expect(201)).body;
    expect(intra.data).toMatchObject({
      tax_rule: 'intra',
      subtotal: 50200,
      tax_total: 9010,
      grand_total: 59210,
    });
    expect(intra.data.lines[0]).toMatchObject({
      taxable_value: 50000,
      tax_rate: 18,
      tax_amount: 9000,
    });
    expect(intra.data.tax_summary).toEqual([
      { component: 'cgst', rate: 9, taxable: 50000, amount: 4500 },
      { component: 'sgst', rate: 9, taxable: 50000, amount: 4500 },
      { component: 'cgst', rate: 2.5, taxable: 200, amount: 5 },
      { component: 'sgst', rate: 2.5, taxable: 200, amount: 5 },
    ]);
    const inter = (await create('invoice', HYD, { customer: ids.away, lines }).expect(201)).body;
    expect(inter.data).toMatchObject({ tax_rule: 'inter', tax_total: 9010 });
    expect(inter.data.tax_summary[0]).toEqual({
      component: 'igst',
      rate: 18,
      taxable: 50000,
      amount: 9000,
    });
    // Changing the customer re-calculates.
    const moved = await http()
      .patch(`/api/v1/records/invoice/${inter.id}`)
      .set('authorization', bearer)
      .send({ data: { customer: ids.local } })
      .expect(200);
    expect(moved.body.data.tax_rule).toBe('intra');
    ids.invoice = inter.id;
  });

  it('reports one row per line item (HSN summary)', async () => {
    const report: ReportDef = {
      key: 'hsn',
      label: { en: 'HSN summary' },
      entity: 'invoice',
      lines: 'lines',
      columns: [],
      filters: [{ path: 'lines.tax_rate', op: 'gt', value: 0 }],
      groupBy: [{ path: 'lines.hsn' }, { path: 'tax_rule' }],
      aggregates: [
        { fn: 'sum', path: 'lines.qty' },
        { fn: 'sum', path: 'lines.taxable_value' },
        { fn: 'sum', path: 'lines.tax_amount' },
      ],
    };
    const res = await http()
      .post('/internal/outputs/reports/run')
      .set('x-service-token', svc())
      .send({ report, acl, lang: 'en' })
      .expect(200);
    expect(
      res.body.rows.map((r: { keys: Record<string, string>; values: Record<string, number> }) => [
        r.keys.g0,
        r.keys.g1,
        r.values.a0,
        r.values.a1,
        r.values.a2,
      ]),
    ).toEqual([
      ['4901', 'intra', 4, 400, 20],
      ['8471', 'intra', 2, 100000, 18000],
    ]);
    const rows = await http()
      .post('/internal/outputs/reports/run')
      .set('x-service-token', svc())
      .send({
        report: {
          ...report,
          groupBy: undefined,
          aggregates: undefined,
          columns: [{ path: 'lines.item' }, { path: 'customer.name' }],
        },
        acl,
        lang: 'en',
      })
      .expect(200);
    expect(rows.body.total).toBe(4);
    expect(new Set(rows.body.rows.map((r: { __id: string }) => r.__id)).size).toBe(4);
  });

  it('removes a pack’s sample records by their source', async () => {
    const tok = svc();
    await http()
      .post('/internal/records/customer')
      .set('x-service-token', tok)
      .send({ data: { name: 'Sample' }, sourceKey: 'pack:industry.demo:c1', depth: 1 })
      .expect(201);
    const res = await http()
      .post('/internal/outputs/samples/remove')
      .set('x-service-token', tok)
      .send({ prefix: 'pack:industry.demo:' })
      .expect(200);
    expect(res.body.deleted).toBe(1);
    // The source key is free again.
    await http()
      .post('/internal/records/customer')
      .set('x-service-token', tok)
      .send({ data: { name: 'Sample' }, sourceKey: 'pack:industry.demo:c1', depth: 1 })
      .expect(201);
  });
});
