import 'reflect-metadata';
import { generateKeyPairSync } from 'node:crypto';
import { Body, Controller, Get, Inject, Module, Post, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Schema } from 'mongoose';
import { z } from 'zod';
import { Internal, Public, RequirePermissions, signAccessToken, signServiceToken } from '@erp/auth';
import { requireContext, tenantPlugin, type TenantDatabases } from '@erp/tenancy';
import { startMongo, type TestMongo } from '@erp/testing';
import { ServiceCoreModule } from './core.module';
import { SharedPlacementResolver } from './placement';
import { TENANT_DATABASES } from './tokens';
import { ZodPipe } from './zod';

const Thing = { name: 'Thing', schema: new Schema({ label: String }).plugin(tenantPlugin) };

@Controller()
class TestController {
  constructor(@Inject(TENANT_DATABASES) private readonly dbs: TenantDatabases) {}

  @Public()
  @Get('public/ping')
  ping() {
    return { ok: true, tenant: requireContext().tenantId ?? null };
  }

  @Post('things')
  @RequirePermissions('org.unit.create')
  async create(@Body(new ZodPipe(z.object({ label: z.string().min(1) }))) body: { label: string }) {
    const T = await this.dbs.model(Thing);
    const doc = await T.create(body);
    return { id: String(doc._id) };
  }

  @Get('things')
  @RequirePermissions('org.unit.read')
  async list() {
    const T = await this.dbs.model(Thing);
    return (await T.find().lean()).map((d) => d.label);
  }

  @Internal()
  @Get('internal/whoami')
  whoami() {
    const c = requireContext();
    return { tenantId: c.tenantId, actor: c.actor };
  }
}

@Module({
  imports: [
    ServiceCoreModule.forRoot({ name: 'test-service', placementResolver: SharedPlacementResolver }),
  ],
  controllers: [TestController],
})
class TestAppModule {}

describe('ServiceCoreModule', () => {
  const keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const secret = 'x'.repeat(40);
  let mongo: TestMongo;
  let app: INestApplication;

  const token = (tid: string, perms: string[]) =>
    signAccessToken(
      {
        sub: `user-${tid}`,
        tid,
        sid: 's',
        acl: [{ ou: 'root', path: '/root/', p: perms as never }],
      },
      keys.privateKey,
      300,
    );

  beforeAll(async () => {
    mongo = await startMongo();
    Object.assign(process.env, {
      PORT: '0',
      LOG_LEVEL: 'silent',
      MONGO_URI: mongo.uri,
      MONGO_DB: 'erp_kit_test',
      NATS_URL: 'memory',
      JWT_PUBLIC_KEY: keys.publicKey,
      INTERNAL_SECRET: secret,
      TENANT_SERVICE_URL: 'http://127.0.0.1:1',
      ENABLE_DOCS: 'false',
    });
    const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
  });

  it('serves public routes without a tenant', async () => {
    const res = await request(app.getHttpServer()).get('/public/ping').expect(200);
    expect(res.body).toEqual({ ok: true, tenant: null });
    expect(res.headers['x-correlation-id']).toBeDefined();
  });

  it('rejects missing and forged tokens with the standard error body', async () => {
    const res = await request(app.getHttpServer()).get('/things').expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(res.body.correlationId).toBeDefined();
    await request(app.getHttpServer())
      .get('/things')
      .set('authorization', 'Bearer abc.def.ghi')
      .expect(401);
  });

  it('enforces permissions', async () => {
    const res = await request(app.getHttpServer())
      .post('/things')
      .set('authorization', `Bearer ${token('tA', ['org.unit.read'])}`)
      .send({ label: 'x' })
      .expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('validates bodies', async () => {
    const res = await request(app.getHttpServer())
      .post('/things')
      .set('authorization', `Bearer ${token('tA', ['org.unit.create'])}`)
      .send({ label: '' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('isolates tenants at the API, ignoring spoofed tenant input', async () => {
    const http = app.getHttpServer();
    const rw = ['org.unit.create', 'org.unit.read'];
    await request(http)
      .post('/things')
      .set('authorization', `Bearer ${token('tA', rw)}`)
      .send({ label: 'A1' })
      .expect(201);
    await request(http)
      .post('/things')
      .set('authorization', `Bearer ${token('tB', rw)}`)
      .set('x-tenant-id', 'tA')
      .send({ label: 'B1', tenantId: 'tA' })
      .expect(201);
    const a = await request(http)
      .get('/things')
      .set('authorization', `Bearer ${token('tA', rw)}`)
      .expect(200);
    const b = await request(http)
      .get('/things')
      .set('authorization', `Bearer ${token('tB', rw)}`)
      .expect(200);
    expect(a.body).toEqual(['A1']);
    expect(b.body).toEqual(['B1']);
  });

  it('accepts only service tokens on internal routes', async () => {
    const http = app.getHttpServer();
    await request(http)
      .get('/internal/whoami')
      .set('authorization', `Bearer ${token('tA', [])}`)
      .expect(401);
    const svc = signServiceToken({ sub: 'svc:caller', tid: 'tA', act: 'u9' }, secret);
    const res = await request(http).get('/internal/whoami').set('x-service-token', svc).expect(200);
    expect(res.body).toEqual({ tenantId: 'tA', actor: { type: 'user', id: 'u9' } });
  });

  it('reports health', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
    await request(app.getHttpServer()).get('/ready').expect(200);
  });
});
