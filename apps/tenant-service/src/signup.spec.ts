import 'reflect-metadata';
import { generateKeyPairSync } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { signAccessToken, signServiceToken } from '@erp/auth';
import { DEFAULT_LOGIN_POLICY, type Permission } from '@erp/contracts';
import { UpstreamError } from '@erp/service-kit';
import { startMongo, type TestMongo } from '@erp/testing';
import { AppModule } from './app.module';
import { CLIENTS } from './clients';

const signup = {
  companyName: 'Acme Schools',
  slug: 'acme',
  countryCode: 'IN',
  industryCode: 'education',
  defaultLanguage: 'en',
  timezone: 'Asia/Kolkata',
  admin: { name: 'Asha', email: 'asha@acme.test', password: 'Secret12345' },
};

describe('tenant sign-up saga', () => {
  const keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  let mongo: TestMongo;
  let app: INestApplication;
  const calls: string[] = [];
  let failAccess = false;

  const clients = {
    reference: {
      get: async () => ({ code: 'IN', currencies: ['INR'], defaultLocale: 'en-IN' }),
    },
    org: {
      post: async () => (calls.push('org.bootstrap'), { rootUnitId: 'r1', rootPath: '/r1/' }),
      delete: async () => calls.push('org.undo'),
    },
    identity: {
      post: async () => (calls.push('identity.bootstrap'), { userId: 'u1' }),
      delete: async () => calls.push('identity.undo'),
    },
    access: {
      post: async () => {
        calls.push('access.bootstrap');
        if (failAccess) throw new UpstreamError('access-service', 503, undefined);
        return {};
      },
      delete: async () => calls.push('access.undo'),
    },
  };

  beforeAll(async () => {
    mongo = await startMongo();
    Object.assign(process.env, {
      PORT: '0',
      LOG_LEVEL: 'silent',
      MONGO_URI: mongo.uri,
      MONGO_DB: 'erp_tenant_test',
      NATS_URL: 'memory',
      JWT_PUBLIC_KEY: keys.publicKey,
      INTERNAL_SECRET: 's'.repeat(40),
      TENANT_SERVICE_URL: 'self',
      ORG_SERVICE_URL: 'http://org.test',
      IDENTITY_SERVICE_URL: 'http://identity.test',
      ACCESS_SERVICE_URL: 'http://access.test',
      REFERENCE_SERVICE_URL: 'http://reference.test',
      ENABLE_DOCS: 'false',
    });
    const ref = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CLIENTS)
      .useValue(clients)
      .compile();
    app = ref.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
  });

  beforeEach(() => {
    calls.length = 0;
    failAccess = false;
  });

  it('runs every step and activates the tenant', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/tenants/signup')
      .send(signup)
      .expect(201);
    expect(res.body).toMatchObject({ slug: 'acme', status: 'active' });
    expect(calls).toEqual(['org.bootstrap', 'identity.bootstrap', 'access.bootstrap']);
    const lookup = await request(app.getHttpServer())
      .get('/api/v1/tenants/lookup/acme')
      .expect(200);
    expect(lookup.body).toMatchObject({ name: 'Acme Schools', status: 'active' });
  });

  it('rejects a taken or reserved slug', async () => {
    await request(app.getHttpServer()).post('/api/v1/tenants/signup').send(signup).expect(409);
    await request(app.getHttpServer())
      .post('/api/v1/tenants/signup')
      .send({ ...signup, slug: 'platform' })
      .expect(409);
    const avail = await request(app.getHttpServer())
      .get('/api/v1/tenants/slug-available/acme')
      .expect(200);
    expect(avail.body.available).toBe(false);
  });

  it('undoes completed steps in reverse order when a step fails, and frees the slug', async () => {
    failAccess = true;
    const res = await request(app.getHttpServer())
      .post('/api/v1/tenants/signup')
      .send({ ...signup, slug: 'beta' })
      .expect(502);
    expect(res.body.error.code).toBe('SIGNUP_FAILED');
    expect(calls).toEqual([
      'org.bootstrap',
      'identity.bootstrap',
      'access.bootstrap',
      'identity.undo',
      'org.undo',
    ]);
    const avail = await request(app.getHttpServer())
      .get('/api/v1/tenants/slug-available/beta')
      .expect(200);
    expect(avail.body.available).toBe(true);
  });

  it('validates input', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/tenants/signup')
      .send({ ...signup, slug: 'x', admin: { ...signup.admin, password: 'short' } })
      .expect(400);
    expect(
      [...new Set(res.body.error.details.map((d: { path: string }) => d.path))].sort(),
    ).toEqual(['admin.password', 'slug']);
  });

  it('lets the company admin choose sign-in methods, and shows them on the login page', async () => {
    const server = app.getHttpServer();
    const t = await request(server)
      .get('/internal/tenants/by-slug/acme')
      .set('x-service-token', signServiceToken({ sub: 'svc:identity-service' }, 's'.repeat(40)))
      .expect(200);
    expect(t.body.loginPolicy).toEqual(DEFAULT_LOGIN_POLICY);
    const token = (p: Permission[]) =>
      `Bearer ${signAccessToken({ sub: 'u1', tid: t.body.id, sid: 's', acl: [{ ou: 'r1', path: '/r1/', p }] }, keys.privateKey, 300)}`;
    const admin = token(['tenant.settings.read', 'tenant.settings.update']);

    const next = {
      methods: { password: true, otp: true, google: true, microsoft: false },
      ssoDomains: ['Acme.in'],
      allowPersonalMicrosoft: false,
      autoJoin: { enabled: true, roleId: 'a'.repeat(24), orgUnitId: 'b'.repeat(24) },
    };
    const saved = await request(server)
      .put('/api/v1/tenants/current/login-policy')
      .set('authorization', admin)
      .send(next)
      .expect(200);
    expect(saved.body.ssoDomains).toEqual(['acme.in']);
    const got = await request(server)
      .get('/api/v1/tenants/current/login-policy')
      .set('authorization', admin)
      .expect(200);
    expect(got.body.methods).toEqual(next.methods);
    const lookup = await request(server).get('/api/v1/tenants/lookup/acme').expect(200);
    expect(lookup.body.loginMethods).toEqual(next.methods);

    // At least one method must stay on; auto-join needs domains, a role and a unit.
    const off = {
      ...next,
      methods: { password: false, otp: false, google: false, microsoft: false },
    };
    await request(server)
      .put('/api/v1/tenants/current/login-policy')
      .set('authorization', admin)
      .send(off)
      .expect(400);
    const noDomains = { ...next, ssoDomains: [] };
    await request(server)
      .put('/api/v1/tenants/current/login-policy')
      .set('authorization', admin)
      .send(noDomains)
      .expect(400);
    // Reading is not enough to change it.
    await request(server)
      .put('/api/v1/tenants/current/login-policy')
      .set('authorization', token(['tenant.settings.read']))
      .send(next)
      .expect(403);
  });
});
