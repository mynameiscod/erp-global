import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import request from 'supertest';
import { signAccessToken } from '@erp/auth';
import { testKeys } from '@erp/testing';
import { createGateway } from './app';
import { gatewayEnvSchema } from './config';

/** A fake upstream that echoes what it received. */
function echoServer(name: string): Promise<{ url: string; server: Server }> {
  const app = express();
  app.use(express.json());
  app.all('/{*path}', (req, res) => {
    res.json({
      service: name,
      path: req.path,
      method: req.method,
      headers: req.headers,
      body: req.body,
    });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server });
    });
  });
}

describe('api-gateway', () => {
  const servers: Server[] = [];
  let gateway: ReturnType<typeof createGateway>;
  const token = () =>
    `Bearer ${signAccessToken({ sub: 'u1', tid: 't1', sid: 's1', acl: [] }, testKeys().privateKey, 300)}`;

  beforeAll(async () => {
    const names = [
      'identity',
      'tenant',
      'org',
      'access',
      'audit',
      'reference',
      'config',
      'records',
      'files',
      'workflow',
      'notification',
      'document',
      'reporting',
    ];
    const ups = await Promise.all(names.map(echoServer));
    servers.push(...ups.map((u) => u.server));
    const url = Object.fromEntries(names.map((n, i) => [n, ups[i].url]));
    const env = gatewayEnvSchema.parse({
      LOG_LEVEL: 'silent',
      JWT_PUBLIC_KEY: testKeys().publicKey,
      AUTH_RATE_LIMIT_PER_MINUTE: '3',
      IDENTITY_SERVICE_URL: url.identity,
      TENANT_SERVICE_URL: url.tenant,
      ORG_SERVICE_URL: url.org,
      ACCESS_SERVICE_URL: url.access,
      AUDIT_SERVICE_URL: url.audit,
      REFERENCE_SERVICE_URL: 'http://127.0.0.1:9',
      CONFIG_SERVICE_URL: url.config,
      RECORDS_SERVICE_URL: url.records,
      FILE_SERVICE_URL: url.files,
      WORKFLOW_SERVICE_URL: url.workflow,
      NOTIFICATION_SERVICE_URL: url.notification,
      DOCUMENT_SERVICE_URL: url.document,
      REPORTING_SERVICE_URL: url.reporting,
    });
    gateway = createGateway(env);
  });

  afterAll(() => servers.forEach((s) => s.close()));

  it('routes each prefix to its service, keeping the path', async () => {
    const cases: [string, string][] = [
      ['/api/v1/org/units', 'org'],
      ['/api/v1/access/roles', 'access'],
      ['/api/v1/audit/events', 'audit'],
      ['/api/v1/identity/me', 'identity'],
      ['/api/v1/workflow/tasks', 'workflow'],
      ['/api/v1/notifications/stream', 'notification'],
      ['/api/v1/notifications', 'notification'],
      ['/api/v1/tenants/current', 'tenant'],
      ['/api/v1/platform/tenants', 'tenant'],
      ['/api/v1/config/effective', 'config'],
      ['/api/v1/records/student', 'records'],
      ['/api/v1/files/abc', 'files'],
    ];
    for (const [path, service] of cases) {
      const res = await request(gateway).get(path).set('authorization', token()).expect(200);
      expect(res.body).toMatchObject({ service, path });
    }
  });

  it('requires a valid token except on public routes', async () => {
    await request(gateway).get('/api/v1/org/units').expect(401);
    await request(gateway)
      .get('/api/v1/org/units')
      .set('authorization', 'Bearer forged.token.here')
      .expect(401);
    await request(gateway).post('/api/v1/tenants/signup').send({}).expect(200);
    await request(gateway).get('/api/v1/tenants/lookup/acme').expect(200);
    await request(gateway).post('/api/v1/identity/auth/refresh').expect(200);
    await request(gateway).get('/api/v1/tenants/current').expect(401);
    await request(gateway)
      .get('/api/v1/files/123e4567-e89b-12d3-a456-426614174000/content')
      .expect(200);
    await request(gateway).get('/api/v1/files/123e4567-e89b-12d3-a456-426614174000').expect(401);
  });

  it('never exposes internal routes or unknown paths', async () => {
    await request(gateway)
      .get('/internal/tenants/abc/placement')
      .set('authorization', token())
      .expect(404);
    await request(gateway).get('/api/v1/nothing').set('authorization', token()).expect(404);
  });

  it('strips trust headers a client tries to send', async () => {
    const res = await request(gateway)
      .get('/api/v1/org/units')
      .set('authorization', token())
      .set('x-service-token', 'forged')
      .set('x-tenant-id', 'other-tenant')
      .expect(200);
    expect(res.body.headers['x-service-token']).toBeUndefined();
    expect(res.body.headers['x-tenant-id']).toBeUndefined();
    expect(res.body.headers['x-correlation-id']).toBeDefined();
  });

  it('forwards request bodies', async () => {
    const res = await request(gateway)
      .post('/api/v1/org/units')
      .set('authorization', token())
      .send({ name: 'HQ', nested: { a: 1 } })
      .expect(200);
    expect(res.body.body).toEqual({ name: 'HQ', nested: { a: 1 } });
  });

  it('returns 502 when a service is down', async () => {
    const res = await request(gateway).get('/api/v1/reference/countries').expect(502);
    expect(res.body.error.code).toBe('UPSTREAM_ERROR');
  });

  it('rate-limits sensitive endpoints', async () => {
    // The limit is 3 per minute across all sensitive endpoints (sign-up above already used one).
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++)
      statuses.push((await request(gateway).post('/api/v1/identity/auth/login').send({})).status);
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThan(0);
    const res = await request(gateway).post('/api/v1/identity/auth/login').send({}).expect(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    // Normal API traffic has its own, larger budget.
    await request(gateway).get('/api/v1/org/units').set('authorization', token()).expect(200);
  });
});
