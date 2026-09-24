import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import {
  InvalidTokenError,
  signAccessToken,
  signServiceToken,
  verifyAccessToken,
  verifyServiceToken,
} from './tokens';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const other = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const claims = {
  sub: 'u1',
  tid: 't1',
  sid: 's1',
  acl: [{ ou: 'o', path: '/o/', p: ['org.unit.read' as const] }],
};

describe('access tokens', () => {
  it('round-trips claims', () => {
    const token = signAccessToken(claims, privateKey, 60);
    expect(verifyAccessToken(token, publicKey)).toMatchObject(claims);
  });

  it('rejects a token signed by another key', () => {
    const token = signAccessToken(claims, other.privateKey, 60);
    expect(() => verifyAccessToken(token, publicKey)).toThrow(InvalidTokenError);
  });

  it('rejects an expired token', () => {
    const token = signAccessToken(claims, privateKey, -10);
    expect(() => verifyAccessToken(token, publicKey)).toThrow(InvalidTokenError);
  });

  it('rejects alg=none and HS256 downgrade attempts', () => {
    const none = jwt.sign(claims, '', {
      algorithm: 'none',
      issuer: 'global-erp',
      audience: 'erp-api',
    });
    expect(() => verifyAccessToken(none, publicKey)).toThrow(InvalidTokenError);
    const hs = jwt.sign(claims, publicKey, {
      algorithm: 'HS256',
      issuer: 'global-erp',
      audience: 'erp-api',
    });
    expect(() => verifyAccessToken(hs, publicKey)).toThrow(InvalidTokenError);
  });

  it('rejects a service token used as an access token', () => {
    const svc = signServiceToken({ sub: 'svc:x', tid: 't1' }, 'secret-secret-secret-secret-1234');
    expect(() => verifyAccessToken(svc, publicKey)).toThrow(InvalidTokenError);
  });
});

describe('service tokens', () => {
  const secret = 'secret-secret-secret-secret-1234';

  it('round-trips', () => {
    const t = signServiceToken({ sub: 'svc:tenant-service', tid: 't1', act: 'u1' }, secret);
    expect(verifyServiceToken(t, secret)).toMatchObject({
      sub: 'svc:tenant-service',
      tid: 't1',
      act: 'u1',
    });
  });

  it('rejects the wrong secret and non-service subjects', () => {
    const t = signServiceToken({ sub: 'svc:a' }, secret);
    expect(() => verifyServiceToken(t, 'another-secret-another-secret-12')).toThrow(
      InvalidTokenError,
    );
    const user = signServiceToken({ sub: 'u1' }, secret);
    expect(() => verifyServiceToken(user, secret)).toThrow(InvalidTokenError);
  });
});
