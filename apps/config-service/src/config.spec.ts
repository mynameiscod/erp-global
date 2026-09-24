import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { signAccessToken, signServiceToken } from '@erp/auth';
import type { AclEntry, Permission } from '@erp/contracts';
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
  { id: string; name: string; code: string; path: string; status: string }
> = {
  [ROOT]: { id: ROOT, name: 'Acme', code: 'HQ', path: `/${ROOT}/`, status: 'active' },
  [HYD]: { id: HYD, name: 'Hyderabad', code: 'HYD', path: `/${ROOT}/${HYD}/`, status: 'active' },
};
const ALL: Permission[] = ['config.read', 'config.manage', 'config.publish'];

const student = {
  key: 'student',
  kind: 'custom',
  label: { en: 'Student', hi: 'छात्र' },
  pluralLabel: { en: 'Students' },
  titleField: 'name',
  fields: [
    { key: 'name', type: 'text', label: { en: 'Name' }, required: true },
    { key: 'adm_no', type: 'autonumber', label: { en: 'Admission no' }, numbering: 'admission' },
  ],
};
const admission = {
  key: 'admission',
  label: { en: 'Admission' },
  pattern: 'ADM/{FY}/{BRANCH}/{SEQ:4}',
  reset: 'yearly',
  scope: 'company',
};

