import { z } from 'zod';
import { normalizePem } from '@erp/auth';

const url = z.string().url();

export const gatewayEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  JWT_PUBLIC_KEY: z.string().min(1).transform(normalizePem),
  /** Comma-separated browser origins allowed to call the API, e.g. https://app.example.com */
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  /** Optional; without it rate limits are per gateway instance. */
  REDIS_URL: z.string().optional(),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(300),
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(20),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(1),
  IDENTITY_SERVICE_URL: url,
  TENANT_SERVICE_URL: url,
  ORG_SERVICE_URL: url,
  ACCESS_SERVICE_URL: url,
  AUDIT_SERVICE_URL: url,
  REFERENCE_SERVICE_URL: url,
  CONFIG_SERVICE_URL: url,
  RECORDS_SERVICE_URL: url,
  FILE_SERVICE_URL: url,
});

export type GatewayEnv = z.infer<typeof gatewayEnvSchema>;

export interface Route {
  /** Path prefixes handled by this service. */
  prefixes: string[];
  service: string;
  target: string;
}

export function routes(env: GatewayEnv): Route[] {
  return [
    {
      prefixes: ['/api/v1/identity'],
      service: 'identity-service',
      target: env.IDENTITY_SERVICE_URL,
    },
    {
      prefixes: ['/api/v1/tenants', '/api/v1/platform'],
      service: 'tenant-service',
      target: env.TENANT_SERVICE_URL,
    },
    { prefixes: ['/api/v1/org'], service: 'org-service', target: env.ORG_SERVICE_URL },
    { prefixes: ['/api/v1/access'], service: 'access-service', target: env.ACCESS_SERVICE_URL },
    { prefixes: ['/api/v1/audit'], service: 'audit-service', target: env.AUDIT_SERVICE_URL },
    {
      prefixes: ['/api/v1/reference'],
      service: 'reference-data-service',
      target: env.REFERENCE_SERVICE_URL,
    },
    { prefixes: ['/api/v1/config'], service: 'config-service', target: env.CONFIG_SERVICE_URL },
    { prefixes: ['/api/v1/records'], service: 'records-service', target: env.RECORDS_SERVICE_URL },
    { prefixes: ['/api/v1/files'], service: 'file-service', target: env.FILE_SERVICE_URL },
  ];
}

/**
 * Routes reachable without a session. Everything else needs a valid access
 * token at the gateway, and the services check it again.
 */
export const PUBLIC_ROUTES: { method: string; pattern: RegExp }[] = [
  { method: 'POST', pattern: /^\/api\/v1\/tenants\/signup$/ },
  { method: 'GET', pattern: /^\/api\/v1\/tenants\/(slug-available|lookup)\/[^/]+$/ },
  { method: 'GET', pattern: /^\/api\/v1\/reference(\/.*)?$/ },
  { method: '*', pattern: /^\/api\/v1\/identity\/auth(\/.*)?$/ },
  // Signed, short-lived download links; file-service verifies the signature.
  { method: 'GET', pattern: /^\/api\/v1\/files\/[0-9a-f-]{36}\/content$/ },
];

/** Stricter limits on endpoints that attackers hammer. */
export const SENSITIVE_ROUTES = [
  /^\/api\/v1\/identity\/auth\/(login|login\/mfa|password\/forgot|password\/reset|invite\/accept)$/,
  /^\/api\/v1\/tenants\/signup$/,
];
