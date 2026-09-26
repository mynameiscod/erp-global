/**
 * Step 5 acceptance test: table fields, print templates and PDFs, reports, exports,
 * scheduled reports and dashboards, end to end through the gateway with every service
 * running (PDFs with a real headless Chromium).
 */
import { PDFDocument } from 'pdf-lib';
import request from 'supertest';
import type { Connection } from 'mongoose';
import { signServiceToken } from '@erp/auth';
import { NotifyTypes, type EmailRequestedPayload, type MailSendPayload } from '@erp/contracts';
import { MONGO_CONNECTION, sharedMemoryBus } from '@erp/service-kit';
import { TEST_INTERNAL_SECRET } from '@erp/testing';
import {
  CLOCK as REPORTING_CLOCK,
  type AdjustableClock,
} from '../../../apps/reporting-service/src/clients';
import { Worker } from '../../../apps/reporting-service/src/worker';
import { findChromium } from '../../../apps/document-service/src/pdf-engine';
import { eventually, startStack, type Stack } from './harness';

const PASSWORD = 'Very-secret-pass-1';
const today = new Date().toISOString().slice(0, 10);

if (!findChromium() && process.env.CI) throw new Error('Chromium is required for the Step 5 tests');
const withChromium = findChromium() ? describe : describe.skip;

