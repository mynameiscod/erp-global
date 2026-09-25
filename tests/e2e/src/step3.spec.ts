/**
 * Step 3 acceptance test: more ways to sign in, end to end through the gateway.
 * WhatsApp/email codes (password-less and as 2FA), mobile verification, and
 * Google/Microsoft sign-in against a fake OpenID Connect provider, with the
 * company's sign-in policy enforced by the server.
 */
import request from 'supertest';
import {
  NotifyTypes,
  type EmailRequestedPayload,
  type LoginPolicy,
  type WhatsappRequestedPayload,
} from '@erp/contracts';
import { sharedMemoryBus } from '@erp/service-kit';
import { startFakeOidc, type FakeIdentity, type FakeOidc } from '@erp/testing';
import { eventually, startStack, type Stack } from './harness';

const PASSWORD = 'Very-secret-pass-1';
const APP_URL = 'https://app.e2e.test';

describe('Step 3 acceptance: sign-in methods', () => {
  let stack: Stack;
  let oidc: FakeOidc;
  const api = () => request(stack.gatewayUrl);
  let A = '';
  let B = '';

  async function signupAndLogin(slug: string, email: string) {
    await api()
      .post('/api/v1/tenants/signup')
      .send({
        companyName: `${slug} Ltd`,
        slug,
        countryCode: 'IN',
        industryCode: 'services',
        defaultLanguage: 'en',
        timezone: 'Asia/Kolkata',
        admin: { name: 'Owner', email, password: PASSWORD },
      })
      .expect(201);
    return login(slug, email);
  }
  async function login(tenantSlug: string, email: string) {
    const res = await api()
      .post('/api/v1/identity/auth/login')
      .send({ tenantSlug, email, password: PASSWORD })
      .expect(200);
    return `Bearer ${res.body.accessToken}`;
  }
  const setPolicy = (auth: string, policy: LoginPolicy) =>
    api().put('/api/v1/tenants/current/login-policy').set('authorization', auth).send(policy);
  const ALL_ON: LoginPolicy = {
    methods: { password: true, otp: true, google: true, microsoft: true },
    ssoDomains: [],
    allowPersonalMicrosoft: true,
    autoJoin: { enabled: false },
  };

  /** The code in the newest WhatsApp (or email) request to `to`, published after `mark`. */
  async function codeFor(type: string, to: string, mark: number): Promise<string> {
    return eventually(async () => {
      const e = sharedMemoryBus()
        .published.slice(mark)
        .reverse()
        .find((x) => {
          const p = x.payload as { to?: string; template?: string };
          return (
            x.type === type &&
            p.to === to &&
            (type !== NotifyTypes.EmailRequested || p.template === 'otp.code')
          );
        });
      if (!e) return undefined;
      return type === NotifyTypes.WhatsappRequested
        ? (e.payload as WhatsappRequestedPayload).code
        : String((e.payload as EmailRequestedPayload).vars.code);
    });
  }
  const mark = () => sharedMemoryBus().published.length;
  const cookieOf = (res: request.Response) =>
    ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith('erp_rt='))
      ?.split(';')[0];

  async function sso(provider: 'google' | 'microsoft', company: string, identity: FakeIdentity) {
    oidc.signInAs(provider, identity);
    const start = await api()
      .get(`/api/v1/identity/sso/${provider}/start?company=${company}`)
      .expect(302);
    const back = new URL(await oidc.authorize(start.headers.location));
    const res = await api()
      .get(back.pathname + back.search)
      .expect(302);
    const location = new URL(res.headers.location);
    expect(location.origin + location.pathname).toBe(`${APP_URL}/sso/complete`);
    return { params: new URLSearchParams(location.hash.slice(1)), cookie: cookieOf(res) };
  }
  const session = async (cookie: string) =>
    (await api().post('/api/v1/identity/auth/refresh').set('cookie', cookie).expect(200)).body;

  beforeAll(async () => {
    oidc = await startFakeOidc();
    stack = await startStack({
      env: {
        GOOGLE_CLIENT_ID: oidc.clientId,
        GOOGLE_CLIENT_SECRET: oidc.clientSecret,
        GOOGLE_ISSUER: `${oidc.url}/google`,
        MICROSOFT_CLIENT_ID: oidc.clientId,
        MICROSOFT_CLIENT_SECRET: oidc.clientSecret,
        MICROSOFT_ISSUER: `${oidc.url}/microsoft`,
      },
    });
    A = await signupAndLogin('sunrise', 'owner@sunrise.test');
    B = await signupAndLogin('moonlight', 'owner@moonlight.test');
  });

  afterAll(async () => {
    await stack?.stop();
    await oidc?.stop();
  });

  it('starts with password only, and the login page shows what the admin turns on', async () => {
    const before = await api().get('/api/v1/tenants/lookup/sunrise').expect(200);
    expect(before.body.loginMethods).toEqual({
      password: true,
      otp: false,
      google: false,
      microsoft: false,
    });
    const refused = await api()
      .post('/api/v1/identity/auth/otp/request')
      .send({ tenantSlug: 'sunrise', phone: '+919876500001' })
      .expect(403);
    expect(refused.body.error.code).toBe('METHOD_DISABLED');

    await setPolicy(A, ALL_ON).expect(200);
    await setPolicy(B, ALL_ON).expect(200);
    const after = await api().get('/api/v1/tenants/lookup/sunrise').expect(200);
    expect(after.body.loginMethods).toEqual(ALL_ON.methods);
  });

  it('verifies a mobile number and signs in with a WhatsApp code or the email fallback', async () => {
    let m = mark();
    await api()
      .post('/api/v1/identity/me/phone')
      .set('authorization', A)
      .send({ phone: '+91 98765 00001' })
      .expect(200);
    const verifyCode = await codeFor(NotifyTypes.WhatsappRequested, '+919876500001', m);
    await api()
      .post('/api/v1/identity/me/phone/verify')
      .set('authorization', A)
      .send({ code: verifyCode })
      .expect(200);

    m = mark();
    const req = await api()
      .post('/api/v1/identity/auth/otp/request')
      .send({ tenantSlug: 'sunrise', phone: '+919876500001' })
      .expect(200);
    const code = await codeFor(NotifyTypes.WhatsappRequested, '+919876500001', m);
    // One code a minute while the last one is unused.
    const soon = await api()
      .post('/api/v1/identity/auth/otp/request')
      .send({ tenantSlug: 'sunrise', phone: '+919876500001', channel: 'email' })
      .expect(429);
    expect(soon.body.error.code).toBe('OTP_TOO_SOON');
    await api()
      .post('/api/v1/identity/auth/otp/verify')
      .send({ otpToken: req.body.otpToken, code: code === '000000' ? '111111' : '000000' })
      .expect(401);
    const ok = await api()
      .post('/api/v1/identity/auth/otp/verify')
      .send({ otpToken: req.body.otpToken, code })
      .expect(200);
    expect(ok.body.user.email).toBe('owner@sunrise.test');
    expect(cookieOf(ok)).toBeDefined();

    // The used code no longer holds up a new one: the email fallback goes out at once.
    m = mark();
    const byEmail = await api()
      .post('/api/v1/identity/auth/otp/request')
      .send({ tenantSlug: 'sunrise', phone: '+919876500001', channel: 'email' })
      .expect(200);
    const emailed = await codeFor(NotifyTypes.EmailRequested, 'owner@sunrise.test', m);
    await api()
      .post('/api/v1/identity/auth/otp/verify')
      .send({ otpToken: byEmail.body.otpToken, code: emailed })
      .expect(200);

    // An unknown number gets the same answer and never a message.
    m = mark();
    const unknown = await api()
      .post('/api/v1/identity/auth/otp/request')
      .send({ tenantSlug: 'sunrise', phone: '+919876599999' })
      .expect(200);
    expect(Object.keys(unknown.body).sort()).toEqual(Object.keys(req.body).sort());
    await api()
      .post('/api/v1/identity/auth/otp/verify')
      .send({ otpToken: unknown.body.otpToken, code: '123456' })
      .expect(401);
    expect(
      sharedMemoryBus()
        .published.slice(m)
        .some((e) => e.type === NotifyTypes.WhatsappRequested),
    ).toBe(false);
  });

  it('uses email codes as the second factor', async () => {
    let m = mark();
    await api()
      .post('/api/v1/identity/me/mfa/otp/setup')
      .set('authorization', B)
      .send({ method: 'email' })
      .expect(200);
    let code = await codeFor(NotifyTypes.EmailRequested, 'owner@moonlight.test', m);
    await api()
      .post('/api/v1/identity/me/mfa/otp/enable')
      .set('authorization', B)
      .send({ code })
      .expect(200);

    m = mark();
    const step1 = await api()
      .post('/api/v1/identity/auth/login')
      .send({ tenantSlug: 'moonlight', email: 'owner@moonlight.test', password: PASSWORD })
      .expect(200);
    expect(step1.body).toMatchObject({ mfaRequired: true, mfaMethod: 'email', channel: 'email' });
    code = await codeFor(NotifyTypes.EmailRequested, 'owner@moonlight.test', m);
    const step2 = await api()
      .post('/api/v1/identity/auth/login/mfa')
      .send({ mfaToken: step1.body.mfaToken, code })
      .expect(200);
    B = `Bearer ${step2.body.accessToken}`;
  });

  it('links an invited user with Google, refuses strangers, and auto-joins only when enabled', async () => {
    await api()
      .post('/api/v1/identity/users/invite')
      .set('authorization', A)
      .send({ email: 'asha@sunrise.in', name: 'Asha' })
      .expect(201);
    const asha = await sso('google', 'sunrise', {
      sub: 'g-asha',
      email: 'asha@sunrise.in',
      email_verified: true,
    });
    expect(asha.params.get('ok')).toBe('1');
    expect((await session(asha.cookie!)).user).toMatchObject({
      email: 'asha@sunrise.in',
      status: 'active',
    });

    const stranger = await sso('google', 'sunrise', {
      sub: 'g-x',
      email: 'x@sunrise.in',
      email_verified: true,
    });
    expect(stranger.params.get('error')).toBe('not_invited');

    const roles = (await api().get('/api/v1/access/roles').set('authorization', A).expect(200))
      .body;
    const viewer = roles.find((r: { key: string }) => r.key === 'viewer');
    const units = (await api().get('/api/v1/org/units').set('authorization', A).expect(200)).body;
    await setPolicy(A, {
      ...ALL_ON,
      ssoDomains: ['sunrise.in'],
      autoJoin: { enabled: true, roleId: viewer.id, orgUnitId: units[0].id },
    }).expect(200);
    const joined = await sso('google', 'sunrise', {
      sub: 'g-x',
      email: 'x@sunrise.in',
      email_verified: true,
      name: 'Xavier',
    });
    expect(joined.params.get('ok')).toBe('1');
    const x = await session(joined.cookie!);
    const me = await api()
      .get('/api/v1/identity/me')
      .set('authorization', `Bearer ${x.accessToken}`)
      .expect(200);
    expect(me.body.acl).toEqual([expect.objectContaining({ ou: units[0].id })]);
    expect(me.body.acl[0].p).toContain('records.*.read');

    const other = await sso('google', 'sunrise', {
      sub: 'g-y',
      email: 'y@gmail.com',
      email_verified: true,
    });
    expect(other.params.get('error')).toBe('domain_not_allowed');
  });

  it('keeps the same Google account in two companies separate, with 2FA still required', async () => {
    await api()
      .post('/api/v1/identity/users/invite')
      .set('authorization', B)
      .send({ email: 'asha@sunrise.in', name: 'Asha' })
      .expect(201);
    const inB = await sso('google', 'moonlight', {
      sub: 'g-asha',
      email: 'asha@sunrise.in',
      email_verified: true,
    });
    const inA = await sso('google', 'sunrise', {
      sub: 'g-asha',
      email: 'asha@sunrise.in',
      email_verified: true,
    });
    const sa = await session(inA.cookie!);
    const sb = await session(inB.cookie!);
    expect(sa.user.tenantId).not.toBe(sb.user.tenantId);
    expect(sa.user.id).not.toBe(sb.user.id);

    // The owner of moonlight has email 2FA: Google sign-in still asks for it.
    const link = await api()
      .post('/api/v1/identity/me/sso/google/link')
      .set('authorization', B)
      .expect(200);
    oidc.signInAs('google', { sub: 'g-owner', email: 'owner@gmail.com', email_verified: true });
    const back = new URL(await oidc.authorize(link.body.url));
    const linked = await api()
      .get(back.pathname + back.search)
      .expect(302);
    expect(linked.headers.location).toBe(`${APP_URL}/sso/complete#linked=google`);
    const m = mark();
    const owner = await sso('google', 'moonlight', {
      sub: 'g-owner',
      email: 'owner@gmail.com',
      email_verified: true,
    });
    expect(owner.cookie).toBeUndefined();
    expect(owner.params.get('mfaMethod')).toBe('email');
    const code = await codeFor(NotifyTypes.EmailRequested, 'owner@moonlight.test', m);
    await api()
      .post('/api/v1/identity/auth/login/mfa')
      .send({ mfaToken: owner.params.get('mfaToken'), code })
      .expect(200);
  });

  it('refuses personal Microsoft accounts when the company says so, and disabled methods', async () => {
    await api()
      .post('/api/v1/identity/users/invite')
      .set('authorization', A)
      .send({ email: 'sam@outlook.com', name: 'Sam' })
      .expect(201);
    const personal = {
      sub: 'ms-sam',
      email: 'sam@outlook.com',
      tid: '9188040d-6c67-4c5b-b112-36a304b66dad',
    };
    await setPolicy(A, { ...ALL_ON, allowPersonalMicrosoft: false }).expect(200);
    expect((await sso('microsoft', 'sunrise', personal)).params.get('error')).toBe(
      'personal_account_not_allowed',
    );
    await setPolicy(A, ALL_ON).expect(200);
    expect((await sso('microsoft', 'sunrise', personal)).params.get('ok')).toBe('1');

    await setPolicy(A, { ...ALL_ON, methods: { ...ALL_ON.methods, microsoft: false } }).expect(200);
    const off = await api().get('/api/v1/identity/sso/microsoft/start?company=sunrise').expect(302);
    expect(off.headers.location).toBe(
      `${APP_URL}/sso/complete#error=method_disabled&provider=microsoft`,
    );
  });

  it('records every sign-in event in the audit chain', async () => {
    await eventually(async () => {
      const page = (
        await api().get('/api/v1/audit/events?pageSize=200').set('authorization', A).expect(200)
      ).body;
      const t = new Set<string>(page.items.map((e: { type: string }) => e.type));
      return [
        'tenant.login_policy.updated',
        'identity.otp.requested',
        'identity.otp.failed',
        'identity.phone.verified',
        'identity.sso.linked',
        'identity.sso.refused',
        'identity.user.auto_joined',
        'access.assignment.created',
      ].every((n) => t.has(n));
    });
    const verify = await api().get('/api/v1/audit/verify').set('authorization', A).expect(200);
    expect(verify.body.valid).toBe(true);
  });
});
