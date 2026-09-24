import { z } from 'zod';
import { baseEnvSchema, ConfigClient, loadEnv, ServiceClient } from '@erp/service-kit';

export const recordsEnvSchema = baseEnvSchema.extend({
  CONFIG_SERVICE_URL: z.string().url(),
  ORG_SERVICE_URL: z.string().url(),
  IDENTITY_SERVICE_URL: z.string().url(),
  FILE_SERVICE_URL: z.string().url(),
});

export const CLIENTS = Symbol('CLIENTS');

export interface OrgUnitInfo {
  id: string;
  name: string;
  code?: string | null;
  path: string;
  status: string;
}

export interface Clients {
  config: ConfigClient;
  configApi: Pick<ServiceClient, 'post'>;
  org: Pick<ServiceClient, 'get'>;
  identity: Pick<ServiceClient, 'get'>;
  files: Pick<ServiceClient, 'get'>;
}

export function createClients(): Clients {
  const env = loadEnv(recordsEnvSchema);
  const make = (name: string, url: string) =>
    new ServiceClient(name, url, 'records-service', env.INTERNAL_SECRET);
  const configApi = make('config-service', env.CONFIG_SERVICE_URL);
  return {
    config: new ConfigClient(configApi),
    configApi,
    org: make('org-service', env.ORG_SERVICE_URL),
    identity: make('identity-service', env.IDENTITY_SERVICE_URL),
    files: make('file-service', env.FILE_SERVICE_URL),
  };
}
