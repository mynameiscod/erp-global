import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Connection } from 'mongoose';
import { PDFDocument } from 'pdf-lib';
import request from 'supertest';
import { signAccessToken, signServiceToken } from '@erp/auth';
import type { AclEntry } from '@erp/contracts';
import {
  emptyLayer,
  platformBaseLayer,
  resolveEffective,
  type ConfigLayer,
  type PrintTemplateDef,
} from '@erp/metadata';
import { NOTIFY_STREAM, NotifyTypes, type EventEnvelope } from '@erp/contracts';
import {
  MONGO_CONNECTION,
  PLACEMENT_RESOLVER,
  SharedPlacementResolver,
  sharedMemoryBus,
} from '@erp/service-kit';
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
import { findChromium } from './pdf-engine';
import { DocumentRenderer, type DocData } from './renderer';

const ROOT = fakeId(1);
const HYD = fakeId(2);
const INV = fakeId(10);
const CUST = fakeId(11);
const USER = fakeId(99);

const receipt: PrintTemplateDef = {
  key: 'fee_receipt',
  entity: 'invoice',
  label: { en: 'Receipt', te: 'రసీదు' },
  page: { size: 'A5' },
  languages: ['en', 'te'],
  copies: [{ en: 'Student copy' }, { en: 'Office copy' }],
  watermarks: [{ text: { en: 'PAID' }, condition: 'STATUS() = "paid"' }],
  mode: 'blocks',
  footer: { pageNumbers: true },
  fileName: 'Receipt-{{number}}',
  blocks: [
    {
      id: 'lh',
      type: 'letterhead',
      lines: [{ en: '{{company.name}}' }, { en: '{{unit.name}}, {{unit.address}}' }],
    },
    { id: 't', type: 'title', text: { en: 'Receipt', te: 'రసీదు' } },
    {
      id: 'f',
      type: 'fields',
      columns: 2,
      items: [
        { path: 'number' },
        { path: 'customer.name' },
        { path: 'invoice_date' },
        { path: 'mode' },
      ],
    },
    {
      id: 'l',
      type: 'table',
      source: 'lines',
      numbered: true,
      columns: [{ path: 'item' }, { path: 'qty' }, { path: 'amount', format: 'currency' }],
      totals: ['amount'],
    },
    {
      id: 's',
      type: 'totals',
      rows: [{ label: { en: 'Total' }, value: 'SUM(lines.amount)', bold: true }],
      words: { value: 'SUM(lines.amount)' },
    },
    { id: 'p', type: 'table', source: 'related:payment.invoice', columns: [{ path: 'paid' }] },
    { id: 'q', type: 'qr', value: 'upi://pay?am={{total|number}}&tn={{number}}' },
    { id: 'n', type: 'text', text: { en: 'Due <b>soon</b>' }, condition: 'STATUS() != "paid"' },
  ],
};

