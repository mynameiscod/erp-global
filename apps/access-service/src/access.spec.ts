import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { signAccessToken, signServiceToken } from '@erp/auth';
import { subjectFor, type AclEntry, type PermissionKey } from '@erp/contracts';
import {
  PLACEMENT_RESOLVER,
  SharedPlacementResolver,
  sharedMemoryBus,
  UpstreamError,
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

// Org layout per tenant: root -> north -> north-branch
const units: Record<string, { id: string; path: string; status: string }> = {};
const unit = (key: string, id: string, path: string) => (
  (units[id] = { id, path, status: 'active' }),
  { key, id, path }
);
const ROOT = unit('root', fakeId(1), `/${fakeId(1)}/`);
const NORTH = unit('north', fakeId(2), `/${fakeId(1)}/${fakeId(2)}/`);
const SOUTH = unit('south', fakeId(3), `/${fakeId(1)}/${fakeId(3)}/`);
const ADMIN = fakeId(100);
const ALICE = fakeId(101);
const BOB = fakeId(102);

describe('access-service', () => {
  let mongo: TestMongo;
  let app: INestApplication;
  let baseUrl = '';
  const http = () => request(baseUrl);
  const svc = (tid: string) => signServiceToken({ sub: 'svc:test', tid }, TEST_INTERNAL_SECRET);
  const bearer = (tid: string, sub: string, acl: AclEntry[]) =>
    `Bearer ${signAccessToken({ sub, tid, sid: 's', acl }, testKeys().privateKey, 300)}`;
  const aclOf = async (tid: string, userId: string): Promise<AclEntry[]> =>
    (
      await http()
        .get(`/internal/access/users/${userId}/acl`)
        .set('x-service-token', svc(tid))
        .expect(200)
    ).body;
  const adminAuth = async (tid: string) => bearer(tid, ADMIN, await aclOf(tid, ADMIN));

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
    identity: { get: async (path: string) => ({ id: path.split('/').pop(), status: 'active' }) },
    config: {
      get: async () => [
        { key: 'user', kind: 'system' },
        { key: 'student', kind: 'custom' },
      ],
    },
  };

  beforeAll(async () => {
    mongo = await startMongo();
    Object.assign(
      process.env,
      serviceTestEnv(mongo.uri, 'erp_access_test', {
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
    for (const tid of ['tA', 'tB']) {
      await http()
        .post('/internal/access/bootstrap')
        .set('x-service-token', svc(tid))
        .send({ adminUserId: ADMIN, rootOrgUnitId: ROOT.id, rootPath: ROOT.path })
        .expect(201);
    }
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
  });

  it('gives the tenant admin every tenant permission at the root', async () => {
    const acl = await aclOf('tA', ADMIN);
    expect(acl).toHaveLength(1);
    expect(acl[0].path).toBe(ROOT.path);
    expect(acl[0].p).toContain('access.role.manage');
    expect(acl[0].p).not.toContain('platform.tenant.manage');
  });

  it('bootstrap is idempotent', async () => {
    await http()
      .post('/internal/access/bootstrap')
      .set('x-service-token', svc('tA'))
      .send({ adminUserId: ADMIN, rootOrgUnitId: ROOT.id, rootPath: ROOT.path })
      .expect(201);
    const roles = await http()
      .get('/api/v1/access/roles')
      .set('authorization', await adminAuth('tA'))
      .expect(200);
    expect(roles.body.map((r: { name: string }) => r.name)).toEqual(['Tenant Admin', 'Viewer']);
  });

  it('creates roles and assigns them at an org unit', async () => {
    const auth = await adminAuth('tA');
    const role = await http()
      .post('/api/v1/access/roles')
      .set('authorization', auth)
      .send({
        name: 'Branch Manager',
        permissions: [
          'org.unit.read',
          'org.unit.create',
          'access.assignment.manage',
          'access.assignment.read',
        ],
      })
      .expect(201);
    await http()
      .post('/api/v1/access/assignments')
      .set('authorization', auth)
      .send({ userId: ALICE, roleId: role.body.id, orgUnitId: NORTH.id })
      .expect(201);
    const acl = await aclOf('tA', ALICE);
    expect(acl).toEqual([
      { ou: NORTH.id, path: NORTH.path, p: expect.arrayContaining(['org.unit.create']) },
    ]);
  });

  it('blocks privilege escalation', async () => {
    const alice = bearer('tA', ALICE, await aclOf('tA', ALICE));
    const roles = (
      await http()
        .get('/api/v1/access/roles')
        .set('authorization', await adminAuth('tA'))
    ).body;
    const tenantAdmin = roles.find((r: { key: string }) => r.key === 'tenant_admin');
    const manager = roles.find((r: { name: string }) => r.name === 'Branch Manager');

    // Alice cannot give herself (or Bob) Tenant Admin, even inside her branch.
    await http()
      .post('/api/v1/access/assignments')
      .set('authorization', alice)
      .send({ userId: BOB, roleId: tenantAdmin.id, orgUnitId: NORTH.id })
      .expect(403);
    // She can hand out her own role inside her branch, but not in another branch.
    await http()
      .post('/api/v1/access/assignments')
      .set('authorization', alice)
      .send({ userId: BOB, roleId: manager.id, orgUnitId: NORTH.id })
      .expect(201);
    await http()
      .post('/api/v1/access/assignments')
      .set('authorization', alice)
      .send({ userId: BOB, roleId: manager.id, orgUnitId: SOUTH.id })
      .expect(403);

    // A role editor cannot grant what they do not hold.
    const editor = bearer('tA', BOB, [
      {
        ou: ROOT.id,
        path: ROOT.path,
        p: ['access.role.manage', 'access.role.read'] as PermissionKey[],
      },
    ]);
    await http()
      .post('/api/v1/access/roles')
      .set('authorization', editor)
      .send({ name: 'Sneaky', permissions: ['audit.event.read'] })
      .expect(403);
  });

  it('protects system roles and the last tenant admin', async () => {
    const auth = await adminAuth('tA');
    const roles = (await http().get('/api/v1/access/roles').set('authorization', auth)).body;
    const tenantAdmin = roles.find((r: { key: string }) => r.key === 'tenant_admin');
    await http()
      .patch(`/api/v1/access/roles/${tenantAdmin.id}`)
      .set('authorization', auth)
      .send({ name: 'x' })
      .expect(403);
    await http()
      .delete(`/api/v1/access/roles/${tenantAdmin.id}`)
      .set('authorization', auth)
      .expect(403);
    const list = (
      await http().get(`/api/v1/access/assignments?userId=${ADMIN}`).set('authorization', auth)
    ).body;
    await http()
      .delete(`/api/v1/access/assignments/${list[0].id}`)
      .set('authorization', auth)
      .expect(409);
  });

  it('keeps tenants apart', async () => {
    const authB = await adminAuth('tB');
    const rolesB = (await http().get('/api/v1/access/roles').set('authorization', authB)).body;
    expect(rolesB.map((r: { name: string }) => r.name)).toEqual(['Tenant Admin', 'Viewer']);
    expect(await aclOf('tB', ALICE)).toEqual([]);
    const rolesA = (
      await http()
        .get('/api/v1/access/roles')
        .set('authorization', await adminAuth('tA'))
    ).body;
    const manager = rolesA.find((r: { name: string }) => r.name === 'Branch Manager');
    await http()
      .patch(`/api/v1/access/roles/${manager.id}`)
      .set('authorization', authB)
      .send({ name: 'Hijack' })
      .expect(404);
    await http()
      .post('/api/v1/access/assignments')
      .set('authorization', authB)
      .send({ userId: ALICE, roleId: manager.id, orgUnitId: ROOT.id })
      .expect(404);
  });

  it('follows org moves through events, in the right tenant only', async () => {
    const newNorthPath = `${SOUTH.path}${NORTH.id}/`;
    await sharedMemoryBus().publish(
      subjectFor('org.unit.moved'),
      {
        eventId: randomUUID(),
        type: 'org.unit.moved',
        version: 1,
        tenantId: 'tA',
        actor: { type: 'user', id: ADMIN },
        occurredAt: new Date().toISOString(),
        source: 'org-service',
        payload: { unitId: NORTH.id, oldPath: NORTH.path, newPath: newNorthPath },
      },
      randomUUID(),
    );
    await sharedMemoryBus().idle();
    expect((await aclOf('tA', ALICE))[0].path).toBe(newNorthPath);
  });

  it('grants generated record permissions for published entities only', async () => {
    const auth = await adminAuth('tA');
    const acl = await aclOf('tA', ADMIN);
    expect(acl[0].p).toContain('records.*.*');
    const catalog = await http()
      .get('/api/v1/access/permissions')
      .set('authorization', auth)
      .expect(200);
    expect(catalog.body.map((p: { key: string }) => p.key)).toEqual(
      expect.arrayContaining(['records.student.read', 'records.student.delete', 'config.publish']),
    );
    await http()
      .post('/api/v1/access/roles')
      .set('authorization', auth)
      .send({ name: 'Admissions', permissions: ['records.student.read', 'records.student.create'] })
      .expect(201);
    const bad = await http()
      .post('/api/v1/access/roles')
      .set('authorization', auth)
      .send({ name: 'Ghost', permissions: ['records.ghost.read'] })
      .expect(400);
    expect(bad.body.error.message).toBe('Unknown entity in permissions: ghost');
    await http()
      .post('/api/v1/access/roles')
      .set('authorization', auth)
      .send({ name: 'Typo', permissions: ['records.student.fly'] })
      .expect(400);
  });
});
