import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import argon2 from 'argon2';

const ARGON_OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON_OPTIONS);
}

// Verifying against a fixed hash when the user does not exist keeps response times similar,
// so login timing does not reveal which emails are registered.
let dummyHash: Promise<string> | undefined;

export async function verifyPassword(hash: string | undefined, password: string): Promise<boolean> {
  dummyHash ??= argon2.hash('not-a-real-password-0000', ARGON_OPTIONS);
  try {
    return await argon2.verify(hash ?? (await dummyHash), password);
  } catch {
    return false;
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Tokens that reach a public endpoint carry their tenant: `<tenantId>.<secret>`.
 * The tenant only selects where to look; the secret must still match a stored hash.
 */
export function composeToken(tenantId: string, secret: string): string {
  return `${tenantId}.${secret}`;
}

export function splitToken(token: string): { tenantId: string; secret: string } | undefined {
  const i = token.indexOf('.');
  if (i <= 0) return undefined;
  const tenantId = token.slice(0, i);
  const secret = token.slice(i + 1);
  if (!/^([a-f0-9]{24}|platform)$/.test(tenantId) || secret.length < 20) return undefined;
  return { tenantId, secret };
}

/** AES-256-GCM for secrets at rest (MFA seeds). Output: base64(iv | tag | ciphertext). */
export function encrypt(plain: string, keyB64: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

export function decrypt(payload: string, keyB64: string): string {
  const raw = Buffer.from(payload, 'base64');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(keyB64, 'base64'),
    raw.subarray(0, 12),
  );
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
