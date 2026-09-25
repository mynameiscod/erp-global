import { z } from 'zod';
import { baseEnvSchema, ConfigClient, loadEnv, ServiceClient } from '@erp/service-kit';

export const clientsEnvSchema = baseEnvSchema.extend({
  IDENTITY_SERVICE_URL: z.string().url(),
  CONFIG_SERVICE_URL: z.string().url(),
});

export const CLIENTS = Symbol('CLIENTS');

export interface Clients {
  identity: Pick<ServiceClient, 'post'>;
  config: Pick<ConfigClient, 'effective' | 'invalidate'>;
}

export interface UserInfo {
  id: string;
  email: string;
  name: string;
  status: string;
  language: string;
  phone: string | null;
}

export function createClients(): Clients {
  const env = loadEnv(clientsEnvSchema);
  const make = (name: string, url: string) =>
    new ServiceClient(name, url, 'notification-service', env.INTERNAL_SECRET);
  return {
    identity: make('identity-service', env.IDENTITY_SERVICE_URL),
    config: new ConfigClient(make('config-service', env.CONFIG_SERVICE_URL)),
  };
}
