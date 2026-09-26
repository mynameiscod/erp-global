import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import type { INestApplication, Type } from '@nestjs/common';
import { createServiceApp, sharedMemoryBus } from '@erp/service-kit';
import { serviceTestEnv, startMongo, testKeys, type TestMongo } from '@erp/testing';
import { AppModule as AccessModule } from '../../../apps/access-service/src/app.module';
import { createGateway } from '../../../apps/api-gateway/src/app';
import { gatewayEnvSchema } from '../../../apps/api-gateway/src/config';
import { AppModule as AuditModule } from '../../../apps/audit-service/src/app.module';
import { AppModule as IdentityModule } from '../../../apps/identity-service/src/app.module';
import { AppModule as NotificationModule } from '../../../apps/notification-service/src/app.module';
import { AppModule as OrgModule } from '../../../apps/org-service/src/app.module';
import { AppModule as ReferenceModule } from '../../../apps/reference-data-service/src/app.module';
import { AppModule as TenantModule } from '../../../apps/tenant-service/src/app.module';
import { AppModule as ConfigModule } from '../../../apps/config-service/src/app.module';
import { AppModule as RecordsModule } from '../../../apps/records-service/src/app.module';
import { AppModule as FileModule } from '../../../apps/file-service/src/app.module';
import { AppModule as WorkflowModule } from '../../../apps/workflow-service/src/app.module';
import { AppModule as DocumentModule } from '../../../apps/document-service/src/app.module';
import { AppModule as ReportingModule } from '../../../apps/reporting-service/src/app.module';
import { AppModule as PackModule } from '../../../apps/pack-service/src/app.module';

const SERVICES = [
  'identity',
  'tenant',
  'org',
  'access',
  'audit',
  'reference',
  'notification',
  'config',
  'records',
  'file',
  'workflow',
  'document',
  'reporting',
  'pack',
] as const;
type ServiceName = (typeof SERVICES)[number];

const MODULES: Record<ServiceName, Type> = {
  identity: IdentityModule,
  tenant: TenantModule,
  org: OrgModule,
  access: AccessModule,
  audit: AuditModule,
  reference: ReferenceModule,
  notification: NotificationModule,
  config: ConfigModule,
  records: RecordsModule,
  file: FileModule,
  workflow: WorkflowModule,
  document: DocumentModule,
  reporting: ReportingModule,
  pack: PackModule,
};

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

export const PLATFORM_ADMIN = { email: 'root@platform.test', password: 'Platform-admin-1' };

export interface Stack {
  gatewayUrl: string;
  /** Direct URL of a service, for its /internal API. */
  serviceUrl(name: ServiceName): string;
  mongo: TestMongo;
  apps: Record<ServiceName, INestApplication>;
  stop(): Promise<void>;
}

/**
 * Boots the whole platform in this process: every microservice on its own
 * port with its own database, talking over real HTTP, plus the gateway in
 * front. Only the event broker is in-memory.
 */
export async function startStack(opts: { env?: Record<string, string> } = {}): Promise<Stack> {
  const mongo = await startMongo();
  const ports = Object.fromEntries(
    await Promise.all(SERVICES.map(async (s) => [s, await freePort()] as const)),
  ) as Record<ServiceName, number>;
  const url = (s: ServiceName) => `http://127.0.0.1:${ports[s]}`;
  const shared = {
    TENANT_SERVICE_URL: url('tenant'),
    IDENTITY_SERVICE_URL: url('identity'),
    ORG_SERVICE_URL: url('org'),
    ACCESS_SERVICE_URL: url('access'),
    REFERENCE_SERVICE_URL: url('reference'),
    CONFIG_SERVICE_URL: url('config'),
    RECORDS_SERVICE_URL: url('records'),
    FILE_SERVICE_URL: url('file'),
    WORKFLOW_SERVICE_URL: url('workflow'),
    NOTIFICATION_SERVICE_URL: url('notification'),
    DOCUMENT_SERVICE_URL: url('document'),
    REPORTING_SERVICE_URL: url('reporting'),
    PACK_SERVICE_URL: url('pack'),
    // Tests run the scheduler by hand and send webhooks to a local receiver.
    SCHEDULER_ENABLED: 'false',
    WEBHOOK_ALLOW_PRIVATE: 'true',
    STORAGE_DRIVER: 'memory',
    JWT_PRIVATE_KEY: testKeys().privateKey,
    DATA_ENC_KEY: randomBytes(32).toString('base64'),
    APP_URL: 'https://app.e2e.test',
    COOKIE_SECURE: 'false',
    MAIL_TRANSPORT: 'json',
    PLATFORM_ADMIN_EMAIL: PLATFORM_ADMIN.email,
    PLATFORM_ADMIN_PASSWORD: PLATFORM_ADMIN.password,
    ...opts.env,
  };

  const apps = {} as Record<ServiceName, INestApplication>;
  for (const s of SERVICES) {
    // Each service reads its configuration while it is created, so set it just before.
    Object.assign(process.env, serviceTestEnv(mongo.uri, `erp_${s}`, shared), {
      LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? 'silent',
    });
    if (s === 'tenant') process.env.TENANT_SERVICE_URL = 'self';
    const app = await createServiceApp(MODULES[s], {
      configure: (a) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        if (s === 'identity') a.use(require('cookie-parser')());
      },
    });
    await app.listen(ports[s], '127.0.0.1');
    apps[s] = app;
  }

  const gatewayPort = await freePort();
  const gateway = createGateway(
    gatewayEnvSchema.parse({
      LOG_LEVEL: 'silent',
      JWT_PUBLIC_KEY: testKeys().publicKey,
      RATE_LIMIT_PER_MINUTE: '100000',
      AUTH_RATE_LIMIT_PER_MINUTE: '100000',
      IDENTITY_SERVICE_URL: url('identity'),
      TENANT_SERVICE_URL: url('tenant'),
      ORG_SERVICE_URL: url('org'),
      ACCESS_SERVICE_URL: url('access'),
      AUDIT_SERVICE_URL: url('audit'),
      REFERENCE_SERVICE_URL: url('reference'),
      CONFIG_SERVICE_URL: url('config'),
      RECORDS_SERVICE_URL: url('records'),
      FILE_SERVICE_URL: url('file'),
      WORKFLOW_SERVICE_URL: url('workflow'),
      NOTIFICATION_SERVICE_URL: url('notification'),
      DOCUMENT_SERVICE_URL: url('document'),
      REPORTING_SERVICE_URL: url('reporting'),
      PACK_SERVICE_URL: url('pack'),
    }),
  );
  const server: Server = await new Promise((resolve) => {
    const srv = gateway.listen(gatewayPort, '127.0.0.1', () => resolve(srv as unknown as Server));
  });

  return {
    gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
    serviceUrl: url,
    mongo,
    apps,
    async stop() {
      await new Promise((r) => server.close(r));
      for (const s of [...SERVICES].reverse()) await apps[s].close();
      await sharedMemoryBus().stop();
      await mongo.stop();
    },
  };
}

/** Polls until `fn` returns a truthy value. Events are delivered in the background. */
export async function eventually<T>(
  fn: () => Promise<T | undefined | false>,
  timeoutMs = 15_000,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms${last ? `: ${String(last)}` : ''}`);
}
