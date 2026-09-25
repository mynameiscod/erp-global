import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { authenticator } from 'otplib';
import request from 'supertest';
import type { Connection } from 'mongoose';
import { signServiceToken, verifyAccessToken } from '@erp/auth';
import {
  DEFAULT_LOGIN_POLICY,
  EventTypes,
  NotifyTypes,
  type EmailRequestedPayload,
  type LoginPolicy,
  type WhatsappRequestedPayload,
} from '@erp/contracts';
import { emptyLayer, platformBaseLayer, resolveEffective } from '@erp/metadata';
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
  startFakeOidc,
  startMongo,
  testKeys,
  TEST_INTERNAL_SECRET,
  type FakeOidc,
  type TestMongo,
} from '@erp/testing';
import { AppModule } from './app.module';
import { CLIENTS } from './config';
import { MS_PERSONAL_TENANT } from './sso.service';

const TA = fakeId(0xa1);
const TB = fakeId(0xb1);
const ROLE = fakeId(0x70);
const OU = fakeId(0x71);
const PASSWORD = 'Correct-horse-1';
const APP_URL = 'https://app.example.test';

interface T {
  id: string;
  name: string;
  status: string;
  requireMfa: boolean;
  defaultLanguage: string;
  loginPolicy: LoginPolicy;
}
const policy = (patch: Partial<LoginPolicy> = {}): LoginPolicy => ({
  ...DEFAULT_LOGIN_POLICY,
  ...patch,
  methods: { password: true, otp: true, google: true, microsoft: true, ...patch.methods },
});
const tenants: Record<string, T> = {
  alpha: {
    id: TA,
    name: 'Alpha',
    status: 'active',
    requireMfa: false,
    defaultLanguage: 'en',
    loginPolicy: policy(),
  },
  beta: {
    id: TB,
    name: 'Beta',
    status: 'active',
    requireMfa: false,
    defaultLanguage: 'hi',
    loginPolicy: policy(),
  },
};

