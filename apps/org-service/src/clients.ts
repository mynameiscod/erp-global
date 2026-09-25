import { z } from 'zod';
import { baseEnvSchema, ConfigClient, loadEnv, ServiceClient } from '@erp/service-kit';

export const orgEnvSchema = baseEnvSchema.extend({
  CONFIG_SERVICE_URL: z.string().url(),
  IDENTITY_SERVICE_URL: z.string().url(),
});

export const CLIENTS = Symbol('CLIENTS');

export interface Clients {
  config: ConfigClient;
  identity: Pick<ServiceClient, 'get'>;
}

export function createClients(): Clients {
  const env = loadEnv(orgEnvSchema);
  return {
    config: new ConfigClient(
      new ServiceClient(
        'config-service',
        env.CONFIG_SERVICE_URL,
        'org-service',
        env.INTERNAL_SECRET,
      ),
    ),
    identity: new ServiceClient(
      'identity-service',
      env.IDENTITY_SERVICE_URL,
      'org-service',
      env.INTERNAL_SECRET,
    ),
  };
}
