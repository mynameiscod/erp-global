import { z } from 'zod';
import { baseEnvSchema, ConfigClient, loadEnv, ServiceClient } from '@erp/service-kit';

export const reportingEnvSchema = baseEnvSchema.extend({
  CONFIG_SERVICE_URL: z.string().url(),
  RECORDS_SERVICE_URL: z.string().url(),
  ACCESS_SERVICE_URL: z.string().url(),
  IDENTITY_SERVICE_URL: z.string().url(),
  FILE_SERVICE_URL: z.string().url(),
  DOCUMENT_SERVICE_URL: z.string().url(),
  /** Exports and scheduled reports. Off in tests, which run them by hand. */
  SCHEDULER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(1000).max(600_000).default(15_000),
});
export type ReportingEnv = z.infer<typeof reportingEnvSchema>;

export const REPORTING_ENV = Symbol('REPORTING_ENV');
export const CLIENTS = Symbol('CLIENTS');
export const CLOCK = Symbol('CLOCK');

export interface Clock {
  now(): Date;
}

export interface Clients {
  config: Pick<ConfigClient, 'effective' | 'invalidate'>;
  records: Pick<ServiceClient, 'post'>;
  access: Pick<ServiceClient, 'get'>;
  identity: Pick<ServiceClient, 'post'>;
  files: Pick<ServiceClient, 'postBytes'>;
  documents: Pick<ServiceClient, 'post'>;
}

export function loadReportingEnv(): ReportingEnv {
  return loadEnv(reportingEnvSchema);
}

export function createClients(env: ReportingEnv): Clients {
  const make = (name: string, url: string) =>
    new ServiceClient(name, url, 'reporting-service', env.INTERNAL_SECRET);
  return {
    config: new ConfigClient(make('config-service', env.CONFIG_SERVICE_URL)),
    records: make('records-service', env.RECORDS_SERVICE_URL),
    access: make('access-service', env.ACCESS_SERVICE_URL),
    identity: make('identity-service', env.IDENTITY_SERVICE_URL),
    files: make('file-service', env.FILE_SERVICE_URL),
    documents: make('document-service', env.DOCUMENT_SERVICE_URL),
  };
}

/** A clock tests can move forward to run schedules. */
export class AdjustableClock implements Clock {
  private offset = 0;
  now(): Date {
    return new Date(Date.now() + this.offset);
  }
  set(to: Date): void {
    this.offset = to.getTime() - Date.now();
  }
}
