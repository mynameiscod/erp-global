import { z } from 'zod';
import { normalizePem } from '@erp/auth';
import { baseEnvSchema, loadEnv, ServiceClient } from '@erp/service-kit';

export const identityEnvSchema = baseEnvSchema.extend({
  JWT_PRIVATE_KEY: z.string().min(1).transform(normalizePem),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  /** 32 bytes, base64. Encrypts MFA secrets at rest. */
  DATA_ENC_KEY: z
    .string()
    .refine(
      (v) => Buffer.from(v, 'base64').length === 32,
      'DATA_ENC_KEY must be 32 bytes, base64-encoded',
    ),
  ACCESS_SERVICE_URL: z.string().url(),
  /** Public web app URL, used in invite and reset links. */
  APP_URL: z.string().url(),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  PLATFORM_ADMIN_EMAIL: z.string().optional(),
  PLATFORM_ADMIN_PASSWORD: z.string().optional(),
  PLATFORM_ADMIN_NAME: z.string().default('Platform Admin'),
});

export type IdentityEnv = z.infer<typeof identityEnvSchema>;

export const IDENTITY_ENV = Symbol('IDENTITY_ENV');
export const CLIENTS = Symbol('CLIENTS');

export interface Clients {
  tenant: Pick<ServiceClient, 'get'>;
  access: Pick<ServiceClient, 'get'>;
}

export function loadIdentityEnv(): IdentityEnv {
  return loadEnv(identityEnvSchema);
}

export function createClients(env: IdentityEnv): Clients {
  return {
    tenant: new ServiceClient(
      'tenant-service',
      env.TENANT_SERVICE_URL,
      'identity-service',
      env.INTERNAL_SECRET,
    ),
    access: new ServiceClient(
      'access-service',
      env.ACCESS_SERVICE_URL,
      'identity-service',
      env.INTERNAL_SECRET,
    ),
  };
}
