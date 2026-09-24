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
});
