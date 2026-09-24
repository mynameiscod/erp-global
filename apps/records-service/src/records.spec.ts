import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Connection } from 'mongoose';
import request from 'supertest';
import { signAccessToken } from '@erp/auth';
import { subjectFor, type AclEntry, type Permission } from '@erp/contracts';
import { emptyLayer, platformBaseLayer, resolveEffective, type ConfigLayer } from '@erp/metadata';
import {
  MONGO_CONNECTION,
  PLACEMENT_RESOLVER,
  SharedPlacementResolver,
  sharedMemoryBus,
  UpstreamError,
} from '@erp/service-kit';
import { fakeId, serviceTestEnv, startMongo, testKeys, type TestMongo } from '@erp/testing';
import { AppModule } from './app.module';
import { CLIENTS } from './clients';

const ROOT = fakeId(1);
const HYD = fakeId(2);
const BLR = fakeId(3);
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
  entities: [
    {
      key: 'klass',
      kind: 'custom',
      label: { en: 'Class' },
      pluralLabel: { en: 'Classes' },
      titleField: 'title',
      orgScoped: false,
      fields: [{ key: 'title', type: 'text', label: { en: 'Title' }, required: true }],
    },
    {
      key: 'student',
      kind: 'custom',
      label: { en: 'Student' },
      pluralLabel: { en: 'Students' },
      titleField: 'name',
      fields: [
        { key: 'name', type: 'text', label: { en: 'Name' }, required: true, searchable: true },
        { key: 'roll', type: 'text', label: { en: 'Roll no' }, unique: true },
        { key: 'fee', type: 'currency', label: { en: 'Fee' } },
        { key: 'klass', type: 'lookup', label: { en: 'Class' }, target: 'klass' },
        {
          key: 'half_fee',
          type: 'formula',
          label: { en: 'Half' },
          formula: 'fee / 2',
          resultType: 'number',
        },
        { key: 'adm_no', type: 'autonumber', label: { en: 'Admission' }, numbering: 'admission' },
      ],
    },
  ],
  numbering: [
    {
      key: 'admission',
      label: { en: 'Admission' },
      pattern: 'ADM/{BRANCH}/{SEQ:3}',
      reset: 'never',
      scope: 'org_unit',
    },
  ],
};

