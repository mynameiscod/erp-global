import { z } from 'zod';
import { normalizePem } from '@erp/auth';

export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MONGO_URI: z.string().min(1),
  /** The service's own database, e.g. `erp_identity`. */
  MONGO_DB: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/),
  /** Comma-separated NATS servers, or `memory` for the in-process bus. */
  NATS_URL: z.string().min(1),
  JWT_PUBLIC_KEY: z.string().min(1).transform(normalizePem),
  INTERNAL_SECRET: z.string().min(32, 'INTERNAL_SECRET must be at least 32 characters'),
  /** Where to ask for tenant data placement. `self` inside tenant-service. */
  TENANT_SERVICE_URL: z.string().min(1),
  ENABLE_DOCS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

/** Validates `process.env` against `schema` and fails fast with a readable message. */
export function loadEnv<S extends z.ZodTypeAny>(
  schema: S,
  source: NodeJS.ProcessEnv = process.env,
): z.infer<S> {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${lines}`);
  }
  return parsed.data;
}
