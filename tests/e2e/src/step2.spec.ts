/**
 * Step 2 acceptance test: the config engine end to end, through the gateway.
 * A company configures a custom entity with every kind of field, a form, a
 * list, number series and picklists, publishes it, uses it, overrides it for
 * one branch, rolls back, and cannot touch another company's data.
 */
import request from 'supertest';
import { NotifyTypes, type EmailRequestedPayload } from '@erp/contracts';
import { fiscalYearLabel } from '@erp/metadata';
import { sharedMemoryBus } from '@erp/service-kit';
import { eventually, startStack, type Stack } from './harness';

const PASSWORD = 'Very-secret-pass-1';
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 7),
]);

describe('Step 2 acceptance: config engine', () => {
  let stack: Stack;
  const api = () => request(stack.gatewayUrl);
  const ids: Record<string, string> = {};
  let A = '';
  let B = '';

  async function signupAndLogin(slug: string, country: string, email: string) {
    await api()
      .post('/api/v1/tenants/signup')
      .send({
        companyName: `${slug} Ltd`,
        slug,
        countryCode: country,
        industryCode: 'education',
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

  const put = (auth: string, kind: string, key: string, body: object, scope?: string) =>
    api()
      .put(`/api/v1/config/draft/${kind}/${key}${scope ? `?scope=${scope}` : ''}`)
      .set('authorization', auth)
      .send(body);

  beforeAll(async () => {
    stack = await startStack();
    A = await signupAndLogin('greenwood', 'IN', 'owner@greenwood.test');
    B = await signupAndLogin('bluebay', 'AE', 'owner@bluebay.test');
    const units = await api().get('/api/v1/org/units').set('authorization', A).expect(200);
    ids.root = units.body[0].id;
    for (const [key, code] of [
      ['hyd', 'HYD'],
      ['blr', 'BLR'],
    ]) {
      const res = await api()
        .post('/api/v1/org/units')
        .set('authorization', A)
        .send({ parentId: ids.root, name: key.toUpperCase(), code, type: 'Campus' })
        .expect(201);
      ids[key] = res.body.id;
    }
  });

  afterAll(async () => {
    await stack?.stop();
  });

  it('configures an entity with every field type, a form, a list, picklists and numbering', async () => {
    await put(A, 'picklists', 'grades', {
      key: 'grades',
      label: { en: 'Grades', hi: 'कक्षाएँ' },
      options: [
        { value: 'g1', label: { en: 'Grade 1', hi: 'कक्षा 1' } },
        { value: 'g2', label: { en: 'Grade 2', hi: 'कक्षा 2' } },
      ],
    }).expect(200);
    await put(A, 'numbering', 'admission', {
      key: 'admission',
      label: { en: 'Admission number' },
      pattern: 'ADM/{FY}/{BRANCH}/{SEQ:4}',
      reset: 'yearly',
      scope: 'org_unit',
    }).expect(200);
    await put(A, 'entities', 'student', {
      key: 'student',
      kind: 'custom',
      label: { en: 'Student', hi: 'छात्र', ar: 'طالب' },
      pluralLabel: { en: 'Students', hi: 'छात्र', ar: 'الطلاب' },
      icon: 'mortarboard',
      titleField: 'full_name',
      fields: [
        {
          key: 'full_name',
          type: 'text',
          label: { en: 'Full name', hi: 'पूरा नाम' },
          required: true,
          searchable: true,
        },
        { key: 'email', type: 'email', label: { en: 'Email' }, unique: true },
        { key: 'phone', type: 'phone', label: { en: 'Phone' } },
        { key: 'dob', type: 'date', label: { en: 'Date of birth' } },
        { key: 'grade', type: 'select', label: { en: 'Grade' }, picklist: 'grades' },
        { key: 'subjects', type: 'multiselect', label: { en: 'Subjects' }, picklist: 'grades' },
        { key: 'fee', type: 'currency', label: { en: 'Annual fee' }, min: 0 },
        { key: 'discount', type: 'percent', label: { en: 'Discount %' }, min: 0, max: 100 },
        {
          key: 'net_fee',
          type: 'formula',
          label: { en: 'Net fee' },
          formula: 'fee - fee * discount / 100',
          resultType: 'number',
        },
        { key: 'mentor', type: 'lookup', label: { en: 'Mentor' }, target: 'user' },
        { key: 'photo', type: 'image', label: { en: 'Photo' }, maxSizeMb: 1 },
        {
          key: 'adm_no',
          type: 'autonumber',
          label: { en: 'Admission no' },
          numbering: 'admission',
        },
      ],
    }).expect(200);
    await put(A, 'forms', 'student', {
      entity: 'student',
      sections: [
        {
          key: 'basic',
          label: { en: 'Basic details' },
          columns: 2,
          fields: ['full_name', 'email', 'phone', 'dob', 'photo'],
        },
        {
          key: 'fees',
          label: { en: 'Fees' },
          columns: 3,
          fields: ['grade', 'subjects', 'fee', 'discount', 'net_fee', 'mentor'],
        },
      ],
    }).expect(200);
    await put(A, 'list-views', 'student', {
      entity: 'student',
      columns: ['number', 'full_name', 'grade', 'fee', 'net_fee'],
      sort: { field: 'createdAt', dir: 'desc' },
    }).expect(200);
    await put(A, 'entities', 'user', {
      key: 'user',
      fields: [
        { key: 'employee_code', type: 'text', label: { en: 'Employee code' }, maxLength: 10 },
      ],
    }).expect(200);
    await put(A, 'entities', 'org_unit', {
      key: 'org_unit',
      fields: [{ key: 'capacity', type: 'integer', label: { en: 'Capacity' }, min: 0 }],
    }).expect(200);
  });

  it('keeps the draft invisible until it is published', async () => {
    await api().get('/api/v1/records/student').set('authorization', A).expect(404);
    const pub = await api()
      .post('/api/v1/config/publish')
      .set('authorization', A)
      .send({ note: 'Students' })
      .expect(201);
    expect(pub.body.version).toBe(1);
    const eff = await api().get('/api/v1/config/effective').set('authorization', A).expect(200);
    expect(eff.body.entities.find((e: { key: string }) => e.key === 'student').label.hi).toBe(
      'छात्र',
    );
    expect(eff.body.settings.fiscalYearStartMonth).toBe(4);
  });

  it('lets users create, list, edit and delete records with numbering, formulas, lookups and files', async () => {
    const me = await api().get('/api/v1/identity/me').set('authorization', A).expect(200);
    const upload = await api()
      .post('/api/v1/files')
      .set('authorization', A)
      .attach('file', PNG, { filename: 'asha.png', contentType: 'image/png' })
      .expect(201);
    ids.photo = upload.body.id;

    const created = await api()
      .post('/api/v1/records/student')
      .set('authorization', A)
      .send({
        orgUnitId: ids.hyd,
        data: {
          full_name: 'Asha Rao',
          email: 'ASHA@example.test',
          phone: '+91 98765 43210',
          dob: '2015-06-01',
          grade: 'g1',
          subjects: ['g1', 'g2'],
          fee: '50000',
          discount: '10',
          mentor: me.body.id,
          photo: ids.photo,
        },
      })
      .expect(201);
    const fy = fiscalYearLabel(new Date(), 4);
    expect(created.body.number).toBe(`ADM/${fy}/HYD/0001`);
    expect(created.body.data).toMatchObject({
      email: 'asha@example.test',
      phone: '+919876543210',
      fee: { amount: '50000.00', currency: 'INR' },
      net_fee: 45000,
    });
    ids.asha = created.body.id;

    const second = await api()
      .post('/api/v1/records/student')
      .set('authorization', A)
      .send({ orgUnitId: ids.blr, data: { full_name: 'Ravi' } })
      .expect(201);
    expect(second.body.number).toBe(`ADM/${fy}/BLR/0001`);
    ids.ravi = second.body.id;

    const dup = await api()
      .post('/api/v1/records/student')
      .set('authorization', A)
      .send({ orgUnitId: ids.blr, data: { full_name: 'Copy', email: 'asha@example.test' } })
      .expect(400);
    expect(dup.body.error.details[0].path).toBe('email');

    const list = await api()
      .get('/api/v1/records/student?q=asha')
      .set('authorization', A)
      .expect(200);
    expect(list.body.items.map((r: { id: string }) => r.id)).toEqual([ids.asha]);

    const edited = await api()
      .patch(`/api/v1/records/student/${ids.asha}`)
      .set('authorization', A)
      .send({ data: { discount: '20' } })
      .expect(200);
    expect(edited.body.data.net_fee).toBe(40000);

    await api().delete(`/api/v1/records/student/${ids.ravi}`).set('authorization', A).expect(200);
    await api().get(`/api/v1/records/student/${ids.ravi}`).set('authorization', A).expect(404);
  });

  it('validates custom fields on users and org units', async () => {
    const bad = await api()
      .post('/api/v1/identity/users/invite')
      .set('authorization', A)
      .send({
        name: 'Meena',
        email: 'meena@greenwood.test',
        custom: { employee_code: 'WAY-TOO-LONG-CODE' },
      })
      .expect(400);
    expect(bad.body.error.details[0].path).toBe('custom.employee_code');
    const ok = await api()
      .post('/api/v1/identity/users/invite')
      .set('authorization', A)
      .send({ name: 'Meena', email: 'meena@greenwood.test', custom: { employee_code: 'T-7' } })
      .expect(201);
    expect(ok.body.custom).toEqual({ employee_code: 'T-7' });
    ids.meena = ok.body.id;
    const unit = await api()
      .patch(`/api/v1/org/units/${ids.hyd}`)
      .set('authorization', A)
      .send({ custom: { capacity: 400 } })
      .expect(200);
    expect(unit.body.custom).toEqual({ capacity: 400 });
  });

  it('applies a branch override only to that branch', async () => {
    await put(
      A,
      'entities',
      'student',
      { key: 'student', fields: [{ key: 'hostel', type: 'boolean', label: { en: 'Hostel' } }] },
      ids.hyd,
    ).expect(200);
    await api()
      .post('/api/v1/config/publish')
      .set('authorization', A)
      .send({ note: 'Hostel at HYD' })
      .expect(201);
    await api()
      .post('/api/v1/records/student')
      .set('authorization', A)
      .send({ orgUnitId: ids.hyd, data: { full_name: 'Hostel kid', hostel: true } })
      .expect(201);
    const blr = await api()
      .post('/api/v1/records/student')
      .set('authorization', A)
      .send({ orgUnitId: ids.blr, data: { full_name: 'Day scholar', hostel: true } })
      .expect(400);
    expect(blr.body.error.details).toEqual([{ path: 'hostel', message: 'Unknown field' }]);
  });

  it('rolls back safely, archiving fields added since', async () => {
    const rb = await api()
      .post('/api/v1/config/versions/1/rollback')
      .set('authorization', A)
      .send({})
      .expect(201);
    expect(rb.body.version).toBe(3);
    const res = await api()
      .post('/api/v1/records/student')
      .set('authorization', A)
      .send({ orgUnitId: ids.hyd, data: { full_name: 'After rollback', hostel: true } })
      .expect(400);
    expect(res.body.error.details).toEqual([{ path: 'hostel', message: 'This field is archived' }]);
    // Data written while the field existed is still there.
    const kid = await api()
      .get('/api/v1/records/student?q=hostel')
      .set('authorization', A)
      .expect(200);
    expect(kid.body.items[0].data.hostel).toBe(true);
  });

  it('generates per-entity permissions and scopes them by branch', async () => {
    const catalog = await api()
      .get('/api/v1/access/permissions')
      .set('authorization', A)
      .expect(200);
    expect(catalog.body.map((p: { key: string }) => p.key)).toEqual(
      expect.arrayContaining(['records.student.read', 'records.student.create']),
    );
    const role = await api()
      .post('/api/v1/access/roles')
      .set('authorization', A)
      .send({ name: 'BLR reader', permissions: ['records.student.read'] })
      .expect(201);

    const mail = await eventually(async () => {
      const e = [...sharedMemoryBus().published]
        .reverse()
        .find(
          (x) =>
            x.type === NotifyTypes.EmailRequested &&
            (x.payload as EmailRequestedPayload).to === 'meena@greenwood.test',
        );
      return e?.payload as EmailRequestedPayload | undefined;
    });
    const token = decodeURIComponent(new URL(mail.vars.link).searchParams.get('token')!);
    await api()
      .post('/api/v1/identity/auth/invite/accept')
      .send({ token, password: PASSWORD })
      .expect(200);
    await api()
      .post('/api/v1/access/assignments')
      .set('authorization', A)
      .send({ userId: ids.meena, roleId: role.body.id, orgUnitId: ids.blr })
      .expect(201);

    const meena = await login('greenwood', 'meena@greenwood.test');
    await api()
      .post('/api/v1/records/student')
      .set('authorization', A)
      .send({ orgUnitId: ids.blr, data: { full_name: 'Blr kid' } })
      .expect(201);
    const seen = await api().get('/api/v1/records/student').set('authorization', meena).expect(200);
    expect(seen.body.items.map((r: { data: { full_name: string } }) => r.data.full_name)).toEqual([
      'Blr kid',
    ]);
    await api().get(`/api/v1/records/student/${ids.asha}`).set('authorization', meena).expect(403);
    await api()
      .post('/api/v1/records/student')
      .set('authorization', meena)
      .send({ orgUnitId: ids.blr, data: { full_name: 'x' } })
      .expect(403);
    await api().get('/api/v1/config/draft').set('authorization', meena).expect(403);
  });

  it('keeps another company out of this company’s configuration, records and files', async () => {
    await api().get('/api/v1/records/student').set('authorization', B).expect(404);
    await api().get(`/api/v1/records/student/${ids.asha}`).set('authorization', B).expect(404);
    await api().get(`/api/v1/files/${ids.photo}`).set('authorization', B).expect(404);
    const eff = await api().get('/api/v1/config/effective').set('authorization', B).expect(200);
    expect(eff.body.version).toBe(0);
    expect(eff.body.settings.fiscalYearStartMonth).toBe(1);
    await put(B, 'entities', 'student', {
      key: 'student',
      kind: 'custom',
      label: { en: 'Pupil' },
      pluralLabel: { en: 'Pupils' },
      fields: [{ key: 'full_name', type: 'text', label: { en: 'Name' } }],
    }).expect(200);
    await api().post('/api/v1/config/publish').set('authorization', B).send({}).expect(201);
    const bList = await api().get('/api/v1/records/student').set('authorization', B).expect(200);
    expect(bList.body.total).toBe(0);
    const aEff = await api().get('/api/v1/config/effective').set('authorization', A).expect(200);
    expect(aEff.body.entities.find((e: { key: string }) => e.key === 'student').label.en).toBe(
      'Student',
    );
  });

  it('serves uploaded files only through signed links', async () => {
    const meta = await api().get(`/api/v1/files/${ids.photo}`).set('authorization', A).expect(200);
    const res = await api().get(meta.body.url).expect(200);
    expect(res.headers['content-type']).toBe('image/png');
    await api().get(`/api/v1/files/${ids.photo}/content`).expect(403);
  });

  it('records configuration and data changes in the audit chain', async () => {
    const types = await eventually(async () => {
      const page = (
        await api().get('/api/v1/audit/events?pageSize=200').set('authorization', A).expect(200)
      ).body;
      const t = new Set<string>(page.items.map((e: { type: string }) => e.type));
      const needed = [
        'config.published',
        'config.rolled_back',
        'records.record.created',
        'records.record.updated',
        'records.record.deleted',
        'files.file.uploaded',
        'identity.user.invited',
      ];
      return needed.every((n) => t.has(n)) && t;
    });
    expect(types.size).toBeGreaterThan(5);
    const verify = await api().get('/api/v1/audit/verify').set('authorization', A).expect(200);
    expect(verify.body.valid).toBe(true);
  });
});
