import { z } from 'zod';
import { baseEnvSchema, loadEnv, ServiceClient, type TenantProfile } from '@erp/service-kit';

export const configEnvSchema = baseEnvSchema.extend({
  ORG_SERVICE_URL: z.string().url(),
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
  org: Pick<ServiceClient, 'get'>;
  tenant: Pick<ServiceClient, 'get'>;
}

export function createClients(): Clients {
  const env = loadEnv(configEnvSchema);
  return {
    org: new ServiceClient(
      'org-service',
      env.ORG_SERVICE_URL,
      'config-service',
      env.INTERNAL_SECRET,
    ),
    tenant: new ServiceClient(
      'tenant-service',
      env.TENANT_SERVICE_URL,
      'config-service',
      env.INTERNAL_SECRET,
    ),
  };
}

export type { TenantProfile };
