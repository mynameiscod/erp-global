import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { NotifyTypes, type EventEnvelope } from '@erp/contracts';
import { PLACEMENT_RESOLVER, SharedPlacementResolver, sharedMemoryBus } from '@erp/service-kit';
import { serviceTestEnv, startMongo, type TestMongo } from '@erp/testing';
import { AppModule } from './app.module';
import supertest from 'supertest';
import { signAccessToken } from '@erp/auth';
import { testKeys } from '@erp/testing';
import { CLIENTS } from './clients';
import { MAILER } from './mailer';
import { PUSH } from './push';
import { render } from './templates';
import { templateLanguage, WHATSAPP } from './whatsapp';

describe('templates', () => {
  it('renders in the user language and falls back to English', () => {
    const vars = {
      name: 'Asha',
      company: 'Acme',
      inviter: 'Ravi',
      link: 'https://app.test/accept-invite?token=x',
    };
    expect(render('user.invite', 'hi-IN', vars).subject).toContain('Acme');
    expect(render('user.invite', 'ar', vars).html).toContain('dir="rtl"');
    expect(render('user.invite', 'fr', vars).subject).toBe("You're invited to Acme on global-erp");
  });

  it('renders the sign-in code email without a link', () => {
    const mail = render('otp.code', 'ar', { code: '123456' });
    expect(mail.subject).toContain('123456');
    expect(mail.html).toContain('dir="rtl"');
    expect(mail.html).not.toContain('<a ');
  });

  it('picks an approved WhatsApp template language for the user', () => {
    const approved = ['en_US', 'hi', 'ar'];
    expect(templateLanguage('hi-IN', approved)).toBe('hi');
    expect(templateLanguage('en', approved)).toBe('en_US');
    expect(templateLanguage('ta', approved)).toBe('en_US');
  });

  it('escapes HTML and refuses non-http links', () => {
    const html = render('password.reset', 'en', {
      name: '<script>x</script>',
      link: 'https://a.test',
    }).html;
    expect(html).not.toContain('<script>');
    expect(() =>
      render('password.reset', 'en', { name: 'x', link: 'javascript:alert(1)' }),
    ).toThrow();
  });
});