const company: ConfigLayer = {
  ...emptyLayer(),
  picklists: [
    {
      key: 'mode',
      label: { en: 'Mode' },
      options: [{ value: 'cash', label: { en: 'Cash', te: 'నగదు' } }],
    },
  ],
  entities: [
    {
      key: 'customer',
      kind: 'custom',
      label: { en: 'Customer' },
      pluralLabel: { en: 'Customers' },
      titleField: 'name',
      fields: [
        { key: 'name', type: 'text', label: { en: 'Name' } },
        { key: 'email', type: 'email', label: { en: 'Email' } },
      ],
    },
    {
      key: 'invoice',
      kind: 'custom',
      label: { en: 'Invoice' },
      pluralLabel: { en: 'Invoices' },
      fields: [
        { key: 'customer', type: 'lookup', target: 'customer', label: { en: 'Customer' } },
        { key: 'invoice_date', type: 'date', label: { en: 'Date', te: 'తేదీ' } },
        { key: 'mode', type: 'select', picklist: 'mode', label: { en: 'Mode' } },
        { key: 'bill', type: 'file', label: { en: 'Bill' } },
        {
          key: 'lines',
          type: 'table',
          label: { en: 'Lines' },
          columns: [
            { key: 'item', type: 'text', label: { en: 'Item', te: 'వస్తువు' } },
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
  printTemplates: [receipt],
};

const invoiceRecord = (status: string | null = null) => ({
  id: INV,
  entity: 'invoice',
  number: 'INV/0001',
  status,
  orgUnitId: HYD,
  orgPath: `/${ROOT}/${HYD}/`,
  data: {
    customer: CUST,
    invoice_date: '2026-09-24',
    mode: 'cash',
    lines: [
      {
        item: 'Tuition <fee>',
        qty: 1,
        rate: { amount: '12000.00', currency: 'INR' },
        amount: 12000,
      },
      { item: 'Books', qty: 2, rate: { amount: '250.25', currency: 'INR' }, amount: 500.5 },
    ],
    total: 12500.5,
  },
  createdAt: '2026-09-24T05:00:00.000Z',
  updatedAt: '2026-09-24T05:00:00.000Z',
  createdBy: USER,
});

const docData = (status: string | null = null): DocData => ({
  records: [invoiceRecord(status)],
  links: {
    [CUST]: {
      ...invoiceRecord(),
      id: CUST,
      entity: 'customer',
      number: null,
      data: { name: 'Ravi Kumar', email: 'ravi@example.com' },
      title: 'Ravi Kumar',
    },
  },
  users: { [USER]: { name: 'Clerk', email: 'c@x.test' } },
  units: { [HYD]: { name: 'Hyderabad', code: 'HYD', custom: {} } },
  related: {
    [INV]: {
      'payment.invoice': [
        {
          ...invoiceRecord(),
          id: fakeId(20),
          entity: 'payment',
          data: { invoice: INV, paid: { amount: '5000.00', currency: 'INR' } },
        },
      ],
    },
  },
});

const cfg = async (orgPath?: string) => ({
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
    name: 'Acme School',
  },
});

describe('document renderer', () => {
  it('fills blocks in two languages, escapes values and draws totals in words', async () => {
    const renderer = new DocumentRenderer(receipt, {
      cfg: await cfg(),
      data: docData('paid'),
      company: { name: 'Acme School', custom: {} },
      unit: { name: 'Hyderabad', code: 'HYD', custom: { address: 'Road No. 1' } },
      lang: 'en',
      images: {},
    });
    const doc = renderer.render(docData('paid').records[0]);
    expect(doc.pages).toHaveLength(2);
    expect(doc.fileName).toBe('Receipt-INV_0001.pdf');
    const html = doc.pages[0];
    expect(html).toContain('Receipt / రసీదు');
    expect(html).toContain("font-family:'Noto Sans Telugu'");
    expect(html).toContain('Hyderabad, Road No. 1');
    expect(html).toContain('Ravi Kumar');
    expect(html).toContain('Cash / నగదు');
    expect(html).toContain('Tuition &lt;fee&gt;');
    expect(html).toContain('₹12,500.50');
    expect(html).toContain('Rupees Twelve Thousand Five Hundred and Fifty Paise Only');
    expect(html).toContain('₹5,000.00');
    expect(html).toContain('class="watermark">PAID');
    expect(html).toContain('Student copy');
    expect(doc.pages[1]).toContain('Office copy');
    // This text block is hidden once paid; when shown, its text is escaped too.
    expect(html).not.toContain('Due &lt;b&gt;');
    const unpaid = renderer.render(docData(null).records[0]).pages[0];
    expect(unpaid).toContain('Due &lt;b&gt;soon&lt;/b&gt;');
    expect(unpaid).not.toContain('class="watermark"');
  });
});

const chromium = findChromium();
const withChromium = chromium ? describe : describe.skip;
if (!chromium)
  console.warn('Chromium not found: skipping PDF tests. Set CHROMIUM_PATH to run them.');

withChromium('document-service', () => {
  let mongo: TestMongo;
  let app: INestApplication;
  let conn: Connection;
  let baseUrl = '';
  const status: string | null = null;
  const http = () => request(baseUrl);
  const acl: AclEntry[] = [{ ou: ROOT, path: `/${ROOT}/`, p: ['records.*.*', 'config.manage'] }];
  const bearer = `Bearer ${signAccessToken({ sub: USER, tid: 'tA', sid: 's', acl }, testKeys().privateKey, 300)}`;
  const stored: { name: string; bytes: Buffer }[] = [];
  const patched: unknown[] = [];
  const dataCalls: { ids: string[]; related?: unknown[] }[] = [];
  let hits = 0;
  let spy: Server;
  const mails: EventEnvelope[] = [];
  const eventually = async <T>(fn: () => T | undefined): Promise<T> => {
    for (let i = 0; i < 100; i++) {
      const v = fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('timed out');
  };

  const clients = {
    config: { effective: cfg, invalidate: () => undefined },
    records: {
      post: async (_p: string, body: { ids: string[]; related?: unknown[] }) => {
        dataCalls.push(body);
        const d = docData(status);
        return { ...d, records: body.ids.map((id) => ({ ...d.records[0], id })) };
      },
      request: async (_m: string, _p: string, body: unknown) => {
        patched.push(body);
        return {};
      },
    },
    files: {
      getBytes: async () => ({ bytes: Buffer.from('89504e47', 'hex'), contentType: 'image/png' }),
      postBytes: async (path: string, bytes: Buffer) => {
        const name = decodeURIComponent(/name=([^&]+)/.exec(path)![1]);
        stored.push({ name, bytes });
        return {
          id: `00000000-0000-4000-8000-00000000000${stored.length}`,
          name,
          size: bytes.length,
        };
      },
    },
    org: {
      get: async () => [
        { id: ROOT, name: 'Acme', code: 'HQ', custom: {} },
        { id: HYD, name: 'Hyderabad', code: 'HYD', custom: { address: 'Road No. 1' } },
      ],
    },
    identity: { post: async () => [{ id: USER, name: 'Clerk' }] },
  };

  const pages = async (bytes: Buffer) => (await PDFDocument.load(bytes)).getPageCount();

  beforeAll(async () => {
    spy = createServer((_req, res) => {
      hits++;
      res.end('x');
    });
    await new Promise<void>((r) => spy.listen(0, '127.0.0.1', () => r()));
    mongo = await startMongo();
    Object.assign(
      process.env,
      serviceTestEnv(mongo.uri, 'erp_document_test', {
        CONFIG_SERVICE_URL: 'http://config.test',
        RECORDS_SERVICE_URL: 'http://records.test',
        FILE_SERVICE_URL: 'http://file.test',
        ORG_SERVICE_URL: 'http://org.test',
        IDENTITY_SERVICE_URL: 'http://identity.test',
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
    conn = app.get(MONGO_CONNECTION);
    await sharedMemoryBus().subscribe({
      durable: 'test-mail',
      stream: NOTIFY_STREAM,
      subjects: [NotifyTypes.MailSend],
      handler: async (e) => {
        mails.push(e);
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    spy?.close();
  });

  const binary = (req: request.Test) =>
    req.buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

  it('prints a record: one page per copy, Telugu font embedded, related rows loaded', async () => {
    const res = await binary(
      http().get(`/api/v1/documents/invoice/${INV}/pdf`).set('authorization', bearer),
    ).expect(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('Receipt-INV_0001.pdf');
    const body = res.body as Buffer;
    expect(await pages(body)).toBe(2);
    expect(dataCalls.at(-1)?.related).toEqual([{ entity: 'payment', field: 'invoice' }]);
  });

  it('merges several records into one PDF', async () => {
    const res = await binary(
      http()
        .post('/api/v1/documents/invoice/pdf')
        .set('authorization', bearer)
        .send({ ids: [INV, fakeId(12)] }),
    ).expect(200);
    expect(await pages(res.body as Buffer)).toBe(4);
  });

  it('emails the PDF: stored, then a mail and an audit event in the outbox', async () => {
    const res = await http()
      .post(`/api/v1/documents/invoice/${INV}/email`)
      .set('authorization', bearer)
      .send({ to: ['ravi@example.com'], message: 'Thank you' })
      .expect(200);
    expect(res.body.fileName).toBe('Receipt-INV_0001.pdf');
    expect(stored.at(-1)!.bytes.subarray(0, 4).toString()).toBe('%PDF');
    const events = await conn.collection('outbox').find({}).toArray();
    const types = events.map((e) => (e.envelope as { type: string }).type);
    expect(types).toContain('documents.document.emailed');
    // Mail requests leave the outbox once handed to the bus.
    const mail = await eventually(() => mails.at(-1));
    expect(mail.payload).toMatchObject({
      to: ['ravi@example.com'],
      subject: 'Receipt INV/0001',
      attachments: [{ name: 'Receipt-INV_0001.pdf' }],
    });
  });

  it('previews a draft on sample values, and refuses scripts', async () => {
    const draft = {
      ...receipt,
      blocks: receipt.blocks!.filter((b) => b.type !== 'table' || b.source === 'lines'),
    };
    const res = await binary(
      http()
        .post('/api/v1/documents/preview')
        .set('authorization', bearer)
        .send({ template: draft }),
    ).expect(200);
    expect((res.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    await http()
      .post('/api/v1/documents/preview')
      .set('authorization', bearer)
      .send({ template: { ...receipt, mode: 'html', html: '<script>alert(1)</script>' } })
      .expect(400);
  });

  it('never lets a template reach the network', async () => {
    const port = (spy.address() as { port: number }).port;
    const html = `<p>{{number}}</p><img src="http://127.0.0.1:${port}/a.png"><div style="background:url(http://127.0.0.1:${port}/b.png)">x</div>`;
    await binary(
      http()
        .post('/api/v1/documents/preview')
        .set('authorization', bearer)
        .send({
          template: {
            ...receipt,
            mode: 'html',
            html,
            css: `p{background:url(http://127.0.0.1:${port}/c.png)}`,
          },
        }),
    ).expect(200);
    expect(hits).toBe(0);
  });

  it('prints an 80 mm receipt as long as its content', async () => {
    const thermal = { ...receipt, key: 'pos', page: { size: 'thermal80' as const }, copies: [] };
    const res = await binary(
      http()
        .post('/api/v1/documents/preview')
        .set('authorization', bearer)
        .send({ template: thermal }),
    ).expect(200);
    const pdf = await PDFDocument.load(res.body as Buffer);
    const { width, height } = pdf.getPage(0).getSize();
    expect(Math.round((width * 25.4) / 72)).toBe(80);
    expect(pdf.getPageCount()).toBe(1);
    expect(height).toBeGreaterThan(width);
  });

  it('generates for automations: attaches to the record and emails the customer', async () => {
    const res = await http()
      .post('/internal/documents/generate')
      .set(
        'x-service-token',
        signServiceToken({ sub: 'svc:workflow-service', tid: 'tA' }, TEST_INTERNAL_SECRET),
      )
      .send({
        entity: 'invoice',
        recordId: INV,
        attachField: 'bill',
        emailTo: ['office@example.com'],
        depth: 1,
      })
      .expect(200);
    expect(res.body.emailedTo).toEqual(['office@example.com']);
    expect(patched.at(-1)).toEqual({ data: { bill: res.body.fileId }, depth: 2 });
  });

  it('renders report tables to PDF for exports', async () => {
    const res = await http()
      .post('/internal/documents/table-pdf')
      .set(
        'x-service-token',
        signServiceToken({ sub: 'svc:reporting-service', tid: 'tA' }, TEST_INTERNAL_SECRET),
      )
      .send({
        title: 'Fees by branch',
        columns: [{ label: 'Branch' }, { label: 'Amount', align: 'right' }],
        rows: Array.from({ length: 120 }, (_, i) => [`Branch ${i}`, `₹${i},000`]),
        fileName: 'fees.pdf',
      })
      .expect(200);
    expect(res.body.name).toBe('fees.pdf');
    expect(await pages(stored.at(-1)!.bytes)).toBeGreaterThan(1);
  });
});
