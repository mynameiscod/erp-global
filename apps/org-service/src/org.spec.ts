import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { signAccessToken, signServiceToken } from '@erp/auth';
import type { AclEntry, PermissionKey } from '@erp/contracts';
import { PLACEMENT_RESOLVER, SharedPlacementResolver } from '@erp/service-kit';
import {
  serviceTestEnv,
  startMongo,
  testKeys,
  TEST_INTERNAL_SECRET,
  type TestMongo,
} from '@erp/testing';
import { emptyLayer, platformBaseLayer, resolveEffective } from '@erp/metadata';
import { AppModule } from './app.module';
import { CLIENTS } from './clients';

const ALL: PermissionKey[] = [
  'org.unit.read',
  'org.unit.create',
  'org.unit.update',
  'org.unit.move',
  'org.unit.deactivate',
];

describe('org-service', () => {
  let mongo: TestMongo;
  let app: INestApplication;
  const roots: Record<string, { rootUnitId: string; rootPath: string }> = {};

  const svc = (tid: string) =>
    signServiceToken({ sub: 'svc:tenant-service', tid }, TEST_INTERNAL_SECRET);
  const user = (tid: string, acl: AclEntry[]) =>
    `Bearer ${signAccessToken({ sub: `u-${tid}`, tid, sid: 's', acl }, testKeys().privateKey, 300)}`;
  const admin = (tid: string) =>
    user(tid, [{ ou: roots[tid].rootUnitId, path: roots[tid].rootPath, p: ALL }]);
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    mongo = await startMongo();
    Object.assign(
      process.env,
      serviceTestEnv(mongo.uri, 'erp_org_test', { CONFIG_SERVICE_URL: 'http://config.test' }),
    );
    const config = {
      effective: async (orgPath?: string) => ({
        ...resolveEffective(
          [platformBaseLayer()],
          {
            company: {
              ...emptyLayer(),
              entities: [
                {
                  key: 'org_unit',
                  fields: [{ key: 'capacity', type: 'integer', label: { en: 'Capacity' }, min: 0 }],
                },
              ],
            },
            orgUnits: {},
          },
          { version: 1, orgPath, defaultFiscalYearStart: 4 },
        ),
        tenant: { countryCode: 'IN', currency: 'INR', locale: 'en-IN', defaultLanguage: 'en' },
      }),
      invalidate: () => undefined,
    };
    const ref = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PLACEMENT_RESOLVER)
      .useClass(SharedPlacementResolver)
      .overrideProvider(CLIENTS)
      .useValue({
        config,
        identity: {
          get: async (path: string) => {
            const id = path.split('/').pop();
            if (id === 'f'.repeat(24)) throw new Error('not found');
            return { id, status: id === 'd'.repeat(24) ? 'deactivated' : 'active' };
          },
        },
      })
      .compile();
    app = ref.createNestApplication();
    await app.init();
    for (const tid of ['tA', 'tB']) {
      const res = await http()
        .post('/internal/org/bootstrap')
        .set('x-service-token', svc(tid))
        .send({ name: `Company ${tid}` })
        .expect(201);
      roots[tid] = res.body;
    }
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
  });

  it('bootstrap is idempotent', async () => {
    const again = await http()
      .post('/internal/org/bootstrap')
      .set('x-service-token', svc('tA'))
      .send({ name: 'x' })
      .expect(201);
    expect(again.body).toEqual(roots.tA);
  });

  it('builds a hierarchy of any depth', async () => {
    let parentId = roots.tA.rootUnitId;
    for (const type of ['Region', 'Branch', 'Department', 'Team']) {
      const res = await http()
        .post('/api/v1/org/units')
        .set('authorization', admin('tA'))
        .send({ parentId, name: `${type} 1`, type })
        .expect(201);
      expect(res.body.path).toBe(
        `${roots.tA.rootPath}${res.body.path.slice(roots.tA.rootPath.length)}`,
      );
      parentId = res.body.id;
    }
    const list = await http()
      .get('/api/v1/org/units')
      .set('authorization', admin('tA'))
      .expect(200);
    expect(list.body.map((u: { depth: number }) => u.depth)).toEqual([0, 1, 2, 3, 4]);
  });

  it('never shows or touches another tenant’s units', async () => {
    const b = await http().get('/api/v1/org/units').set('authorization', admin('tB')).expect(200);
    expect(b.body).toHaveLength(1);
    expect(b.body[0].name).toBe('Company tB');
    await http()
      .get(`/api/v1/org/units/${roots.tA.rootUnitId}`)
      .set('authorization', admin('tB'))
      .expect(404);
    await http()
      .post('/api/v1/org/units')
      .set('authorization', admin('tB'))
      .send({ parentId: roots.tA.rootUnitId, name: 'Sneaky', type: 'Branch' })
      .expect(404);
  });

  it('limits a branch manager to their branch', async () => {
    const north = await http()
      .post('/api/v1/org/units')
      .set('authorization', admin('tA'))
      .send({ parentId: roots.tA.rootUnitId, name: 'North', type: 'Region' })
      .expect(201);
    const south = await http()
      .post('/api/v1/org/units')
      .set('authorization', admin('tA'))
      .send({ parentId: roots.tA.rootUnitId, name: 'South', type: 'Region' })
      .expect(201);
    const manager = user('tA', [{ ou: north.body.id, path: north.body.path, p: ALL }]);

    await http()
      .post('/api/v1/org/units')
      .set('authorization', manager)
      .send({ parentId: north.body.id, name: 'North Branch', type: 'Branch' })
      .expect(201);
    await http()
      .post('/api/v1/org/units')
      .set('authorization', manager)
      .send({ parentId: south.body.id, name: 'Not mine', type: 'Branch' })
      .expect(403);
    const visible = await http().get('/api/v1/org/units').set('authorization', manager).expect(200);
    expect(visible.body.map((u: { name: string }) => u.name).sort()).toEqual([
      'North',
      'North Branch',
    ]);
  });

  it('moves a subtree and rewrites descendant paths', async () => {
    const auth = admin('tA');
    const mk = async (parentId: string, name: string) =>
      (
        await http()
          .post('/api/v1/org/units')
          .set('authorization', auth)
          .send({ parentId, name, type: 'X' })
          .expect(201)
      ).body;
    const a = await mk(roots.tA.rootUnitId, 'A');
    const b = await mk(roots.tA.rootUnitId, 'B');
    const a1 = await mk(a.id, 'A1');
    const a11 = await mk(a1.id, 'A11');

    await http()
      .post(`/api/v1/org/units/${a.id}/move`)
      .set('authorization', auth)
      .send({ newParentId: a11.id })
      .expect(400);
    const moved = await http()
      .post(`/api/v1/org/units/${a1.id}/move`)
      .set('authorization', auth)
      .send({ newParentId: b.id })
      .expect(201);
    expect(moved.body.path).toBe(`${b.path}${a1.id}/`);
    const child = await http()
      .get(`/api/v1/org/units/${a11.id}`)
      .set('authorization', auth)
      .expect(200);
    expect(child.body.path).toBe(`${b.path}${a1.id}/${a11.id}/`);
    expect(child.body.depth).toBe(3);
  });

  it('protects the root and units with active children', async () => {
    const auth = admin('tA');
    await http()
      .post(`/api/v1/org/units/${roots.tA.rootUnitId}/deactivate`)
      .set('authorization', auth)
      .expect(400);
    const p = (
      await http()
        .post('/api/v1/org/units')
        .set('authorization', auth)
        .send({ parentId: roots.tA.rootUnitId, name: 'P', type: 'X' })
    ).body;
    await http()
      .post('/api/v1/org/units')
      .set('authorization', auth)
      .send({ parentId: p.id, name: 'C', type: 'X' })
      .expect(201);
    await http()
      .post(`/api/v1/org/units/${p.id}/deactivate`)
      .set('authorization', auth)
      .expect(409);
  });

  it('rejects duplicate codes within a tenant only', async () => {
    const body = (tid: string) => ({
      parentId: roots[tid].rootUnitId,
      name: 'HQ',
      type: 'Branch',
      code: 'HQ-1',
    });
    await http()
      .post('/api/v1/org/units')
      .set('authorization', admin('tA'))
      .send(body('tA'))
      .expect(201);
    await http()
      .post('/api/v1/org/units')
      .set('authorization', admin('tA'))
      .send(body('tA'))
      .expect(409);
    await http()
      .post('/api/v1/org/units')
      .set('authorization', admin('tB'))
      .send(body('tB'))
      .expect(201);
  });

  it('validates custom fields configured for org units', async () => {
    const auth = admin('tA');
    const bad = await http()
      .post('/api/v1/org/units')
      .set('authorization', auth)
      .send({
        parentId: roots.tA.rootUnitId,
        name: 'Hall',
        type: 'Campus',
        custom: { capacity: -5 },
      })
      .expect(400);
    expect(bad.body.error.details).toEqual([
      { path: 'custom.capacity', message: 'Must be at least 0' },
    ]);
    const ok = await http()
      .post('/api/v1/org/units')
      .set('authorization', auth)
      .send({
        parentId: roots.tA.rootUnitId,
        name: 'Hall',
        type: 'Campus',
        custom: { capacity: '250' },
      })
      .expect(201);
    expect(ok.body.custom).toEqual({ capacity: 250 });
    const upd = await http()
      .patch(`/api/v1/org/units/${ok.body.id}`)
      .set('authorization', auth)
      .send({ custom: { capacity: 300 } })
      .expect(200);
    expect(upd.body.custom).toEqual({ capacity: 300 });
  });

  it('sets a unit head and lists the units above a unit with their heads and codes', async () => {
    const auth = admin('tA');
    const region = await http()
      .post('/api/v1/org/units')
      .set('authorization', auth)
      .send({ parentId: roots.tA.rootUnitId, name: 'North', code: 'NORTH', type: 'Region' })
      .expect(201);
    const branch = await http()
      .post('/api/v1/org/units')
      .set('authorization', auth)
      .send({ parentId: region.body.id, name: 'Delhi', code: 'DEL', type: 'Branch' })
      .expect(201);
    const head = 'a'.repeat(24);
    const set = await http()
      .patch(`/api/v1/org/units/${region.body.id}`)
      .set('authorization', auth)
      .send({ headUserId: head })
      .expect(200);
    expect(set.body.headUserId).toBe(head);
    await http()
      .patch(`/api/v1/org/units/${region.body.id}`)
      .set('authorization', auth)
      .send({ headUserId: 'd'.repeat(24) })
      .expect(400);
    await http()
      .patch(`/api/v1/org/units/${region.body.id}`)
      .set('authorization', auth)
      .send({ headUserId: 'f'.repeat(24) })
      .expect(400);

    const ancestors = await http()
      .get(`/internal/org/units/${branch.body.id}/ancestors`)
      .set('x-service-token', svc('tA'))
      .expect(200);
    expect(
      ancestors.body.map((u: { code: string | null; headUserId: string | null }) => [
        u.code,
        u.headUserId,
      ]),
    ).toEqual([
      [null, null],
      ['NORTH', head],
      ['DEL', null],
    ]);

    const cleared = await http()
      .patch(`/api/v1/org/units/${region.body.id}`)
      .set('authorization', auth)
      .send({ headUserId: null })
      .expect(200);
    expect(cleared.body.headUserId).toBeNull();
    // Another company cannot read these units.
    await http()
      .get(`/internal/org/units/${branch.body.id}/ancestors`)
      .set('x-service-token', svc('tB'))
      .expect(404);
  });
});
