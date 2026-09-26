import { z } from 'zod';
import { baseEnvSchema, ConfigClient, loadEnv, ServiceClient } from '@erp/service-kit';

export const workflowEnvSchema = baseEnvSchema.extend({
  CONFIG_SERVICE_URL: z.string().url(),
  RECORDS_SERVICE_URL: z.string().url(),
  ACCESS_SERVICE_URL: z.string().url(),
  IDENTITY_SERVICE_URL: z.string().url(),
  ORG_SERVICE_URL: z.string().url(),
  /** PDFs for the "document" automation action. */
  DOCUMENT_SERVICE_URL: z.string().url().optional(),
  /** Timers, schedules and digests. Off in tests, which run the scheduler by hand. */
  SCHEDULER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(1000).max(600_000).default(15_000),
  /** Tests point webhooks at a local server; production never allows private addresses. */
  WEBHOOK_ALLOW_PRIVATE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});
export type WorkflowEnv = z.infer<typeof workflowEnvSchema>;

export const WORKFLOW_ENV = Symbol('WORKFLOW_ENV');
export const CLIENTS = Symbol('CLIENTS');

export interface Clients {
  config: ConfigClient;
  records: Pick<ServiceClient, 'get' | 'post' | 'request'>;
  access: Pick<ServiceClient, 'get'>;
  identity: Pick<ServiceClient, 'get' | 'post'>;
  org: Pick<ServiceClient, 'get'>;
  documents?: Pick<ServiceClient, 'post'>;
}

export function loadWorkflowEnv(): WorkflowEnv {
  return loadEnv(workflowEnvSchema);
}

export function createClients(env: WorkflowEnv): Clients {
  const make = (name: string, url: string) =>
    new ServiceClient(name, url, 'workflow-service', env.INTERNAL_SECRET);
  return {
    config: new ConfigClient(make('config-service', env.CONFIG_SERVICE_URL)),
    records: make('records-service', env.RECORDS_SERVICE_URL),
    access: make('access-service', env.ACCESS_SERVICE_URL),
    identity: make('identity-service', env.IDENTITY_SERVICE_URL),
    org: make('org-service', env.ORG_SERVICE_URL),
    documents: env.DOCUMENT_SERVICE_URL
      ? make('document-service', env.DOCUMENT_SERVICE_URL)
      : undefined,
  };
}

/** Shapes returned by the other services' internal APIs. */
export interface RecordInfo {
  id: string;
  entity: string;
  number: string | null;
  status: string | null;
  data: Record<string, unknown>;
  orgUnitId: string | null;
  orgPath: string;
  createdBy: string;
  deleted?: boolean;
}

export interface UserInfo {
  id: string;
  email: string;
  name: string;
  status: string;
  language: string;
  timezone: string;
  phone: string | null;
  managerId: string | null;
}

/** The current time. Outside production, tests can move it forward. */
export const CLOCK = Symbol('CLOCK');
export interface Clock {
  now(): Date;
}

export class AdjustableClock implements Clock {
  private offsetMs = 0;
  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
  /** Makes `now()` return `at` from this moment on (the clock keeps running). */
  set(at: Date): void {
    this.offsetMs = at.getTime() - Date.now();
  }
}
