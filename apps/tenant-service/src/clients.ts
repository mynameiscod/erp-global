import { z } from 'zod';
import { baseEnvSchema, loadEnv, ServiceClient } from '@erp/service-kit';

export const tenantEnvSchema = baseEnvSchema.extend({
  ORG_SERVICE_URL: z.string().url(),
  IDENTITY_SERVICE_URL: z.string().url(),
  ACCESS_SERVICE_URL: z.string().url(),
  REFERENCE_SERVICE_URL: z.string().url(),
});

export const CLIENTS = Symbol('CLIENTS');

export interface Clients {
  org: ServiceClient;
  identity: ServiceClient;
  access: ServiceClient;
  reference: ServiceClient;
}

export function createClients(): Clients {
  const env = loadEnv(tenantEnvSchema);
  const make = (service: string, url: string) =>
    new ServiceClient(service, url, 'tenant-service', env.INTERNAL_SECRET);
  return {
    org: make('org-service', env.ORG_SERVICE_URL),
    identity: make('identity-service', env.IDENTITY_SERVICE_URL),
    access: make('access-service', env.ACCESS_SERVICE_URL),
    reference: make('reference-data-service', env.REFERENCE_SERVICE_URL),
  };
}
