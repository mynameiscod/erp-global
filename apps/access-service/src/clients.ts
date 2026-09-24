import { z } from 'zod';
import { baseEnvSchema, loadEnv, ServiceClient } from '@erp/service-kit';

export const accessEnvSchema = baseEnvSchema.extend({
  ORG_SERVICE_URL: z.string().url(),
  IDENTITY_SERVICE_URL: z.string().url(),
});

export const CLIENTS = Symbol('CLIENTS');

export interface Clients {
  org: Pick<ServiceClient, 'get'>;
  identity: Pick<ServiceClient, 'get'>;
}

export function createClients(): Clients {
  const env = loadEnv(accessEnvSchema);
  return {
    org: new ServiceClient(
      'org-service',
      env.ORG_SERVICE_URL,
      'access-service',
      env.INTERNAL_SECRET,
    ),
    identity: new ServiceClient(
      'identity-service',
      env.IDENTITY_SERVICE_URL,
      'access-service',
      env.INTERNAL_SECRET,
    ),
  };
}