describe('identity-service: sign-in methods', () => {
  let mongo: TestMongo;
  let oidc: FakeOidc;
  let app: INestApplication;
  let baseUrl = '';
  const http = () => request(baseUrl);
  const assignments: unknown[] = [];

  const clients = {
    tenant: {
      get: async (path: string) => {
        const slug = path.match(/by-slug\/(.+)$/)?.[1];
        const t = slug ? tenants[slug] : Object.values(tenants).find((x) => path.endsWith(x.id));
        if (!t)
          throw new UpstreamError('tenant-service', 404, {
            error: { code: 'NOT_FOUND', message: 'nf' },
          });
        return t;
      },
    },
    config: {
      effective: async () => ({
        ...resolveEffective(
          [platformBaseLayer()],
          { company: emptyLayer(), orgUnits: {} },
          {
            version: 1,
            defaultFiscalYearStart: 4,
          },
        ),
        tenant: { countryCode: 'IN', currency: 'INR', locale: 'en-IN', defaultLanguage: 'en' },
      }),
      invalidate: () => undefined,
    },
    access: {
      get: async () => [
        { ou: OU, path: `/${OU}/`, p: ['identity.user.read', 'identity.user.invite'] },
      ],
      post: async (_path: string, body: unknown) => {
        assignments.push(body);
        return { id: fakeId(assignments.length) };
      },
    },
  };

  const svc = (tid: string) =>
    signServiceToken({ sub: 'svc:tenant-service', tid }, TEST_INTERNAL_SECRET);
  const conn = () => app.get<Connection>(MONGO_CONNECTION);
  const published = () => sharedMemoryBus().published.length;
  const login = (tenantSlug: string, email: string, password = PASSWORD) =>
    http().post('/api/v1/identity/auth/login').send({ tenantSlug, email, password });
  const bearer = async (slug: string, email: string) =>
    `Bearer ${(await login(slug, email).expect(200)).body.accessToken}`;
  const cookieOf = (res: request.Response) =>
    ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith('erp_rt='))
      ?.split(';')[0];

  /** Waits for the relay and returns the newest notification of a type for a recipient. */
  async function sent<P extends { to: string; template?: string }>(
    type: string,
    to: string,
    after: number,
    template?: string,
  ) {
    for (let i = 0; i < 100; i++) {
      const e = sharedMemoryBus()
        .published.slice(after)
        .reverse()
        .find(
          (x) =>
            x.type === type &&
            (x.payload as P).to === to &&
            (!template || (x.payload as P).template === template),
        );
      if (e) return e.payload as P;
      await new Promise((r) => setTimeout(r, 30));
    }
    return undefined;
  }
  const whatsappCode = async (to: string, after: number) =>
    (await sent<WhatsappRequestedPayload>(NotifyTypes.WhatsappRequested, to, after))?.code;
  const emailCode = async (to: string, after: number) =>
    (await sent<EmailRequestedPayload>(NotifyTypes.EmailRequested, to, after, 'otp.code'))?.vars
      .code;
  /** Makes earlier codes count as old, so rate limits do not get in the way of the next step. */
  const ageCodes = () =>
    conn()
      .collection('otp_challenges')
      .updateMany({}, { $set: { createdAt: new Date(Date.now() - 2 * 3_600_000) } });

  async function createUser(slug: string, email: string) {
    await http()
      .post('/internal/users/bootstrap-admin')
      .set('x-service-token', svc(tenants[slug]!.id))
      .send({
        name: email.split('@')[0],
        email,
        password: PASSWORD,
        language: 'en',
        timezone: 'UTC',
      })
      .expect(201);
  }

  async function verifyPhone(auth: string, phone: string) {
    await ageCodes();
    const mark = published();
    await http()
      .post('/api/v1/identity/me/phone')
      .set('authorization', auth)
      .send({ phone })
      .expect(200);
    const code = await whatsappCode(phone.replace(/[\s-]/g, ''), mark);
    expect(code).toMatch(/^\d{6}$/);
    return http()
      .post('/api/v1/identity/me/phone/verify')
      .set('authorization', auth)
      .send({ code })
      .expect(200);
  }

  /** Browser round trip: start → provider → callback. Returns the final redirect. */
  async function sso(
    provider: 'google' | 'microsoft',
    company: string,
    identity: Parameters<FakeOidc['signInAs']>[1],
  ) {
    oidc.signInAs(provider, identity);
    const start = await http()
      .get(`/api/v1/identity/sso/${provider}/start?company=${company}`)
      .expect(302);
    expect(start.headers.location).toContain(`${oidc.url}/${provider}/authorize`);
    const back = new URL(await oidc.authorize(start.headers.location));
    expect(back.origin + back.pathname).toBe(`${APP_URL}/api/v1/identity/sso/${provider}/callback`);
    const res = await http()
      .get(back.pathname + back.search)
      .expect(302);
    const location = new URL(res.headers.location);
    expect(location.origin + location.pathname).toBe(`${APP_URL}/sso/complete`);
    return { res, params: new URLSearchParams(location.hash.slice(1)), cookie: cookieOf(res) };
  }

  beforeAll(async () => {
    [mongo, oidc] = await Promise.all([startMongo(), startFakeOidc()]);
    Object.assign(
      process.env,
      serviceTestEnv(mongo.uri, 'erp_identity_login_test', {
        JWT_PRIVATE_KEY: testKeys().privateKey,
        DATA_ENC_KEY: randomBytes(32).toString('base64'),
        ACCESS_SERVICE_URL: 'http://access.test',
        CONFIG_SERVICE_URL: 'http://config.test',
        APP_URL,
        COOKIE_SECURE: 'false',
        GOOGLE_CLIENT_ID: oidc.clientId,
        GOOGLE_CLIENT_SECRET: oidc.clientSecret,
        GOOGLE_ISSUER: `${oidc.url}/google`,
        MICROSOFT_CLIENT_ID: oidc.clientId,
        MICROSOFT_CLIENT_SECRET: oidc.clientSecret,
        MICROSOFT_ISSUER: `${oidc.url}/microsoft`,
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
    await createUser('alpha', 'admin@alpha.test');
    await createUser('beta', 'admin@beta.test');
  });

  afterAll(async () => {
    await app?.close();
    await Promise.all([mongo?.stop(), oidc?.stop()]);
  });

  beforeEach(() => {
    tenants.alpha!.loginPolicy = policy();
    tenants.beta!.loginPolicy = policy();
  });

  // ---- mobile number and WhatsApp sign-in ----

  it('verifies a mobile number with a WhatsApp code and signs in with it', async () => {
    await createUser('alpha', 'ravi@alpha.test');
    const auth = await bearer('alpha', 'ravi@alpha.test');
    const verified = await verifyPhone(auth, '+91 98765-43210');
    expect(verified.body.phone).toBe('+919876543210');

    await ageCodes();
    const mark = published();
    const req = await http()
      .post('/api/v1/identity/auth/otp/request')
      .send({ tenantSlug: 'alpha', phone: '+919876543210' })
      .expect(200);
    expect(req.body).toMatchObject({
      channel: 'whatsapp',
      sentTo: '+91••••••3210',
      resendAfter: 60,
    });
    const code = await whatsappCode('+919876543210', mark);
    const res = await http()
      .post('/api/v1/identity/auth/otp/verify')
      .send({ otpToken: req.body.otpToken, code })
      .expect(200);
    expect(verifyAccessToken(res.body.accessToken, testKeys().publicKey).tid).toBe(TA);
    expect(cookieOf(res)).toBeDefined();
    // Single use.
    await http()
      .post('/api/v1/identity/auth/otp/verify')
      .send({ otpToken: req.body.otpToken, code })
      .expect(401);
  });

  it('sends the sign-in code by email when asked', async () => {
    await ageCodes();
    const mark = published();
    const req = await http()
      .post('/api/v1/identity/auth/otp/request')
      .send({ tenantSlug: 'alpha', phone: '+919876543210', channel: 'email' })
      .expect(200);
    expect(req.body.sentTo).toBeUndefined();
    const mail = await sent<EmailRequestedPayload>(
      NotifyTypes.EmailRequested,
      'ravi@alpha.test',
      mark,
      'otp.code',
    );
    expect(mail?.template).toBe('otp.code');
    await http()
      .post('/api/v1/identity/auth/otp/verify')
      .send({ otpToken: req.body.otpToken, code: mail!.vars.code })
      .expect(200);
  });

  it('answers the same for unknown numbers and never lets them in', async () => {
    await ageCodes();
    const mark = published();
    const res = await http()
      .post('/api/v1/identity/auth/otp/request')
      .send({ tenantSlug: 'alpha', phone: '+919999999999' })
      .expect(200);
    expect(Object.keys(res.body).sort()).toEqual([
      'channel',
      'expiresIn',
      'otpToken',
      'resendAfter',
      'sentTo',
    ]);
    await new Promise((r) => setTimeout(r, 400));
    expect(
      sharedMemoryBus()
        .published.slice(mark)
        .some((e) => e.type === NotifyTypes.WhatsappRequested),
    ).toBe(false);
    const bad = await http()
      .post('/api/v1/identity/auth/otp/verify')
      .send({ otpToken: res.body.otpToken, code: '123456' })
      .expect(401);
    expect(bad.body.error.code).toBe('INVALID_CODE');
  });

  it('refuses wrong codes, kills a code after five tries and rate-limits requests', async () => {
    await ageCodes();
    const mark = published();
    const req = await http()
      .post('/api/v1/identity/auth/otp/request')
      .send({ tenantSlug: 'alpha', phone: '+919876543210' })
      .expect(200);
    const code = await whatsappCode('+919876543210', mark);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      await http()
        .post('/api/v1/identity/auth/otp/verify')
        .send({ otpToken: req.body.otpToken, code: wrong })
        .expect(401);
    }
    // The fifth failure also locks the account, as with passwords; unlock to show the code is dead.
    await conn()
      .collection('users')
      .updateMany({}, { $set: { failedLogins: 0 }, $unset: { lockedUntil: '' } });
    await http()
      .post('/api/v1/identity/auth/otp/verify')
      .send({ otpToken: req.body.otpToken, code })
      .expect(401);

    const again = await http()
      .post('/api/v1/identity/auth/otp/request')
      .send({ tenantSlug: 'alpha', phone: '+919876543210' })
      .expect(429);
    expect(again.body.error.code).toBe('OTP_TOO_SOON');

    // Five wrong tries also count towards the account lockout; clear it for the next tests.
    await conn()
      .collection('users')
      .updateMany({}, { $set: { failedLogins: 0 }, $unset: { lockedUntil: '' } });
  });

  it('refuses sign-in methods the company has turned off, on the server', async () => {
    tenants.alpha!.loginPolicy = policy({
      methods: { password: true, otp: false, google: false, microsoft: false },
    });
    const otp = await http()
      .post('/api/v1/identity/auth/otp/request')
      .send({ tenantSlug: 'alpha', phone: '+919876543210' })
      .expect(403);
    expect(otp.body.error.code).toBe('METHOD_DISABLED');
    const google = await http().get('/api/v1/identity/sso/google/start?company=alpha').expect(302);
    expect(google.headers.location).toBe(
      `${APP_URL}/sso/complete#error=method_disabled&provider=google`,
    );

    tenants.alpha!.loginPolicy = policy({
      methods: { password: false, otp: true, google: true, microsoft: true },
    });
    expect((await login('alpha', 'admin@alpha.test').expect(403)).body.error.code).toBe(
      'METHOD_DISABLED',
    );
  });

  // ---- WhatsApp / email as the second factor ----

  it('uses WhatsApp codes for two-step verification, with email as the fallback', async () => {
    await createUser('alpha', 'meena@alpha.test');
    const auth = await bearer('alpha', 'meena@alpha.test');
    await verifyPhone(auth, '+919800000001');

    await ageCodes();
    let mark = published();
    await http()
      .post('/api/v1/identity/me/mfa/otp/setup')
      .set('authorization', auth)
      .send({ method: 'whatsapp' })
      .expect(200);
    let code = await whatsappCode('+919800000001', mark);
    await http()
      .post('/api/v1/identity/me/mfa/otp/enable')
      .set('authorization', auth)
      .send({ code })
      .expect(200);

    await ageCodes();
    mark = published();
    const step1 = await login('alpha', 'meena@alpha.test').expect(200);
    expect(step1.body).toMatchObject({
      mfaRequired: true,
      mfaMethod: 'whatsapp',
      channel: 'whatsapp',
      codeSent: true,
    });
    code = await whatsappCode('+919800000001', mark);
    const ok = await http()
      .post('/api/v1/identity/auth/login/mfa')
      .send({ mfaToken: step1.body.mfaToken, code })
      .expect(200);
    expect(ok.body.user.mfaMethod).toBe('whatsapp');

    // WhatsApp did not arrive: send it by email instead.
    await ageCodes();
    const again = await login('alpha', 'meena@alpha.test').expect(200);
    await ageCodes();
    mark = published();
    await http()
      .post('/api/v1/identity/auth/login/mfa/resend')
      .send({ mfaToken: again.body.mfaToken, channel: 'email' })
      .expect(200);
    code = await emailCode('meena@alpha.test', mark);
    await http()
      .post('/api/v1/identity/auth/login/mfa')
      .send({ mfaToken: again.body.mfaToken, code })
      .expect(200);

    // A WhatsApp code cannot be both factors.
    await ageCodes();
    mark = published();
    const req = await http()
      .post('/api/v1/identity/auth/otp/request')
      .send({ tenantSlug: 'alpha', phone: '+919800000001' })
      .expect(200);
    code = await whatsappCode('+919800000001', mark);
    const refused = await http()
      .post('/api/v1/identity/auth/otp/verify')
      .send({ otpToken: req.body.otpToken, code })
      .expect(403);
    expect(refused.body.error.code).toBe('OTP_LOGIN_NOT_ALLOWED');

    // The number cannot be removed while 2FA depends on it; turning 2FA off needs a code.
    await http().delete('/api/v1/identity/me/phone').set('authorization', auth).expect(400);
    await ageCodes();
    mark = published();
    await http().post('/api/v1/identity/me/mfa/code').set('authorization', auth).expect(200);
    code = await whatsappCode('+919800000001', mark);
    await http()
      .post('/api/v1/identity/me/mfa/disable')
      .set('authorization', auth)
      .send({ code })
      .expect(200);
    await http().delete('/api/v1/identity/me/phone').set('authorization', auth).expect(200);
  });

  it('asks for the authenticator app after a WhatsApp sign-in when the app is the 2FA method', async () => {
    await createUser('alpha', 'totp@alpha.test');
    const auth = await bearer('alpha', 'totp@alpha.test');
    await verifyPhone(auth, '+919800000002');
    const setup = await http()
      .post('/api/v1/identity/me/mfa/setup')
      .set('authorization', auth)
      .expect(200);
    await http()
      .post('/api/v1/identity/me/mfa/enable')
      .set('authorization', auth)
      .send({ code: authenticator.generate(setup.body.secret) })
      .expect(200);

    await ageCodes();
    const mark = published();
    const req = await http()
      .post('/api/v1/identity/auth/otp/request')
      .send({ tenantSlug: 'alpha', phone: '+919800000002' })
      .expect(200);
    const step1 = await http()
      .post('/api/v1/identity/auth/otp/verify')
      .send({ otpToken: req.body.otpToken, code: await whatsappCode('+919800000002', mark) })
      .expect(200);
    expect(step1.body).toMatchObject({ mfaRequired: true, mfaMethod: 'totp' });
    await http()
      .post('/api/v1/identity/auth/login/mfa')
      .send({ mfaToken: step1.body.mfaToken, code: authenticator.generate(setup.body.secret) })
      .expect(200);
  });

  it('keeps one mobile number to one user per company', async () => {
    const auth = await bearer('alpha', 'admin@alpha.test');
    await ageCodes();
    const res = await http()
      .post('/api/v1/identity/me/phone')
      .set('authorization', auth)
      .send({ phone: '+919876543210' })
      .expect(409);
    expect(res.body.error.message).toMatch(/another account/);
    // Another company is separate.
    const beta = await bearer('beta', 'admin@beta.test');
    await verifyPhone(beta, '+919876543210');
  });

  // ---- Google and Microsoft ----

  it('links an invited user on Google sign-in and refuses strangers', async () => {
    const auth = await bearer('alpha', 'admin@alpha.test');
    await http()
      .post('/api/v1/identity/users/invite')
      .set('authorization', auth)
      .send({ email: 'priya@acme.in', name: 'Priya' })
      .expect(201);

    const first = await sso('google', 'alpha', {
      sub: 'g-priya',
      email: 'priya@acme.in',
      email_verified: true,
      name: 'Priya',
    });
    expect(first.params.get('ok')).toBe('1');
    const session = await http()
      .post('/api/v1/identity/auth/refresh')
      .set('cookie', first.cookie!)
      .expect(200);
    expect(session.body.user).toMatchObject({
      email: 'priya@acme.in',
      status: 'active',
      hasPassword: false,
    });

    // Next time the link is used even if the email changed at Google.
    const second = await sso('google', 'alpha', {
      sub: 'g-priya',
      email: 'priya.new@gmail.com',
      email_verified: true,
    });
    expect(second.params.get('ok')).toBe('1');

    const stranger = await sso('google', 'alpha', {
      sub: 'g-x',
      email: 'x@acme.in',
      email_verified: true,
    });
    expect(stranger.params.get('error')).toBe('not_invited');
    expect(stranger.cookie).toBeUndefined();

    // An unverified email never matches anyone.
    await http()
      .post('/api/v1/identity/users/invite')
      .set('authorization', auth)
      .send({ email: 'unverified@acme.in', name: 'U' })
      .expect(201);
    const unverified = await sso('google', 'alpha', {
      sub: 'g-u',
      email: 'unverified@acme.in',
      email_verified: false,
    });
    expect(unverified.params.get('error')).toBe('email_not_verified');

    await new Promise((r) => setTimeout(r, 300));
    const types = sharedMemoryBus().published.map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        EventTypes.SsoLinked,
        EventTypes.SsoRefused,
        EventTypes.UserActivated,
      ]),
    );
  });

  it('creates users by domain auto-join only when the admin turned it on', async () => {
    tenants.alpha!.loginPolicy = policy({ ssoDomains: ['acme.in'], autoJoin: { enabled: false } });
    const off = await sso('google', 'alpha', {
      sub: 'g-new1',
      email: 'new1@acme.in',
      email_verified: true,
    });
    expect(off.params.get('error')).toBe('not_invited');

    tenants.alpha!.loginPolicy = policy({
      ssoDomains: ['acme.in'],
      autoJoin: { enabled: true, roleId: ROLE, orgUnitId: OU },
    });
    const before = assignments.length;
    const on = await sso('google', 'alpha', {
      sub: 'g-new1',
      email: 'new1@acme.in',
      email_verified: true,
      name: 'New One',
    });
    expect(on.params.get('ok')).toBe('1');
    expect(assignments.slice(before)).toEqual([
      { userId: expect.any(String), roleId: ROLE, orgUnitId: OU },
    ]);
    const me = await http()
      .post('/api/v1/identity/auth/refresh')
      .set('cookie', on.cookie!)
      .expect(200);
    expect(me.body.user).toMatchObject({ email: 'new1@acme.in', name: 'New One' });

    const other = await sso('google', 'alpha', {
      sub: 'g-new2',
      email: 'new2@gmail.com',
      email_verified: true,
    });
    expect(other.params.get('error')).toBe('domain_not_allowed');
  });

  it('follows the company rule for personal Microsoft accounts', async () => {
    const auth = await bearer('alpha', 'admin@alpha.test');
    await http()
      .post('/api/v1/identity/users/invite')
      .set('authorization', auth)
      .send({ email: 'sam@outlook.com', name: 'Sam' })
      .expect(201);
    const personal = {
      sub: 'ms-sam',
      email: 'sam@outlook.com',
      tid: MS_PERSONAL_TENANT,
      name: 'Sam',
    };

    tenants.alpha!.loginPolicy = policy({ allowPersonalMicrosoft: false });
    expect((await sso('microsoft', 'alpha', personal)).params.get('error')).toBe(
      'personal_account_not_allowed',
    );

    tenants.alpha!.loginPolicy = policy({ allowPersonalMicrosoft: true });
    expect((await sso('microsoft', 'alpha', personal)).params.get('ok')).toBe('1');

    // A work account's email is only trusted with xms_edov.
    await http()
      .post('/api/v1/identity/users/invite')
      .set('authorization', auth)
      .send({ email: 'lee@contoso.com', name: 'Lee' })
      .expect(201);
    const work = {
      sub: 'ms-lee',
      email: 'lee@contoso.com',
      tid: 'aaaaaaaa-0000-0000-0000-000000000001',
    };
    expect((await sso('microsoft', 'alpha', work)).params.get('error')).toBe('email_not_verified');
    expect((await sso('microsoft', 'alpha', { ...work, xms_edov: true })).params.get('ok')).toBe(
      '1',
    );
  });

  it('gives the same Google account separate sessions in two companies', async () => {
    const google = { sub: 'g-shared', email: 'shared@acme.in', email_verified: true };
    for (const slug of ['alpha', 'beta']) {
      await http()
        .post('/api/v1/identity/users/invite')
        .set('authorization', await bearer(slug, `admin@${slug}.test`))
        .send({ email: 'shared@acme.in', name: 'Shared' })
        .expect(201);
    }
    const a = await sso('google', 'alpha', google);
    const b = await sso('google', 'beta', google);
    const sa = await http()
      .post('/api/v1/identity/auth/refresh')
      .set('cookie', a.cookie!)
      .expect(200);
    const sb = await http()
      .post('/api/v1/identity/auth/refresh')
      .set('cookie', b.cookie!)
      .expect(200);
    const ca = verifyAccessToken(sa.body.accessToken, testKeys().publicKey);
    const cb = verifyAccessToken(sb.body.accessToken, testKeys().publicKey);
    expect([ca.tid, cb.tid]).toEqual([TA, TB]);
    expect(ca.sub).not.toBe(cb.sub);
  });

  it('rejects tampered or replayed provider responses', async () => {
    const identity = { sub: 'g-priya', email: 'priya@acme.in', email_verified: true };
    oidc.tamperNext({ nonce: 'wrong' });
    expect((await sso('google', 'alpha', identity)).params.get('error')).toBe('invalid_token');
    oidc.tamperNext({ aud: 'someone-else' });
    expect((await sso('google', 'alpha', identity)).params.get('error')).toBe('invalid_token');

    // The state can be used once.
    oidc.signInAs('google', identity);
    const start = await http().get('/api/v1/identity/sso/google/start?company=alpha').expect(302);
    const back = new URL(await oidc.authorize(start.headers.location));
    await http()
      .get(back.pathname + back.search)
      .expect(302);
    const replay = await http()
      .get(back.pathname + back.search)
      .expect(302);
    expect(new URLSearchParams(new URL(replay.headers.location).hash.slice(1)).get('error')).toBe(
      'invalid_state',
    );
  });

  it('asks for the second factor after Google sign-in when 2FA is on', async () => {
    const auth = await bearer('alpha', 'admin@alpha.test');
    await http()
      .post('/api/v1/identity/users/invite')
      .set('authorization', auth)
      .send({ email: 'mfa@acme.in', name: 'Mfa' })
      .expect(201);
    const first = await sso('google', 'alpha', {
      sub: 'g-mfa',
      email: 'mfa@acme.in',
      email_verified: true,
    });
    const session = await http()
      .post('/api/v1/identity/auth/refresh')
      .set('cookie', first.cookie!)
      .expect(200);
    const user = `Bearer ${session.body.accessToken}`;
    await ageCodes();
    let mark = published();
    await http()
      .post('/api/v1/identity/me/mfa/otp/setup')
      .set('authorization', user)
      .send({ method: 'email' })
      .expect(200);
    await http()
      .post('/api/v1/identity/me/mfa/otp/enable')
      .set('authorization', user)
      .send({ code: await emailCode('mfa@acme.in', mark) })
      .expect(200);

    await ageCodes();
    mark = published();
    const next = await sso('google', 'alpha', {
      sub: 'g-mfa',
      email: 'mfa@acme.in',
      email_verified: true,
    });
    expect(next.cookie).toBeUndefined();
    expect(next.params.get('mfaMethod')).toBe('email');
    await http()
      .post('/api/v1/identity/auth/login/mfa')
      .send({ mfaToken: next.params.get('mfaToken'), code: await emailCode('mfa@acme.in', mark) })
      .expect(200);
  });

  it('lists, links and unlinks accounts, but never the last way to sign in', async () => {
    const auth = await bearer('alpha', 'admin@alpha.test');
    const link = await http()
      .post('/api/v1/identity/me/sso/microsoft/link')
      .set('authorization', auth)
      .expect(200);
    oidc.signInAs('microsoft', {
      sub: 'ms-admin',
      email: 'admin@contoso.com',
      tid: 'aaaaaaaa-0000-0000-0000-000000000002',
    });
    const back = new URL(await oidc.authorize(link.body.url));
    const done = await http()
      .get(back.pathname + back.search)
      .expect(302);
    expect(done.headers.location).toBe(`${APP_URL}/sso/complete#linked=microsoft`);

    const list = await http()
      .get('/api/v1/identity/me/linked-accounts')
      .set('authorization', auth)
      .expect(200);
    expect(list.body).toEqual([
      expect.objectContaining({ provider: 'microsoft', email: 'admin@contoso.com' }),
    ]);
    await http()
      .delete(`/api/v1/identity/me/linked-accounts/${list.body[0].id}`)
      .set('authorization', auth)
      .expect(200);

    // Priya has no password and no phone: her only Google link stays.
    const priya = await sso('google', 'alpha', {
      sub: 'g-priya',
      email: 'priya@acme.in',
      email_verified: true,
    });
    const s = await http()
      .post('/api/v1/identity/auth/refresh')
      .set('cookie', priya.cookie!)
      .expect(200);
    const pAuth = `Bearer ${s.body.accessToken}`;
    const mine = await http()
      .get('/api/v1/identity/me/linked-accounts')
      .set('authorization', pAuth)
      .expect(200);
    const res = await http()
      .delete(`/api/v1/identity/me/linked-accounts/${mine.body[0].id}`)
      .set('authorization', pAuth)
      .expect(409);
    expect(res.body.error.code).toBe('LAST_SIGN_IN_METHOD');
  });
});