describe('records-service', () => {
  let mongo: TestMongo;
  let app: INestApplication;
  let baseUrl = '';
  const http = () => request(baseUrl);
  const counters = new Map<string, number>();
  const bearer = (tid: string, acl: AclEntry[]) =>
    `Bearer ${signAccessToken({ sub: fakeId(99), tid, sid: 's', acl }, testKeys().privateKey, 300)}`;
  const full: Permission[] = ['records.*.*'];
  const admin = (tid = 'tA') => bearer(tid, [{ ou: ROOT, path: units[ROOT].path, p: full }]);
  const hydClerk = bearer('tA', [
    {
      ou: HYD,
      path: units[HYD].path,
      p: ['records.student.read', 'records.student.create', 'records.student.update'],
    },
    { ou: ROOT, path: units[ROOT].path, p: ['records.klass.read'] },
  ]);

  const notFound = (svc: string) =>
    new UpstreamError(svc, 404, { error: { code: 'NOT_FOUND', message: 'nf' } });
  const clients = {
    config: {
      effective: async (orgPath?: string) => ({
        ...resolveEffective(
          [platformBaseLayer()],
          { company, orgUnits: {} },
          { version: 1, orgPath, defaultFiscalYearStart: 4 },
        ),
        tenant: { countryCode: 'IN', currency: 'INR', locale: 'en-IN', defaultLanguage: 'en' },
      }),
      invalidate: () => undefined,
    },
    configApi: {
      post: async (_path: string, body: { orgUnitId: string; orgCode: string }) => {
        const n = (counters.get(body.orgUnitId) ?? 0) + 1;
        counters.set(body.orgUnitId, n);
        return { number: `ADM/${body.orgCode}/${String(n).padStart(3, '0')}` };
      },
    },
    org: {
      get: async (path: string) => {
        const u = units[path.split('/').pop()!];
        if (!u) throw notFound('org-service');
        return u;
      },
    },
    identity: { get: async () => ({}) },
    files: { get: async () => ({}) },
  };

  const create = (
    auth: string,
    orgUnitId: string | undefined,
    data: Record<string, unknown>,
    entity = 'student',
  ) =>
    http().post(`/api/v1/records/${entity}`).set('authorization', auth).send({ orgUnitId, data });

  beforeAll(async () => {
    mongo = await startMongo();
    Object.assign(
      process.env,
      serviceTestEnv(mongo.uri, 'erp_records_test', {
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

  let klass: string;
  let asha: { id: string; number: string };

  it('creates records with normalized data, formulas and auto-numbers', async () => {
    klass = (await create(admin(), undefined, { title: 'Grade 5' }, 'klass').expect(201)).body.id;
    const res = await create(admin(), HYD, {
      name: ' Asha ',
      roll: 'R-1',
      fee: '1,200.5',
      klass,
    }).expect(201);
    expect(res.body).toMatchObject({
      number: 'ADM/HYD/001',
      orgUnitId: HYD,
      data: {
        name: 'Asha',
        roll: 'R-1',
        fee: { amount: '1200.50', currency: 'INR' },
        klass,
        half_fee: 600.25,
        adm_no: 'ADM/HYD/001',
      },
    });
    asha = res.body;
  });

  it('stores money as Decimal128 so it sorts as a number', async () => {
    await create(admin(), HYD, { name: 'Ravi', fee: '99.00' }).expect(201);
    await create(admin(), HYD, { name: 'Meera', fee: '10000' }).expect(201);
    const conn = app.get<Connection>(MONGO_CONNECTION);
    const raw = await conn.collection('records').findOne({ 'data.name': 'Asha' });
    expect(raw?.data.fee.amount._bsontype).toBe('Decimal128');
    const sorted = await http()
      .get('/api/v1/records/student?sort=fee:asc')
      .set('authorization', admin())
      .expect(200);
    expect(sorted.body.items.map((r: { data: { name: string } }) => r.data.name)).toEqual([
      'Ravi',
      'Asha',
      'Meera',
    ]);
  });

  it('reports validation problems per field', async () => {
    const res = await create(admin(), HYD, { fee: 'lots', adm_no: 'X', klass: 'nope' }).expect(400);
    const byField = Object.fromEntries(
      res.body.error.details.map((d: { path: string; message: string }) => [d.path, d.message]),
    );
    expect(byField).toEqual({
      fee: 'Must be an amount',
      adm_no: 'Calculated automatically',
      klass: 'Invalid reference',
      name: 'Required',
    });
    await create(admin(), undefined, { name: 'No branch' }).expect(400);
  });

  it('checks that lookups point at existing records', async () => {
    const res = await create(admin(), HYD, { name: 'X', klass: fakeId(777) }).expect(400);
    expect(res.body.error.details).toEqual([{ path: 'klass', message: 'Linked record not found' }]);
  });

  it('enforces unique fields within a tenant only', async () => {
    const dup = await create(admin(), BLR, { name: 'Dup', roll: 'r-1' }).expect(400);
    expect(dup.body.error.details).toEqual([
      { path: 'roll', message: 'This value is already used by another record' },
    ]);
    await create(admin('tB'), HYD, { name: 'Other tenant', roll: 'R-1' }).expect(201);
  });

  it('updates, tracks changes and frees unique values on delete', async () => {
    const upd = await http()
      .patch(`/api/v1/records/student/${asha.id}`)
      .set('authorization', admin())
      .send({ data: { fee: { amount: '1000', currency: 'INR' }, roll: 'R-9' } })
      .expect(200);
    expect(upd.body.data.half_fee).toBe(500);
    expect(upd.body.number).toBe('ADM/HYD/001');
    await create(admin(), HYD, { name: 'Reuse', roll: 'R-1' }).expect(201);

    await http()
      .delete(`/api/v1/records/student/${asha.id}`)
      .set('authorization', admin())
      .expect(200);
    await http()
      .get(`/api/v1/records/student/${asha.id}`)
      .set('authorization', admin())
      .expect(404);
    await create(admin(), HYD, { name: 'Reuse 9', roll: 'R-9' }).expect(201);

    let updated;
    for (let i = 0; i < 100 && !updated; i++) {
      updated = sharedMemoryBus().published.find((e) => e.type === 'records.record.updated');
      if (!updated) await new Promise((r) => setTimeout(r, 50));
    }
    expect((updated!.payload as { changes: Record<string, unknown> }).changes).toHaveProperty(
      'roll',
      { from: 'R-1', to: 'R-9' },
    );
  });

  it('limits a branch clerk to their branch and their actions', async () => {
    await create(admin(), BLR, { name: 'Bangalore kid' }).expect(201);
    const list = await http()
      .get('/api/v1/records/student')
      .set('authorization', hydClerk)
      .expect(200);
    expect(list.body.items.every((r: { orgUnitId: string }) => r.orgUnitId === HYD)).toBe(true);
    await create(hydClerk, BLR, { name: 'Nope' }).expect(403);
    const mine = await create(hydClerk, HYD, { name: 'Mine' }).expect(201);
    await http()
      .delete(`/api/v1/records/student/${mine.body.id}`)
      .set('authorization', hydClerk)
      .expect(403);
    await http()
      .get(`/api/v1/records/student?orgUnitId=${BLR}`)
      .set('authorization', hydClerk)
      .expect(403);
    // Classes are not org-scoped: readable company-wide with the permission.
    const classes = await http()
      .get('/api/v1/records/klass')
      .set('authorization', hydClerk)
      .expect(200);
    expect(classes.body.total).toBe(1);
  });

  it('searches, filters and rejects operator injection', async () => {
    const found = await http()
      .get('/api/v1/records/student?q=mee')
      .set('authorization', admin())
      .expect(200);
    expect(found.body.items.map((r: { data: { name: string } }) => r.data.name)).toEqual(['Meera']);
    const byClass = await http()
      .get(`/api/v1/records/student?filter=${encodeURIComponent(JSON.stringify({ klass }))}`)
      .set('authorization', admin())
      .expect(200);
    expect(byClass.body.total).toBe(0);
    await http()
      .get(
        `/api/v1/records/student?filter=${encodeURIComponent(JSON.stringify({ name: { $ne: null } }))}`,
      )
      .set('authorization', admin())
      .expect(400);
    const lookup = await http()
      .get('/api/v1/records/klass/lookup?q=grade')
      .set('authorization', admin())
      .expect(200);
    expect(lookup.body).toEqual([{ id: klass, number: null, title: 'Grade 5' }]);
  });

  it('keeps tenants apart', async () => {
    const b = await http()
      .get('/api/v1/records/student')
      .set('authorization', admin('tB'))
      .expect(200);
    expect(b.body.items.map((r: { data: { name: string } }) => r.data.name)).toEqual([
      'Other tenant',
    ]);
    const aId = (
      await http().get('/api/v1/records/student').set('authorization', admin()).expect(200)
    ).body.items[0].id;
    await http()
      .get(`/api/v1/records/student/${aId}`)
      .set('authorization', admin('tB'))
      .expect(404);
    await http()
      .patch(`/api/v1/records/student/${aId}`)
      .set('authorization', admin('tB'))
      .send({ data: { name: 'x' } })
      .expect(404);
    await create(admin('tB'), HYD, { name: 'x', klass }).expect(400);
  });

  it('rejects unknown and non-custom entities', async () => {
    await http().get('/api/v1/records/ghost').set('authorization', admin()).expect(404);
    await http().get('/api/v1/records/user').set('authorization', admin()).expect(404);
  });

  it('follows org moves', async () => {
    const newHydPath = `${units[BLR].path}${HYD}/`;
    await sharedMemoryBus().publish(
      subjectFor('org.unit.moved'),
      {
        eventId: randomUUID(),
        type: 'org.unit.moved',
        version: 1,
        tenantId: 'tA',
        actor: { type: 'user', id: 'u' },
        occurredAt: new Date().toISOString(),
        source: 'org-service',
        payload: { unitId: HYD, oldPath: units[HYD].path, newPath: newHydPath },
      },
      randomUUID(),
    );
    await sharedMemoryBus().idle();
    const conn = app.get<Connection>(MONGO_CONNECTION);
    const moved = await conn
      .collection('records')
      .countDocuments({ tenantId: 'tA', orgPath: newHydPath });
    const stale = await conn
      .collection('records')
      .countDocuments({ tenantId: 'tA', orgPath: units[HYD].path });
    expect(moved).toBeGreaterThan(0);
    expect(stale).toBe(0);
  });
});
