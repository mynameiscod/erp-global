/**
 * Step 6 acceptance test: Country and Industry Packs end to end through the gateway.
 * A services company in Hyderabad installs India and Services from the Packs page,
 * publishes, gets the pack roles, adds sample data, invoices clients in Telangana and
 * Karnataka (CGST+SGST and IGST), runs a line-item report and removes the pack again.
 */
import request from 'supertest';
import { EventTypes } from '@erp/contracts';
import { checkIdentifier, type IdentifierType } from '@erp/metadata';
import { findPack } from '@erp/packs';
import { sharedMemoryBus } from '@erp/service-kit';
import { eventually, startStack, type Stack } from './harness';

const PASSWORD = 'Very-secret-pass-1';
const today = new Date().toISOString().slice(0, 10);

/** A GSTIN with a valid check digit for a state and PAN. */
function gstin(state: string, pan: string): string {
  const type = findPack('country.in')!.layer.identifierTypes!.find(
    (t) => t.key === 'in_gstin',
  ) as IdentifierType;
  for (const c of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const v = `${state}${pan}1Z${c}`;
    if ('value' in checkIdentifier(type, v)) return v;
  }
  throw new Error('no check digit');
}

describe('Step 6 acceptance: Country and Industry Packs', () => {
  let stack: Stack;
  const api = () => request(stack.gatewayUrl);
  const ids: Record<string, string> = {};
  let admin = '';

  const published = (type: string, match: (p: Record<string, unknown>) => boolean) =>
    eventually(async () =>
      sharedMemoryBus()
        .published.slice()
        .reverse()
        .find((x) => x.type === type && match(x.payload as Record<string, unknown>)),
    );

  const packs = async () =>
    (await api().get('/api/v1/packs').set('authorization', admin).expect(200)).body as {
      id: string;
      suggested: boolean;
      draft: string | null;
      published: string | null;
      samples: { added: boolean; count: number };
    }[];

  const publish = async (note: string) => {
    const issues = await api()
      .get('/api/v1/config/draft/validate')
      .set('authorization', admin)
      .expect(200);
    expect(issues.body.issues ?? issues.body).toEqual([]);
    await api()
      .post('/api/v1/config/publish')
      .set('authorization', admin)
      .send({ note })
      .expect(201);
  };

  const create = async (entity: string, data: Record<string, unknown>, status = 201) =>
    (
      await api()
        .post(`/api/v1/records/${entity}`)
        .set('authorization', admin)
        .send({ orgUnitId: ids.root, data })
        .expect(status)
    ).body as { id: string; data: Record<string, unknown> };

  beforeAll(async () => {
    stack = await startStack();
    await api()
      .post('/api/v1/tenants/signup')
      .send({
        companyName: 'Galaxy Digital',
        slug: 'galaxy',
        countryCode: 'IN',
        industryCode: 'services',
        defaultLanguage: 'en',
        timezone: 'Asia/Kolkata',
        admin: { name: 'Owner', email: 'owner@galaxy.test', password: PASSWORD },
      })
      .expect(201);
    const res = await api()
      .post('/api/v1/identity/auth/login')
      .send({ tenantSlug: 'galaxy', email: 'owner@galaxy.test', password: PASSWORD })
      .expect(200);
    admin = `Bearer ${res.body.accessToken}`;
    const units = await api().get('/api/v1/org/units').set('authorization', admin).expect(200);
    ids.root = units.body[0].id;
  });

  afterAll(async () => {
    await stack?.stop();
  });

  it('lists the catalog and suggests packs for the company', async () => {
    const list = await packs();
    expect(list.map((p) => p.id)).toEqual(
      expect.arrayContaining([
        'country.in',
        'industry.education',
        'industry.retail',
        'industry.services',
        'industry.healthcare',
      ]),
    );
    const suggested = list.filter((p) => p.suggested).map((p) => p.id);
    expect(suggested.sort()).toEqual(['country.in', 'industry.services']);
    expect(list.every((p) => p.draft === null && p.published === null)).toBe(true);
    // Without packs.manage the page is closed (a fresh token without the permission is not
    // available here; the gateway still requires a token).
    await api().get('/api/v1/packs').expect(401);
  });

  it('previews, installs into the draft and publishes', async () => {
    const preview = await api()
      .post('/api/v1/packs/industry.services/preview')
      .set('authorization', admin)
      .expect(200);
    expect(preview.body).toMatchObject({ action: 'install', conflicts: [] });
    expect(preview.body.added.length).toBeGreaterThan(5);

    await api().put('/api/v1/packs/country.in').set('authorization', admin).send({}).expect(200);
    await api()
      .put('/api/v1/packs/industry.services')
      .set('authorization', admin)
      .send({})
      .expect(200);
    await published(EventTypes.PackInstalled, (p) => p.packId === 'industry.services');
    const inDraft = await packs();
    expect(inDraft.find((p) => p.id === 'country.in')).toMatchObject({
      draft: '1.0.0',
      published: null,
    });

    // Samples need the pack to be live.
    await api()
      .post('/api/v1/packs/industry.services/samples')
      .set('authorization', admin)
      .expect(409);

    await publish('Packs: India and Services');
    const live = await packs();
    expect(live.find((p) => p.id === 'industry.services')).toMatchObject({ published: '1.0.0' });

    const effective = await api()
      .get('/api/v1/config/effective')
      .set('authorization', admin)
      .expect(200);
    const invoice = (effective.body.entities as { key: string; fields: { key: string }[] }[]).find(
      (e) => e.key === 'svc_invoice',
    )!;
    expect(invoice.fields.map((f) => f.key)).toEqual(
      expect.arrayContaining(['place_of_supply', 'customer_gstin', 'grand_total', 'tax_total']),
    );
  });

  it('creates the pack roles by key once the pack is live', async () => {
    const roles = await eventually(async () => {
      const res = await api().get('/api/v1/access/roles').set('authorization', admin).expect(200);
      const list = res.body as { key: string | null; name: string; permissions: string[] }[];
      return list.some((r) => r.key === 'svc_owner') ? list : undefined;
    });
    const keys = roles.map((r) => r.key).filter(Boolean);
    expect(keys).toEqual(expect.arrayContaining(['svc_owner', 'svc_sales', 'svc_accounts']));
    expect(roles.find((r) => r.key === 'svc_accounts')!.permissions).toContain(
      'records.svc_invoice.create',
    );
  });

  it('validates GSTINs and calculates GST by place of supply', async () => {
    // The company's GSTIN and state (Telangana) on the top unit.
    await api()
      .patch(`/api/v1/org/units/${ids.root}`)
      .set('authorization', admin)
      .send({ custom: { gstin: gstin('36', 'AABCG1234K'), state: '36' } })
      .expect(200);

    const bad = await api()
      .post('/api/v1/records/svc_client')
      .set('authorization', admin)
      .send({ data: { name: 'Bad GSTIN Ltd', gstin: '36AABCG1234K1Z0', state: '36' } });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain('gstin');

    const local = await create('svc_client', {
      name: 'Charminar Traders',
      gstin: gstin('36', 'AAACC1111A'),
      state: '36',
      email: 'ap@charminar.test',
    });
    const away = await create('svc_client', {
      name: 'Mysore Silks',
      gstin: gstin('29', 'AAACM2222B'),
      state: '29',
      email: 'ap@mysore.test',
    });
    const service = await create('svc_service', {
      name: 'Brand strategy',
      price: '100000',
      gst_category: 'gst_18',
      hsn: '998361',
    });

    const within = await create('svc_invoice', {
      customer: local.id,
      date: today,
      lines: [{ item: service.id, qty: 1 }],
    });
    expect(within.data).toMatchObject({
      place_of_supply: '36',
      tax_rule: 'intra',
      subtotal: 100000,
      tax_total: 18000,
      grand_total: 118000,
      gst_section: 'B2B',
    });
    const summary = within.data.tax_summary as { component: string; amount: number }[];
    expect(summary.map((s) => [s.component, s.amount]).sort()).toEqual([
      ['cgst', 9000],
      ['sgst', 9000],
    ]);

    const across = await create('svc_invoice', {
      customer: away.id,
      date: today,
      lines: [{ item: service.id, qty: 2 }],
    });
    expect(across.data).toMatchObject({
      place_of_supply: '29',
      tax_rule: 'inter',
      tax_total: 36000,
      grand_total: 236000,
    });
    const lines = across.data.lines as Record<string, unknown>[];
    expect(lines[0]).toMatchObject({
      rate: { amount: '100000.00', currency: 'INR' },
      hsn: '998361',
      tax_category: 'gst_18',
      taxable_value: 200000,
    });
  });

  it('runs GST returns data and line-item reports', async () => {
    const hsn = await api()
      .post('/api/v1/reports/gstr1_hsn/run')
      .set('authorization', admin)
      // The return is for last month by default; this test's invoices are from today.
      .send({ params: { filters: { '0': { relative: { period: 'this_month' } } } } })
      .expect(200);
    expect(JSON.stringify(hsn.body)).toContain('998361');

    const byService = await api()
      .post('/api/v1/reports/svc_sales_by_service/run')
      .set('authorization', admin)
      .send({ params: {} })
      .expect(200);
    expect(JSON.stringify(byService.body)).toContain('Brand strategy');
  });

  it('adds and removes sample data', async () => {
    const added = await api()
      .post('/api/v1/packs/industry.services/samples')
      .set('authorization', admin)
      .expect(200);
    expect(added.body.count).toBe(findPack('industry.services')!.samples!.length);
    await published(EventTypes.PackSamplesAdded, (p) => p.packId === 'industry.services');
    const clients = await api()
      .get('/api/v1/records/svc_client')
      .set('authorization', admin)
      .expect(200);
    expect(JSON.stringify(clients.body)).toContain('Deccan Foods');
    expect((await packs()).find((p) => p.id === 'industry.services')!.samples).toMatchObject({
      added: true,
    });
    // Only once.
    await api()
      .post('/api/v1/packs/industry.services/samples')
      .set('authorization', admin)
      .expect(409);

    await api()
      .delete('/api/v1/packs/industry.services/samples')
      .set('authorization', admin)
      .expect(200);
    const after = await api()
      .get('/api/v1/records/svc_client')
      .set('authorization', admin)
      .expect(200);
    expect(JSON.stringify(after.body)).not.toContain('Deccan Foods');
    expect(JSON.stringify(after.body)).toContain('Charminar Traders');
  });

  it('removes a pack and keeps the data', async () => {
    await api().delete('/api/v1/packs/industry.services').set('authorization', admin).expect(200);
    await published(EventTypes.PackRemoved, (p) => p.packId === 'industry.services');
    await publish('Remove Services');
    expect((await packs()).find((p) => p.id === 'industry.services')).toMatchObject({
      draft: null,
      published: null,
    });
    // Records stay in the database; the entities are retired (archived), not deleted.
    const draft = await api().get('/api/v1/config/draft').set('authorization', admin).expect(200);
    const retired = (draft.body.config?.retired ?? draft.body.retired) as {
      entities: { key: string }[];
    };
    expect(retired.entities.map((e) => e.key)).toEqual(expect.arrayContaining(['svc_invoice']));
  });
});

