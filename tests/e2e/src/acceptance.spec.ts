/**
 * Step 1 acceptance test. Runs the real services behind the real gateway and
 * proves that Tenant A and Tenant B cannot reach each other's data through the
 * API, the repository layer or background event processing; that dedicated
 * tenants get their own databases; and that sensitive changes land in a
 * verifiable hash-chained audit log.
 */
import mongoose, { type Connection } from 'mongoose';
import request from 'supertest';
import { NotifyTypes, type EmailRequestedPayload } from '@erp/contracts';
import { sharedMemoryBus, TENANT_DATABASES } from '@erp/service-kit';
import {
  dedicatedDbName,
  runAsTenant,
  TenantContextMissingError,
  type TenantDatabases,
} from '@erp/tenancy';
import { OrgUnitModel } from '../../../apps/org-service/src/org-unit.model';
import { eventually, PLATFORM_ADMIN, startStack, type Stack } from './harness';

const PASSWORD = 'Very-secret-pass-1';
const SAME_EMAIL = 'owner@example.test';

interface Session {
  auth: string;
  cookie: string;
  userId: string;
  tenantId: string;
  body: Record<string, unknown>;
}

describe('Step 1 acceptance', () => {
  let stack: Stack;
  let A: Session;
  let B: Session;
  const ids = { a: {} as Record<string, string>, b: {} as Record<string, string> };
  const api = () => request(stack.gatewayUrl);

  async function signup(
    slug: string,
    company: string,
    countryCode: string,
    industryCode: string,
    timezone: string,
    lang = 'en',
  ) {
    const res = await api()
      .post('/api/v1/tenants/signup')
      .send({
        companyName: company,
        slug,
        countryCode,
        industryCode,
        defaultLanguage: lang,
        timezone,
        admin: { name: `${company} Owner`, email: SAME_EMAIL, password: PASSWORD },
      });
    expect(res.status).toBe(201);
    return res.body as { tenantId: string };
  }

  async function login(tenantSlug: string, email: string, password = PASSWORD): Promise<Session> {
    const res = await api()
      .post('/api/v1/identity/auth/login')
      .send({ tenantSlug, email, password });
    expect(res.status).toBe(200);
    const cookie = ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith('erp_rt='))!
      .split(';')[0];
    return {
      auth: `Bearer ${res.body.accessToken}`,
      cookie,
      userId: res.body.user.id,
      tenantId: res.body.user.tenantId,
      body: res.body,
    };
  }

  async function emailTo(to: string): Promise<EmailRequestedPayload> {
    return eventually(async () => {
      const e = [...sharedMemoryBus().published]
        .reverse()
        .find(
          (x) =>
            x.type === NotifyTypes.EmailRequested && (x.payload as EmailRequestedPayload).to === to,
        );
      return e?.payload as EmailRequestedPayload | undefined;
    });
  }

  beforeAll(async () => {
    stack = await startStack();
    ids.a.tenant = (
      await signup('acme', 'Acme Schools', 'IN', 'education', 'Asia/Kolkata')
    ).tenantId;
    ids.b.tenant = (
      await signup('globex', 'Globex Trading', 'AE', 'retail', 'Asia/Dubai', 'ar')
    ).tenantId;
    A = await login('acme', SAME_EMAIL);
    B = await login('globex', SAME_EMAIL);
  });

  afterAll(async () => {
    await stack?.stop();
  });

  // ---------------------------------------------------------------- sign-up

  it('signs up two tenants with country-driven defaults', async () => {
    const a = await api().get('/api/v1/tenants/current').set('authorization', A.auth).expect(200);
    const b = await api().get('/api/v1/tenants/current').set('authorization', B.auth).expect(200);
    expect(a.body).toMatchObject({
      slug: 'acme',
      countryCode: 'IN',
      currency: 'INR',
      locale: 'en-IN',
      industryCode: 'education',
      status: 'active',
    });
    expect(b.body).toMatchObject({
      slug: 'globex',
      countryCode: 'AE',
      currency: 'AED',
      industryCode: 'retail',
      defaultLanguage: 'ar',
    });
    // Same email, two companies, two separate accounts.
    expect(A.tenantId).toBe(ids.a.tenant);
    expect(B.tenantId).toBe(ids.b.tenant);
    expect(A.userId).not.toBe(B.userId);
  });

  it('serves ~190+ countries from reference data', async () => {
    const res = await api().get('/api/v1/reference/countries?lang=ar').expect(200);
    expect(res.body.length).toBeGreaterThanOrEqual(190);
    expect(res.body.find((c: { code: string }) => c.code === 'IN').name).toBe('الهند');
  });

  // ---------------------------------------------------------------- org, roles, users

  it('lets the tenant admin build an org hierarchy of any depth', async () => {
    const units = await api().get('/api/v1/org/units').set('authorization', A.auth).expect(200);
    expect(units.body).toHaveLength(1);
    ids.a.root = units.body[0].id;
    let parent = ids.a.root;
    for (const [key, type] of [
      ['region', 'Region'],
      ['branch', 'Branch'],
      ['dept', 'Department'],
    ] as const) {
      const res = await api()
        .post('/api/v1/org/units')
        .set('authorization', A.auth)
        .send({ parentId: parent, name: `A ${type}`, type })
        .expect(201);
      ids.a[key] = res.body.id;
      parent = res.body.id;
    }
    ids.a.otherRegion = (
      await api()
        .post('/api/v1/org/units')
        .set('authorization', A.auth)
        .send({ parentId: ids.a.root, name: 'A Other Region', type: 'Region' })
        .expect(201)
    ).body.id;
    const b = await api().get('/api/v1/org/units').set('authorization', B.auth).expect(200);
    ids.b.root = b.body[0].id;
    ids.b.branch = (
      await api()
        .post('/api/v1/org/units')
        .set('authorization', B.auth)
        .send({ parentId: ids.b.root, name: 'B Store', type: 'Store' })
        .expect(201)
    ).body.id;
  });

  it('creates a role, invites a user and scopes them to one branch', async () => {
    const role = await api()
      .post('/api/v1/access/roles')
      .set('authorization', A.auth)
      .send({
        name: 'Branch Manager',
        permissions: ['org.unit.read', 'org.unit.create', 'identity.user.read'],
      })
      .expect(201);
    ids.a.role = role.body.id;

    const invite = await api()
      .post('/api/v1/identity/users/invite')
      .set('authorization', A.auth)
      .send({ name: 'Meera', email: 'meera@acme.test' })
      .expect(201);
    ids.a.manager = invite.body.id;
    const mail = await emailTo('meera@acme.test');
    const token = decodeURIComponent(new URL(mail.vars.link).searchParams.get('token')!);
    await api()
      .post('/api/v1/identity/auth/invite/accept')
      .send({ token, password: PASSWORD })
      .expect(200);

    await api()
      .post('/api/v1/access/assignments')
      .set('authorization', A.auth)
      .send({ userId: ids.a.manager, roleId: ids.a.role, orgUnitId: ids.a.branch })
      .expect(201);

    const meera = await login('acme', 'meera@acme.test');
    const visible = await api()
      .get('/api/v1/org/units')
      .set('authorization', meera.auth)
      .expect(200);
    expect(visible.body.map((u: { id: string }) => u.id).sort()).toEqual(
      [ids.a.branch, ids.a.dept].sort(),
    );
    await api()
      .post('/api/v1/org/units')
      .set('authorization', meera.auth)
      .send({ parentId: ids.a.branch, name: 'A Team', type: 'Team' })
      .expect(201);
    await api()
      .post('/api/v1/org/units')
      .set('authorization', meera.auth)
      .send({ parentId: ids.a.otherRegion, name: 'Nope', type: 'Team' })
      .expect(403);
    // Meera cannot manage roles at all.
    await api()
      .post('/api/v1/access/roles')
      .set('authorization', meera.auth)
      .send({ name: 'x', permissions: [] })
      .expect(403);
  });

  // ---------------------------------------------------------------- isolation

  describe('tenant isolation', () => {
    it('lists only the caller’s own data in every service', async () => {
      const [units, roles, users] = await Promise.all([
        api().get('/api/v1/org/units').set('authorization', B.auth).expect(200),
        api().get('/api/v1/access/roles').set('authorization', B.auth).expect(200),
        api().get('/api/v1/identity/users').set('authorization', B.auth).expect(200),
      ]);
      const aIds = Object.values(ids.a);
      const seen = JSON.stringify([units.body, roles.body, users.body]);
      for (const id of aIds) expect(seen).not.toContain(id);
      expect(roles.body.map((r: { name: string }) => r.name)).not.toContain('Branch Manager');
      expect(users.body.items.map((u: { email: string }) => u.email)).not.toContain(
        'meera@acme.test',
      );
    });

    it('returns 404 for another tenant’s ids, for reads and writes', async () => {
      const b = (r: request.Test) => r.set('authorization', B.auth);
      await b(api().get(`/api/v1/org/units/${ids.a.branch}`)).expect(404);
      await b(api().patch(`/api/v1/org/units/${ids.a.branch}`))
        .send({ name: 'Hacked' })
        .expect(404);
      await b(api().post(`/api/v1/org/units/${ids.a.branch}/deactivate`)).expect(404);
      await b(api().post('/api/v1/org/units'))
        .send({ parentId: ids.a.root, name: 'Implant', type: 'X' })
        .expect(404);
      await b(api().patch(`/api/v1/access/roles/${ids.a.role}`))
        .send({ name: 'Hacked' })
        .expect(404);
      await b(api().delete(`/api/v1/access/roles/${ids.a.role}`)).expect(404);
      await b(api().post('/api/v1/access/assignments'))
        .send({ userId: B.userId, roleId: ids.a.role, orgUnitId: ids.b.root })
        .expect(404);
      await b(api().post('/api/v1/access/assignments'))
        .send({ userId: ids.a.manager, roleId: ids.a.role, orgUnitId: ids.a.root })
        .expect(404);
      await b(api().get(`/api/v1/identity/users/${ids.a.manager}`)).expect(404);
      await b(api().post(`/api/v1/identity/users/${ids.a.manager}/deactivate`)).expect(404);

      const unit = await api()
        .get(`/api/v1/org/units/${ids.a.branch}`)
        .set('authorization', A.auth)
        .expect(200);
      expect(unit.body.name).toBe('A Branch');
    });

    it('ignores tenant ids smuggled in headers, query or body', async () => {
      const res = await api()
        .post('/api/v1/org/units')
        .set('authorization', B.auth)
        .set('x-tenant-id', ids.a.tenant)
        .query({ tenantId: ids.a.tenant })
        .send({ parentId: ids.b.root, name: 'Smuggled', type: 'X', tenantId: ids.a.tenant })
        .expect(201);
      const aUnits = await api().get('/api/v1/org/units').set('authorization', A.auth).expect(200);
      expect(aUnits.body.map((u: { id: string }) => u.id)).not.toContain(res.body.id);
      const bUnits = await api().get('/api/v1/org/units').set('authorization', B.auth).expect(200);
      expect(bUnits.body.map((u: { id: string }) => u.id)).toContain(res.body.id);
    });

    it('rejects a token whose tenant was edited', async () => {
      const [h, p, s] = B.auth.slice(7).split('.');
      const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
      const forged = `${h}.${Buffer.from(JSON.stringify({ ...claims, tid: ids.a.tenant })).toString('base64url')}.${s}`;
      await api().get('/api/v1/org/units').set('authorization', `Bearer ${forged}`).expect(401);
    });

    it('does not expose internal service APIs through the gateway', async () => {
      await api().get(`/internal/tenants/${ids.a.tenant}`).expect(404);
      await api()
        .get(`/api/v1/internal/access/users/${A.userId}/acl`)
        .set('authorization', B.auth)
        .expect(404);
    });

    it('keeps company settings separate', async () => {
      await api()
        .patch('/api/v1/tenants/current/settings')
        .set('authorization', B.auth)
        .send({ name: 'Globex Renamed' })
        .expect(200);
      const a = await api().get('/api/v1/tenants/current').set('authorization', A.auth).expect(200);
      expect(a.body.name).toBe('Acme Schools');
    });

    it('isolates at the repository layer, and fails closed without a tenant', async () => {
      const dbs = stack.apps.org.get<TenantDatabases>(TENANT_DATABASES);
      const actor = { type: 'system' as const, id: 'e2e' };
      const bUnits = await runAsTenant(ids.b.tenant, actor, async () =>
        (await dbs.model(OrgUnitModel)).find().lean(),
      );
      expect(bUnits.length).toBeGreaterThan(0);
      expect(bUnits.every((u) => u.tenantId === ids.b.tenant)).toBe(true);
      const leaked = await runAsTenant(ids.b.tenant, actor, async () =>
        (await dbs.model(OrgUnitModel)).findById(ids.a.branch).lean(),
      );
      expect(leaked).toBeNull();
      const Units = await dbs.modelFor(ids.b.tenant, OrgUnitModel);
      await expect(Units.find().exec()).rejects.toBeInstanceOf(TenantContextMissingError);
    });

    it('isolates background event processing: each audit trail holds only its tenant’s events', async () => {
      const auditOf = async (s: Session) =>
        (
          await api()
            .get('/api/v1/audit/events?pageSize=200')
            .set('authorization', s.auth)
            .expect(200)
        ).body;
      const a = await eventually(async () => {
        const page = await auditOf(A);
        return (
          page.items.some(
            (e: { type: string; payload?: { userId?: string } }) =>
              e.type === 'access.assignment.created' && e.payload?.userId === ids.a.manager,
          ) && page
        );
      });
      const b = await auditOf(B);
      expect(JSON.stringify(b.items)).not.toContain(ids.a.manager);
      expect(JSON.stringify(b.items)).not.toContain(ids.a.branch);
      expect(JSON.stringify(a.items)).not.toContain(ids.b.branch);
    });

    it('stores a dedicated tenant in its own databases', async () => {
      const root = await login('platform', PLATFORM_ADMIN.email, PLATFORM_ADMIN.password);
      const res = await api()
        .post('/api/v1/platform/tenants')
        .set('authorization', root.auth)
        .send({
          companyName: 'Initech Hospital',
          slug: 'initech',
          countryCode: 'US',
          industryCode: 'healthcare',
          defaultLanguage: 'en',
          timezone: 'America/New_York',
          placement: 'dedicated',
          admin: { name: 'Bill', email: 'bill@initech.test', password: PASSWORD },
        })
        .expect(201);
      const cId = res.body.tenantId as string;
      const C = await login('initech', 'bill@initech.test');
      await api().get('/api/v1/org/units').set('authorization', C.auth).expect(200);

      const conn: Connection = await mongoose.createConnection(stack.mongo.uri).asPromise();
      try {
        const count = async (db: string, coll: string, filter: object) =>
          conn.useDb(db).collection(coll).countDocuments(filter);
        expect(await count(dedicatedDbName('erp_org', cId), 'org_units', { tenantId: cId })).toBe(
          1,
        );
        expect(await count('erp_org', 'org_units', { tenantId: cId })).toBe(0);
        expect(await count(dedicatedDbName('erp_identity', cId), 'users', { tenantId: cId })).toBe(
          1,
        );
        expect(await count('erp_identity', 'users', { tenantId: cId })).toBe(0);
        // Each service keeps its data in its own database.
        expect(await count('erp_identity', 'org_units', {})).toBe(0);
        expect(await count('erp_org', 'users', {})).toBe(0);
      } finally {
        await conn.close();
      }
    });
  });

  // ---------------------------------------------------------------- audit

  it('records sensitive changes in a verifiable hash chain, and detects tampering', async () => {
    await api()
      .patch('/api/v1/tenants/current/settings')
      .set('authorization', A.auth)
      .send({ requireMfa: true })
      .expect(200);
    const required = [
      'tenant.created',
      'tenant.activated',
      'tenant.settings.updated',
      'org.unit.created',
      'access.role.created',
      'access.assignment.created',
      'identity.user.created',
      'identity.user.invited',
      'identity.user.activated',
      'identity.login.succeeded',
    ];
    const types = await eventually(async () => {
      const page = (
        await api()
          .get('/api/v1/audit/events?pageSize=200')
          .set('authorization', A.auth)
          .expect(200)
      ).body;
      const t = new Set(page.items.map((e: { type: string }) => e.type));
      return required.every((r) => t.has(r)) && t;
    });
    expect([...types]).toEqual(expect.arrayContaining(required));

    const va = await api().get('/api/v1/audit/verify').set('authorization', A.auth).expect(200);
    expect(va.body.valid).toBe(true);
    expect(va.body.records).toBeGreaterThanOrEqual(required.length);

    const conn: Connection = await mongoose
      .createConnection(stack.mongo.uri, { dbName: 'erp_audit' })
      .asPromise();
    try {
      await conn
        .collection('audit_records')
        .updateOne(
          { tenantId: ids.a.tenant, type: 'access.role.created' },
          { $set: { 'payload.name': 'Forged' } },
        );
    } finally {
      await conn.close();
    }
    const tampered = await api()
      .get('/api/v1/audit/verify')
      .set('authorization', A.auth)
      .expect(200);
    expect(tampered.body.valid).toBe(false);
    const vb = await api().get('/api/v1/audit/verify').set('authorization', B.auth).expect(200);
    expect(vb.body.valid).toBe(true);
  });

  it('asks users to set up 2FA once the company requires it', async () => {
    const again = await login('acme', SAME_EMAIL);
    expect(again.body.mfaSetupRequired).toBe(true);
  });

  // ---------------------------------------------------------------- platform

  it('lets the platform admin see all tenants and suspend one', async () => {
    const root = await login('platform', PLATFORM_ADMIN.email, PLATFORM_ADMIN.password);
    const list = await api()
      .get('/api/v1/platform/tenants')
      .set('authorization', root.auth)
      .expect(200);
    expect(list.body.items.map((t: { slug: string }) => t.slug)).toEqual(
      expect.arrayContaining(['acme', 'globex']),
    );
    // Tenant admins cannot use platform APIs.
    await api().get('/api/v1/platform/tenants').set('authorization', A.auth).expect(403);

    await api()
      .patch(`/api/v1/platform/tenants/${ids.b.tenant}/status`)
      .set('authorization', root.auth)
      .send({ status: 'suspended' })
      .expect(200);
    const blocked = await api()
      .post('/api/v1/identity/auth/login')
      .send({ tenantSlug: 'globex', email: SAME_EMAIL, password: PASSWORD })
      .expect(403);
    expect(blocked.body.error.code).toBe('TENANT_SUSPENDED');
    await api().post('/api/v1/identity/auth/refresh').set('cookie', B.cookie).expect(403);

    await api()
      .patch(`/api/v1/platform/tenants/${ids.b.tenant}/status`)
      .set('authorization', root.auth)
      .send({ status: 'active' })
      .expect(200);
    await login('globex', SAME_EMAIL);
  });
});
