import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import mongoose, { type Connection } from 'mongoose';
import { dedicatedDbName } from '@erp/tenancy';

/**
 * Each service connects with its own MongoDB user that can only use its own
 * database. A dedicated tenant gets extra databases (`erp_org__<tenantId>`, ...),
 * so those users need a grant for them before any data is written.
 *
 * Runs only when DB_ADMIN_URI is set (production). Without it (tests, local
 * development without auth) there is nothing to grant.
 */
export const TENANT_DATA_SERVICES = [
  'identity',
  'org',
  'access',
  'audit',
  'notification',
  'config',
  'records',
  'files',
] as const;

@Injectable()
export class DbProvisioner implements OnModuleDestroy {
  private admin?: Promise<Connection>;

  constructor(private readonly log: PinoLogger) {}

  get enabled(): boolean {
    return !!process.env.DB_ADMIN_URI;
  }

  private connection(): Promise<Connection> {
    this.admin ??= mongoose
      .createConnection(process.env.DB_ADMIN_URI!, { dbName: 'admin' })
      .asPromise();
    return this.admin;
  }

  async grantDedicated(tenantId: string): Promise<void> {
    if (!this.enabled) return;
    const conn = await this.connection();
    for (const svc of TENANT_DATA_SERVICES) {
      await conn.db!.command({
        grantRolesToUser: `svc_${svc}`,
        roles: [{ role: 'readWrite', db: dedicatedDbName(`erp_${svc}`, tenantId) }],
      });
    }
    this.log.info({ tenantId }, 'granted dedicated database access to service users');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.admin) await (await this.admin).close();
  }
}