describe('Step 6 acceptance: every Industry Pack with India', () => {
  let stack: Stack;
  const api = () => request(stack.gatewayUrl);
  let admin = '';
  const INDUSTRIES = [
    'industry.education',
    'industry.retail',
    'industry.services',
    'industry.healthcare',
  ];

  beforeAll(async () => {
    stack = await startStack();
    await api()
      .post('/api/v1/tenants/signup')
      .send({
        companyName: 'Omni Group',
        slug: 'omni',
        countryCode: 'IN',
        industryCode: 'other',
        defaultLanguage: 'en',
        timezone: 'Asia/Kolkata',
        admin: { name: 'Owner', email: 'owner@omni.test', password: PASSWORD },
      })
      .expect(201);
    const res = await api()
      .post('/api/v1/identity/auth/login')
      .send({ tenantSlug: 'omni', email: 'owner@omni.test', password: PASSWORD })
      .expect(200);
    admin = `Bearer ${res.body.accessToken}`;
  });

  afterAll(async () => {
    await stack?.stop();
  });

  it('installs all packs together, adds their samples and runs their reports and dashboards', async () => {
    // Industries first and India last: the country patches every conforming entity.
    for (const id of [...INDUSTRIES, 'country.in'])
      await api().put(`/api/v1/packs/${id}`).set('authorization', admin).send({}).expect(200);
    const issues = await api()
      .get('/api/v1/config/draft/validate')
      .set('authorization', admin)
      .expect(200);
    expect(issues.body.issues ?? issues.body).toEqual([]);
    await api()
      .post('/api/v1/config/publish')
      .set('authorization', admin)
      .send({ note: 'All packs' })
      .expect(201);

    for (const id of INDUSTRIES) {
      const res = await api().post(`/api/v1/packs/${id}/samples`).set('authorization', admin);
      expect({ id, status: res.status, body: res.status === 200 ? 'ok' : res.body }).toEqual({
        id,
        status: 200,
        body: 'ok',
      });
      expect(res.body.count).toBe(findPack(id)!.samples!.length);
    }

    const reports = (await api().get('/api/v1/reports').set('authorization', admin).expect(200))
      .body as { ref: string; kind: string }[];
    const company = reports.filter((r) => r.kind === 'company');
    expect(company.length).toBeGreaterThan(40);
    const failed: string[] = [];
    for (const r of company) {
      const run = await api()
        .post(`/api/v1/reports/${r.ref}/run`)
        .set('authorization', admin)
        .send({ params: {} });
      if (run.status !== 200) failed.push(`${r.ref}: ${run.status} ${JSON.stringify(run.body)}`);
    }
    expect(failed).toEqual([]);

    const dashboards = (
      await api().get('/api/v1/dashboards').set('authorization', admin).expect(200)
    ).body as { ref: string; kind: string }[];
    const packDashboards = dashboards.filter((d) => d.kind === 'company');
    expect(packDashboards.length).toBeGreaterThanOrEqual(6);
    for (const d of packDashboards) {
      const data = await api()
        .post(`/api/v1/dashboards/${d.ref}/data`)
        .set('authorization', admin)
        .send({});
      expect({ ref: d.ref, status: data.status }).toEqual({ ref: d.ref, status: 200 });
      const errors = Object.values(data.body as Record<string, { kind: string; message?: string }>)
        .filter((w) => w?.kind === 'error')
        .map((w) => `${d.ref}: ${w.message}`);
      expect(errors).toEqual([]);
    }
  });
});
