import jwt from 'jsonwebtoken';
import type { AccessTokenClaims, ServiceTokenClaims } from '@erp/contracts';

export const TOKEN_ISSUER = 'global-erp';
export const ACCESS_AUDIENCE = 'erp-api';
export const SERVICE_AUDIENCE = 'erp-internal';

export class InvalidTokenError extends Error {
  constructor(message = 'Invalid or expired token') {
    super(message);
    this.name = 'InvalidTokenError';
  }
}

/** PEM keys may be passed in env as raw PEM, PEM with `\n` escapes, or base64. */
export function normalizePem(value: string): string {
  const v = value.trim();
  if (v.startsWith('-----BEGIN')) return v.replace(/\\n/g, '\n');
  return Buffer.from(v, 'base64').toString('utf8');
}

/** User access tokens are RS256: identity-service signs, every service verifies with the public key. */
export function signAccessToken(
  claims: AccessTokenClaims,
  privateKeyPem: string,
  ttlSeconds: number,
): string {
  return jwt.sign(claims, privateKeyPem, {
    algorithm: 'RS256',
    expiresIn: ttlSeconds,
    issuer: TOKEN_ISSUER,
    audience: ACCESS_AUDIENCE,
  });
}

export function verifyAccessToken(token: string, publicKeyPem: string): AccessTokenClaims {
  try {
    const decoded = jwt.verify(token, publicKeyPem, {
      algorithms: ['RS256'],
      issuer: TOKEN_ISSUER,
      audience: ACCESS_AUDIENCE,
    });
    if (typeof decoded === 'string') throw new InvalidTokenError();
    const c = decoded as Partial<AccessTokenClaims>;
    if (!c.sub || !c.tid || !c.sid || !Array.isArray(c.acl))
      throw new InvalidTokenError('Malformed token');
    return { sub: c.sub, tid: c.tid, sid: c.sid, acl: c.acl, plat: c.plat };
  } catch (err) {
    if (err instanceof InvalidTokenError) throw err;
    throw new InvalidTokenError();
  }
}

export interface ServiceTokenInput extends ServiceTokenClaims {
  /** The user the call is made for, when there is one. */
  act?: string;
}

/**
 * Service-to-service tokens are HS256 with a shared internal secret and a very
 * short life. They are only accepted on `/internal` routes, which the gateway
 * never exposes.
 */
export function signServiceToken(
  claims: ServiceTokenInput,
  secret: string,
  ttlSeconds = 60,
): string {
  return jwt.sign(claims, secret, {
    algorithm: 'HS256',
    expiresIn: ttlSeconds,
    issuer: TOKEN_ISSUER,
    audience: SERVICE_AUDIENCE,
  });
}

export function verifyServiceToken(token: string, secret: string): ServiceTokenInput {
  try {
    const decoded = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      issuer: TOKEN_ISSUER,
      audience: SERVICE_AUDIENCE,
    });
    if (typeof decoded === 'string' || !decoded.sub?.startsWith('svc:'))
      throw new InvalidTokenError();
    return decoded as ServiceTokenInput;
  } catch (err) {
    if (err instanceof InvalidTokenError) throw err;
    throw new InvalidTokenError();
  }
}
