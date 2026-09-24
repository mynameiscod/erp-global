import { createHash } from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);

/**
 * Deterministic JSON: object keys sorted at every level, `undefined` dropped,
 * dates as ISO strings. The same record always produces the same bytes.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : normalize(v)));
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] !== undefined) out[key] = normalize(obj[key]);
  }
  return out;
}

export interface ChainFields {
  tenantId: string;
  seq: number;
  eventId: string;
  type: string;
  source: string;
  actor: { type: string; id: string };
  occurredAt: string;
  recordedAt: string;
  correlationId?: string;
  payload: unknown;
}

/** hash(n) = SHA-256(hash(n-1) + canonical(record n)). Changing any record breaks every later hash. */
export function chainHash(prevHash: string, fields: ChainFields): string {
  return createHash('sha256').update(prevHash).update(canonicalJson(fields)).digest('hex');
}

const SECRET_KEY = /password|secret|token|^otp$|^code$/i;

/** Defense in depth: events should never carry secrets, but never store one if they do. */
export function redact(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      SECRET_KEY.test(k) ? '[redacted]' : redact(v),
    ]),
  );
}
