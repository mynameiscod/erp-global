/**
 * Step 4 acceptance test: workflows, approvals, rules, automations and notifications,
 * end to end through the gateway with every service running.
 */
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { signServiceToken } from '@erp/auth';
import { NotifyTypes, type EmailRequestedPayload } from '@erp/contracts';
import { sharedMemoryBus } from '@erp/service-kit';
import { TEST_INTERNAL_SECRET } from '@erp/testing';
import { eventually, startStack, type Stack } from './harness';

const PASSWORD = 'Very-secret-pass-1';
const HOUR = 3_600_000;

interface Hook {
  body: Record<string, unknown>;
  signature: string;
  delivery: string;
}

describe('Step 4 acceptance: workflows and automations', () => {
  let stack: Stack;
  let receiver: Server;
  let receiverUrl = '';
  let receiverStatus = 200;
  const hooks: Hook[] = [];
  const api = () => request(stack.gatewayUrl);
  const ids: Record<string, string> = {};
  const auth: Record<string, string> = {};
  /** The workflow service's clock, moved forward for reminders and escalations. */
  let now = Date.now();

  async function login(tenantSlug: string, email: string) {
    const res = await api()
      .post('/api/v1/identity/auth/login')
      .send({ tenantSlug, email, password: PASSWORD })
      .expect(200);
    return `Bearer ${res.body.accessToken}`;
  }

  async function signup(slug: string, email: string) {
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

  async function emailTo(to: string): Promise<EmailRequestedPayload> {
    return eventually(async () => {
      const e = sharedMemoryBus()
        .published.slice()
        .reverse()
        .find(
          (x) =>
            x.type === NotifyTypes.EmailRequested && (x.payload as EmailRequestedPayload).to === to,
        );
      return e?.payload as EmailRequestedPayload | undefined;
    });
  }

  /** Invites a user, accepts the invite, gives them a role at a unit, and signs them in. */
  async function person(key: string, name: string, roleId?: string, unitId?: string) {
    const email = `${key}@acme.test`;
    const invite = await api()
      .post('/api/v1/identity/users/invite')
      .set('authorization', auth.admin)
      .send({ name, email })
      .expect(201);
    ids[key] = invite.body.id;
    const mail = await emailTo(email);
    const token = decodeURIComponent(new URL(mail.vars.link).searchParams.get('token')!);
    await api()
      .post('/api/v1/identity/auth/invite/accept')
      .send({ token, password: PASSWORD })
      .expect(200);
    if (roleId && unitId) {
      await api()
        .post('/api/v1/access/assignments')
        .set('authorization', auth.admin)
        .send({ userId: ids[key], roleId, orgUnitId: unitId })
        .expect(201);
    }
    auth[key] = await login('acme', email);
  }

  const role = async (name: string, permissions: string[]) =>
    (
      await api()
        .post('/api/v1/access/roles')
        .set('authorization', auth.admin)
        .send({ name, permissions })
        .expect(201)
    ).body.id as string;

  const unit = async (parentId: string, name: string, code: string, type: string) =>
    (
      await api()
        .post('/api/v1/org/units')
        .set('authorization', auth.admin)
        .send({ parentId, name, code, type })
        .expect(201)
    ).body.id as string;

  const put = (kind: string, key: string, body: object, scope?: string) =>
    api()
      .put(`/api/v1/config/draft/${kind}/${key}${scope ? `?scope=${scope}` : ''}`)
      .set('authorization', auth.admin)
      .send(body);

  const createPurchase = async (who: string, orgUnitId: string, title: string, amount: number) =>
    (
      await api()
        .post('/api/v1/records/purchase')
        .set('authorization', auth[who])
        .send({ orgUnitId, data: { title, amount: String(amount), reason: 'Needed for the team' } })
        .expect(201)
    ).body.id as string;

  const act = (who: string, id: string, action: string, comment?: string) =>
    api()
      .post(`/api/v1/workflow/records/purchase/${id}/actions/${action}`)
      .set('authorization', auth[who])
      .send({ comment });

  const view = async (who: string, id: string) =>
    (
      await api()
        .get(`/api/v1/workflow/records/purchase/${id}`)
        .set('authorization', auth[who])
        .expect(200)
    ).body;

  const tasksOf = async (who: string) =>
    (await api().get('/api/v1/workflow/tasks').set('authorization', auth[who]).expect(200)).body
      .items as {
      id: string;
      recordId: string;
      level: string;
      onBehalfOf: string | null;
    }[];

  const taskFor = (who: string, recordId: string) =>
    eventually(async () => (await tasksOf(who)).find((t) => t.recordId === recordId));

  const decide = (
    who: string,
    taskIds: string[],
    decision: 'approve' | 'reject',
    comment?: string,
  ) =>
    api()
      .post('/api/v1/workflow/tasks/decide')
      .set('authorization', auth[who])
      .send({ taskIds, decision, comment })
      .expect(200);

  const inbox = (who: string, template: string) =>
    eventually(async () => {
      const res = await api()
        .get('/api/v1/notifications')
        .set('authorization', auth[who])
        .expect(200);
      return (res.body.items as { template: string; title: string; link: string | null }[]).find(
        (n) => n.template === template,
      );
    });

  const record = async (id: string) =>
    (await api().get(`/api/v1/records/purchase/${id}`).set('authorization', auth.admin).expect(200))
      .body;

  /** Moves the workflow clock forward and runs whatever became due. */
  const advance = async (ms: number) => {
    now += ms;
    const token = signServiceToken({ sub: 'svc:e2e' }, TEST_INTERNAL_SECRET);
    return (
      await request(stack.serviceUrl('workflow'))
        .post('/internal/workflow/scheduler/run')
        .set('x-service-token', token)
        .send({ now: new Date(now).toISOString() })
        .expect(200)
    ).body.ran as number;
  };

  beforeAll(async () => {
    receiver = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        hooks.push({
          body: JSON.parse(raw || '{}'),
          signature: String(req.headers['x-erp-signature'] ?? ''),
          delivery: String(req.headers['x-erp-delivery'] ?? ''),
        });
        res.writeHead(receiverStatus);
        res.end();
      });
    });
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks`;

    stack = await startStack();
    auth.admin = await signup('acme', 'owner@acme.test');
    auth.other = await signup('beta', 'owner@beta.test');

    const units = await api().get('/api/v1/org/units').set('authorization', auth.admin).expect(200);
    ids.root = units.body[0].id;
    ids.region = await unit(ids.root, 'South', 'SOUTH', 'Region');
    ids.branch = await unit(ids.region, 'Hyderabad', 'HYD', 'Branch');
    ids.branch2 = await unit(ids.region, 'Chennai', 'CHN', 'Branch');

    // Roles naming the approvers exist before the workflow; their record permissions are
    // added once the entities are published (see the first test).
    ids.regionalRole = await role('Regional Head', ['org.unit.read']);
    ids.financeRole = await role('Finance', ['org.unit.read']);
  });

  /** People and their roles, once the entities exist and record permissions can be granted. */
  async function staffUp() {
    const staff = await role('Staff', ['records.purchase.*', 'records.purchase_log.read']);
    for (const r of [ids.regionalRole, ids.financeRole]) {
      await api()
        .patch(`/api/v1/access/roles/${r}`)
        .set('authorization', auth.admin)
        .send({
          permissions: ['org.unit.read', 'records.purchase.read', 'records.purchase.update'],
        })
        .expect(200);
    }
    await person('priya', 'Priya', staff, ids.branch);
    await person('bala', 'Bala', staff, ids.branch);
    await person('rani', 'Rani', ids.regionalRole, ids.region);
    await person('farah', 'Farah', ids.financeRole, ids.root);
    await person('dev', 'Dev', staff, ids.region);
    // Bala heads the Hyderabad branch.
    await api()
      .patch(`/api/v1/org/units/${ids.branch}`)
      .set('authorization', auth.admin)
      .send({ headUserId: ids.bala })
      .expect(200);
  }

  afterAll(async () => {
    await stack?.stop();
    await new Promise((r) => receiver?.close(r));
  });

  it('builds the workflow, rules and automations in the studio and publishes them', async () => {
    await put('entities', 'purchase', {
      key: 'purchase',
      kind: 'custom',
      label: { en: 'Purchase request', hi: 'खरीद अनुरोध' },
      pluralLabel: { en: 'Purchase requests' },
      titleField: 'title',
      fields: [
        { key: 'title', type: 'text', label: { en: 'Title' }, required: true },
        { key: 'amount', type: 'currency', label: { en: 'Amount' } },
        { key: 'reason', type: 'longtext', label: { en: 'Reason' } },
        { key: 'approved_on', type: 'date', label: { en: 'Approved on' } },
        { key: 'touches', type: 'integer', label: { en: 'Touches' } },
      ],
    }).expect(200);
    await put('entities', 'purchase_log', {
      key: 'purchase_log',
      kind: 'custom',
      label: { en: 'Purchase log' },
      pluralLabel: { en: 'Purchase logs' },
      titleField: 'title',
      fields: [{ key: 'title', type: 'text', label: { en: 'Title' } }],
    }).expect(200);

    await put('workflows', 'purchase', {
      entity: 'purchase',
      initialState: 'draft',
      states: [
        { key: 'draft', label: { en: 'Draft' } },
        {
          key: 'pending',
          label: { en: 'Pending approval' },
          color: '#fd7e14',
          locked: true,
          editableFields: ['reason'],
        },
        {
          key: 'approved',
          label: { en: 'Approved' },
          color: '#198754',
          locked: true,
          editableFields: ['touches'],
        },
        { key: 'rejected', label: { en: 'Rejected' }, color: '#dc3545' },
      ],
      actions: [
        {
          key: 'submit',
          label: { en: 'Submit for approval' },
          from: ['draft'],
          to: 'pending',
          requesterOnly: true,
          approval: {
            approvedState: 'approved',
            rejectedState: 'rejected',
            levels: [
              {
                key: 'head',
                label: { en: 'Branch head' },
                approvers: [{ type: 'unit_head' }],
                mode: 'any',
                remindAfterHours: 24,
                escalateAfterHours: 48,
                escalateTo: [{ type: 'role', roleId: ids.regionalRole }],
              },
              {
                key: 'region',
                label: { en: 'Regional head' },
                condition: 'amount > 50000',
                approvers: [{ type: 'role', roleId: ids.regionalRole }],
                mode: 'all',
              },
              {
                key: 'finance',
                label: { en: 'Finance' },
                condition: 'amount > 500000',
                approvers: [{ type: 'role', roleId: ids.financeRole }],
                mode: 'any',
              },
            ],
          },
        },
        {
          key: 'cancel',
          label: { en: 'Withdraw' },
          from: ['pending'],
          to: 'draft',
          requesterOnly: true,
        },
        {
          key: 'reopen',
          label: { en: 'Reopen' },
          from: ['rejected'],
          to: 'draft',
          requesterOnly: true,
          commentRequired: true,
        },
      ],
    }).expect(200);

    await put('rules', 'positive', {
      key: 'positive',
      entity: 'purchase',
      on: 'save',
      effect: 'block',
      condition: 'amount <= 0',
      message: { en: 'The amount must be more than zero' },
    }).expect(200);

    await put('templates', 'po.approved', {
      key: 'po.approved',
      label: { en: 'Purchase approved' },
      title: { en: 'Go ahead with {{record.title}}' },
      body: { en: '{{record.title}} ({{record.amount}}) was approved.' },
      whatsapp: { template: 'po_approved', params: ['record.title'] },
    }).expect(200);

    await put('automations', 'on_approved', {
      key: 'on_approved',
      entity: 'purchase',
      label: { en: 'When approved' },
      trigger: { type: 'status_changed', to: 'approved' },
      actions: [
        { type: 'update', set: [{ field: 'approved_on', value: 'TODAY()' }] },
        {
          type: 'create',
          entity: 'purchase_log',
          set: [{ field: 'title', value: 'CONCAT("Approved: ", title)' }],
        },
        {
          type: 'notify',
          template: 'po.approved',
          recipients: [{ type: 'creator' }],
          channels: ['inapp', 'email'],
        },
        { type: 'webhook', url: receiverUrl },
      ],
    }).expect(200);

    // Touching a record touches it again: the chain must stop by itself.
    await put('automations', 'touch_loop', {
      key: 'touch_loop',
      entity: 'purchase',
      label: { en: 'Loop' },
      trigger: { type: 'field_changed', field: 'touches' },
      actions: [{ type: 'update', set: [{ field: 'touches', value: 'touches + 1' }] }],
    }).expect(200);

    await put('automations', 'daily_nudge', {
      key: 'daily_nudge',
      entity: 'purchase',
      label: { en: 'Daily nudge' },
      trigger: { type: 'schedule', every: 'day', at: '09:00' },
      condition: 'STATUS() = "pending"',
      actions: [
        {
          type: 'notify',
          template: 'approval.reminder',
          recipients: [{ type: 'creator' }],
          channels: ['inapp'],
        },
      ],
    }).expect(200);

    // Chennai has its own chain: Finance only.
    await put(
      'workflows',
      'purchase',
      {
        entity: 'purchase',
        initialState: 'draft',
        states: [
          { key: 'draft', label: { en: 'Draft' } },
          { key: 'pending', label: { en: 'Pending approval' }, locked: true },
          { key: 'approved', label: { en: 'Approved' }, locked: true },
          { key: 'rejected', label: { en: 'Rejected' } },
        ],
        actions: [
          {
            key: 'submit',
            label: { en: 'Submit' },
            from: ['draft'],
            to: 'pending',
            approval: {
              approvedState: 'approved',
              rejectedState: 'rejected',
              levels: [
                {
                  key: 'finance',
                  label: { en: 'Finance' },
                  approvers: [{ type: 'role', roleId: ids.financeRole }],
                  mode: 'any',
                },
              ],
            },
          },
        ],
      },
      ids.branch2,
    ).expect(200);

    const issues = await api()
      .get('/api/v1/config/draft/validate')
      .set('authorization', auth.admin)
      .expect(200);
    expect(issues.body.issues ?? issues.body).toEqual([]);
    await api()
      .post('/api/v1/config/publish')
      .set('authorization', auth.admin)
      .send({ note: 'Step 4' })
      .expect(201);
    await staffUp();
  });

  it('enforces rules on the server', async () => {
    const res = await api()
      .post('/api/v1/records/purchase')
      .set('authorization', auth.priya)
      .send({ orgUnitId: ids.branch, data: { title: 'Free', amount: '0' } })
      .expect(400);
    expect(res.body.error.details).toEqual([
      { path: '_record', message: 'The amount must be more than zero' },
    ]);
  });

  it('runs a one-level approval, locks the record, and fires the automations', async () => {
    const id = (ids.small = await createPurchase('priya', ids.branch, 'Chairs', 10_000));
    expect((await record(id)).status).toBe('draft');
    expect((await view('priya', id)).actions.map((a: { key: string }) => a.key)).toEqual([
      'submit',
    ]);
    expect((await act('bala', id, 'submit')).status).toBe(403);

    const submitted = await act('priya', id, 'submit').expect(200);
    expect(submitted.body).toMatchObject({ state: 'pending', locked: true });
    expect(submitted.body.pending).toEqual([
      expect.objectContaining({ level: 'head', assigneeName: 'Bala' }),
    ]);
    expect((await record(id)).status).toBe('pending');
    const locked = await api()
      .patch(`/api/v1/records/purchase/${id}`)
      .set('authorization', auth.priya)
      .send({ data: { title: 'More chairs' } })
      .expect(409);
    expect(locked.body.error.code).toBe('RECORD_LOCKED');
    // The reason stays editable while pending.
    await api()
      .patch(`/api/v1/records/purchase/${id}`)
      .set('authorization', auth.priya)
      .send({ data: { reason: 'Urgent' } })
      .expect(200);

    const requested = await inbox('bala', 'approval.requested');
    expect(requested.title).toBe('Approval needed: Purchase request Chairs');
    const task = await taskFor('bala', id);
    await decide('bala', [task.id], 'approve');

    expect((await view('priya', id)).state).toBe('approved');
    await inbox('priya', 'approval.approved');
    const custom = await inbox('priya', 'po.approved');
    expect(custom.title).toBe('Go ahead with Chairs');

    // Automations: the date is set (despite the lock), a log record is created, a signed webhook sent.
    const after = await eventually(async () => {
      const r = await record(id);
      return r.data.approved_on ? r : undefined;
    });
    expect(after.data.approved_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const logs = await eventually(async () => {
      const res = await api()
        .get('/api/v1/records/purchase_log')
        .set('authorization', auth.admin)
        .expect(200);
      return res.body.items.length ? res.body.items : undefined;
    });
    expect(logs[0].data.title).toBe('Approved: Chairs');
    const hook = await eventually(async () =>
      hooks.find((h) => (h.body.record as { id: string })?.id === id),
    );
    const secret = (
      await api()
        .get('/api/v1/workflow/webhook-secret')
        .set('authorization', auth.admin)
        .expect(200)
    ).body.secret;
    expect(hook.signature).toBe(
      `sha256=${createHmac('sha256', secret).update(JSON.stringify(hook.body)).digest('hex')}`,
    );
    expect(hook.body).toMatchObject({
      event: 'status_changed',
      automation: 'on_approved',
      entity: 'purchase',
    });
  });

  it('adds levels by amount, lets a delegate act, and records who did what', async () => {
    const id = (ids.big = await createPurchase('priya', ids.branch, 'Servers', 600_000));
    await act('priya', id, 'submit').expect(200);
    await decide('bala', [(await taskFor('bala', id)).id], 'approve');

    // Level 2: the regional head, who is out of office and delegates to Dev.
    await api()
      .put('/api/v1/identity/me/delegation')
      .set('authorization', auth.rani)
      .send({
        toUserId: ids.dev,
        from: new Date(Date.now() - HOUR).toISOString(),
        until: new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
      })
      .expect(200);
    const delegated = await taskFor('dev', id);
    expect(delegated).toMatchObject({ level: 'region', onBehalfOf: 'Rani' });
    await decide('dev', [delegated.id], 'approve');

    // Level 3: Finance rejects with a comment.
    const finance = await taskFor('farah', id);
    const result = await decide('farah', [finance.id], 'reject', 'Over budget this quarter');
    expect(result.body.results).toEqual([{ taskId: finance.id, ok: true }]);

    const v = await view('priya', id);
    expect(v.state).toBe('rejected');
    expect(v.history.map((h: { action: string }) => h.action)).toEqual([
      'submit',
      'approve',
      'approve',
      'reject',
    ]);
    const byDelegate = v.history[2];
    expect(byDelegate).toMatchObject({ byName: 'Dev', onBehalfOfName: 'Rani', level: 'region' });
    const rejected = await inbox('priya', 'approval.rejected');
    expect(rejected.link).toBe(`/r/purchase/${id}`);

    // Reopening needs a comment.
    await act('priya', id, 'reopen').expect(400);
    await act('priya', id, 'reopen', 'Splitting into two orders').expect(200);
  });

  it('never lets anyone approve their own request', async () => {
    // Bala raises a request in his own branch; he is also its head, so nobody is left to approve.
    const id = await createPurchase('bala', ids.branch, 'Desk', 5_000);
    const res = await act('bala', id, 'submit').expect(409);
    expect(res.body.error.code).toBe('NO_APPROVER');
    const tasks = await tasksOf('bala');
    expect(tasks.some((t) => t.recordId === id)).toBe(false);
  });

  it('uses the branch override: Chennai goes straight to Finance', async () => {
    const id = await createPurchase('dev', ids.branch2, 'Printer', 70_000);
    await act('dev', id, 'submit').expect(200);
    const task = await taskFor('farah', id);
    expect(task.level).toBe('finance');
    expect((await tasksOf('bala')).some((t) => t.recordId === id)).toBe(false);
  });

  it('stops automations that trigger each other', async () => {
    await api()
      .patch(`/api/v1/records/purchase/${ids.small}`)
      .set('authorization', auth.priya)
      .send({ data: { touches: 1 } })
      .expect(200);
    const runs = await eventually(async () => {
      const res = await api()
        .get('/api/v1/workflow/automation-runs')
        .set('authorization', auth.admin)
        .expect(200);
      const loop = res.body.items.filter(
        (r: { automation: string }) => r.automation === 'touch_loop',
      );
      return loop.some((r: { status: string }) => r.status === 'skipped') ? loop : undefined;
    });
    expect(runs.filter((r: { status: string }) => r.status === 'ok')).toHaveLength(3);
    expect(runs.find((r: { status: string }) => r.status === 'skipped').error).toMatch(/Stopped/);
    expect((await record(ids.small)).data.touches).toBe(4);
  });

  it('shows failed automations and runs them again', async () => {
    receiverStatus = 500;
    const id = await createPurchase('dev', ids.branch2, 'Toner', 1_000);
    await act('dev', id, 'submit').expect(200);
    await decide('farah', [(await taskFor('farah', id)).id], 'approve');
    const failed = await eventually(async () => {
      const res = await api()
        .get('/api/v1/workflow/automation-runs?status=failed')
        .set('authorization', auth.admin)
        .expect(200);
      return res.body.items.find((r: { recordId: string }) => r.recordId === id);
    });
    expect(failed.error).toMatch(/500/);
    await api()
      .post(`/api/v1/workflow/automation-runs/${failed.id}/retry`)
      .set('authorization', auth.priya)
      .expect(403);
    receiverStatus = 200;
    const retried = await api()
      .post(`/api/v1/workflow/automation-runs/${failed.id}/retry`)
      .set('authorization', auth.admin)
      .expect(200);
    expect(retried.body).toEqual({ status: 'ok', error: null });
  });

  it('reminds, then escalates, when nobody acts in time', async () => {
    const id = await createPurchase('priya', ids.branch, 'Laptop', 20_000);
    await act('priya', id, 'submit').expect(200);
    const task = await taskFor('bala', id);

    expect(await advance(25 * HOUR)).toBeGreaterThan(0);
    await inbox('bala', 'approval.reminder');

    await advance(24 * HOUR);
    const escalated = await taskFor('rani', id);
    expect(escalated.level).toBe('head');
    expect((await tasksOf('bala')).some((t) => t.id === task.id)).toBe(false);
    await inbox('rani', 'approval.escalated');
    const v = await view('priya', id);
    expect(v.history.map((h: { action: string }) => h.action)).toContain('escalate');
  });

  it('runs scheduled automations at the time of day in the company time zone', async () => {
    // Priya is never an approver, so reminders in her inbox come only from the daily nudge,
    // which also ran when the clock passed 09:00 in the escalation test.
    const nudges = async () =>
      (
        await api()
          .get('/api/v1/notifications?pageSize=200')
          .set('authorization', auth.priya)
          .expect(200)
      ).body.items.filter((n: { template: string }) => n.template === 'approval.reminder').length;
    const before = await nudges();
    await advance(24 * HOUR);
    const after = await eventually(async () => {
      const n = await nudges();
      return n > before ? n : undefined;
    });
    expect(after).toBeGreaterThan(before);
    const runs = await api()
      .get('/api/v1/workflow/automation-runs?pageSize=200')
      .set('authorization', auth.admin)
      .expect(200);
    expect(
      runs.body.items.some(
        (r: { automation: string; status: string; trigger: string }) =>
          r.automation === 'daily_nudge' && r.status === 'ok' && r.trigger === 'schedule',
      ),
    ).toBe(true);
  });

  it('keeps notifications, preferences and approvals per user and per company', async () => {
    const list = await api()
      .get('/api/v1/notifications?unread=true')
      .set('authorization', auth.priya)
      .expect(200);
    expect(list.body.unread).toBeGreaterThan(0);
    await api().post('/api/v1/notifications/read-all').set('authorization', auth.priya).expect(200);
    expect(
      (
        await api()
          .get('/api/v1/notifications/unread-count')
          .set('authorization', auth.priya)
          .expect(200)
      ).body.unread,
    ).toBe(0);

    const prefs = await api()
      .put('/api/v1/notifications/preferences')
      .set('authorization', auth.priya)
      .send({ disabled: ['approval.approved:email'], digest: true })
      .expect(200);
    expect(prefs.body).toEqual({ disabled: ['approval.approved:email'], digest: true });

    // The other company sees nothing of this one.
    await api()
      .get(`/api/v1/workflow/records/purchase/${ids.small}`)
      .set('authorization', auth.other)
      .expect(404);
    expect(
      (await api().get('/api/v1/workflow/tasks').set('authorization', auth.other).expect(200)).body
        .items,
    ).toEqual([]);
    expect(
      (await api().get('/api/v1/notifications').set('authorization', auth.other).expect(200)).body
        .items,
    ).toEqual([]);
  });

  it('records workflow activity in the audit chain', async () => {
    await eventually(async () => {
      const page = (
        await api()
          .get('/api/v1/audit/events?pageSize=200')
          .set('authorization', auth.admin)
          .expect(200)
      ).body;
      const t = new Set<string>(page.items.map((e: { type: string }) => e.type));
      return [
        'workflow.action.taken',
        'workflow.task.created',
        'workflow.task.decided',
        'workflow.task.reminded',
        'workflow.task.escalated',
        'workflow.automation.failed',
        'workflow.webhook.called',
        'records.record.status_changed',
        'identity.delegation.set',
      ].every((n) => t.has(n));
    });
    const verify = await api()
      .get('/api/v1/audit/verify')
      .set('authorization', auth.admin)
      .expect(200);
    expect(verify.body.valid).toBe(true);
  });
});
