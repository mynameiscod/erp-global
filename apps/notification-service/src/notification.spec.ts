import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { NotifyTypes, type EventEnvelope } from '@erp/contracts';
import { PLACEMENT_RESOLVER, SharedPlacementResolver, sharedMemoryBus } from '@erp/service-kit';
import { serviceTestEnv, startMongo, type TestMongo } from '@erp/testing';
import { AppModule } from './app.module';
import { MAILER } from './mailer';
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
  const sent: { to: string; subject: string }[] = [];
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
      serviceTestEnv(mongo.uri, 'erp_notification_test', { MAIL_TRANSPORT: 'json' }),
    );
    const ref = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PLACEMENT_RESOLVER)
      .useClass(SharedPlacementResolver)
      .overrideProvider(MAILER)
      .useValue(mailer)
      .overrideProvider(WHATSAPP)
      .useValue(whatsapp)
      .compile();
    app = ref.createNestApplication();
    await app.init();
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
});
