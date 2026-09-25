import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { authenticator } from 'otplib';
import request from 'supertest';
import { signServiceToken, verifyAccessToken } from '@erp/auth';
import { NotifyTypes, type EmailRequestedPayload } from '@erp/contracts';
import type { Connection } from 'mongoose';
import {
  MONGO_CONNECTION,
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
import { emptyLayer, platformBaseLayer, resolveEffective } from '@erp/metadata';
import { AppModule } from './app.module';
import { CLIENTS } from './config';

const TA = fakeId(0xa);
const TB = fakeId(0xb);
const tenants: Record<
  string,
  { id: string; name: string; status: string; requireMfa: boolean; defaultLanguage: string }
> = {
  alpha: { id: TA, name: 'Alpha', status: 'active', requireMfa: false, defaultLanguage: 'en' },
  beta: { id: TB, name: 'Beta', status: 'active', requireMfa: false, defaultLanguage: 'ar' },
};
const PASSWORD = 'Correct-horse-1';

describe('identity-service', () => {
  let mongo: TestMongo;
  let app: INestApplication;
  let baseUrl = '';
  const http = () => request(baseUrl);
  const admins: Record<string, string> = {};

  const notFound = () =>
    new UpstreamError('tenant-service', 404, { error: { code: 'NOT_FOUND', message: 'nf' } });
  const clients = {
    tenant: {
      get: async (path: string) => {
        const slug = path.match(/by-slug\/(.+)$/)?.[1];
        const t = slug ? tenants[slug] : Object.values(tenants).find((x) => path.endsWith(x.id));
        if (!t) throw notFound();
        return t;
      },
    },
    config: {
      effective: async () => ({
        ...resolveEffective(
          [platformBaseLayer()],
          {
            company: {
              ...emptyLayer(),
              entities: [
                {
                  key: 'user',
                  fields: [
                    {
                      key: 'employee_code',
                      type: 'text',
                      label: { en: 'Employee code' },
                      maxLength: 8,
                    },
                  ],
                },
              ],
            },
            orgUnits: {},
          },
          { version: 1, defaultFiscalYearStart: 4 },
        ),
        tenant: { countryCode: 'IN', currency: 'INR', locale: 'en-IN', defaultLanguage: 'en' },
      }),
      invalidate: () => undefined,
    },
    access: {
      get: async () => [
        {
          ou: fakeId(1),
          path: `/${fakeId(1)}/`,
          p: ['identity.user.read', 'identity.user.invite', 'identity.user.manage'],
        },
      ],
    },
  };

  const svc = (tid: string) =>
    signServiceToken({ sub: 'svc:tenant-service', tid }, TEST_INTERNAL_SECRET);
  const login = (tenantSlug: string, email: string, password = PASSWORD) =>
    http().post('/api/v1/identity/auth/login').send({ tenantSlug, email, password });
  const refreshCookie = (res: request.Response) =>
    ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith('erp_rt='))!
      .split(';')[0];
  /** Waits for the outbox relay to publish the email request, then returns the newest one. */
  const lastEmail = async (to: string, after = 0): Promise<EmailRequestedPayload | undefined> => {
    for (let i = 0; i < 100; i++) {
      const found = sharedMemoryBus()
        .published.slice(after)
        .reverse()
        .find(
          (e) =>
            e.type === NotifyTypes.EmailRequested && (e.payload as EmailRequestedPayload).to === to,
        );
      if (found) return found.payload as EmailRequestedPayload;
      await new Promise((r) => setTimeout(r, 50));
    }
    return undefined;
  };
  const published = () => sharedMemoryBus().published.length;
  const tokenFromLink = (link: string) =>
    decodeURIComponent(new URL(link).searchParams.get('token')!);

  beforeAll(async () => {
    mongo = await startMongo();
    Object.assign(
      process.env,
      serviceTestEnv(mongo.uri, 'erp_identity_test', {
        JWT_PRIVATE_KEY: testKeys().privateKey,
        DATA_ENC_KEY: randomBytes(32).toString('base64'),
        ACCESS_SERVICE_URL: 'http://access.test',
        CONFIG_SERVICE_URL: 'http://config.test',
        APP_URL: 'https://app.example.test',
        COOKIE_SECURE: 'false',
        PLATFORM_ADMIN_EMAIL: 'root@platform.test',
        PLATFORM_ADMIN_PASSWORD: PASSWORD,
      }),
    );
    const ref = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PLACEMENT_RESOLVER)
      .useClass(SharedPlacementResolver)
      .overrideProvider(CLIENTS)
      .useValue(clients)
      .compile();
    app = ref.createNestApplication();
    (app as unknown as { use: (m: unknown) => void }).use(cookieParser());
    await app.listen(0, '127.0.0.1');
    baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');

    for (const [slug, t] of Object.entries(tenants)) {
      const res = await http()
        .post('/internal/users/bootstrap-admin')
        .set('x-service-token', svc(t.id))
        .send({
          name: `Admin ${slug}`,
          email: 'admin@shared.test',
          password: PASSWORD,
          language: 'en',
          timezone: 'UTC',
        })
        .expect(201);
      admins[slug] = res.body.userId;
    }
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
  });

  it('keeps the same email in two tenants as two separate accounts', async () => {
    const a = await login('alpha', 'admin@shared.test').expect(200);
    const b = await login('beta', 'admin@shared.test').expect(200);
    const ca = verifyAccessToken(a.body.accessToken, testKeys().publicKey);
    const cb = verifyAccessToken(b.body.accessToken, testKeys().publicKey);
    expect(ca.tid).toBe(TA);
    expect(cb.tid).toBe(TB);
    expect(ca.sub).not.toBe(cb.sub);
    expect(a.body.refreshToken).toBeUndefined();
    expect(refreshCookie(a)).toMatch(/^erp_rt=/);
  });

  it('rejects wrong passwords, unknown users and unknown companies with one message', async () => {
    const r1 = await login('alpha', 'admin@shared.test', 'Wrong-password-1').expect(401);
    const r2 = await login('alpha', 'nobody@shared.test').expect(401);
    const r3 = await login('nope', 'admin@shared.test').expect(401);
    expect(
      new Set([r1.body.error.message, r2.body.error.message, r3.body.error.message]).size,
    ).toBe(1);
  });

  it('signs in the platform admin with platform permissions', async () => {
    const res = await login('platform', 'root@platform.test').expect(200);
    const claims = verifyAccessToken(res.body.accessToken, testKeys().publicKey);
    expect(claims.tid).toBe('platform');
    expect(claims.plat).toContain('platform.tenant.manage');
    expect(claims.acl).toEqual([]);
  });

  it('rotates refresh tokens and revokes the session when an old one is replayed', async () => {
    const res = await login('alpha', 'admin@shared.test').expect(200);
    const first = refreshCookie(res);
    const r1 = await http().post('/api/v1/identity/auth/refresh').set('cookie', first).expect(200);
    const second = refreshCookie(r1);
    expect(second).not.toBe(first);
    const r2 = await http().post('/api/v1/identity/auth/refresh').set('cookie', second).expect(200);
    const current = refreshCookie(r2);

    // Within the grace window (two tabs racing) replaying the previous token is refused,
    // but the session survives.
    await http().post('/api/v1/identity/auth/refresh').set('cookie', second).expect(401);
    const r3 = await http()
      .post('/api/v1/identity/auth/refresh')
      .set('cookie', current)
      .expect(200);

    // Later, replaying an old token looks like theft: the whole session is revoked.
    const conn = app.get<Connection>(MONGO_CONNECTION);
    await conn.collection('sessions').updateMany({}, { $set: { lastUsedAt: new Date(0) } });
    await http().post('/api/v1/identity/auth/refresh').set('cookie', current).expect(401);
    await http().post('/api/v1/identity/auth/refresh').set('cookie', refreshCookie(r3)).expect(401);

    // An older token (two rotations back) is always treated as theft.
    const again = await login('alpha', 'admin@shared.test').expect(200);
    const a1 = await http()
      .post('/api/v1/identity/auth/refresh')
      .set('cookie', refreshCookie(again))
      .expect(200);
    const a2 = await http()
      .post('/api/v1/identity/auth/refresh')
      .set('cookie', refreshCookie(a1))
      .expect(200);
    await http()
      .post('/api/v1/identity/auth/refresh')
      .set('cookie', refreshCookie(again))
      .expect(401);
    await http().post('/api/v1/identity/auth/refresh').set('cookie', refreshCookie(a2)).expect(401);
  });

  it('locks the account after repeated failures', async () => {
    await http()
      .post('/internal/users/bootstrap-admin')
      .set('x-service-token', svc(TA))
      .send({
        name: 'Lock Me',
        email: 'lock@alpha.test',
        password: PASSWORD,
        language: 'en',
        timezone: 'UTC',
      })
      .expect(201);
    for (let i = 0; i < 5; i++)
      await login('alpha', 'lock@alpha.test', 'Wrong-password-1').expect(401);
    const res = await login('alpha', 'lock@alpha.test').expect(429);
    expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('enables TOTP two-factor and requires it at login', async () => {
    const auth = `Bearer ${(await login('beta', 'admin@shared.test').expect(200)).body.accessToken}`;
    const setup = await http()
      .post('/api/v1/identity/me/mfa/setup')
      .set('authorization', auth)
      .expect(200);
    expect(setup.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    await http()
      .post('/api/v1/identity/me/mfa/enable')
      .set('authorization', auth)
      .send({ code: '000000' })
      .expect(400);
    await http()
      .post('/api/v1/identity/me/mfa/enable')
      .set('authorization', auth)
      .send({ code: authenticator.generate(setup.body.secret) })
      .expect(200);

    const step1 = await login('beta', 'admin@shared.test').expect(200);
    expect(step1.body).toEqual({
      mfaRequired: true,
      mfaToken: expect.any(String),
      mfaMethod: 'totp',
    });
    await http()
      .post('/api/v1/identity/auth/login/mfa')
      .send({ mfaToken: step1.body.mfaToken, code: '000000' })
      .expect(401);
    const step2 = await http()
      .post('/api/v1/identity/auth/login/mfa')
      .send({ mfaToken: step1.body.mfaToken, code: authenticator.generate(setup.body.secret) })
      .expect(200);
    expect(step2.body.accessToken).toBeDefined();
    // The MFA token is single-use.
    await http()
      .post('/api/v1/identity/auth/login/mfa')
      .send({ mfaToken: step1.body.mfaToken, code: authenticator.generate(setup.body.secret) })
      .expect(401);
  });

  it('invites a user who then sets a password and signs in', async () => {
    const auth = `Bearer ${(await login('alpha', 'admin@shared.test').expect(200)).body.accessToken}`;
    const mark = published();
    const invited = await http()
      .post('/api/v1/identity/users/invite')
      .set('authorization', auth)
      .send({ name: 'Ravi', email: 'Ravi@Alpha.test' })
      .expect(201);
    expect(invited.body).toMatchObject({ email: 'ravi@alpha.test', status: 'invited' });
    const mail = await lastEmail('ravi@alpha.test', mark);
    expect(mail?.template).toBe('user.invite');
    expect(mail?.vars.company).toBe('Alpha');
    const token = tokenFromLink(mail!.vars.link);

    // The invite link must not appear in any audited business event.
    const businessEvents = sharedMemoryBus().published.filter((e) => !e.type.startsWith('notify.'));
    expect(JSON.stringify(businessEvents)).not.toContain(token.split('.')[1]);

    await login('alpha', 'ravi@alpha.test').expect(401);
    const details = await http().get('/api/v1/identity/auth/invite').query({ token }).expect(200);
    expect(details.body).toEqual({ email: 'ravi@alpha.test', name: 'Ravi', company: 'Alpha' });
    await http()
      .post('/api/v1/identity/auth/invite/accept')
      .send({ token, password: PASSWORD })
      .expect(200);
    await http()
      .post('/api/v1/identity/auth/invite/accept')
      .send({ token, password: PASSWORD })
      .expect(400);
    await login('alpha', 'ravi@alpha.test').expect(200);
    await login('beta', 'ravi@alpha.test').expect(401);
  });

  it('resets a forgotten password and ends existing sessions', async () => {
    const before = await login('alpha', 'ravi@alpha.test').expect(200);
    const mark = published();
    await http()
      .post('/api/v1/identity/auth/password/forgot')
      .send({ tenantSlug: 'alpha', email: 'ravi@alpha.test' })
      .expect(202);
    await http()
      .post('/api/v1/identity/auth/password/forgot')
      .send({ tenantSlug: 'alpha', email: 'ghost@alpha.test' })
      .expect(202);
    const token = tokenFromLink((await lastEmail('ravi@alpha.test', mark))!.vars.link);
    await http()
      .post('/api/v1/identity/auth/password/reset')
      .send({ token, password: 'Brand-new-pass-2' })
      .expect(200);
    await http()
      .post('/api/v1/identity/auth/refresh')
      .set('cookie', refreshCookie(before))
      .expect(401);
    await login('alpha', 'ravi@alpha.test').expect(401);
    await login('alpha', 'ravi@alpha.test', 'Brand-new-pass-2').expect(200);
  });

  it('deactivates users, blocking login and refresh', async () => {
    const adminAuth = `Bearer ${(await login('alpha', 'admin@shared.test').expect(200)).body.accessToken}`;
    const ravi = await login('alpha', 'ravi@alpha.test', 'Brand-new-pass-2').expect(200);
    const list = await http()
      .get('/api/v1/identity/users?q=ravi')
      .set('authorization', adminAuth)
      .expect(200);
    const raviId = list.body.items[0].id;
    await http()
      .post(`/api/v1/identity/users/${raviId}/deactivate`)
      .set('authorization', adminAuth)
      .expect(200);
    await login('alpha', 'ravi@alpha.test', 'Brand-new-pass-2').expect(401);
    await http()
      .post('/api/v1/identity/auth/refresh')
      .set('cookie', refreshCookie(ravi))
      .expect(401);
  });

  it('never lists or changes another tenant’s users', async () => {
    const alphaAuth = `Bearer ${(await login('alpha', 'admin@shared.test').expect(200)).body.accessToken}`;
    const users = await http()
      .get('/api/v1/identity/users')
      .set('authorization', alphaAuth)
      .expect(200);
    const ids = users.body.items.map((u: { id: string }) => u.id);
    expect(ids).toContain(admins.alpha);
    expect(ids).not.toContain(admins.beta);
    await http()
      .get(`/api/v1/identity/users/${admins.beta}`)
      .set('authorization', alphaAuth)
      .expect(404);
    await http()
      .post(`/api/v1/identity/users/${admins.beta}/deactivate`)
      .set('authorization', alphaAuth)
      .expect(404);
  });

  it('blocks sign-in to a suspended company', async () => {
    tenants.alpha.status = 'suspended';
    try {
      const res = await login('alpha', 'admin@shared.test').expect(403);
      expect(res.body.error.code).toBe('TENANT_SUSPENDED');
    } finally {
      tenants.alpha.status = 'active';
    }
  });

  it('validates and stores custom fields configured for users', async () => {
    const auth = `Bearer ${(await login('alpha', 'admin@shared.test').expect(200)).body.accessToken}`;
    const bad = await http()
      .post('/api/v1/identity/users/invite')
      .set('authorization', auth)
      .send({
        name: 'Kiran',
        email: 'kiran@alpha.test',
        custom: { employee_code: 'TOO-LONG-CODE', ghost: 1 },
      })
      .expect(400);
    expect(bad.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual([
      'custom.employee_code',
      'custom.ghost',
    ]);
    const ok = await http()
      .post('/api/v1/identity/users/invite')
      .set('authorization', auth)
      .send({ name: 'Kiran', email: 'kiran@alpha.test', custom: { employee_code: ' E-101 ' } })
      .expect(201);
    expect(ok.body.custom).toEqual({ employee_code: 'E-101' });
    const upd = await http()
      .patch(`/api/v1/identity/users/${ok.body.id}`)
      .set('authorization', auth)
      .send({ name: 'Kiran K', custom: { employee_code: 'E-102' } })
      .expect(200);
    expect(upd.body).toMatchObject({ name: 'Kiran K', custom: { employee_code: 'E-102' } });
  });

  it('sets a manager, refuses reporting loops, and manages out-of-office delegation', async () => {
    const auth = `Bearer ${(await login('alpha', 'admin@shared.test').expect(200)).body.accessToken}`;
    const invite = async (email: string) =>
      (
        await http()
          .post('/api/v1/identity/users/invite')
          .set('authorization', auth)
          .send({ name: email.split('@')[0], email })
          .expect(201)
      ).body.id as string;
    const lead = await invite('lead@alpha.test');
    const member = await invite('member@alpha.test');
    const set = await http()
      .patch(`/api/v1/identity/users/${member}`)
      .set('authorization', auth)
      .send({ managerId: lead })
      .expect(200);
    expect(set.body.managerId).toBe(lead);
    const loop = await http()
      .patch(`/api/v1/identity/users/${lead}`)
      .set('authorization', auth)
      .send({ managerId: member })
      .expect(400);
    expect(loop.body.error.message).toMatch(/loop/);
    await http()
      .patch(`/api/v1/identity/users/${lead}`)
      .set('authorization', auth)
      .send({ managerId: lead })
      .expect(400);

    const svcAuth = svc(TA);
    const batch = await http()
      .post('/internal/users/batch')
      .set('x-service-token', svcAuth)
      .send({ ids: [member, lead, 'nope'] })
      .expect(200);
    expect(batch.body.find((u: { id: string }) => u.id === member)).toMatchObject({
      managerId: lead,
      language: 'en',
    });
    expect(batch.body).toHaveLength(2);

    // The admin goes on leave and hands approvals to the lead.
    const admin = admins.alpha;
    const hour = 3_600_000;
    await http()
      .put('/api/v1/identity/me/delegation')
      .set('authorization', auth)
      .send({
        toUserId: admin,
        from: new Date().toISOString(),
        until: new Date(Date.now() + hour).toISOString(),
      })
      .expect(400);
    const d = await http()
      .put('/api/v1/identity/me/delegation')
      .set('authorization', auth)
      .send({
        toUserId: lead,
        from: new Date(Date.now() - hour).toISOString(),
        until: new Date(Date.now() + 24 * hour).toISOString(),
        note: 'Holiday',
      })
      .expect(400);
    // The lead has not accepted the invite yet, so is not active.
    expect(d.body.error.message).toMatch(/active user/);
    await http()
      .post(`/api/v1/identity/users/${lead}/deactivate`)
      .set('authorization', auth)
      .expect(200);
    await http()
      .post(`/api/v1/identity/users/${lead}/reactivate`)
      .set('authorization', auth)
      .expect(200);

    // Delegate to the admin of the other company? Unknown here: refused.
    await http()
      .put('/api/v1/identity/me/delegation')
      .set('authorization', auth)
      .send({
        toUserId: admins.beta,
        from: new Date().toISOString(),
        until: new Date(Date.now() + hour).toISOString(),
      })
      .expect(400);

    // An active colleague: bootstrap one directly.
    const colleague = (
      await http()
        .post('/internal/users/bootstrap-admin')
        .set('x-service-token', svcAuth)
        .send({
          name: 'Colleague',
          email: 'colleague@alpha.test',
          password: PASSWORD,
          language: 'en',
          timezone: 'UTC',
        })
        .expect(201)
    ).body.userId;
    const ok = await http()
      .put('/api/v1/identity/me/delegation')
      .set('authorization', auth)
      .send({
        toUserId: colleague,
        from: new Date(Date.now() - hour).toISOString(),
        until: new Date(Date.now() + 24 * hour).toISOString(),
      })
      .expect(200);
    expect(ok.body).toMatchObject({ toUserId: colleague, toName: 'Colleague', active: true });
    expect(
      (
        await http()
          .get(`/internal/users/${admin}/delegate`)
          .set('x-service-token', svcAuth)
          .expect(200)
      ).body,
    ).toEqual({ toUserId: colleague });
    expect(
      (
        await http()
          .get(`/internal/users/${colleague}/delegators`)
          .set('x-service-token', svcAuth)
          .expect(200)
      ).body,
    ).toEqual([admin]);

    await http().delete('/api/v1/identity/me/delegation').set('authorization', auth).expect(200);
    expect(
      (
        await http()
          .get(`/internal/users/${admin}/delegate`)
          .set('x-service-token', svcAuth)
          .expect(200)
      ).body,
    ).toEqual({ toUserId: null });
  });
});