describe('config-service', () => {
  let mongo: TestMongo;
  let app: INestApplication;
  let baseUrl = '';
  const http = () => request(baseUrl);
  const auth = (tid: string, acl: AclEntry[]) =>
    `Bearer ${signAccessToken({ sub: fakeId(99), tid, sid: 's', acl }, testKeys().privateKey, 300)}`;
  const admin = (tid = 'tA') => auth(tid, [{ ou: ROOT, path: units[ROOT].path, p: ALL }]);
  const branchAdmin = auth('tA', [{ ou: HYD, path: units[HYD].path, p: ALL }]);
  const svc = (tid = 'tA') =>
    signServiceToken({ sub: 'svc:records-service', tid }, TEST_INTERNAL_SECRET);

  const clients = {
    org: {
      get: async (path: string) => {
        const u = units[path.split('/').pop()!];
        if (!u)
          throw new UpstreamError('org-service', 404, {
            error: { code: 'NOT_FOUND', message: 'nf' },
          });
        return u;
      },
    },
    tenant: {
      get: async () => ({
        countryCode: 'IN',
        currency: 'INR',
        locale: 'en-IN',
        defaultLanguage: 'en',
      }),
    },
  };

  beforeAll(async () => {
    mongo = await startMongo();
    Object.assign(
      process.env,
      serviceTestEnv(mongo.uri, 'erp_config_test', { ORG_SERVICE_URL: 'http://org.test' }),
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

  it('starts with only the built-in entities and the country fiscal year', async () => {
    const res = await http()
      .get('/api/v1/config/effective')
      .set('authorization', admin())
      .expect(200);
    expect(res.body.version).toBe(0);
    expect(res.body.entities.map((e: { key: string }) => e.key)).toEqual(['user', 'org_unit']);
    expect(res.body.settings.fiscalYearStartMonth).toBe(4);
    expect(res.body.tenant.currency).toBe('INR');
  });

  it('keeps draft changes invisible until published', async () => {
    await http()
      .put('/api/v1/config/draft/numbering/admission')
      .set('authorization', admin())
      .send(admission)
      .expect(200);
    const draft = await http()
      .put('/api/v1/config/draft/entities/student')
      .set('authorization', admin())
      .send(student)
      .expect(200);
    expect(draft.body.changes).toEqual(
      expect.arrayContaining([
        'Added entity Student (student)',
        'Added number series Admission (admission)',
      ]),
    );

    const live = await http()
      .get('/api/v1/config/effective')
      .set('authorization', admin())
      .expect(200);
    expect(live.body.entities.map((e: { key: string }) => e.key)).not.toContain('student');
    const preview = await http()
      .get('/api/v1/config/effective?source=draft')
      .set('authorization', admin())
      .expect(200);
    expect(preview.body.entities.map((e: { key: string }) => e.key)).toContain('student');

    const pub = await http()
      .post('/api/v1/config/publish')
      .set('authorization', admin())
      .send({ note: 'Students' })
      .expect(201);
    expect(pub.body.version).toBe(1);
    const after = await http()
      .get('/api/v1/config/effective')
      .set('authorization', admin())
      .expect(200);
    expect(after.body.version).toBe(1);
    expect(after.body.entities.find((e: { key: string }) => e.key === 'student').label.hi).toBe(
      'छात्र',
    );
    await http().post('/api/v1/config/publish').set('authorization', admin()).send({}).expect(409);
  });

  it('validates items and refuses to publish a broken configuration', async () => {
    const bad = await http()
      .put('/api/v1/config/draft/entities/bad')
      .set('authorization', admin())
      .send({ key: 'bad', fields: [{ key: 'X', type: 'nope', label: {} }] })
      .expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');

    await http()
      .put('/api/v1/config/draft/entities/course')
      .set('authorization', admin())
      .send({
        key: 'course',
        kind: 'custom',
        label: { en: 'Course' },
        pluralLabel: { en: 'Courses' },
        fields: [{ key: 'teacher', type: 'lookup', label: { en: 'Teacher' }, target: 'ghost' }],
      })
      .expect(200);
    const res = await http()
      .post('/api/v1/config/publish')
      .set('authorization', admin())
      .send({})
      .expect(422);
    expect(res.body.error.code).toBe('CONFIG_INVALID');
    expect(res.body.error.details[0].message).toBe('Unknown entity "ghost"');
    await http()
      .delete('/api/v1/config/draft/entities/course')
      .set('authorization', admin())
      .expect(200);
  });

  it('blocks deleting a published field but allows archiving it', async () => {
    const withoutName = {
      ...student,
      fields: student.fields.filter((f) => f.key !== 'name'),
      titleField: undefined,
    };
    await http()
      .put('/api/v1/config/draft/entities/student')
      .set('authorization', admin())
      .send(withoutName)
      .expect(200);
    const res = await http()
      .post('/api/v1/config/publish')
      .set('authorization', admin())
      .send({})
      .expect(422);
    expect(res.body.error.details[0].message).toContain('Archive it instead');
    await http().post('/api/v1/config/draft/discard').set('authorization', admin()).expect(200);
  });

  it('applies branch overrides only in that branch', async () => {
    await http()
      .put(`/api/v1/config/draft/entities/student?scope=${HYD}`)
      .set('authorization', branchAdmin)
      .send({
        key: 'student',
        fields: [{ key: 'hostel', type: 'boolean', label: { en: 'Hostel' } }],
      })
      .expect(200);
    // A branch admin cannot change company-wide config or publish.
    await http()
      .put('/api/v1/config/draft/entities/student')
      .set('authorization', branchAdmin)
      .send(student)
      .expect(403);
    await http()
      .post('/api/v1/config/publish')
      .set('authorization', branchAdmin)
      .send({})
      .expect(403);

    await http()
      .post('/api/v1/config/publish')
      .set('authorization', admin())
      .send({ note: 'Hostel in HYD' })
      .expect(201);
    const fieldsAt = async (orgUnitId: string) =>
      (
        await http()
          .get(`/api/v1/config/effective?orgUnitId=${orgUnitId}`)
          .set('authorization', admin())
          .expect(200)
      ).body.entities
        .find((e: { key: string }) => e.key === 'student')
        .fields.map((f: { key: string }) => f.key);
    expect(await fieldsAt(ROOT)).not.toContain('hostel');
    expect(await fieldsAt(HYD)).toContain('hostel');
  });

  it('rolls back, keeping newer fields archived', async () => {
    const res = await http()
      .post('/api/v1/config/versions/1/rollback')
      .set('authorization', admin())
      .send({})
      .expect(201);
    expect(res.body.version).toBe(3);
    const eff = await http()
      .get(`/api/v1/config/effective?orgUnitId=${HYD}`)
      .set('authorization', admin())
      .expect(200);
    const hostel = eff.body.entities
      .find((e: { key: string }) => e.key === 'student')
      .fields.find((f: { key: string }) => f.key === 'hostel');
    expect(hostel.archived).toBe(true);
    const versions = await http()
      .get('/api/v1/config/versions')
      .set('authorization', admin())
      .expect(200);
    expect(versions.body.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
    expect(versions.body[0].rolledBackFrom).toBe(1);
  });

  it('allocates numbers atomically, with no duplicates under load', async () => {
    const next = () =>
      http().post('/internal/config/numbering/next').set('x-service-token', svc()).send({
        series: 'admission',
        orgUnitId: HYD,
        orgPath: units[HYD].path,
        orgCode: 'HYD',
        date: '2026-09-24T00:00:00.000Z',
      });
    const results = await Promise.all(Array.from({ length: 50 }, () => next()));
    const numbers = results.map((r) => r.body.number);
    expect(new Set(numbers).size).toBe(50);
    expect(numbers.sort()[0]).toBe('ADM/2026-27/HYD/0001');
    expect(numbers.sort()[49]).toBe('ADM/2026-27/HYD/0050');
    // A new fiscal year restarts the count.
    const nextYear = await http()
      .post('/internal/config/numbering/next')
      .set('x-service-token', svc())
      .send({
        series: 'admission',
        orgUnitId: HYD,
        orgPath: units[HYD].path,
        orgCode: 'HYD',
        date: '2027-04-01T00:00:00.000Z',
      })
      .expect(200);
    expect(nextYear.body.number).toBe('ADM/2027-28/HYD/0001');
  });

  it('keeps each tenant’s configuration separate', async () => {
    const b = await http()
      .get('/api/v1/config/effective')
      .set('authorization', admin('tB'))
      .expect(200);
    expect(b.body.version).toBe(0);
    expect(b.body.entities.map((e: { key: string }) => e.key)).toEqual(['user', 'org_unit']);
    const draftB = await http()
      .get('/api/v1/config/draft')
      .set('authorization', admin('tB'))
      .expect(200);
    expect(draftB.body.config.company.entities).toEqual([]);
    const counterB = await http()
      .post('/internal/config/numbering/next')
      .set('x-service-token', svc('tB'))
      .send({ series: 'admission', orgUnitId: HYD, orgPath: units[HYD].path })
      .expect(404);
    expect(counterB.body.error.code).toBe('NOT_FOUND');
  });

  it('requires config permissions for the studio', async () => {
    const viewer = auth('tA', [{ ou: ROOT, path: units[ROOT].path, p: ['org.unit.read'] }]);
    await http().get('/api/v1/config/draft').set('authorization', viewer).expect(403);
    await http().get('/api/v1/config/effective').set('authorization', viewer).expect(200);
  });
});
