import { z } from 'zod';
import { baseEnvSchema, loadEnv, ServiceClient } from '@erp/service-kit';

export const packEnvSchema = baseEnvSchema.extend({
  CONFIG_SERVICE_URL: z.string().url(),
  RECORDS_SERVICE_URL: z.string().url(),
  ACCESS_SERVICE_URL: z.string().url(),
  TENANT_SERVICE_URL: z.string().url(),
  ORG_SERVICE_URL: z.string().url(),
});
export type PackEnv = z.infer<typeof packEnvSchema>;

export const CLIENTS = Symbol('CLIENTS');

export type Client = Pick<ServiceClient, 'get' | 'post' | 'delete' | 'request'>;

export interface Clients {
  config: Client;
  records: Client;
  access: Client;
  tenants: Client;
  org: Client;
}

export function createClients(env: PackEnv): Clients {
  const make = (name: string, url: string) =>
    new ServiceClient(name, url, 'pack-service', env.INTERNAL_SECRET);
  return {
    config: make('config-service', env.CONFIG_SERVICE_URL),
    records: make('records-service', env.RECORDS_SERVICE_URL),
    access: make('access-service', env.ACCESS_SERVICE_URL),
    tenants: make('tenant-service', env.TENANT_SERVICE_URL),
    org: make('org-service', env.ORG_SERVICE_URL),
  };
}

export function loadPackEnv(): PackEnv {
  return loadEnv(packEnvSchema);
}