withChromium('Step 5 acceptance: documents, reports and dashboards', () => {
  let stack: Stack;
  const api = () => request(stack.gatewayUrl);
  const ids: Record<string, string> = {};
  const auth: Record<string, string> = {};

  const binary = (req: request.Test) =>
    req.buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

  const fileBytes = async (fileId: string) =>
    (
      await binary(
        request(stack.serviceUrl('file'))
          .get(`/internal/files/${fileId}/bytes`)
          .set(
            'x-service-token',
            signServiceToken({ sub: 'svc:e2e', tid: ids.tenant }, TEST_INTERNAL_SECRET),
          ),
      ).expect(200)
    ).body as Buffer;

  async function login(tenantSlug: string, email: string) {
    const res = await api()
      .post('/api/v1/identity/auth/login')
      .send({ tenantSlug, email, password: PASSWORD })
      .expect(200);
    return `Bearer ${res.body.accessToken}`;
  }

  const published = <T>(type: string, match: (p: T) => boolean) =>
    eventually(async () => {
      const e = sharedMemoryBus()
        .published.slice()
        .reverse()
        .find((x) => x.type === type && match(x.payload as T));
      return e ? { ...e, payload: e.payload as T } : undefined;
    });

  async function person(key: string, roleId: string, unitId: string) {
    const email = `${key}@acme.test`;
    const invite = await api()
      .post('/api/v1/identity/users/invite')
      .set('authorization', auth.admin)
      .send({ name: key, email })
      .expect(201);
    ids[key] = invite.body.id;
    const mail = await published<EmailRequestedPayload>(
      NotifyTypes.EmailRequested,
      (p) => p.to === email,
    );
    const token = decodeURIComponent(new URL(mail.payload.vars.link).searchParams.get('token')!);
    await api()
      .post('/api/v1/identity/auth/invite/accept')
      .send({ token, password: PASSWORD })
      .expect(200);
    await api()
      .post('/api/v1/access/assignments')
      .set('authorization', auth.admin)
      .send({ userId: ids[key], roleId, orgUnitId: unitId })
      .expect(201);
    auth[key] = await login('acme', email);
  }

  const put = (kind: string, key: string, body: object, scope?: string) =>
    api()
      .put(`/api/v1/config/draft/${kind}/${key}${scope ? `?scope=${scope}` : ''}`)
      .set('authorization', auth.admin)
      .send(body)
      .expect(200);

  const unit = async (parentId: string, name: string, code: string) =>
    (
      await api()
        .post('/api/v1/org/units')
        .set('authorization', auth.admin)
        .send({ parentId, name, code, type: 'Branch' })
        .expect(201)
    ).body.id as string;

  const invoice = async (
    orgUnitId: string,
    customer: string,
    lines: [string, number, string][],
    mode = 'cash',
  ) =>
    (
      await api()
        .post('/api/v1/records/invoice')
        .set('authorization', auth.admin)
        .send({
          orgUnitId,
          data: {
            customer,
            invoice_date: today,
            mode,
            email: 'accounts@customer.test',
            lines: lines.map(([item, qty, rate]) => ({ item, qty, rate })),
          },
        })
        .expect(201)
    ).body as { id: string; number: string; data: Record<string, unknown> };

  beforeAll(async () => {
    stack = await startStack();
    await api()
      .post('/api/v1/tenants/signup')
      .send({
        companyName: 'Acme School',
        slug: 'acme',
        countryCode: 'IN',
        industryCode: 'education',
        defaultLanguage: 'en',
        timezone: 'Asia/Kolkata',
        admin: { name: 'Owner', email: 'owner@acme.test', password: PASSWORD },
      })
      .expect(201);
    auth.admin = await login('acme', 'owner@acme.test');
    // The tenant id travels in the access token.
    const claims = auth.admin.split(' ')[1].split('.')[1];
    ids.tenant = (JSON.parse(Buffer.from(claims, 'base64url').toString()) as { tid: string }).tid;
    const units = await api().get('/api/v1/org/units').set('authorization', auth.admin).expect(200);
    ids.root = units.body[0].id;
    ids.hyd = await unit(ids.root, 'Hyderabad', 'HYD');
    ids.blr = await unit(ids.root, 'Bengaluru', 'BLR');
  });

  afterAll(async () => {
    await stack?.stop();
  });

  it('builds entities with line items, templates, reports and dashboards in the studio', async () => {
    await put('picklists', 'mode', {
      key: 'mode',
      label: { en: 'Mode' },
      options: [
        { value: 'cash', label: { en: 'Cash', te: 'నగదు' } },
        { value: 'upi', label: { en: 'UPI' } },
      ],
    });
    await put('numbering', 'invoice', {
      key: 'invoice',
      label: { en: 'Invoice' },
      pattern: 'INV/{SEQ:4}',
      reset: 'never',
      scope: 'company',
    });
    await put('entities', 'customer', {
      key: 'customer',
      kind: 'custom',
      label: { en: 'Customer' },
      pluralLabel: { en: 'Customers' },
      titleField: 'name',
      orgScoped: false,
      fields: [{ key: 'name', type: 'text', label: { en: 'Name' }, required: true }],
    });
    await put('entities', 'invoice', {
      key: 'invoice',
      kind: 'custom',
      label: { en: 'Invoice', te: 'ఇన్వాయిస్' },
      pluralLabel: { en: 'Invoices' },
      fields: [
        { key: 'inv_no', type: 'autonumber', numbering: 'invoice', label: { en: 'No.' } },
        { key: 'customer', type: 'lookup', target: 'customer', label: { en: 'Customer' } },
        { key: 'invoice_date', type: 'date', label: { en: 'Date' } },
        { key: 'mode', type: 'select', picklist: 'mode', label: { en: 'Mode' } },
        { key: 'email', type: 'email', label: { en: 'Email' } },
        { key: 'bill', type: 'file', label: { en: 'Bill PDF' } },
        {
          key: 'lines',
          type: 'table',
          label: { en: 'Lines' },
          columns: [
            { key: 'item', type: 'text', label: { en: 'Item', te: 'వస్తువు' }, required: true },
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
    });
    const blocks = [
      {
        id: 'lh',
        type: 'letterhead',
        lines: [{ en: '{{company.name}}' }, { en: '{{unit.name}}' }],
      },
      { id: 't', type: 'title', text: { en: 'Tax invoice', te: 'పన్ను ఇన్వాయిస్' } },
      {
        id: 'f',
        type: 'fields',
        columns: 2,
        items: [
          { path: 'inv_no' },
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
        columns: [
          { path: 'item' },
          { path: 'qty' },
          { path: 'rate' },
          { path: 'amount', format: 'currency' },
        ],
        totals: ['amount'],
      },
      {
        id: 's',
        type: 'totals',
        rows: [{ label: { en: 'Total' }, value: 'total', bold: true }],
        words: { value: 'total' },
      },
      { id: 'q', type: 'qr', value: 'upi://pay?am={{total|number}}&tn={{inv_no}}' },
    ];
    await put('print-templates', 'invoice_a4', {
      key: 'invoice_a4',
      entity: 'invoice',
      label: { en: 'Invoice' },
      page: { size: 'A4' },
      mode: 'blocks',
      footer: { pageNumbers: true },
      fileName: 'Invoice-{{number}}',
      blocks,
    });
    await put('print-templates', 'receipt', {
      key: 'receipt',
      entity: 'invoice',
      label: { en: 'Receipt' },
      page: { size: 'A5' },
      languages: ['en', 'te'],
      copies: [{ en: 'Customer copy' }, { en: 'Office copy' }],
      mode: 'blocks',
      blocks,
    });
    // Bengaluru prints the invoice with its own letterhead (and file name).
    await put(
      'print-templates',
      'invoice_a4',
      {
        key: 'invoice_a4',
        entity: 'invoice',
        label: { en: 'Invoice' },
        page: { size: 'A4' },
        mode: 'blocks',
        fileName: 'BLR-{{number}}',
        blocks,
      },
      ids.blr,
    );
    await put('reports', 'sales_by_branch', {
      key: 'sales_by_branch',
      label: { en: 'Sales by branch' },
      entity: 'invoice',
      columns: [],
      filters: [{ path: 'mode', op: 'eq', prompt: true, label: { en: 'Mode' } }],
      pivot: {
        rows: [{ path: 'orgUnitId' }],
        column: { path: 'invoice_date', bucket: 'month' },
        values: [{ fn: 'sum', path: 'total' }],
      },
      dateField: 'invoice_date',
    });
    await put('reports', 'sales_by_mode', {
      key: 'sales_by_mode',
      label: { en: 'Sales by mode' },
      entity: 'invoice',
      columns: [],
      filters: [],
      groupBy: [{ path: 'mode' }],
      aggregates: [{ fn: 'count' }, { fn: 'sum', path: 'total' }],
      chart: { type: 'bar' },
      dateField: 'invoice_date',
    });
    await put('reports', 'invoice_list', {
      key: 'invoice_list',
      label: { en: 'Invoices' },
      entity: 'invoice',
      columns: [
        { path: 'inv_no' },
        { path: 'customer.name' },
        { path: 'orgUnitId' },
        { path: 'total' },
      ],
      filters: [{ path: 'invoice_date', op: 'relative', relative: { period: 'this_fiscal_year' } }],
      sort: [{ path: 'inv_no', dir: 'asc' }],
      dateField: 'invoice_date',
    });
    await put('reports', 'sales_kpi', {
      key: 'sales_kpi',
      label: { en: 'Sales this month' },
      entity: 'invoice',
      columns: [],
      filters: [{ path: 'invoice_date', op: 'relative', relative: { period: 'this_month' } }],
      aggregates: [{ fn: 'sum', path: 'total' }],
      dateField: 'invoice_date',
    });
    // Automation: every new invoice gets its PDF attached and emailed to the customer.
    await put('automations', 'invoice_pdf', {
      key: 'invoice_pdf',
      entity: 'invoice',
      label: { en: 'Invoice PDF' },
      trigger: { type: 'created' },
      actions: [
        { type: 'document', template: 'invoice_a4', attachField: 'bill', emailFields: ['email'] },
      ],
    });
    const role = await api()
      .post('/api/v1/access/roles')
      .set('authorization', auth.admin)
      .send({
        name: 'Branch Head',
        permissions: ['org.unit.read', 'reports.export', 'reports.personal', 'reports.share'],
      })
      .expect(201);
    ids.headRole = role.body.id;
    await put('dashboards', 'branch_head', {
      key: 'branch_head',
      label: { en: 'Branch head' },
      roleIds: [ids.headRole],
      home: true,
      filters: { dateRange: true, orgUnit: true },
      widgets: [
        {
          id: 'kpi',
          type: 'kpi',
          report: 'sales_kpi',
          kpi: { compare: true },
          x: 0,
          y: 0,
          w: 3,
          h: 2,
        },
        { id: 'chart', type: 'chart', report: 'sales_by_mode', x: 3, y: 0, w: 6, h: 4 },
        { id: 'list', type: 'list', report: 'invoice_list', limit: 5, x: 0, y: 4, w: 12, h: 4 },
        { id: 'approvals', type: 'approvals', x: 9, y: 0, w: 3, h: 4 },
      ],
    });
    const issues = await api()
      .get('/api/v1/config/draft/validate')
      .set('authorization', auth.admin)
      .expect(200);
    expect(issues.body.issues ?? issues.body).toEqual([]);
    await api()
      .post('/api/v1/config/publish')
      .set('authorization', auth.admin)
      .send({ note: 'Step 5' })
      .expect(201);

    // Record permissions exist once the entities are published.
    await api()
      .patch(`/api/v1/access/roles/${ids.headRole}`)
      .set('authorization', auth.admin)
      .send({
        permissions: [
          'org.unit.read',
          'reports.export',
          'reports.personal',
          'reports.share',
          'records.invoice.read',
          'records.customer.read',
        ],
      })
      .expect(200);
    await person('hema', ids.headRole, ids.hyd);
    await person('bhanu', ids.headRole, ids.blr);
    const noReports = await api()
      .post('/api/v1/access/roles')
      .set('authorization', auth.admin)
      .send({ name: 'Clerk', permissions: ['records.invoice.read'] })
      .expect(201);
    await person('chitra', noReports.body.id, ids.hyd);
  });

  it('keeps line items with row formulas and a total', async () => {
    ids.ravi = (
      await api()
        .post('/api/v1/records/customer')
        .set('authorization', auth.admin)
        .send({ data: { name: 'Ravi Kumar' } })
        .expect(201)
    ).body.id;
    const inv = await invoice(ids.hyd, ids.ravi, [
      ['Tuition', 1, '12000'],
      ['Books', 2, '250.25'],
    ]);
    ids.inv1 = inv.id;
    expect(inv.data.lines).toEqual([
      { item: 'Tuition', qty: 1, rate: { amount: '12000.00', currency: 'INR' }, amount: 12000 },
      { item: 'Books', qty: 2, rate: { amount: '250.25', currency: 'INR' }, amount: 500.5 },
    ]);
    expect(inv.data.total).toBe(12500.5);
    ids.inv2 = (await invoice(ids.hyd, ids.ravi, [['Bus', 1, '1500']], 'upi')).id;
    ids.inv3 = (await invoice(ids.blr, ids.ravi, [['Tuition', 1, '9000']])).id;
    const bad = await api()
      .post('/api/v1/records/invoice')
      .set('authorization', auth.admin)
      .send({ orgUnitId: ids.hyd, data: { lines: [{ qty: 'x' }] } })
      .expect(400);
    expect(bad.body.error.details[0].path).toBe('lines');
  });

  it('attaches and emails the PDF from an automation', async () => {
    const withBill = await eventually(async () => {
      const r = await api()
        .get(`/api/v1/records/invoice/${ids.inv1}`)
        .set('authorization', auth.admin)
        .expect(200);
      return r.body.data.bill ? r.body : undefined;
    }, 60_000);
    expect((await fileBytes(withBill.data.bill)).subarray(0, 4).toString()).toBe('%PDF');
    const mail = await published<MailSendPayload>(NotifyTypes.MailSend, (p) =>
      p.to.includes('accounts@customer.test'),
    );
    expect(mail.payload.attachments[0].name).toMatch(/^Invoice-.*\.pdf$/);
  });

  it('prints records to PDF: copies, branch overrides and several at once', async () => {
    const one = await binary(
      api().get(`/api/v1/documents/invoice/${ids.inv1}/pdf`).set('authorization', auth.hema),
    ).expect(200);
    expect(one.headers['content-type']).toBe('application/pdf');
    expect(one.headers['content-disposition']).toMatch(/Invoice-/);
    expect((await PDFDocument.load(one.body as Buffer)).getPageCount()).toBe(1);

    const receipt = await binary(
      api()
        .get(`/api/v1/documents/invoice/${ids.inv1}/pdf?template=receipt`)
        .set('authorization', auth.hema),
    ).expect(200);
    expect((await PDFDocument.load(receipt.body as Buffer)).getPageCount()).toBe(2);

    const blr = await binary(
      api().get(`/api/v1/documents/invoice/${ids.inv3}/pdf`).set('authorization', auth.admin),
    ).expect(200);
    expect(blr.headers['content-disposition']).toMatch(/BLR-/);

    const both = await binary(
      api()
        .post('/api/v1/documents/invoice/pdf')
        .set('authorization', auth.admin)
        .send({ ids: [ids.inv1, ids.inv3] }),
    ).expect(200);
    expect((await PDFDocument.load(both.body as Buffer)).getPageCount()).toBe(2);

    // A branch head cannot print another branch's invoice.
    await api()
      .get(`/api/v1/documents/invoice/${ids.inv3}/pdf`)
      .set('authorization', auth.hema)
      .expect(403);
  });

  it('emails a PDF and keeps a copy', async () => {
    const res = await api()
      .post(`/api/v1/documents/invoice/${ids.inv2}/email`)
      .set('authorization', auth.hema)
      .send({ to: ['parent@example.com'], message: 'Your receipt' })
      .expect(200);
    const mail = await published<MailSendPayload>(
      NotifyTypes.MailSend,
      (p) => p.to[0] === 'parent@example.com',
    );
    expect(mail.payload.attachments).toEqual([
      { fileId: res.body.fileId, name: res.body.fileName },
    ]);
    // notification-service fetched the attachment from file-service and sent the mail.
    const conn = stack.apps.notification.get<Connection>(MONGO_CONNECTION);
    await eventually(async () =>
      conn.collection('deliveries').findOne({ eventId: mail.eventId, status: 'sent' }),
    );
  });

  it('previews a draft template on sample values', async () => {
    const res = await binary(
      api()
        .post('/api/v1/documents/preview')
        .set('authorization', auth.admin)
        .send({
          template: {
            key: 'draft',
            entity: 'invoice',
            label: { en: 'Draft' },
            page: { size: 'thermal80' },
            mode: 'blocks',
            blocks: [{ id: 'x', type: 'title', text: { en: 'Receipt {{number}}' } }],
          },
        }),
    ).expect(200);
    const width = (await PDFDocument.load(res.body as Buffer)).getPage(0).getSize().width;
    expect(Math.round((width * 25.4) / 72)).toBe(80);
  });

  it('shows each person only the reports and records they may see', async () => {
    const list = await api().get('/api/v1/reports').set('authorization', auth.hema).expect(200);
    expect(list.body.map((r: { ref: string }) => r.ref).sort()).toEqual([
      'invoice_list',
      'sales_by_branch',
      'sales_by_mode',
      'sales_kpi',
    ]);
    const pivot = (who: string, params = {}) =>
      api()
        .post('/api/v1/reports/sales_by_branch/run')
        .set('authorization', auth[who])
        .send({ params })
        .expect(200);
    const hema = await pivot('hema');
    expect(hema.body.rows.map((r: { labels: { g0: string } }) => r.labels.g0)).toEqual([
      'Hyderabad',
    ]);
    expect(hema.body.grandTotal).toEqual({ a0: 14000.5 });
    const admin = await pivot('admin');
    expect(admin.body.grandTotal).toEqual({ a0: 23000.5 });
    const upi = await pivot('admin', { filters: { '0': { value: 'upi' } } });
    expect(upi.body.grandTotal).toEqual({ a0: 1500 });

    const rows = await api()
      .post('/api/v1/reports/invoice_list/run')
      .set('authorization', auth.hema)
      .send({})
      .expect(200);
    expect(rows.body.rows.map((r: { c1: string; c2: string }) => [r.c1, r.c2])).toEqual([
      ['Ravi Kumar', 'Hyderabad'],
      ['Ravi Kumar', 'Hyderabad'],
    ]);
    // Without access to invoices there are no invoice reports.
    const clerk = await api().get('/api/v1/reports').set('authorization', auth.chitra).expect(200);
    expect(clerk.body.length).toBe(4);
    await api()
      .post('/api/v1/reports/invoice_list/export')
      .set('authorization', auth.chitra)
      .send({ format: 'csv' })
      .expect(403);
  });

  it('exports in the background and tells the person when the file is ready', async () => {
    const job = await api()
      .post('/api/v1/reports/invoice_list/export')
      .set('authorization', auth.hema)
      .send({ format: 'xlsx' })
      .expect(201);
    await stack.apps.reporting.get(Worker).runDue();
    const done = await api()
      .get(`/api/v1/reports/exports/${job.body.id}`)
      .set('authorization', auth.hema)
      .expect(200);
    expect(done.body).toMatchObject({ status: 'done', rows: 2, format: 'xlsx' });
    // An .xlsx file is a zip archive.
    expect((await fileBytes(done.body.fileId)).subarray(0, 2).toString()).toBe('PK');
    await eventually(async () => {
      const res = await api()
        .get('/api/v1/notifications')
        .set('authorization', auth.hema)
        .expect(200);
      return (res.body.items as { template: string }[]).find((n) => n.template === 'report.ready');
    });

    const pdf = await api()
      .post('/api/v1/reports/sales_by_mode/export')
      .set('authorization', auth.admin)
      .send({ format: 'pdf' })
      .expect(201);
    await stack.apps.reporting.get(Worker).runDue();
    const pdfDone = await api()
      .get(`/api/v1/reports/exports/${pdf.body.id}`)
      .set('authorization', auth.admin)
      .expect(200);
    expect(pdfDone.body.status).toBe('done');
    expect((await fileBytes(pdfDone.body.fileId)).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('sends scheduled reports, each recipient seeing only their branch', async () => {
    const sched = await api()
      .post('/api/v1/reports/schedules')
      .set('authorization', auth.admin)
      .send({
        ref: 'invoice_list',
        frequency: 'weekly',
        weekday: 1,
        at: '08:00',
        formats: ['csv'],
        recipients: { roleIds: [ids.headRole] },
      })
      .expect(201);
    expect(new Date(sched.body.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    const clock = stack.apps.reporting.get<AdjustableClock>(REPORTING_CLOCK);
    clock.set(new Date(new Date(sched.body.nextRunAt).getTime() + 60_000));
    await stack.apps.reporting.get(Worker).runDue();
    clock.set(new Date());

    const toHema = await published<MailSendPayload>(
      NotifyTypes.MailSend,
      (p) => p.to[0] === 'hema@acme.test',
    );
    const toBhanu = await published<MailSendPayload>(
      NotifyTypes.MailSend,
      (p) => p.to[0] === 'bhanu@acme.test',
    );
    const csv = async (m: { payload: MailSendPayload }) =>
      (await fileBytes(m.payload.attachments[0].fileId)).toString('utf8');
    const hemaCsv = await csv(toHema);
    const bhanuCsv = await csv(toBhanu);
    expect(hemaCsv).toContain('Hyderabad');
    expect(hemaCsv).not.toContain('Bengaluru');
    expect(bhanuCsv).toContain('Bengaluru');
    expect(bhanuCsv).not.toContain('Hyderabad');
    const after = await api()
      .get('/api/v1/reports/schedules')
      .set('authorization', auth.admin)
      .expect(200);
    expect(after.body[0].lastResult).toBe('Sent to 2');
  });

  it('builds the home dashboard with filters, comparison and caching', async () => {
    const list = await api().get('/api/v1/dashboards').set('authorization', auth.hema).expect(200);
    expect(list.body.find((d: { home: boolean }) => d.home).ref).toBe('branch_head');
    const data = await api()
      .post('/api/v1/dashboards/branch_head/data')
      .set('authorization', auth.hema)
      .send({})
      .expect(200);
    expect(data.body.data.kpi).toMatchObject({ kind: 'kpi', value: 14000.5, previous: null });
    expect(data.body.data.chart.result.kind).toBe('groups');
    expect(data.body.data.list.result.rows).toHaveLength(2);
    expect(data.body.data.approvals).toBeUndefined();

    const bhanu = await api()
      .post('/api/v1/dashboards/branch_head/data')
      .set('authorization', auth.bhanu)
      .send({})
      .expect(200);
    expect(bhanu.body.data.kpi.value).toBe(9000);

    const ranged = await api()
      .post('/api/v1/dashboards/branch_head/data')
      .set('authorization', auth.admin)
      .send({ dateRange: { from: '2020-01-01', to: '2020-01-31' } })
      .expect(200);
    expect(ranged.body.data.list.result.rows).toHaveLength(0);
    // Without the role the company dashboard is not there.
    await api().get('/api/v1/dashboards/branch_head').set('authorization', auth.chitra).expect(404);
  });

  it('lets people build, share and use their own reports and dashboards', async () => {
    const mine = await api()
      .post('/api/v1/reports/my')
      .set('authorization', auth.hema)
      .send({
        label: { en: 'My UPI invoices' },
        entity: 'invoice',
        columns: [{ path: 'inv_no' }, { path: 'total' }],
        filters: [{ path: 'mode', op: 'eq', value: 'upi' }],
      })
      .expect(201);
    const run = await api()
      .post(`/api/v1/reports/${mine.body.ref}/run`)
      .set('authorization', auth.hema)
      .send({})
      .expect(200);
    expect(run.body.total).toBe(1);
    await api()
      .get(`/api/v1/reports/${mine.body.ref}`)
      .set('authorization', auth.bhanu)
      .expect(404);
    await api()
      .put(`/api/v1/reports/my/${mine.body.ref.slice(3)}/share`)
      .set('authorization', auth.hema)
      .send({ roleIds: [ids.headRole] })
      .expect(200);
    // Shared, it shows Bhanu his own branch's data.
    const shared = await api()
      .post(`/api/v1/reports/${mine.body.ref}/run`)
      .set('authorization', auth.bhanu)
      .send({})
      .expect(200);
    expect(shared.body.total).toBe(0);

    const dash = await api()
      .post('/api/v1/dashboards/my')
      .set('authorization', auth.hema)
      .send({
        label: { en: 'Mine' },
        widgets: [{ id: 'w', type: 'list', report: mine.body.ref, x: 0, y: 0, w: 6, h: 3 }],
      })
      .expect(201);
    const data = await api()
      .post(`/api/v1/dashboards/${dash.body.ref}/data`)
      .set('authorization', auth.hema)
      .send({})
      .expect(200);
    expect(data.body.data.w.result.rows).toHaveLength(1);
    // A clerk without reports.personal cannot build one.
    await api()
      .post('/api/v1/reports/my')
      .set('authorization', auth.chitra)
      .send({ label: { en: 'x' }, entity: 'invoice', columns: [{ path: 'inv_no' }], filters: [] })
      .expect(403);
  });

  it('records emails, exports and schedules in the audit chain', async () => {
    await eventually(async () => {
      const page = (
        await api()
          .get('/api/v1/audit/events?pageSize=200')
          .set('authorization', auth.admin)
          .expect(200)
      ).body;
      const t = new Set<string>(page.items.map((e: { type: string }) => e.type));
      return [
        'documents.document.emailed',
        'documents.document.attached',
        'reports.report.exported',
        'reports.schedule.sent',
        'reports.report.shared',
      ].every((n) => t.has(n));
    });
    const verify = await api()
      .get('/api/v1/audit/verify')
      .set('authorization', auth.admin)
      .expect(200);
    expect(verify.body.valid).toBe(true);
  });
});