describe('notification-service', () => {
  let mongo: TestMongo;
  let app: INestApplication;
  let baseUrl = '';
  const bearer = (sub: string, tid = 'tA') =>
    `Bearer ${signAccessToken({ sub, tid, sid: 's', acl: [] }, testKeys().privateKey, 300)}`;
  const userNotify = (payload: Record<string, unknown>): EventEnvelope => ({
    eventId: randomUUID(),
    type: NotifyTypes.UserNotify,
    version: 1,
    tenantId: 'tA',
    actor: { type: 'system', id: 'workflow-service' },
    occurredAt: new Date().toISOString(),
    source: 'workflow-service',
    payload,
  });
  const deliver = async (e: EventEnvelope) => {
    await sharedMemoryBus().publish(e.type, e, e.eventId);
    await sharedMemoryBus().idle();
  };
  const sent: { to: string; subject: string; html?: string }[] = [];
  const pushed: { endpoint: string; title: string }[] = [];
  const users: Record<
    string,
    {
      id: string;
      email: string;
      name: string;
      status: string;
      language: string;
      phone: string | null;
    }
  > = {
    u1: {
      id: 'u1',
      email: 'asha@x.test',
      name: 'Asha',
      status: 'active',
      language: 'hi',
      phone: '+919800000001',
    },
    u2: {
      id: 'u2',
      email: 'ravi@x.test',
      name: 'Ravi',
      status: 'active',
      language: 'en',
      phone: null,
    },
    u3: {
      id: 'u3',
      email: 'gone@x.test',
      name: 'Gone',
      status: 'deactivated',
      language: 'en',
      phone: null,
    },
  };
  const clients = {
    identity: {
      post: async (_p: string, body: { ids: string[] }) =>
        body.ids.map((i) => users[i]).filter(Boolean),
    },
    config: {
      effective: async () => ({
        tenant: { defaultLanguage: 'en' },
        templates: [
          {
            key: 'po.approved',
            label: { en: 'PO approved' },
            title: { en: 'Approved: {{record.title}}', hi: 'स्वीकृत: {{record.title}}' },
            body: { en: '{{entity}} {{record.title}} is approved.' },
            whatsapp: { template: 'po_approved', params: ['record.title', 'link'] },
          },
        ],
      }),
      invalidate: () => undefined,
    },
  };
  const push = {
    publicKey: 'test-public-key',
    send: async (sub: { endpoint: string }, msg: { title: string }) => {
      pushed.push({ endpoint: sub.endpoint, title: msg.title });
      return !sub.endpoint.includes('gone');
    },
  };
  let failures = 0;
  const mailer = {
    send: async (m: { to: string; subject: string }) => {
      if (failures > 0) {
        failures--;
        throw new Error('SMTP down');
      }
      sent.push(m);
      return { messageId: randomUUID() };
    },
  };

  const whatsappSent: { to: string; code: string; locale: string }[] = [];
  let whatsappFailures = 0;
  const whatsapp = {
    provider: 'test',
    sendTemplate: async (to: string, template: string, locale: string, params: string[]) => {
      whatsappSent.push({ to, code: `${template}:${params.join('|')}`, locale });
      return { messageId: randomUUID() };
    },
    sendOtp: async (to: string, code: string, locale: string) => {
      if (whatsappFailures > 0) {
        whatsappFailures--;
        throw new Error('Graph API down');
      }
      whatsappSent.push({ to, code, locale });
      return { messageId: randomUUID() };
    },
  };
  const whatsappRequest = (to: string, ageMs = 0): EventEnvelope => ({
    eventId: randomUUID(),
    type: NotifyTypes.WhatsappRequested,
    version: 1,
    tenantId: 'tA',
    actor: { type: 'user', id: 'u1' },
    occurredAt: new Date(Date.now() - ageMs).toISOString(),
    source: 'identity-service',
    payload: { to, template: 'otp', locale: 'hi', code: '654321' },
  });

  const request = (to: string): EventEnvelope => ({
    eventId: randomUUID(),
    type: NotifyTypes.EmailRequested,
    version: 1,
    tenantId: 'tA',
    actor: { type: 'user', id: 'u1' },
    occurredAt: new Date().toISOString(),
    source: 'identity-service',
    payload: {
      to,
      template: 'user.invite',
      locale: 'en',
      vars: { name: 'A', company: 'C', link: 'https://x.test' },
    },
  });

  beforeAll(async () => {
    mongo = await startMongo();
    Object.assign(
      process.env,
      serviceTestEnv(mongo.uri, 'erp_notification_test', {
        MAIL_TRANSPORT: 'json',
        IDENTITY_SERVICE_URL: 'http://identity.test',
        CONFIG_SERVICE_URL: 'http://config.test',
        APP_URL: 'https://app.test',
      }),
    );
    const ref = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PLACEMENT_RESOLVER)
      .useClass(SharedPlacementResolver)
      .overrideProvider(MAILER)
      .useValue(mailer)
      .overrideProvider(WHATSAPP)
      .useValue(whatsapp)
      .overrideProvider(CLIENTS)
      .useValue(clients)
      .overrideProvider(PUSH)
      .useValue(push)
      .compile();
    app = ref.createNestApplication();
    await app.listen(0, '127.0.0.1');
    baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
  });

  it('sends each requested email once, even if the request is delivered twice', async () => {
    const e = request('a@x.test');
    const bus = sharedMemoryBus();
    await bus.publish(e.type, e, e.eventId);
    await bus.publish(e.type, e, randomUUID());
    await bus.idle();
    expect(sent.filter((m) => m.to === 'a@x.test')).toHaveLength(1);
  });

  it('retries when the mail server fails', async () => {
    failures = 2;
    const e = request('b@x.test');
    await sharedMemoryBus().publish(e.type, e, e.eventId);
    await sharedMemoryBus().idle();
    expect(sent.filter((m) => m.to === 'b@x.test')).toHaveLength(1);
  });

  it('sends each WhatsApp code once and retries while the code is still fresh', async () => {
    const bus = sharedMemoryBus();
    const e = whatsappRequest('+919876543210');
    whatsappFailures = 1;
    await bus.publish(e.type, e, e.eventId);
    await bus.publish(e.type, e, randomUUID());
    await bus.idle();
    expect(whatsappSent.filter((m) => m.to === '+919876543210')).toEqual([
      { to: '+919876543210', code: '654321', locale: 'hi' },
    ]);
  });

  it('drops WhatsApp codes that would arrive after they expire', async () => {
    const e = whatsappRequest('+919800000000', 5 * 60_000);
    await sharedMemoryBus().publish(e.type, e, e.eventId);
    await sharedMemoryBus().idle();
    expect(whatsappSent.some((m) => m.to === '+919800000000')).toBe(false);
  });

  describe('user notifications', () => {
    const vars = {
      record: { title: 'Laptops', amount: { amount: 5000 } },
      entity: { en: 'Purchase', hi: 'खरीद' },
    };

    it('renders in each user language and delivers in-app, email, WhatsApp and push once', async () => {
      await supertest(baseUrl)
        .post('/api/v1/notifications/push/subscriptions')
        .set('authorization', bearer('u1'))
        .send({ endpoint: 'https://push.test/u1', keys: { p256dh: 'k', auth: 'a' } })
        .expect(201);
      await supertest(baseUrl)
        .post('/api/v1/notifications/push/subscriptions')
        .set('authorization', bearer('u1'))
        .send({ endpoint: 'https://push.test/gone', keys: { p256dh: 'k', auth: 'a' } })
        .expect(201);
      const e = userNotify({
        userIds: ['u1', 'u2', 'u3'],
        template: 'po.approved',
        channels: ['inapp', 'email', 'whatsapp', 'push'],
        vars,
        link: '/r/purchase/1',
      });
      await deliver(e);
      await deliver(e); // redelivered: nothing twice

      const asha = await supertest(baseUrl)
        .get('/api/v1/notifications')
        .set('authorization', bearer('u1'))
        .expect(200);
      expect(asha.body.items).toEqual([
        expect.objectContaining({
          title: 'स्वीकृत: Laptops',
          body: 'खरीद Laptops is approved.',
          link: '/r/purchase/1',
          read: false,
        }),
      ]);
      const ravi = await supertest(baseUrl)
        .get('/api/v1/notifications')
        .set('authorization', bearer('u2'))
        .expect(200);
      expect(ravi.body.items.map((i: { title: string }) => i.title)).toEqual(['Approved: Laptops']);
      expect(
        (
          await supertest(baseUrl)
            .get('/api/v1/notifications')
            .set('authorization', bearer('u3'))
            .expect(200)
        ).body.items,
      ).toEqual([]);

      expect(sent.filter((m) => m.to === 'asha@x.test')).toHaveLength(1);
      expect(sent.find((m) => m.to === 'ravi@x.test')?.html).toContain(
        'https://app.test/r/purchase/1',
      );
      expect(whatsappSent.filter((w) => w.to === '+919800000001')).toEqual([
        {
          to: '+919800000001',
          code: 'po_approved:Laptops|https://app.test/r/purchase/1',
          locale: 'hi',
        },
      ]);
      expect(pushed.filter((p) => p.endpoint === 'https://push.test/u1')).toHaveLength(1);
      // A subscription the browser dropped is removed.
      await deliver(
        userNotify({ userIds: ['u1'], template: 'approval.approved', channels: ['push'], vars }),
      );
      expect(pushed.filter((p) => p.endpoint === 'https://push.test/gone')).toHaveLength(2 - 1);
    });

    it('respects preferences, keeps essential in-app messages, and sends digests only by choice', async () => {
      await supertest(baseUrl)
        .put('/api/v1/notifications/preferences')
        .set('authorization', bearer('u2'))
        .send({ disabled: ['approval.requested:inapp', 'approval.approved:email'], digest: true })
        .expect(200);
      const before = sent.filter((m) => m.to === 'ravi@x.test').length;
      await deliver(
        userNotify({
          userIds: ['u2'],
          template: 'approval.requested',
          channels: ['inapp', 'email'],
          vars,
          essential: true,
          link: '/approvals',
        }),
      );
      await deliver(
        userNotify({
          userIds: ['u2'],
          template: 'approval.approved',
          channels: ['inapp', 'email'],
          vars,
        }),
      );
      await deliver(
        userNotify({
          userIds: ['u1', 'u2'],
          template: 'approval.digest',
          channels: ['email'],
          vars: { count: 3 },
        }),
      );
      const ravi = sent.filter((m) => m.to === 'ravi@x.test').slice(before);
      // Requested: digest instead of email. Approved: email turned off. Digest: yes.
      expect(ravi.map((m) => m.subject)).toEqual(['3 approvals are waiting for you']);
      expect(sent.some((m) => m.to === 'asha@x.test' && m.subject.includes('3'))).toBe(false);
      const inbox = await supertest(baseUrl)
        .get('/api/v1/notifications?unread=true')
        .set('authorization', bearer('u2'))
        .expect(200);
      expect(inbox.body.items.map((i: { template: string }) => i.template)).toEqual(
        expect.arrayContaining(['approval.requested', 'approval.approved']),
      );
    });

    it('marks notifications read, keeps them per user and company, and streams new ones', async () => {
      const auth = bearer('u2');
      const count = async () =>
        (
          await supertest(baseUrl)
            .get('/api/v1/notifications/unread-count')
            .set('authorization', auth)
            .expect(200)
        ).body.unread;
      expect(await count()).toBeGreaterThan(0);
      const first = (
        await supertest(baseUrl).get('/api/v1/notifications').set('authorization', auth).expect(200)
      ).body.items[0];
      await supertest(baseUrl)
        .post(`/api/v1/notifications/${first.id}/read`)
        .set('authorization', bearer('u1'))
        .expect(200);
      expect(
        (await supertest(baseUrl).get('/api/v1/notifications').set('authorization', auth)).body
          .items[0].read,
      ).toBe(false);
      await supertest(baseUrl)
        .post('/api/v1/notifications/read-all')
        .set('authorization', auth)
        .expect(200);
      expect(await count()).toBe(0);
      expect(
        (
          await supertest(baseUrl)
            .get('/api/v1/notifications')
            .set('authorization', bearer('u2', 'tB'))
            .expect(200)
        ).body.items,
      ).toEqual([]);

      // Live stream: a new notification arrives as a server-sent event.
      const ctrl = new AbortController();
      const res = await fetch(`${baseUrl}/api/v1/notifications/stream`, {
        headers: { authorization: auth },
        signal: ctrl.signal,
      });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      await deliver(
        userNotify({ userIds: ['u2'], template: 'po.approved', channels: ['inapp'], vars }),
      );
      let text = '';
      while (!text.includes('event: notification')) {
        const { value } = await reader.read();
        text += new TextDecoder().decode(value);
      }
      expect(text).toContain('Approved: Laptops');
      ctrl.abort();
      await reader.cancel().catch(() => undefined);
    });
  });
});
