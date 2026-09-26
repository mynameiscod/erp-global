import { z } from 'zod';
import { baseEnvSchema, ConfigClient, loadEnv, ServiceClient } from '@erp/service-kit';

export const documentEnvSchema = baseEnvSchema.extend({
  CONFIG_SERVICE_URL: z.string().url(),
  RECORDS_SERVICE_URL: z.string().url(),
  FILE_SERVICE_URL: z.string().url(),
  ORG_SERVICE_URL: z.string().url(),
  IDENTITY_SERVICE_URL: z.string().url(),
});

export const CLIENTS = Symbol('CLIENTS');

export interface Clients {
  config: Pick<ConfigClient, 'effective' | 'invalidate'>;
  records: Pick<ServiceClient, 'post' | 'request'>;
  files: Pick<ServiceClient, 'getBytes' | 'postBytes'>;
  org: Pick<ServiceClient, 'get'>;
  identity: Pick<ServiceClient, 'post'>;
}

export function createClients(): Clients {
  const env = loadEnv(documentEnvSchema);
  const make = (name: string, url: string) =>
    new ServiceClient(name, url, 'document-service', env.INTERNAL_SECRET);
  return {
    config: new ConfigClient(make('config-service', env.CONFIG_SERVICE_URL)),
    records: make('records-service', env.RECORDS_SERVICE_URL),
    files: make('file-service', env.FILE_SERVICE_URL),
    org: make('org-service', env.ORG_SERVICE_URL),
    identity: make('identity-service', env.IDENTITY_SERVICE_URL),
  };
}
